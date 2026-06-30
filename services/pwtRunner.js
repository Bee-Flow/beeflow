/**
 * Playwright Runner — dockerode lifecycle for throwaway test containers.
 *
 * Each Studio test run executes in its own short-lived container built from
 * server/pwt-runner/. This module owns image resolution, the isolated network,
 * container creation/teardown, live log streaming, and orphan reaping. It
 * deliberately mirrors the patterns in services/guardInstaller.js (same docker
 * socket, isServerInContainer detection, network discovery, image pull/build,
 * log demux) so operators reason about one container story, not two.
 *
 * Isolation guarantees:
 *   • Containers attach ONLY to PWT_NETWORK — never beeflow-network — so a
 *     malicious target page driven through the browser cannot reach postgres,
 *     rustfs, redis, the guard, or the API server.
 *   • Suite containers get an allowlisted env (no process.env spread), closing
 *     the secret-leak that the old host `spawn` had.
 *   • Memory / CPU / PID caps + a reaper bound the blast radius and guarantee
 *     cleanup even if the worker crashes mid-run.
 */

const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');

// The runner image MUST match the server's Playwright version (connect()
// rejects a minor-version mismatch). Derive the version and bake it into the
// local image tag so a version bump naturally invalidates the cached image and
// forces a rebuild instead of silently reusing a stale, mismatched runner.
let PW_VERSION = 'local';
try { PW_VERSION = require('playwright/package.json').version; } catch (_) { /* fall back */ }
const LOCAL_IMAGE_TAG = `beeflow-pwt-runner:pw-${PW_VERSION}`;

const PWT_NETWORK = 'beeflow-pwt-net';
const LABEL_KIND = 'bf.kind';
const LABEL_KIND_VALUE = 'pwt-runner';
const LABEL_RUN = 'bf.runId';
const LABEL_BORN = 'bf.bornAt';
const SERVE_PORT = 9222;

const MEMORY_MB = parseInt(process.env.PLAYWRIGHT_RUNNER_MEMORY_MB || '1024', 10);
const CPUS = parseFloat(process.env.PLAYWRIGHT_RUNNER_CPUS || '1.0');
const SHM_MB = parseInt(process.env.PLAYWRIGHT_RUNNER_SHM_MB || '256', 10);
const MAX_AGE_MS = parseInt(process.env.PLAYWRIGHT_RUNNER_MAX_AGE_MS || '600000', 10); // 10 min
const SERVE_READY_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_SERVE_READY_TIMEOUT_MS || '60000', 10);

// ── Long-lived shared browser singleton ─────────────────────────────────────
// A persistent serve container (distinct from the per-run throwaways) that the
// API process drives remotely for PDF export, thumbnails, SPA ingestion, and
// the Tests Studio host fallback. It carries a DIFFERENT kind label so the
// reaper never touches it, and it owns its own liveness checks.
const BROWSER_NAME = process.env.BROWSER_CONTAINER_NAME || 'bf-browser';
const LABEL_KIND_BROWSER = 'pwt-browser';
const BROWSER_MEMORY_MB = parseInt(process.env.BROWSER_CONTAINER_MEMORY_MB || '1024', 10);
const BROWSER_CPUS = parseFloat(process.env.BROWSER_CONTAINER_CPUS || '1.0');
const BROWSER_SHM_MB = parseInt(process.env.BROWSER_CONTAINER_SHM_MB || '256', 10);
const BROWSER_READY_TIMEOUT_MS = parseInt(process.env.BROWSER_READY_TIMEOUT_MS || '60000', 10);

function getDocker() {
    return new Docker({ socketPath: '/var/run/docker.sock' });
}

/**
 * Cheap availability probe — the socket file must exist AND the daemon must
 * answer a ping. Callers use this to pick the container path vs the host
 * fallback. Cached after first success.
 */
let _available = null;
async function dockerAvailable() {
    if (_available !== null) return _available;
    try {
        if (!fs.existsSync('/var/run/docker.sock')) { _available = false; return false; }
        await getDocker().ping();
        _available = true;
    } catch (_) {
        _available = false;
    }
    return _available;
}

