/**
 * Browser Provider — a thin Playwright client over a REMOTE Chromium.
 *
 * The server image no longer bakes in a Chromium binary. Instead, all in-process
 * browser work (PDF export, webpage thumbnails, SPA URL ingestion, and the
 * Tests Studio host-mode fallback) is driven against a long-lived, network-
 * isolated browser container that `pwtRunner.ensureBrowserSingleton()` manages
 * (or an external Playwright server via BROWSER_WS_ENDPOINT).
 *
 * Connection discipline (this is the whole point of the module):
 *   • We hold ONE persistent `chromium.connect()` for the process (`_conn`).
 *   • Each unit of work runs in its own `browser.newContext()` and only the
 *     CONTEXT is closed afterwards.
 *   • We NEVER call `browser.close()` during normal operation — on a
 *     `launchServer` host that would tear down the shared browser for everyone.
 *     Callers therefore never see a raw Browser; they get a context (via
 *     `withContext`) or a context they must close themselves (`newSharedContext`).
 *   • If the connection drops (singleton crashed / respawned), the next call
 *     transparently reconnects (and respawns the container via pwtRunner).
 *
 * Contexts are fully isolated (separate storage/cookies) and cheap, so a single
 * shared browser comfortably serves the low-volume export/thumbnail/ingest load.
 */

const pwtRunner = require('./pwtRunner');

const CONNECT_TIMEOUT_MS = parseInt(process.env.BROWSER_CONNECT_TIMEOUT_MS || '30000', 10);
// Dev-only escape hatch: launch a browser in-process when no remote backend is
// reachable. Requires a locally-installed browser (absent from the slim image),
// so this is OFF in production and only useful for native `npm start` dev runs.
const ALLOW_LOCAL = process.env.BROWSER_ALLOW_LOCAL_LAUNCH === 'true';
const LOCAL_LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'];

let _conn = null;          // persistent connected (or locally-launched) Browser
let _connecting = null;    // in-flight connect promise (dedupes concurrent first use)

function chromium() {
    return require('playwright').chromium;
}

async function establish() {
    let endpoint = null;
    try {
        endpoint = await pwtRunner.getBrowserEndpoint();
    } catch (err) {
        if (!ALLOW_LOCAL) {
            throw new Error(
                `Browser backend unavailable (${err.message}). Start Docker so the server can launch the `
                + `shared browser container, or set BROWSER_WS_ENDPOINT to a reachable Playwright server. `
                + `For native dev, install a local browser and set BROWSER_ALLOW_LOCAL_LAUNCH=true.`
            );
        }
        endpoint = null; // fall through to dev-only local launch
    }

    let browser;
    if (endpoint) {
        browser = await chromium().connect(endpoint, { timeout: CONNECT_TIMEOUT_MS });
    } else {
        browser = await chromium().launch({ headless: true, args: LOCAL_LAUNCH_ARGS });
    }
    // Drop the cached handle the moment the remote browser goes away so the next
    // call reconnects/respawns instead of throwing on a dead socket.
    browser.on('disconnected', () => { if (_conn === browser) _conn = null; });
    return browser;
}

async function getConnection() {
    if (_conn && _conn.isConnected()) return _conn;
    if (_connecting) return _connecting;
    _connecting = establish()
        .then((b) => { _conn = b; return b; })
        .finally(() => { _connecting = null; });
    return _connecting;
}

/**
 * Create a context, retrying ONCE through a fresh connection if the persistent
 * one turns out to be dead (the failure surfaces here, on newContext). The retry
 * deliberately wraps only connection + context creation — never the caller's
 * work — so a bug in the caller is not re-run.
 */
async function newContextWithRetry(contextOptions) {
    try {
        const browser = await getConnection();
        return await browser.newContext(contextOptions || {});
    } catch (err) {
        _conn = null; // assume the connection is gone; force a clean reconnect
        const browser = await getConnection();
        return await browser.newContext(contextOptions || {});
    }
}

/**
 * Run `fn(context)` against an isolated context on the shared browser, then
 * close the context. The shared browser/connection is left intact.
 *
 * @param {object} contextOptions  passed to browser.newContext (viewport,
 *                                 userAgent, deviceScaleFactor, …) — all work
 *                                 over connect().
 * @param {(context: import('playwright').BrowserContext) => Promise<any>} fn
 */
async function withContext(contextOptions, fn) {
    const context = await newContextWithRetry(contextOptions);
    try {
        return await fn(context);
    } finally {
        try { await context.close(); } catch (_) { /* ignore */ }
    }
}

/**
 * Hand back an isolated context the CALLER owns. The caller MUST
 * `await context.close()` when done and MUST NOT close the browser. Used by the
 * Tests Studio host-mode fallback, whose explore/agent loops manage their own
 * page/context lifecycle.
 */
async function newSharedContext(contextOptions) {
    return newContextWithRetry(contextOptions);
}

/** Pass-through to the underlying remote ws endpoint (rarely needed directly). */
async function getBrowserEndpoint() {
    return pwtRunner.getBrowserEndpoint();
}

/** Tear down the persistent connection (e.g. on process shutdown). */
async function close() {
    const b = _conn;
    _conn = null;
    if (b) { try { await b.close(); } catch (_) { /* ignore */ } }
}

module.exports = { withContext, newSharedContext, getBrowserEndpoint, close };
