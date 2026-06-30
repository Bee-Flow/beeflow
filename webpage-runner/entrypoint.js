/**
 * Webpage full-tier runner entrypoint (runs INSIDE the per-project container).
 *
 * 1. Install the project's npm deps (if it ships a package.json).
 * 2. Start an optional custom Node backend (server.js) alongside the dev server.
 * 3. Serve the project with the project's own `dev` script, else our Vite.
 *
 * The container is disposable; /project is a bind-mount hydrated from RustFS by
 * the runtime manager. Resource/security limits are enforced by the daemon
 * (Memory/CPU/PID caps, no-new-privileges, cap-drop, isolated network).
 */

const fs = require('fs');
const { spawn } = require('child_process');

const PROJECT = '/project';
const RUNNER = '/runner';
const PORT = process.env.PORT || '5173';

function run(cmd, args) {
    return new Promise((resolve) => {
        const p = spawn(cmd, args, { stdio: 'inherit', cwd: PROJECT });
        p.on('exit', (code) => resolve(code ?? 0));
        p.on('error', (e) => { console.error(`[runner] spawn error: ${cmd}: ${e.message}`); resolve(1); });
    });
}

function readPkg() {
    try { return JSON.parse(fs.readFileSync(`${PROJECT}/package.json`, 'utf8')); }
    catch { return null; }
}

(async () => {
    const pkg = readPkg();

    // 1. Install deps (best-effort; the daemon's wall limits bound runaways).
    if (pkg) {
        console.log('[runner] installing project dependencies…');
        await run('npm', ['install', '--no-audit', '--no-fund']);
    }

    // 2. Optional custom backend.
    if (fs.existsSync(`${PROJECT}/server.js`)) {
        console.log('[runner] starting project server.js');
        const srv = spawn('node', ['server.js'], { stdio: 'inherit', cwd: PROJECT });
        srv.on('error', (e) => console.error('[runner] server.js error:', e.message));
    }

    // 3. Dev server — prefer the project's own `dev` script.
    const hasDevScript = !!(pkg?.scripts?.dev);
    if (hasDevScript) {
        console.log('[runner] npm run dev');
        await run('npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', PORT]);
    } else {
        const hasOwnConfig = ['vite.config.js', 'vite.config.mjs', 'vite.config.ts']
            .some((f) => fs.existsSync(`${PROJECT}/${f}`));
        const cfgArgs = hasOwnConfig ? [] : ['--config', `${RUNNER}/vite.config.js`];
        console.log('[runner] starting Vite dev server');
        await run('node', [`${RUNNER}/node_modules/vite/bin/vite.js`, '--host', '0.0.0.0', '--port', PORT, ...cfgArgs]);
    }

    console.log('[runner] dev server exited');
    process.exit(0);
})();