function isServerInContainer() {
    try {
        if (fs.existsSync('/.dockerenv')) return true;
    } catch (_) { /* ignore */ }
    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        return /docker|containerd|kubepods/.test(cgroup);
    } catch (_) { /* native */ }
    return false;
}

function containerName(runId) {
    return `bf-pwt-${String(runId).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40)}`;
}

function runnerLabels(runId) {
    return {
        [LABEL_KIND]: LABEL_KIND_VALUE,
        [LABEL_RUN]: String(runId),
        [LABEL_BORN]: String(Date.now()),
    };
}

function hostConfigCaps(extra = {}) {
    return {
        Memory: Math.max(256, MEMORY_MB) * 1024 * 1024,
        NanoCpus: Math.round(Math.max(0.25, CPUS) * 1e9),
        PidsLimit: 512,
        ShmSize: Math.max(64, SHM_MB) * 1024 * 1024,
        Init: true,
        AutoRemove: false, // explicit removal — AutoRemove races with log/report reads
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        ...extra,
    };
}

// ── Image resolution (mirrors guardInstaller.resolveGuardImage) ─────────────

async function imageExists(docker, image) {
    try {
        await docker.getImage(image).inspect();
        return true;
    } catch (err) {
        if (err.statusCode === 404) return false;
        throw err;
    }
}

async function pullImage(docker, image, onLine) {
    await new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
            if (err) return reject(err);
            let lastReport = 0;
            docker.modem.followProgress(
                stream,
                (progressErr) => progressErr ? reject(progressErr) : resolve(),
                (evt) => {
                    if (!evt || !onLine) return;
                    const now = Date.now();
                    if (now - lastReport < 1000) return;
                    lastReport = now;
                    const status = evt.status || '';
                    if (/downloading|extracting|pull complete|already exists/i.test(status)) {
                        onLine(`[runner-image] ${status}${evt.id ? ` ${evt.id}` : ''}`);
                    }
                },
            );
        });
    });
}

