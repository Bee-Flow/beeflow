/**
 * Sandboxed JavaScript execution for automation `code` steps.
 *
 * Uses `isolated-vm` (V8 isolate) — separate heap, no Node bindings, no
 * filesystem, no raw network. Host bridges expose:
 *   - inputs            : the resolved step inputs
 *   - ctx.log(...)      : captured per-run, surfaced in run-step output
 *   - ctx.http(url, opts): HTTPS-only fetch proxy with hard limits
 *   - ctx.integrations.<tool>(args) : proxy to toolDispatcher.executeTool
 *   - ctx.secrets(name) : returns only secrets explicitly listed in step.inputs.secretKeys
 *
 * Limits per call:
 *   memoryMb : default 64
 *   cpuMs    : default 1000  (V8 timeout)
 *   wallMs   : default 5000  (host-side Promise.race)
 *
 * Gated behind feature flag `automation_code_step_enabled`. If isolated-vm
 * is not installed, the runner refuses to execute code steps with a clear
 * error rather than crashing on require().
 */

let ivm = null;
let ivmLoadError = null;
try {
    // eslint-disable-next-line global-require
    ivm = require('isolated-vm');
} catch (e) {
    ivmLoadError = e;
    // The runner reads `isAvailable()` before calling runCode().
}

function isAvailable() { return ivm != null; }
function loadError() { return ivmLoadError ? ivmLoadError.message : null; }

const DEFAULT_LIMITS = { memoryMb: 64, cpuMs: 1000, wallMs: 5000 };
const HTTP_BUDGET_DEFAULT = 5;
const HTTP_RESPONSE_CAP = 1024 * 1024; // 1MB

/**
 * Run user-provided JS in the sandbox.
 *
 * @param {object} options
 * @param {string} options.code        Source. May be a single expression,
 *                                     a top-level await block, or a function
 *                                     definition `function main(inputs, ctx)`.
 * @param {object} options.inputs      Resolved inputs (already free of secrets unless declared).
 * @param {object} options.limits      Optional resource limits.
 * @param {object} options.bridges
 *   bridges.executeTool(toolName, args)  → resolves a tool call (host-side toolDispatcher).
 *   bridges.allowedTools                 Set<string> of tool names the step may call.
 *   bridges.fetchHttp(url, opts)         HTTPS fetch helper (host-side).
 *   bridges.secrets                      object — secrets the step explicitly bound.
 *
 * @returns {Promise<{ result, logs, http: { calls } }>}
 */
