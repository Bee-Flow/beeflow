/**
 * Webpage light-tier API runtime.
 *
 * Runs a project's `api/<route>.js` handler files server-side in an isolated-vm
 * sandbox (server/automation/codeSandbox.js) — the "light tier" backend. This
 * gives react-mui / vanilla pages a real request→response backend without a
 * per-project container: handlers get the per-page SQLite, the author's granted
 * integrations (acts-as-author), and an HTTPS fetch, all behind hard limits.
 *
 * Handler contract — an `api/<route>.js` file defines:
 *     async function main(req, ctx) {
 *       // req  = { method, path, query, body }
 *       // ctx.db.query(sql, params) / ctx.db.exec(...) / ctx.db.batch(...)
 *       // ctx.integrations.<granted_tool>(args)   (acts-as-author)
 *       // ctx.http(url, opts)                       (https only)
 *       // ctx.log(...)
 *       return { status: 200, body: { ... } };       // or just return a value
 *     }
 *
 * The full tier (settings.runtime === 'full') runs these in the project's Node
 * container instead — this module is only used for the light tier.
 */

const codeSandbox = require('../automation/codeSandbox');
const webpageStore = require('../stores/webpageStore');
const webpageDbStore = require('../stores/webpageDbStore');
const { loadAuthorContext } = require('../core/webpageBridgeAuth');
const { executeTool } = require('../core/toolDispatcher');

const LIMITS = { memoryMb: 128, cpuMs: 4000, wallMs: 12000, httpBudget: 10 };

/** Normalise a request route into a safe `api/<route>.js` extra-file path. */
function handlerPathForRoute(route) {
    const clean = String(route || '')
        .replace(/\.js$/i, '')
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(seg => seg && seg !== '.' && seg !== '..')
        .map(seg => seg.replace(/[^A-Za-z0-9_\-]/g, ''))
        .filter(Boolean)
        .join('/');
    if (!clean) return null;
    return `api/${clean}.js`;
}

/**
 * Execute a light-tier api handler. Returns { status, body, headers? }.
 * `req` is the sanitised request envelope { method, path, query, body }.
 */
async function executeApiHandler({ webpageId, route, req }) {
    if (!codeSandbox.isAvailable()) {
        return { status: 503, body: { error: 'Backend runtime unavailable (isolated-vm not installed).' } };
    }

    const path = handlerPathForRoute(route);
    if (!path) return { status: 404, body: { error: 'No api route specified.' } };

    // Acts-as-author: load the page owner's context so the handler reaches the
    // author's DB + granted integrations (never the viewer's).
    const ctx = await loadAuthorContext(webpageId);
    if (!ctx) return { status: 404, body: { error: 'Webpage not found.' } };

    const file = await webpageStore.readExtraFile({ webpageId, userId: ctx.authorUserId, path });
    if (!file || !file.meta?.isText) {
        return { status: 404, body: { error: `No handler at ${path}. Create it with an exported main(req, ctx).` } };
    }

    // Only the author's GRANTED integrations are callable (same allowlist the AI
    // bridge uses), with pinned fixedArgs merged in server-side.
    const grantByTool = new Map();
    for (const g of (ctx.bridgeGrants?.integrations || [])) grantByTool.set(g.tool, g);

    const bridges = {
        allowedTools: new Set(grantByTool.keys()),
        executeTool: async (toolName, args) => {
            const grant = grantByTool.get(toolName);
            if (!grant) return { error: `Tool "${toolName}" is not granted to this page.` };
            const merged = { ...(args || {}), ...(grant.fixedArgs || {}) };
            return executeTool(toolName, merged, {
                userId: ctx.authorUserId,
                session: ctx.authorSession,
                orgId: ctx.authorOrgId,
                autoSend: true,
            });
        },
        db: async (op, a) => {
            if (op === 'query') return webpageDbStore.query(ctx.authorUserId, webpageId, a.sql, a.params || []);
            if (op === 'exec') return webpageDbStore.exec(ctx.authorUserId, webpageId, a.sql, a.params || []);
            if (op === 'batch') return webpageDbStore.batch(ctx.authorUserId, webpageId, a.statements || []);
            return { error: `unknown db op "${op}"` };
        },
        fetchHttp: codeSandbox.defaultFetchHttp,
        secrets: {},
    };

    let runResult;
    try {
        runResult = await codeSandbox.runCode({ code: file.text, inputs: req, limits: LIMITS, bridges });
    } catch (err) {
        return { status: 500, body: { error: err.message || 'Handler execution failed.' } };
    }

    // Normalise the handler's return value into an HTTP-shaped response.
    const r = runResult.result;
    if (r && typeof r === 'object' && !Array.isArray(r) && ('body' in r || 'status' in r)) {
        return {
            status: Number.isInteger(r.status) ? r.status : 200,
            body: r.body !== undefined ? r.body : null,
            headers: (r.headers && typeof r.headers === 'object') ? r.headers : undefined,
        };
    }
    return { status: 200, body: r ?? null };
}

module.exports = { executeApiHandler, handlerPathForRoute };