async function buildRunnerImage(docker, image, onLine) {
    const candidates = [
        '/app/pwt-runner',
        path.resolve(__dirname, '..', 'pwt-runner'),
    ];
    const contextDir = candidates.find(c => fs.existsSync(path.join(c, 'Dockerfile')));
    if (!contextDir) {
        throw new Error(`pwt-runner Dockerfile not found (looked in: ${candidates.join(', ')})`);
    }
    onLine?.(`[runner-image] building ${image} from ${contextDir} (first run only, can take a few minutes)`);
    const { spawn } = require('child_process');
    await new Promise((resolve, reject) => {
        const proc = spawn('docker', ['build', '-t', image, contextDir], {
            env: { ...process.env, DOCKER_BUILDKIT: '1' },
        });
        let stderrTail = '';
        proc.stdout.on('data', (c) => {
            for (const line of c.toString().split('\n')) if (line.trim()) onLine?.(`[runner-image] ${line.trim()}`);
        });
        proc.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-4000); });
        proc.on('error', reject);
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker build exited ${code}\n${stderrTail}`)));
    });
}

let _resolvedImage = null;
async function resolvePwtImage(docker, onLine) {
    if (_resolvedImage) return _resolvedImage;

    if (process.env.PLAYWRIGHT_RUNNER_IMAGE) {
        const img = process.env.PLAYWRIGHT_RUNNER_IMAGE;
        if (!(await imageExists(docker, img))) await pullImage(docker, img, onLine);
        _resolvedImage = img;
        return img;
    }

    // Version-pinned local tag first — guarantees we never reuse a runner
    // built against a different Playwright version.
    if (await imageExists(docker, LOCAL_IMAGE_TAG)) { _resolvedImage = LOCAL_IMAGE_TAG; return LOCAL_IMAGE_TAG; }

    const tagChain = process.env.PLAYWRIGHT_RUNNER_IMAGE_TAG
        ? [process.env.PLAYWRIGHT_RUNNER_IMAGE_TAG]
        : ['dev', 'latest'];
    let lastPullErr = null;
    for (const tag of tagChain) {
        const registryImage = `ghcr.io/bee-flow/pwt-runner:${tag}`;
        try {
            await pullImage(docker, registryImage, onLine);
            _resolvedImage = registryImage;
            return registryImage;
        } catch (e) {
            lastPullErr = e;
            console.warn(`[PwtRunner] registry pull ${registryImage} failed: ${e.message}`);
        }
    }

    const buildContextExists = fs.existsSync('/app/pwt-runner/Dockerfile')
        || fs.existsSync(path.resolve(__dirname, '..', 'pwt-runner', 'Dockerfile'));
    if (!buildContextExists) {
        throw new Error(
            'Could not pull ghcr.io/bee-flow/pwt-runner and the build context is not reachable. '
            + 'Set PLAYWRIGHT_RUNNER_IMAGE to a reachable image, or ensure server/pwt-runner is present. '
            + (lastPullErr ? `(last pull error: ${lastPullErr.message})` : '')
        );
    }
    await buildRunnerImage(docker, LOCAL_IMAGE_TAG, onLine);
    _resolvedImage = LOCAL_IMAGE_TAG;
    return LOCAL_IMAGE_TAG;
}

// ── Network ─────────────────────────────────────────────────────────────────

async function ensurePwtNetwork(docker) {
    try {
        await docker.getNetwork(PWT_NETWORK).inspect();
        return;
    } catch (err) {
        if (err.statusCode !== 404) throw err;
    }
    await docker.createNetwork({ Name: PWT_NETWORK, Driver: 'bridge' });
}

/**
 * When the worker runs inside a container it must join PWT_NETWORK to reach
 * the runner by name. Idempotent — a 403 ("already exists in network") is fine.
 */
async function connectSelfToNetwork(docker) {
    const hostname = process.env.HOSTNAME;
    if (!hostname) return false;
    try {
        await docker.getNetwork(PWT_NETWORK).connect({ Container: hostname });
        return true;
    } catch (err) {
        if (err.statusCode === 403 || /already exists/i.test(err.message || '')) return true;
        console.warn('[PwtRunner] could not attach worker to pwt network:', err.message);
        return false;
    }
}

async function removeContainerIfExists(docker, name) {
    try {
        const c = docker.getContainer(name);
        try { await c.stop({ t: 3 }); } catch (_) { /* may be stopped */ }
        await c.remove({ force: true });
    } catch (err) {
        if (err.statusCode !== 404) throw err;
    }
}

// ── Log streaming ─────────────────────────────────────────────────────────

/**
 * Follow a container's combined stdout/stderr, splitting into trimmed lines and
 * invoking onLine per line. Returns a function that detaches the stream.
 * Uses demuxStream so the 8-byte multiplex headers never corrupt a line.
 */
function followLogs(docker, container, onLine) {
    const { Writable } = require('stream');
    let buf = '';
    const sink = new Writable({
        write(chunk, _enc, cb) {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (line && onLine) { try { onLine(line); } catch (_) {} }
            }
            cb();
        },
    });
    let logStream = null;
    container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
        if (err || !stream) return;
        logStream = stream;
        container.modem.demuxStream(stream, sink, sink);
    });
    return () => { try { logStream?.destroy(); } catch (_) {} };
}

// ── Suite mode: run a spec to completion in a container ─────────────────────

/**
 * Run the suite spec bind-mounted at `workdir` (which must contain
 * playwright.config.ts and tests/). Streams output via onLine. Resolves with
 * { exitCode, timedOut } after the container exits or the timeout fires.
 * The container is always removed before returning.
 */
async function runSuiteContainer({ runId, workdir, baseUrl, onLine, timeoutMs, secretEnv = {} }) {
    const docker = getDocker();
    const image = await resolvePwtImage(docker, onLine);
    await ensurePwtNetwork(docker);
    const name = containerName(runId);
    await removeContainerIfExists(docker, name);

    // Per-run secret env (BF_USERNAME etc.) — injected only while the throwaway
    // container runs; never persisted, never logged.
    const secretEnvList = Object.entries(secretEnv || {}).map(([k, v]) => `${k}=${v}`);

    const container = await docker.createContainer({
        name,
        Image: image,
        Cmd: ['suite'],
        Env: ['CI=1', baseUrl ? `BASE_URL=${baseUrl}` : null, ...secretEnvList].filter(Boolean),
        Labels: runnerLabels(runId),
        WorkingDir: '/runner',
        HostConfig: hostConfigCaps({
            Binds: [`${workdir}:/work:rw`],
            NetworkMode: PWT_NETWORK,
        }),
        NetworkingConfig: { EndpointsConfig: { [PWT_NETWORK]: {} } },
    });

    let timedOut = false;
    let killTimer = null;
    const detach = followLogs(docker, container, onLine);
    try {
        await container.start();
        if (timeoutMs && timeoutMs > 0) {
            killTimer = setTimeout(() => {
                timedOut = true;
                container.stop({ t: 3 }).catch(() => container.kill().catch(() => {}));
            }, timeoutMs);
            killTimer.unref?.();
        }
        const status = await container.wait();
        return { exitCode: timedOut ? 124 : (status?.StatusCode ?? 1), timedOut };
    } finally {
        if (killTimer) clearTimeout(killTimer);
        detach();
        try { await container.remove({ force: true }); } catch (_) { /* reaper backstop */ }
    }
}

// ── Serve mode: a Chromium server the worker drives remotely ────────────────

/**
 * Start a serve container and wait for its wsEndpoint line. Returns
 * { containerId, wsEndpoint, cleanup }. The wsEndpoint host is rewritten to an
 * address the worker can actually reach:
 *   • worker native     → published port on 127.0.0.1
 *   • worker container  → the runner's container name on PWT_NETWORK
 * Caller MUST call cleanup() when done (worker owns timeout/cancel).
 */
async function startServeContainer({ runId, onLine }) {
    const docker = getDocker();
    const image = await resolvePwtImage(docker, onLine);
    await ensurePwtNetwork(docker);
    const inContainer = isServerInContainer();
    if (inContainer) await connectSelfToNetwork(docker);

    const name = containerName(runId);
    await removeContainerIfExists(docker, name);

    const hostExtra = { NetworkMode: PWT_NETWORK };
    const createOpts = {
        name,
        Image: image,
        Cmd: ['serve'],
        Env: [`PWT_SERVE_PORT=${SERVE_PORT}`],
        Labels: runnerLabels(runId),
        WorkingDir: '/runner',
        ExposedPorts: { [`${SERVE_PORT}/tcp`]: {} },
        NetworkingConfig: { EndpointsConfig: { [PWT_NETWORK]: {} } },
    };
    if (!inContainer) {
        // Native worker reaches the browser via a published loopback port.
        hostExtra.PortBindings = { [`${SERVE_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }] };
    }
    createOpts.HostConfig = hostConfigCaps(hostExtra);

    const container = await docker.createContainer(createOpts);

    let detach = () => {};
    const cleanup = async () => {
        try { detach(); } catch (_) {}
        try { await container.stop({ t: 3 }); } catch (_) {}
        try { await container.remove({ force: true }); } catch (_) {}
    };

    try {
        await container.start();

        // Resolve the address the worker uses to reach the served browser.
        let reachableHost;
        if (inContainer) {
            reachableHost = `${name}:${SERVE_PORT}`;
        } else {
            const info = await container.inspect();
            const binding = info?.NetworkSettings?.Ports?.[`${SERVE_PORT}/tcp`]?.[0];
            const hostPort = binding?.HostPort;
            if (!hostPort) throw new Error('serve container did not publish a host port');
            reachableHost = `127.0.0.1:${hostPort}`;
        }

        const rawEndpoint = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('serve container did not report a wsEndpoint in time')), SERVE_READY_TIMEOUT_MS);
            timer.unref?.();
            detach = followLogs(docker, container, (line) => {
                const m = /^PWT_WS_ENDPOINT=(.+)$/.exec(line);
                if (m) { clearTimeout(timer); resolve(m[1].trim()); }
                else if (onLine) onLine(line);
            });
        });

        // Rewrite ws://127.0.0.1:9222/<guid> → ws://<reachableHost>/<guid>
        const wsEndpoint = rawEndpoint.replace(/^ws:\/\/[^/]+/, `ws://${reachableHost}`);
        return { containerId: container.id, wsEndpoint, cleanup };
    } catch (e) {
        await cleanup();
        throw e;
    }
}