async function runCode({ code, inputs = {}, limits = {}, bridges = {} } = {}) {
    if (!isAvailable()) {
        const msg = loadError() || 'isolated-vm not installed';
        throw new Error(`Code step disabled: ${msg}`);
    }
    const lim = { ...DEFAULT_LIMITS, ...limits };
    const logs = [];
    let httpCalls = 0;
    const httpBudget = Number.isFinite(lim.httpBudget) ? lim.httpBudget : HTTP_BUDGET_DEFAULT;

    const isolate = new ivm.Isolate({ memoryLimit: lim.memoryMb });
    const context = await isolate.createContext();
    const jail = context.global;

    await jail.set('global', jail.derefInto());
    await jail.set('inputs', new ivm.ExternalCopy(inputs).copyInto({ release: true }));

    // Host bridge: ctx (Reference into a host object)
    const allowed = bridges.allowedTools instanceof Set ? bridges.allowedTools : null;

    const ctxHost = {
        log: (...args) => {
            try { logs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')); } catch {}
        },
        // Returns a JSON-serialisable result.
        callTool: async (toolName, argsJson) => {
            if (typeof bridges.executeTool !== 'function') return { error: 'no executeTool bridge' };
            if (allowed && !allowed.has(toolName)) return { error: `tool "${toolName}" not allowed for this step` };
            let argsObj = {};
            try { argsObj = argsJson ? JSON.parse(argsJson) : {}; } catch { return { error: 'invalid tool args' }; }
            try {
                const r = await bridges.executeTool(toolName, argsObj);
                return r;
            } catch (e) {
                return { error: e.message || String(e) };
            }
        },
        http: async (url, optsJson) => {
            if (typeof bridges.fetchHttp !== 'function') return { error: 'no http bridge' };
            if (httpCalls >= httpBudget) return { error: `http call budget exceeded (${httpBudget})` };
            httpCalls++;
            let opts = {};
            try { opts = optsJson ? JSON.parse(optsJson) : {}; } catch { return { error: 'invalid http opts' }; }
            try {
                const r = await bridges.fetchHttp(url, opts, { responseCap: HTTP_RESPONSE_CAP, timeoutMs: 10_000 });
                return r;
            } catch (e) {
                return { error: e.message || String(e) };
            }
        },
        secret: (name) => {
            if (!bridges.secrets || typeof name !== 'string') return null;
            return bridges.secrets[name] ?? null;
        },
    };

    // Expose host-async functions inside the isolate. We wrap each as a
    // Reference; inside the sandbox we re-wrap them as async functions
    // that await applyIgnored/apply with their args serialised to JSON
    // (only JSON-friendly types cross the boundary).
    await jail.set('__hostCallTool', new ivm.Reference(ctxHost.callTool));
    await jail.set('__hostHttp', new ivm.Reference(ctxHost.http));
    await jail.set('__hostSecret', new ivm.Reference(ctxHost.secret));
    await jail.set('__hostLog', new ivm.Reference(ctxHost.log));

    // Bootstrapping JS that constructs the in-isolate ctx surface and
    // wraps the user code into an async IIFE.
    const bootstrap = `
        const ctx = {
            log: (...args) => __hostLog.applyIgnored(undefined, args.map(a => typeof a === 'string' ? a : JSON.stringify(a))),
            secrets: (name) => __hostSecret.applySync(undefined, [name]),
            integrations: new Proxy({}, {
                get(_, toolName) {
                    return async (args) => {
                        const json = args === undefined ? '{}' : JSON.stringify(args);
                        const ref = await __hostCallTool.apply(undefined, [toolName, json], { result: { promise: true, copy: true } });
                        return ref;
                    };
                },
            }),
            http: async (url, opts) => {
                const json = opts === undefined ? '{}' : JSON.stringify(opts);
                const ref = await __hostHttp.apply(undefined, [url, json], { result: { promise: true, copy: true } });
                return ref;
            },
        };
        (async () => {
            ${code}
            if (typeof main === 'function') return await main(inputs, ctx);
            return undefined;
        })()
    `;

    const script = await isolate.compileScript(bootstrap);

    // Wall-clock guard: race the script against a host timer.
    let timedOut = false;
    const wallTimer = setTimeout(() => { timedOut = true; isolate.dispose(); }, lim.wallMs);

    let result;
    try {
        result = await script.run(context, { timeout: lim.cpuMs, promise: true, copy: true });
    } catch (e) {
        clearTimeout(wallTimer);
        if (timedOut) throw new Error(`Code step exceeded wall-clock limit (${lim.wallMs}ms)`);
        throw new Error(`Code step error: ${e.message}`);
    } finally {
        clearTimeout(wallTimer);
        try { script.release(); } catch {}
        try { context.release(); } catch {}
        try { if (!isolate.isDisposed) isolate.dispose(); } catch {}
    }

    return { result, logs, http: { calls: httpCalls } };
}

/**
 * HTTPS-only fetch helper used by ctx.http inside the sandbox. The
 * runner injects this so we keep network policy in one place.
 */
async function defaultFetchHttp(url, opts = {}, { responseCap = HTTP_RESPONSE_CAP, timeoutMs = 10_000 } = {}) {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
        return { error: 'Only https:// URLs are allowed.' };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const resp = await fetch(url, {
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
            signal: ac.signal,
        });
        const text = await resp.text();
        const truncated = text.length > responseCap ? text.slice(0, responseCap) : text;
        return {
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
            body: truncated,
            truncated: text.length > responseCap,
        };
    } catch (e) {
        return { error: e.message || String(e) };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = { runCode, isAvailable, loadError, defaultFetchHttp };
