/**
 * Shared helpers for lead-enrichment providers.
 * All providers hit fixed vendor base URLs (no arbitrary/user-supplied hosts),
 * so there is no SSRF surface here — only timeouts + cancellation handling.
 */

const DEFAULT_TIMEOUT_MS = 15000;

/** Combine the per-company cancel signal with a per-request timeout. */
function withTimeout(ctxSignal, ms = DEFAULT_TIMEOUT_MS) {
    const timeout = AbortSignal.timeout(ms);
    if (ctxSignal && typeof AbortSignal.any === 'function') {
        return AbortSignal.any([ctxSignal, timeout]);
    }
    return ctxSignal || timeout;
}

/** GET/POST JSON with timeout + graceful failure. Returns null on any error. */
async function fetchJson(url, { method = 'GET', headers = {}, body = null, signal, timeoutMs } = {}) {
    try {
        const res = await fetch(url, {
            method,
            headers: { Accept: 'application/json', ...headers },
            body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
            signal: withTimeout(signal, timeoutMs),
        });
        if (!res.ok) return { _error: `HTTP ${res.status}`, _status: res.status };
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('json')) return { _error: 'non-json', _status: res.status };
        return await res.json();
    } catch (e) {
        return { _error: e.name === 'TimeoutError' ? 'timeout' : e.message };
    }
}

function isErr(r) { return !r || r._error; }

/** Bare registrable host of a URL/domain (no scheme, no www, no path). */
function registrableDomain(website) {
    if (!website) return '';
    let host = String(website).trim().toLowerCase();
    host = host.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return host.split(/[\/?#]/)[0];
}

module.exports = { withTimeout, fetchJson, isErr, registrableDomain, DEFAULT_TIMEOUT_MS };