// ── Shared browser singleton ────────────────────────────────────────────────

function browserHostConfigCaps(extra = {}) {
    return {
        Memory: Math.max(256, BROWSER_MEMORY_MB) * 1024 * 1024,
        NanoCpus: Math.round(Math.max(0.25, BROWSER_CPUS) * 1e9),
        PidsLimit: 512,
        ShmSize: Math.max(64, BROWSER_SHM_MB) * 1024 * 1024,
        Init: true,
        AutoRemove: false,
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        ...extra,
    };
}

let _browserSingleton = null;   // { wsEndpoint, containerId } | { wsEndpoint, external:true }
let _browserStarting = null;    // in-flight promise to dedupe concurrent first use

/**
 * Is the cached singleton still usable? External endpoints are assumed up;
 * docker-managed ones are confirmed via inspect (Running).
 */
async function isBrowserAlive(s) {
    if (!s) return false;
    if (s.external) return true;
    try {
        const info = await getDocker().getContainer(s.containerId || BROWSER_NAME).inspect();
        return info?.State?.Running === true;
    } catch (_) {
        return false;
    }
}

/**
 * Ensure a long-lived browser is reachable and return { wsEndpoint, ... }.
 *   • BROWSER_WS_ENDPOINT set        → use it verbatim (external/sidecar), no docker.
 *   • cached singleton still alive   → reuse.
 *   • otherwise                      → (re)create the `bf-browser` serve container.
 *
 * The launchServer endpoint embeds a per-launch guid we can't recover from the
 * outside, so we always remove+recreate on a cold start to capture a fresh
 * PWT_WS_ENDPOINT line. The container reuses the same `serve` entrypoint and the
 * isolated PWT_NETWORK as the throwaway runners.
 */
