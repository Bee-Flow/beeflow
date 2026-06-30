/**
 * Security Scan Runner — dockerode lifecycle for throwaway scanner containers.
 *
 * Each security scan executes one or more scanner engines (ZAP / nuclei /
 * testssl.sh), and every engine runs in its own short-lived container. This
 * module owns image resolution, the isolated scan network, container
 * creation/teardown, live log streaming, and orphan reaping. It deliberately
 * mirrors services/pwtRunner.js (same docker socket, isServerInContainer
 * detection, network discovery, image pull, log demux) so operators reason
 * about one container story across both runners.
 *
 * Isolation guarantees:
 *   • Containers attach ONLY to SCAN_NETWORK — never beeflow-network — so an
 *     off-the-shelf scanner image driven against an attacker-supplied target
 *     cannot reach postgres, rustfs, redis, the guard, or the API server.
 *   • Memory / CPU / PID caps + a reaper bound the blast radius and guarantee
 *     cleanup even if the worker crashes mid-scan.
 *   • This module never reads the scanner report files — it only runs the
 *     container and streams its logs. The worker reads workdir/report.json
 *     after runEngineContainer resolves.
 *
 * The cheap docker helpers (getDocker / dockerAvailable / isServerInContainer /
 * imageExists / pullImage style) duplicate pwtRunner's — they are a handful of
 * lines and duplicating them keeps the two runners independently readable and
 * avoids coupling scan availability to the playwright runner's module state.
 */

const fs = require('fs');
const crypto = require('crypto');
const Docker = require('dockerode');

const SCAN_NETWORK = 'beeflow-scan-net';
const LABEL_KIND = 'bf.kind';
const LABEL_KIND_VALUE = 'scan-runner';
const LABEL_SCAN = 'bf.scanId';
const LABEL_BORN = 'bf.bornAt';
const LABEL_PREWARM = 'bf.prewarm';

// Pre-warm: an unclaimed warm toolbox is released after this TTL (in-memory
// sweep); the reaper also removes any prewarm container older than the backstop
// (covers orphans left after a process restart loses the registry).
const PREWARM_TTL_MS = parseInt(process.env.SECURITY_PREWARM_TTL_MS || '300000', 10); // 5 min
const PREWARM_BACKSTOP_MS = parseInt(process.env.SECURITY_PREWARM_BACKSTOP_MS || '900000', 10); // 15 min

const MEMORY_MB = parseInt(process.env.SECURITY_SCANNER_MEMORY_MB || '1536', 10);
const CPUS = parseFloat(process.env.SECURITY_SCANNER_CPUS || '1.0');
const MAX_AGE_MS = parseInt(process.env.SECURITY_SCANNER_MAX_AGE_MS || '3600000', 10); // 60 min — full scans are slow

// Agent-mode (live, AI-driven) extras. The ZAP daemon + the free-form tools
// sandbox are long-lived containers driven by the agent; they carry the same
// bf.scanId label so killScan()/reapStaleRunners() tear them down too.
// ZAP 2.17 daemon cold-boot loads every passive/active rule + the callback
// service before the REST port opens — that's ~60-90s on a cold container, so
// the readiness budget is generous.
const ZAP_BOOT_TIMEOUT_MS = parseInt(process.env.SECURITY_ZAP_BOOT_TIMEOUT_MS || '120000', 10);
const TOOLS_IMAGE = process.env.SECURITY_TOOLS_IMAGE || 'beeflow-security-tools:latest';
const TOOLS_MEMORY_MB = parseInt(process.env.SECURITY_TOOLS_MEMORY_MB || '768', 10);
const TOOLS_CPUS = parseFloat(process.env.SECURITY_TOOLS_CPUS || '0.5');

// Default images per engine. Each can be overridden via its env var.
const DEFAULT_IMAGES = {
    zap: process.env.SECURITY_SCANNER_ZAP_IMAGE || 'ghcr.io/zaproxy/zaproxy:stable',
    nuclei: process.env.SECURITY_SCANNER_NUCLEI_IMAGE || 'projectdiscovery/nuclei:latest',
    testssl: process.env.SECURITY_SCANNER_TESTSSL_IMAGE || 'drwetter/testssl.sh:latest',
};

function getDocker() {
    return new Docker({ socketPath: '/var/run/docker.sock' });
}

