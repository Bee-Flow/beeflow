/**
 * HTTP / DB / cache metrics — lightweight, dependency-free, same Map-counter
 * style as ticketAssistantMetrics.js. No external dependency (prom-client is
 * not installed); swap internals behind this API if/when it is.
 *
 * Mount renderTextFormat()/snapshot() behind an ADMIN-gated endpoint only —
 * route labels are templated (low cardinality) but still operational data.
 *
 * Metrics exposed:
 *   - http_requests_total{method,route,status}        (status = "2xx".."5xx")
 *   - http_request_duration_ms_sum{method,route}
 *   - http_request_duration_ms_count{method,route}
 *   - http_request_duration_ms_max{method,route}
 *   - http_requests_slow_total{method,route}          (> HTTP_SLOW_MS)
 *   - db_queries_total
 *   - db_query_duration_ms_sum / _count / _max
 *   - db_queries_slow_total                           (> DB_SLOW_MS)
 *   - cache_hits_total{cache}
 *   - cache_misses_total{cache}
 */

const HTTP_SLOW_MS = Number(process.env.HTTP_SLOW_MS || 1000);
const DB_SLOW_MS = Number(process.env.DB_SLOW_MS || 200);

const counters = new Map();   // "name::labelKey" → number
const durations = new Map();  // "name::labelKey" → { sum, count, max }

function labelKey(labels) {
    return Object.entries(labels || {}).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
}

function inc(name, labels, delta = 1) {
    const key = `${name}::${labelKey(labels)}`;
    counters.set(key, (counters.get(key) || 0) + delta);
}

function observe(name, labels, ms) {
    const key = `${name}::${labelKey(labels)}`;
    const d = durations.get(key) || { sum: 0, count: 0, max: 0 };
    d.sum += ms;
    d.count += 1;
    if (ms > d.max) d.max = ms;
    durations.set(key, d);
}

function recordHttp({ method, route, status, ms }) {
    const cls = `${Math.floor((status || 0) / 100)}xx`;
    inc('http_requests_total', { method, route, status: cls });
    observe('http_request_duration_ms', { method, route }, ms);
    if (ms > HTTP_SLOW_MS) inc('http_requests_slow_total', { method, route });
}

function recordQuery(ms) {
    inc('db_queries_total', {});
    observe('db_query_duration_ms', {}, ms);
    if (ms > DB_SLOW_MS) inc('db_queries_slow_total', {});
}

/** Record a cache lookup outcome. `cache` is a stable cache name (e.g. 'permissions'). */
function recordCache(cache, hit) {
    inc(hit ? 'cache_hits_total' : 'cache_misses_total', { cache });
}

function _fmtLabels(labelStr) {
    if (!labelStr) return '';
    return `{${labelStr.split('|').map(p => {
        const i = p.indexOf('=');
        return `${p.slice(0, i)}="${p.slice(i + 1)}"`;
    }).join(',')}}`;
}

/** Prometheus-style textual dump. Safe to mount behind an admin endpoint. */
function renderTextFormat() {
    const lines = [];
    for (const [key, value] of counters) {
        const [name, labelStr] = key.split('::');
        lines.push(`${name}${_fmtLabels(labelStr)} ${value}`);
    }
    for (const [key, d] of durations) {
        const [name, labelStr] = key.split('::');
        const l = _fmtLabels(labelStr);
        lines.push(`${name}_sum${l} ${d.sum.toFixed(1)}`);
        lines.push(`${name}_count${l} ${d.count}`);
        lines.push(`${name}_max${l} ${d.max.toFixed(1)}`);
    }
    return lines.join('\n');
}

function snapshot() {
    return {
        thresholds: { httpSlowMs: HTTP_SLOW_MS, dbSlowMs: DB_SLOW_MS },
        counters: Object.fromEntries(counters),
        durations: Object.fromEntries(durations),
    };
}

module.exports = {
    HTTP_SLOW_MS,
    DB_SLOW_MS,
    recordHttp,
    recordQuery,
    recordCache,
    renderTextFormat,
    snapshot,
};
