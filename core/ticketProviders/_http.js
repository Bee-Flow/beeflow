/**
 * Shared HTTP helpers for ticket source providers.
 *
 * - `httpJson(url, opts)` — fetch + JSON parse + uniform error shape
 * - `basicAuth(user, pass)` — build the Authorization header value
 * - `classifyError(err)` — produce an error with `status`, `retryable`,
 *   `retryAfterMs` hints for the sync engine's backoff loop.
 *
 * All providers use these so rate-limit handling + logging are consistent.
 */

function basicAuth(user, pass) {
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function parseRetryAfter(res) {
    const h = res.headers?.get?.('retry-after');
    if (!h) return null;
    const asSeconds = parseInt(String(h), 10);
    if (!Number.isNaN(asSeconds) && asSeconds >= 0) return Math.min(60_000, asSeconds * 1000);
    const asDate = Date.parse(String(h));
    if (!Number.isNaN(asDate)) return Math.max(0, Math.min(60_000, asDate - Date.now()));
    return null;
}

async function httpJson(url, opts = {}) {
    const { headers = {}, method = 'GET', body, timeoutMs = 30_000, ...rest } = opts;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url, {
            method,
            headers: { 'Accept': 'application/json', ...headers },
            body,
            signal: ctrl.signal,
            ...rest,
        });
    } catch (err) {
        const e = new Error(`Network error: ${err.message}`);
        e.retryable = true;
        e.cause = err;
        throw e;
    } finally {
        clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) {
        const text = await res.text().catch(() => '');
        const e = new Error(`Auth failed (${res.status}) at ${url}: ${text.slice(0, 400)}`);
        e.status = res.status;
        e.needsReauth = true;
        throw e;
    }
    if (res.status === 429) {
        const e = new Error(`Rate limited at ${url}`);
        e.status = 429;
        e.retryable = true;
        e.retryAfterMs = parseRetryAfter(res);
        throw e;
    }
    if (res.status >= 500) {
        const e = new Error(`Server error ${res.status} at ${url}`);
        e.status = res.status;
        e.retryable = true;
        throw e;
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const e = new Error(`HTTP ${res.status} at ${url}: ${text.slice(0, 400)}`);
        e.status = res.status;
        throw e;
    }

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
        return res.json();
    }
    return res.text();
}

/**
 * Small helper for paginated generators. Keeps per-provider listTickets
 * implementations focused on one page's logic.
 */
async function* paginate(pageFn, { maxPages = 200 } = {}) {
    let cursor = undefined;
    for (let i = 0; i < maxPages; i++) {
        const { items, next } = await pageFn(cursor);
        for (const item of items) yield item;
        if (!next) return;
        cursor = next;
    }
}

module.exports = {
    httpJson,
    basicAuth,
    paginate,
    parseRetryAfter,
};