/**
 * Cheap availability probe — the socket file must exist AND the daemon must
 * answer a ping. The worker uses this to decide whether scans can run at all
 * (there is no host fallback for security scans). Cached after first success.
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

function containerName(scanId, engine) {
    const safeId = String(scanId).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);
    const safeEngine = String(engine).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 12);
    return `bf-scan-${safeId}-${safeEngine}`;
}

function runnerLabels(scanId) {
    return {
        [LABEL_KIND]: LABEL_KIND_VALUE,
        [LABEL_SCAN]: String(scanId),
        [LABEL_BORN]: String(Date.now()),
    };
}

function hostConfigCaps(extra = {}) {
    return {
        Memory: Math.max(256, MEMORY_MB) * 1024 * 1024,
        NanoCpus: Math.round(Math.max(0.25, CPUS) * 1e9),
        PidsLimit: 512,
        Init: true,
        AutoRemove: false, // explicit removal — AutoRemove races with log/report reads
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        ...extra,
    };
}

// ── Image resolution (mirrors pwtRunner.resolvePwtImage) ────────────────────

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
                        onLine(`[scanner-image] ${status}${evt.id ? ` ${evt.id}` : ''}`);
                    }
                },
            );
        });
    });
}

/**
 * Resolve the image for an engine: honour the per-engine env override, else the
 * baked default tag. Pull it if it isn't present locally. Resolved images are
 * cached per-engine so a multi-engine scan only inspects/pulls once.
 */
const _resolvedImages = {};
async function resolveScanImage(engine, onLine) {
    if (_resolvedImages[engine]) return _resolvedImages[engine];

    const image = DEFAULT_IMAGES[engine];
    if (!image) throw new Error(`unknown scanner engine: ${engine}`);

    if (!(await imageExists(getDocker(), image))) {
        await pullImage(getDocker(), image, onLine);
    }
    _resolvedImages[engine] = image;
    return image;
}

// ── Network ─────────────────────────────────────────────────────────────────

async function ensureScanNetwork(docker) {
    try {
        await docker.getNetwork(SCAN_NETWORK).inspect();
        return;
    } catch (err) {
        if (err.statusCode !== 404) throw err;
    }
    await docker.createNetwork({ Name: SCAN_NETWORK, Driver: 'bridge' });
}

