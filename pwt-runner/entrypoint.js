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
 * This file has no dependency on the main server — it only needs `playwright`,
 * which is installed in the image.
 */

const mode = process.argv[2];

const SERVE_PORT = parseInt(process.env.PWT_SERVE_PORT || '9222', 10);

async function runServe() {
    const { chromium } = require('playwright');
    const server = await chromium.launchServer({
        headless: true,
        port: SERVE_PORT,
        // The container is itself the sandbox boundary; Chromium's own sandbox
        // does not work without extra capabilities, so disable it here. shm is
        // small by default — point Chromium away from it.
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

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
