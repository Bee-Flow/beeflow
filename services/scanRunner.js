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
const Docker = require('dockerode');

const SCAN_NETWORK = 'beeflow-scan-net';
const LABEL_KIND = 'bf.kind';
const LABEL_KIND_VALUE = 'scan-runner';
const LABEL_SCAN = 'bf.scanId';
const LABEL_BORN = 'bf.bornAt';

const MEMORY_MB = parseInt(process.env.SECURITY_SCANNER_MEMORY_MB || '1536', 10);
const CPUS = parseFloat(process.env.SECURITY_SCANNER_CPUS || '1.0');
const MAX_AGE_MS = parseInt(process.env.SECURITY_SCANNER_MAX_AGE_MS || '3600000', 10); // 60 min — full scans are slow

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
        const now = Date.now();
        for (const c of containers) {
            const scanId = c.Labels?.[LABEL_SCAN];
            const born = parseInt(c.Labels?.[LABEL_BORN] || '0', 10);
            const exited = c.State === 'exited' || c.State === 'dead' || c.State === 'created';
            const tooOld = born > 0 && (now - born) > MAX_AGE_MS;
            let inactive = false;
            if (isScanActive && scanId) {
                try { inactive = !(await isScanActive(scanId)); } catch (_) { inactive = false; }
            }
            if (exited || tooOld || inactive) {
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

module.exports = {
    dockerAvailable,
    isServerInContainer,
    resolveScanImage,
    ensureScanNetwork,
    runEngineContainer,
    killScan,
    reapStaleRunners,
    SCAN_NETWORK,
};