async function removeContainerIfExists(docker, name) {
    try {
        const c = docker.getContainer(name);
        try { await c.stop({ t: 10 }); } catch (_) { /* may be stopped */ }
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

// ── Engine descriptors ──────────────────────────────────────────────────────

/**
 * Translate an engine descriptor into the container's mount + Cmd. Each engine
 * writes its report into the bind-mounted workdir (always landing at
 * workdir/report.json on the host); the worker reads it back after we return.
 *
 *   • zap     — workdir → /zap/wrk:rw; zap-baseline.py / zap-full-scan.py emit
 *               report.{json,html,xml,md} into the working dir.
 *   • nuclei  — workdir → /out:rw; -je writes JSON export to /out/report.json.
 *   • testssl — workdir → /out:rw; --jsonfile writes /out/report.json.
 */
function engineSpec(engine, intensity, targetUrl) {
    switch (engine) {
        case 'zap': {
            const script = intensity === 'full' ? 'zap-full-scan.py' : 'zap-baseline.py';
            return {
                bind: '/zap/wrk:rw',
                Cmd: [script, '-t', targetUrl, '-J', 'report.json', '-r', 'report.html', '-x', 'report.xml', '-w', 'report.md'],
            };
        }
        case 'nuclei':
            return {
                bind: '/out:rw',
                Cmd: ['-u', targetUrl, '-je', '/out/report.json', '-silent'],
            };
        case 'testssl':
            return {
                bind: '/out:rw',
                Cmd: ['--jsonfile', '/out/report.json', '--quiet', targetUrl],
            };
        default:
            throw new Error(`unknown scanner engine: ${engine}`);
    }
}

/**
 * Run a single scanner engine to completion in a throwaway container. The
 * `workdir` host path is bind-mounted at the engine's expected report dir;
 * after this resolves the report lands at `workdir/report.json` (and, for ZAP,
 * the .html/.xml/.md siblings) for the worker to read. Streams output via
 * onLine. Resolves with { exitCode, timedOut } after the container exits or the
 * timeout fires. The container is ALWAYS removed before returning.
 *
 * This function deliberately does NOT read the report — the worker owns report
 * parsing so this module stays a thin docker lifecycle layer.
 */
async function runEngineContainer({ scanId, engine, intensity, workdir, targetUrl, onLine, timeoutMs }) {
    const docker = getDocker();
    const image = await resolveScanImage(engine, onLine);
    await ensureScanNetwork(docker);
    const spec = engineSpec(engine, intensity, targetUrl);
    const name = containerName(scanId, engine);
    await removeContainerIfExists(docker, name);

    const container = await docker.createContainer({
        name,
        Image: image,
        Cmd: spec.Cmd,
        Labels: runnerLabels(scanId),
        HostConfig: hostConfigCaps({
            Binds: [`${workdir}:${spec.bind}`],
            NetworkMode: SCAN_NETWORK,
        }),
        NetworkingConfig: { EndpointsConfig: { [SCAN_NETWORK]: {} } },
    });

    let timedOut = false;
    let killTimer = null;
    const detach = followLogs(docker, container, onLine);
    try {
        await container.start();
        if (timeoutMs && timeoutMs > 0) {
            killTimer = setTimeout(() => {
                timedOut = true;
                // ZAP needs a moment to flush its report on SIGTERM — give it a
                // generous grace period before the hard kill.
                container.stop({ t: 10 }).catch(() => container.kill().catch(() => {}));
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

// ── Cancellation + reaping ──────────────────────────────────────────────────

/**
 * Tear down every engine container for a scan. Used by the worker's cancel
 * poll — a scan may have several engine containers in flight, so we remove all
 * of this scan's containers by label rather than by a single name.
 */
async function killScan(scanId) {
    // Adopted (pre-warmed) containers are labeled bf.prewarm, NOT bf.scanId, so
    // the label filter below would miss them — clean up via the registry first.
    const adopted = _activeToolboxes.get(String(scanId));
    if (adopted) {
        _activeToolboxes.delete(String(scanId));
        try { await adopted.cleanup(); } catch (_) {}
    }
    try {
        const docker = getDocker();
        const containers = await docker.listContainers({
            all: true,
            filters: { label: [`${LABEL_SCAN}=${String(scanId)}`] },
        });
        for (const c of containers) {
            try {
                const cont = docker.getContainer(c.Id);
                try { await cont.stop({ t: 10 }); } catch (_) {}
                await cont.remove({ force: true });
            } catch (_) { /* already gone */ }
        }
    } catch (_) { /* ignore */ }
}

/**
 * Remove scanner containers that are orphaned: stopped/exited, or older than
 * MAX_AGE_MS, or whose scan is no longer active. Run on worker boot (kills
 * leftovers from a crashed worker) and on an interval. `isScanActive` lets the
 * caller consult the DB so we don't reap a container whose scan is mid-flight.
 */
async function reapStaleRunners(isScanActive = null) {
    if (!(await dockerAvailable())) return { reaped: 0 };
    let reaped = 0;
    try {
        const docker = getDocker();
        const containers = await docker.listContainers({
            all: true,
            filters: { label: [`${LABEL_KIND}=${LABEL_KIND_VALUE}`] },
        });
        // Never reap a container that's actively driving a scan right now (cold
        // or adopted) — these are tracked in-process by containerId.
        const activeIds = new Set();
        for (const h of _activeToolboxes.values()) { if (h?.containerId) activeIds.add(h.containerId); }
        const now = Date.now();
        for (const c of containers) {
            if (activeIds.has(c.Id)) continue;
            const scanId = c.Labels?.[LABEL_SCAN];
            const isPrewarm = !!c.Labels?.[LABEL_PREWARM];
            const born = parseInt(c.Labels?.[LABEL_BORN] || '0', 10);
            const exited = c.State === 'exited' || c.State === 'dead' || c.State === 'created';
            const tooOld = born > 0 && (now - born) > MAX_AGE_MS;
            // Backstop for warm containers orphaned by a process restart (the
            // in-memory TTL sweep handles the normal case).
            const prewarmOrphan = isPrewarm && born > 0 && (now - born) > PREWARM_BACKSTOP_MS;
            let inactive = false;
            if (isScanActive && scanId) {
                try { inactive = !(await isScanActive(scanId)); } catch (_) { inactive = false; }
            }
            if (exited || tooOld || inactive || prewarmOrphan) {
                try {
                    const cont = docker.getContainer(c.Id);
                    try { await cont.stop({ t: 10 }); } catch (_) {}
                    await cont.remove({ force: true });
                    reaped++;
                } catch (_) { /* already gone */ }
            }
        }
    } catch (e) {
        console.warn('[ScanRunner] reap failed:', e.message);
    }
    return { reaped };
}

// ── Agent mode: long-lived ZAP daemon + free-form tools sandbox ─────────────

/**
 * Join the API/worker's own container to SCAN_NETWORK so it can reach the ZAP
 * daemon / tools sandbox by container name (the in-container case). Idempotent —
 * a second connect throws and is ignored. Native (non-container) workers reach
 * the daemon via a published 127.0.0.1 port instead, so this is a no-op there.
 */
async function connectSelfToNetwork(docker) {
    try {
        const os = require('os');
        const selfId = os.hostname(); // inside docker this is the container id
        const net = docker.getNetwork(SCAN_NETWORK);
        try { await net.connect({ Container: selfId }); } catch (_) { /* already connected */ }
    } catch (_) { /* best-effort */ }
}

/**
 * Resolve the free-form tools sandbox image (SECURITY_TOOLS_IMAGE, default a
 * locally-built tag). Use it if present locally; otherwise try a registry pull;
 * otherwise fail loudly with the build command. Cached after first success.
 */
let _toolsImageResolved = null;
async function resolveToolsImage(onLine) {
    if (_toolsImageResolved) return _toolsImageResolved;
    const docker = getDocker();
    if (await imageExists(docker, TOOLS_IMAGE)) { _toolsImageResolved = TOOLS_IMAGE; return TOOLS_IMAGE; }
    try {
        await pullImage(docker, TOOLS_IMAGE, onLine);
    } catch (e) {
        throw new Error(`security tools image '${TOOLS_IMAGE}' not found locally and pull failed (${e.message}). Build it: docker build -t ${TOOLS_IMAGE} server/terminal-runner`);
    }
    _toolsImageResolved = TOOLS_IMAGE;
    return TOOLS_IMAGE;
}

function toolsHostConfig(extra = {}) {
    return {
        Memory: Math.max(128, TOOLS_MEMORY_MB) * 1024 * 1024,
        NanoCpus: Math.round(Math.max(0.25, TOOLS_CPUS) * 1e9),
        PidsLimit: 256,
        Init: true,
        AutoRemove: false,
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        ...extra,
    };
}

async function _awaitDaemonReady(baseUrl, apiKey, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = 'timeout';
    // The daemon requires its api.key on every request (views included), so the
    // readiness probe must carry it too — otherwise ZAP answers 4xx forever.
    const url = `${baseUrl}/JSON/core/view/version/?apikey=${encodeURIComponent(apiKey)}`;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
            if (res.ok) return true;
            lastErr = `HTTP ${res.status}`;
        } catch (e) { lastErr = e.message; }
        await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`ZAP daemon not ready within ${timeoutMs}ms (${lastErr})`);
}

/**
 * Start a long-lived ZAP daemon container exposing the ZAP REST API, with a
 * per-scan api.key (never logged). Returns { baseUrl, apiKey, containerId,
 * cleanup }. Reachable via the container name on SCAN_NETWORK (worker-in-
 * container) or a published 127.0.0.1 port (native). Caller MUST cleanup().
 */
async function startZapDaemon({ scanId, onLine }) {
    const docker = getDocker();
    const image = await resolveScanImage('zap', onLine);
    await ensureScanNetwork(docker);
    const inContainer = isServerInContainer();
    if (inContainer) await connectSelfToNetwork(docker);

    const apiKey = crypto.randomBytes(24).toString('hex'); // per-scan; never logged
    const PORT = 8080;
    const name = containerName(scanId, 'zapd');
    await removeContainerIfExists(docker, name);

    const cmd = [
        'zap-x.sh', '-daemon', '-host', '0.0.0.0', '-port', String(PORT),
        '-config', `api.key=${apiKey}`,
        '-config', 'api.addrs.addr.name=.*',
        '-config', 'api.addrs.addr.regex=true',
    ];
    const hostExtra = { NetworkMode: SCAN_NETWORK };
    const createOpts = {
        name, Image: image, Cmd: cmd,
        Labels: runnerLabels(scanId),
        ExposedPorts: { [`${PORT}/tcp`]: {} },
        NetworkingConfig: { EndpointsConfig: { [SCAN_NETWORK]: {} } },
    };
    if (!inContainer) hostExtra.PortBindings = { [`${PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }] };
    createOpts.HostConfig = hostConfigCaps(hostExtra);

    const container = await docker.createContainer(createOpts);
    let detach = () => {};
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return; cleaned = true;
        try { detach(); } catch (_) {}
        try { await container.stop({ t: 5 }); } catch (_) {}
        try { await container.remove({ force: true }); } catch (_) {}
    };
    try {
        await container.start();
        let host;
        if (inContainer) {
            host = `${name}:${PORT}`;
        } else {
            const info = await container.inspect();
            const hp = info?.NetworkSettings?.Ports?.[`${PORT}/tcp`]?.[0]?.HostPort;
            if (!hp) throw new Error('ZAP daemon did not publish a host port');
            host = `127.0.0.1:${hp}`;
        }
        const baseUrl = `http://${host}`;
        detach = followLogs(docker, container, (line) => { if (onLine) onLine(line); });
        await _awaitDaemonReady(baseUrl, apiKey, ZAP_BOOT_TIMEOUT_MS);
        return { baseUrl, apiKey, containerId: container.id, cleanup };
    } catch (e) {
        await cleanup();
        throw e;
    }
}

/**
 * Start a long-lived, free-form tools sandbox the agent runs shell commands in.
 * Isolated egress-only network, non-root image, no docker socket, tight caps.
 * Returns { containerId, exec, cleanup } where
 *   exec(command, { onChunk, timeoutMs }) -> { exitCode, timedOut }
 * streams stdout/stderr to onChunk({ stream, chunk }) per chunk. Caller cleanup().
 */
async function startToolsSandbox({ scanId, onLine }) {
    const docker = getDocker();
    const image = await resolveToolsImage(onLine);
    await ensureScanNetwork(docker);
    if (isServerInContainer()) await connectSelfToNetwork(docker);

    const name = containerName(scanId, 'tools');
    await removeContainerIfExists(docker, name);

    const container = await docker.createContainer({
        name, Image: image,
        Cmd: ['sleep', 'infinity'], // idle; commands run via container.exec
        Labels: runnerLabels(scanId),
        HostConfig: toolsHostConfig({ NetworkMode: SCAN_NETWORK }),
        NetworkingConfig: { EndpointsConfig: { [SCAN_NETWORK]: {} } },
    });

    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return; cleaned = true;
        try { await container.stop({ t: 5 }); } catch (_) {}
        try { await container.remove({ force: true }); } catch (_) {}
    };

    const exec = async (command, { onChunk, timeoutMs = 30000 } = {}) => {
        const { Writable } = require('stream');
        const ex = await container.exec({
            Cmd: ['sh', '-lc', command],
            AttachStdout: true, AttachStderr: true, Tty: false,
        });
        const stream = await ex.start({ hijack: true, stdin: false });
        const mk = (tag) => new Writable({
            write(chunk, _enc, cb) {
                try { onChunk && onChunk({ stream: tag, chunk: chunk.toString('utf8') }); } catch (_) {}
                cb();
            },
        });
        container.modem.demuxStream(stream, mk('stdout'), mk('stderr'));

        let timedOut = false;
        const done = new Promise((resolve) => { stream.on('end', resolve); stream.on('close', resolve); });
        let timer = null;
        const to = new Promise((resolve) => {
            timer = setTimeout(() => { timedOut = true; try { stream.destroy(); } catch (_) {} resolve(); }, Math.max(1000, timeoutMs));
            timer.unref?.();
        });
        await Promise.race([done, to]);
        if (timer) clearTimeout(timer);

        let exitCode = timedOut ? 124 : 0;
        try {
            const info = await ex.inspect();
            if (!timedOut && typeof info.ExitCode === 'number') exitCode = info.ExitCode;
        } catch (_) { /* exec gone */ }
        return { exitCode, timedOut };
    };

    try {
        await container.start();
        return { containerId: container.id, exec, cleanup };
    } catch (e) {
        await cleanup();
        throw e;
    }
}

// ── Agent mode: ONE container with the full arsenal + an in-container ZAP ────
//
// The security agent drives a SINGLE long-lived container (the Kali toolbox
// image) that holds every scanner tool AND runs the OWASP ZAP daemon as a
// backgrounded process inside itself. This collapses the previous 3-container
// split (startZapDaemon + startToolsSandbox + per-engine runEngineContainer)
// into one box. startZapDaemon/startToolsSandbox stay exported (deprecated) but
// agent mode no longer calls them; runEngineContainer remains only for any
// legacy quick path.
//
// Raw sockets: nmap -sS / masscan need CAP_NET_RAW. Because no-new-privileges
// blocks non-root file-capability elevation, the only reliable way to let those
// tools use raw sockets is to run the container as root with EVERY capability
// DROPPED except NET_RAW (+ NET_BIND_SERVICE). That is still a tightly-bounded
// process: isolated egress-only network, no docker socket, all-but-NET_RAW
// dropped, no-new-privileges, and cpu/mem/pid caps. Gated by
// SECURITY_TOOLBOX_NET_RAW (default ON); when off, the container runs as the
// unprivileged `scanner` user and nmap degrades to TCP-connect (-sT).
const TOOLBOX_MEMORY_MB = parseInt(process.env.SECURITY_TOOLBOX_MEMORY_MB || '2048', 10);
const TOOLBOX_CPUS = parseFloat(process.env.SECURITY_TOOLBOX_CPUS || '1.0');
const toolboxNetRaw = () => process.env.SECURITY_TOOLBOX_NET_RAW !== 'false';
const ZAP_PORT = 8080;

function toolboxHostConfig(extra = {}) {
    const cfg = {
        Memory: Math.max(512, TOOLBOX_MEMORY_MB) * 1024 * 1024,
        NanoCpus: Math.round(Math.max(0.5, TOOLBOX_CPUS) * 1e9),
        PidsLimit: 1024,
        Init: true,
        AutoRemove: false,
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        ...extra,
    };
    if (toolboxNetRaw()) {
        cfg.CapDrop = ['ALL'];
        cfg.CapAdd = ['NET_RAW', 'NET_BIND_SERVICE'];
    }
    return cfg;
}

/**
 * Build the per-container exec closure the agent runs shell commands through.
 * Same shape startToolsSandbox returns: exec(command,{onChunk,timeoutMs}) ->
 * { exitCode, timedOut }, streaming stdout/stderr to onChunk({ stream, chunk }).
 * Uses `bash -c` (NOT a login shell) so the image's ENV PATH — which includes
 * /opt/pd/bin and /opt/venv/bin — is inherited intact rather than reset by
 * /etc/profile.
 */
function makeContainerExec(container) {
    return async (command, { onChunk, timeoutMs = 30000 } = {}) => {
        const { Writable } = require('stream');
        const ex = await container.exec({
            Cmd: ['bash', '-c', command],
            AttachStdout: true, AttachStderr: true, Tty: false,
        });
        const stream = await ex.start({ hijack: true, stdin: false });
        const mk = (tag) => new Writable({
            write(chunk, _enc, cb) {
                try { onChunk && onChunk({ stream: tag, chunk: chunk.toString('utf8') }); } catch (_) {}
                cb();
            },
        });
        container.modem.demuxStream(stream, mk('stdout'), mk('stderr'));

        let timedOut = false;
        const done = new Promise((resolve) => { stream.on('end', resolve); stream.on('close', resolve); });
        let timer = null;
        const to = new Promise((resolve) => {
            timer = setTimeout(() => { timedOut = true; try { stream.destroy(); } catch (_) {} resolve(); }, Math.max(1000, timeoutMs));
            timer.unref?.();
        });
        await Promise.race([done, to]);
        if (timer) clearTimeout(timer);

        let exitCode = timedOut ? 124 : 0;
        try {
            const info = await ex.inspect();
            if (!timedOut && typeof info.ExitCode === 'number') exitCode = info.ExitCode;
        } catch (_) { /* exec gone */ }
        return { exitCode, timedOut };
    };
}

// Build the ZAP daemon launch command. The proxy/API MUST bind to 0.0.0.0 via
// the `network` add-on — ZAP 2.12+ ignores the legacy `-host` flag and would
// otherwise listen on 127.0.0.1 only, so the worker (reaching the container by
// its network IP/name) gets ECONNREFUSED. `-silent` skips the update-check and
// callhome/telemetry for a faster, deterministic boot on the isolated network.
function _zapDaemonCmd(apiKey) {
    return [
        'zaproxy', '-daemon', '-silent',
        '-host', '0.0.0.0', '-port', String(ZAP_PORT),
        '-dir', '/home/scanner/work/.zap',
        '-config', `network.localServers.mainProxy.address=0.0.0.0`,
        '-config', `network.localServers.mainProxy.port=${ZAP_PORT}`,
        '-config', `api.key=${apiKey}`,
        '-config', 'api.addrs.addr.name=.*',
        '-config', 'api.addrs.addr.regex=true',
    ].join(' ');
}

/**
 * Create + start one toolbox container and launch the in-container ZAP daemon,
 * WITHOUT waiting for ZAP readiness. Returns { handle, cleanup, awaitReady }:
 *   • handle      — { zap:{baseUrl,apiKey}, containerId, exec, cleanup }
 *   • cleanup     — stop+remove the container (usable mid-boot, e.g. to release
 *                   a pre-warm container before ZAP has finished booting)
 *   • awaitReady  — () => Promise<handle> that resolves once ZAP answers.
 * Splitting create from await-ready is what lets pre-warm boot in the
 * background and lets a release tear the container down mid-boot.
 */
async function _spawnToolbox({ name, apiKey, labels, onLine }) {
    const docker = getDocker();
    const image = await resolveToolsImage(onLine);
    await ensureScanNetwork(docker);
    const inContainer = isServerInContainer();
    if (inContainer) await connectSelfToNetwork(docker);
    await removeContainerIfExists(docker, name);

    const hostExtra = { NetworkMode: SCAN_NETWORK };
    if (!inContainer) hostExtra.PortBindings = { [`${ZAP_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }] };

    const createOpts = {
        name, Image: image,
        Cmd: ['sleep', 'infinity'], // idle; ZAP + agent commands arrive via exec
        // HOME keeps both ZAP (~/.ZAP) and nuclei (baked templates) pointed at
        // the scanner home even when the container runs as root for NET_RAW.
        Env: ['HOME=/home/scanner'],
        Labels: labels,
        ExposedPorts: { [`${ZAP_PORT}/tcp`]: {} },
        NetworkingConfig: { EndpointsConfig: { [SCAN_NETWORK]: {} } },
        HostConfig: toolboxHostConfig(hostExtra),
    };
    // Raw-socket tooling needs root + NET_RAW (see toolboxHostConfig); without
    // the cap we stay as the image's non-root `scanner` user.
    if (toolboxNetRaw()) createOpts.User = '0';

    const container = await docker.createContainer(createOpts);

    let detach = () => {};
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return; cleaned = true;
        try { detach(); } catch (_) {}
        try { await container.stop({ t: 5 }); } catch (_) {}
        try { await container.remove({ force: true }); } catch (_) {}
    };

    try {
        await container.start();
        detach = followLogs(docker, container, (line) => { if (onLine) onLine(line); });

        // Launch ZAP as a backgrounded process; setsid+nohup detach it from the
        // exec session so it survives. Output goes to the workdir.
        const zapCmd = _zapDaemonCmd(apiKey);
        const zapExec = await container.exec({
            Cmd: ['bash', '-c', `mkdir -p /home/scanner/work/.zap && setsid nohup ${zapCmd} >/home/scanner/work/zap.log 2>&1 & echo zap-launched`],
            AttachStdout: true, AttachStderr: true, Tty: false,
        });
        try {
            const zs = await zapExec.start({ hijack: true, stdin: false });
            zs.on('data', () => {}); // drain; ZAP keeps running via setsid+nohup
            zs.on('error', () => {});
        } catch (_) { /* the readiness poll is the real synchronization */ }

        let host;
        if (inContainer) {
            host = `${name}:${ZAP_PORT}`;
        } else {
            const info = await container.inspect();
            const hp = info?.NetworkSettings?.Ports?.[`${ZAP_PORT}/tcp`]?.[0]?.HostPort;
            if (!hp) throw new Error('toolbox did not publish a host port for ZAP');
            host = `127.0.0.1:${hp}`;
        }
        const baseUrl = `http://${host}`;
        const handle = {
            zap: { baseUrl, apiKey },
            containerId: container.id,
            exec: makeContainerExec(container),
            cleanup,
        };
        const awaitReady = async () => {
            await _awaitDaemonReady(baseUrl, apiKey, ZAP_BOOT_TIMEOUT_MS);
            return handle;
        };
        return { handle, cleanup, awaitReady };
    } catch (e) {
        await cleanup();
        throw e;
    }
}

/**
 * Cold path: start one toolbox + ZAP for a scan and wait until ZAP is ready.
 * The container carries the bf.scanId label so killScan()/reapStaleRunners()
 * tear it down too; callers MUST also cleanup() in finally.
 */
async function startAgentToolbox({ scanId, onLine }) {
    const apiKey = crypto.randomBytes(24).toString('hex'); // per-scan; never logged
    const name = containerName(scanId, 'agent');
    const spawned = await _spawnToolbox({ name, apiKey, labels: runnerLabels(scanId), onLine });
    try {
        return await spawned.awaitReady();
    } catch (e) {
        await spawned.cleanup();
        throw e;
    }
}

// ── Pre-warm: boot a toolbox in the background so a scan starts instantly ────
//
// When the user opens the New-scan dialog the route pre-warms a toolbox; by the
// time they submit it's booted and the worker ADOPTS it. Single-use: the
// adopted container is destroyed after the scan (no cross-scan reuse, so no
// session reset needed). Best-effort everywhere — if anything fails the worker
// just cold-starts.
const _prewarmRegistry = new Map(); // prewarmId -> { promise, cleanup?, userId, createdAt, state, claimed, released }
const _activeToolboxes = new Map(); // scanId -> handle (cold OR adopted) for cancel/reap

/** Start warming a toolbox in the background; returns a prewarmId immediately. */
function prewarmToolbox({ userId = null } = {}) {
    // One unclaimed warm container per user — release the previous one.
    for (const [pid, e] of _prewarmRegistry) {
        if (e.userId === userId && !e.claimed) releasePrewarm(pid).catch(() => {});
    }
    const prewarmId = crypto.randomBytes(12).toString('hex');
    const apiKey = crypto.randomBytes(24).toString('hex');
    const name = containerName(prewarmId, 'warm');
    const labels = {
        [LABEL_KIND]: LABEL_KIND_VALUE,
        [LABEL_PREWARM]: prewarmId,
        [LABEL_BORN]: String(Date.now()),
    };
    const entry = { userId, createdAt: Date.now(), state: 'warming', claimed: false, released: false, cleanup: null };
    entry.promise = (async () => {
        const spawned = await _spawnToolbox({ name, apiKey, labels, onLine: null });
        entry.cleanup = spawned.cleanup;
        if (entry.released) { await spawned.cleanup(); throw new Error('prewarm_released'); }
        try {
            const handle = await spawned.awaitReady();
            if (entry.released) { await spawned.cleanup(); throw new Error('prewarm_released'); }
            entry.state = 'ready';
            return handle;
        } catch (e) {
            entry.state = 'failed';
            await spawned.cleanup();
            throw e;
        }
    })();
    entry.promise.catch(() => {}); // avoid unhandledRejection; adopt/release handle errors
    _prewarmRegistry.set(prewarmId, entry);
    return prewarmId;
}

/** Adopt a warm toolbox (awaiting the remainder of its boot). null → cold-start. */
async function adoptToolbox(prewarmId) {
    const entry = prewarmId ? _prewarmRegistry.get(prewarmId) : null;
    if (!entry || entry.released) return null;
    entry.claimed = true;
    _prewarmRegistry.delete(prewarmId);
    try { return await entry.promise; }
    catch (_) { return null; }
}

/** Tear down an unclaimed warm toolbox (e.g. dialog closed without submitting). */
async function releasePrewarm(prewarmId) {
    const entry = prewarmId ? _prewarmRegistry.get(prewarmId) : null;
    if (!entry) return;
    _prewarmRegistry.delete(prewarmId);
    entry.released = true;
    // If the container already exists, clean it up now; otherwise the warming
    // promise's `entry.released` check tears it down as soon as it's created.
    if (entry.cleanup) { try { await entry.cleanup(); } catch (_) {} }
}

/** Release unclaimed warm toolboxes past their TTL. Runs on an interval. */
function sweepPrewarmRegistry() {
    const now = Date.now();
    for (const [pid, e] of _prewarmRegistry) {
        if (!e.claimed && (now - e.createdAt) > PREWARM_TTL_MS) {
            releasePrewarm(pid).catch(() => {});
        }
    }
}
const _prewarmSweep = setInterval(sweepPrewarmRegistry, 60000);
_prewarmSweep.unref?.();

/** Track a live toolbox by scanId so cancel/reap can target it (incl. adopted). */
function registerActiveToolbox(scanId, handle) {
    if (scanId && handle) _activeToolboxes.set(String(scanId), handle);
}
function unregisterActiveToolbox(scanId) {
    if (scanId) _activeToolboxes.delete(String(scanId));
}

module.exports = {
    dockerAvailable,
    isServerInContainer,
    resolveScanImage,
    ensureScanNetwork,
    runEngineContainer,
    killScan,
    reapStaleRunners,
    connectSelfToNetwork,
    resolveToolsImage,
    startZapDaemon,
    startToolsSandbox,
    startAgentToolbox,
    prewarmToolbox,
    adoptToolbox,
    releasePrewarm,
    registerActiveToolbox,
    unregisterActiveToolbox,
    SCAN_NETWORK,
};