async function ensureBrowserSingleton({ onLine } = {}) {
    if (process.env.BROWSER_WS_ENDPOINT) {
        return { wsEndpoint: process.env.BROWSER_WS_ENDPOINT, external: true };
    }
    if (_browserSingleton && await isBrowserAlive(_browserSingleton)) return _browserSingleton;
    if (_browserStarting) return _browserStarting;

    _browserStarting = (async () => {
        if (!(await dockerAvailable())) {
            throw new Error('docker_unavailable: cannot start the shared browser container');
        }
        const docker = getDocker();
        const image = await resolvePwtImage(docker, onLine);
        await ensurePwtNetwork(docker);
        const inContainer = isServerInContainer();
        if (inContainer) await connectSelfToNetwork(docker);
        await removeContainerIfExists(docker, BROWSER_NAME);

        const createOpts = {
            name: BROWSER_NAME,
            Image: image,
            Cmd: ['serve'],
            Env: [`PWT_SERVE_PORT=${SERVE_PORT}`],
            Labels: { [LABEL_KIND]: LABEL_KIND_BROWSER, [LABEL_BORN]: String(Date.now()) },
            WorkingDir: '/runner',
            ExposedPorts: { [`${SERVE_PORT}/tcp`]: {} },
            NetworkingConfig: { EndpointsConfig: { [PWT_NETWORK]: {} } },
        };
        const hostExtra = { NetworkMode: PWT_NETWORK };
        if (!inContainer) {
            hostExtra.PortBindings = { [`${SERVE_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }] };
        }
        createOpts.HostConfig = browserHostConfigCaps(hostExtra);

        const container = await docker.createContainer(createOpts);
        let detach = () => {};
        try {
            await container.start();

            let reachableHost;
            if (inContainer) {
                reachableHost = `${BROWSER_NAME}:${SERVE_PORT}`;
            } else {
                const info = await container.inspect();
                const binding = info?.NetworkSettings?.Ports?.[`${SERVE_PORT}/tcp`]?.[0];
                const hostPort = binding?.HostPort;
                if (!hostPort) throw new Error('browser container did not publish a host port');
                reachableHost = `127.0.0.1:${hostPort}`;
            }

            const rawEndpoint = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('browser container did not report a wsEndpoint in time')), BROWSER_READY_TIMEOUT_MS);
                timer.unref?.();
                detach = followLogs(docker, container, (line) => {
                    const m = /^PWT_WS_ENDPOINT=(.+)$/.exec(line);
                    if (m) { clearTimeout(timer); resolve(m[1].trim()); }
                    else if (onLine) onLine(line);
                });
            });

            const wsEndpoint = rawEndpoint.replace(/^ws:\/\/[^/]+/, `ws://${reachableHost}`);
            _browserSingleton = { wsEndpoint, containerId: container.id };
            return _browserSingleton;
        } catch (e) {
            try { detach(); } catch (_) {}
            try { await container.stop({ t: 3 }); } catch (_) {}
            try { await container.remove({ force: true }); } catch (_) {}
            throw e;
        } finally {
            // We only needed logs to capture the endpoint line; liveness is
            // tracked via inspect afterwards, so stop following.
            try { detach(); } catch (_) {}
        }
    })().finally(() => { _browserStarting = null; });

    return _browserStarting;
}

/** Convenience: ensure the singleton and return just its ws endpoint. */
async function getBrowserEndpoint(opts) {
    const s = await ensureBrowserSingleton(opts || {});
    return s.wsEndpoint;
}

// ── Cancellation + reaping ──────────────────────────────────────────────────

async function killRun(runId) {
    try {
        const docker = getDocker();
        await removeContainerIfExists(docker, containerName(runId));
    } catch (_) { /* ignore */ }
}

/**
 * Remove runner containers that are orphaned: stopped/exited, or older than
 * MAX_AGE_MS, or whose run is no longer active. Run on worker boot (kills
 * leftovers from a crashed worker) and on an interval. `isRunActive` lets the
 * caller consult the DB so we don't reap a container whose run is mid-flight.
 *
 * NOTE: the long-lived browser singleton carries the DIFFERENT kind label
 * `pwt-browser`, so the `pwt-runner` filter below never matches it — it is
 * intentionally exempt from reaping and manages its own liveness.
 */
async function reapStaleRunners(isRunActive = null) {
    if (!(await dockerAvailable())) return { reaped: 0 };
    let reaped = 0;
    try {
        const docker = getDocker();
        const containers = await docker.listContainers({
            all: true,
            filters: { label: [`${LABEL_KIND}=${LABEL_KIND_VALUE}`] },
        });
        const now = Date.now();
        for (const c of containers) {
            const runId = c.Labels?.[LABEL_RUN];
            const born = parseInt(c.Labels?.[LABEL_BORN] || '0', 10);
            const exited = c.State === 'exited' || c.State === 'dead' || c.State === 'created';
            const tooOld = born > 0 && (now - born) > MAX_AGE_MS;
            let inactive = false;
            if (isRunActive && runId) {
                try { inactive = !(await isRunActive(runId)); } catch (_) { inactive = false; }
            }
            if (exited || tooOld || inactive) {
                try {
                    const cont = docker.getContainer(c.Id);
                    try { await cont.stop({ t: 3 }); } catch (_) {}
                    await cont.remove({ force: true });
                    reaped++;
                } catch (_) { /* already gone */ }
            }
        }
    } catch (e) {
        console.warn('[PwtRunner] reap failed:', e.message);
    }
    return { reaped };
}

module.exports = {
    dockerAvailable,
    isServerInContainer,
    resolvePwtImage,
    ensurePwtNetwork,
    runSuiteContainer,
    startServeContainer,
    ensureBrowserSingleton,
    getBrowserEndpoint,
    isBrowserAlive,
    killRun,
    reapStaleRunners,
    PWT_NETWORK,
};
