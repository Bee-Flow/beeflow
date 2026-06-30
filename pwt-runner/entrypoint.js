/**
 * Entrypoint for the throwaway Playwright runner container.
 *
 *   node entrypoint.js suite
 *     Runs the spec bind-mounted at /work via `playwright test`, writing
 *     /work/report.json (the worker reads it back after the container exits).
 *     stdout/stderr are streamed to the worker via the docker log attach.
 *
 *   node entrypoint.js serve
 *     Launches a Chromium server and prints exactly one line:
 *         PWT_WS_ENDPOINT=ws://127.0.0.1:9222/<guid>
 *     The worker parses that line, rewrites the host to a reachable address,
 *     and drives the browser remotely (explore / agent modes). Idles until the
 *     container is stopped.
 *
 *     Two optional env knobs make `serve` usable as a long-lived Deployment
 *     (the Kapsule `bf-browser` pod) where the docker-socket lifecycle that
 *     scrapes the endpoint from this log line is unavailable:
 *       PWT_SERVE_WS_PATH  serve at a STABLE path instead of an unguessable
 *                          per-launch one, so a STATIC BROWSER_WS_ENDPOINT can
 *                          target it (ws://<svc>:<port><path>).
 *       PWT_SERVE_HOST     bind host (e.g. 0.0.0.0) so a k8s Service can route
 *                          to the pod.
 *     Both UNSET → identical behaviour to before (random path, default bind),
 *     so the docker singleton / throwaway-runner paths are unaffected.
 *
 * This file has no dependency on the main server — it only needs `playwright`,
 * which is installed in the image.
 */

const mode = process.argv[2];

const SERVE_PORT = parseInt(process.env.PWT_SERVE_PORT || '9222', 10);
let SERVE_WS_PATH = process.env.PWT_SERVE_WS_PATH || '';
if (SERVE_WS_PATH && !SERVE_WS_PATH.startsWith('/')) SERVE_WS_PATH = `/${SERVE_WS_PATH}`;
const SERVE_HOST = process.env.PWT_SERVE_HOST || '';

async function runServe() {
    const { chromium } = require('playwright');
    const launchOpts = {
        headless: true,
        port: SERVE_PORT,
        // The container is itself the sandbox boundary; Chromium's own sandbox
        // does not work without extra capabilities, so disable it here. shm is
        // small by default — point Chromium away from it.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };
    // Only override when explicitly set so the docker-managed paths keep their
    // existing (random-path, default-bind) behaviour byte-for-byte.
    if (SERVE_WS_PATH) launchOpts.wsPath = SERVE_WS_PATH;
    if (SERVE_HOST) launchOpts.host = SERVE_HOST;
    const server = await chromium.launchServer(launchOpts);

    // Single, greppable line the worker waits for. Flush before idling.
    process.stdout.write(`PWT_WS_ENDPOINT=${server.wsEndpoint()}\n`);

    const shutdown = async () => {
        try { await server.close(); } catch (_) { /* ignore */ }
        process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

    // Keep the event loop alive indefinitely; the worker tears the container
    // down when the run finishes or times out.
    setInterval(() => {}, 1 << 30);
}

function runSuite() {
    const { spawn } = require('child_process');
    const child = spawn('npx', ['playwright', 'test', '--config', '/work/playwright.config.ts'], {
        cwd: '/runner',
        env: { ...process.env, CI: '1' },
        stdio: 'inherit',
    });
    child.on('error', (err) => {
        process.stderr.write(`spawn_failed: ${err.message}\n`);
        process.exit(1);
    });
    child.on('exit', (code, signal) => {
        if (signal) {
            process.stderr.write(`killed_by_signal: ${signal}\n`);
            process.exit(1);
        }
        process.exit(code == null ? 1 : code);
    });
}

if (mode === 'serve') {
    runServe().catch((e) => {
        process.stderr.write(`serve_failed: ${e.message}\n`);
        process.exit(1);
    });
} else if (mode === 'suite') {
    runSuite();
} else {
    process.stderr.write(`unknown mode: ${mode || '(none)'} — expected "suite" or "serve"\n`);
    process.exit(2);
}
