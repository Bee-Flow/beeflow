/**
 * Email KB metrics — lightweight in-memory counters and histograms.
 *
 * No external dependency (prom-client is not installed). If/when it is,
 * swap the internals behind the same public API without changing callers.
 *
 * Metrics exposed:
 *   - email_kb_emails_ingested_total        { provider, connectionId }
 *   - email_kb_emails_skipped_total         { provider, connectionId, reason }
 *   - email_kb_emails_failed_total          { provider, connectionId, stage }
 *   - email_kb_api_retries_total            { provider, code }
 *   - email_kb_sync_duration_seconds_sum    { provider }
 *   - email_kb_sync_duration_seconds_count  { provider }
 *
 * Cost attribution is piggybacked via `recordCost(connectionId, usd)` —
 * sums into per-connection rolling 30-day totals so the UI can show
 * "last-30d cost" on each ConnectionCard.
 */

const counters = new Map();
const durationSum = new Map();   // provider → seconds
const durationCount = new Map(); // provider → count
const connectionCost = new Map(); // connectionId → [{ts, usd}]

function labelKey(labels) {
    return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('|');
}

function inc(metricName, labels, delta = 1) {
    const key = `${metricName}::${labelKey(labels || {})}`;
    counters.set(key, (counters.get(key) || 0) + delta);
}

function recordSyncDuration(provider, seconds) {
    durationSum.set(provider, (durationSum.get(provider) || 0) + seconds);
    durationCount.set(provider, (durationCount.get(provider) || 0) + 1);
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function recordCost(connectionId, usd) {
    if (!connectionId || !Number.isFinite(usd)) return;
    const arr = connectionCost.get(connectionId) || [];
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const pruned = arr.filter(e => e.ts >= cutoff);
    pruned.push({ ts: Date.now(), usd });
    connectionCost.set(connectionId, pruned);
}

function getCost30d(connectionId) {
    const arr = connectionCost.get(connectionId) || [];
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    return arr.filter(e => e.ts >= cutoff).reduce((sum, e) => sum + e.usd, 0);
}

/**
 * Emit a Prometheus-style textual dump for all currently-tracked metrics.
 * Safe to mount behind an admin endpoint.
 */
function renderTextFormat() {
    const lines = [];
    for (const [key, value] of counters) {
        const [name, labelStr] = key.split('::');
        const labelFmt = labelStr ? `{${labelStr.split('|').map(p => p.replace('=', '="') + '"').join(',')}}` : '';
        lines.push(`${name}${labelFmt} ${value}`);
    }
    for (const [provider, sum] of durationSum) {
        lines.push(`email_kb_sync_duration_seconds_sum{provider="${provider}"} ${sum}`);
    }
    for (const [provider, count] of durationCount) {
        lines.push(`email_kb_sync_duration_seconds_count{provider="${provider}"} ${count}`);
    }
    for (const [connectionId, arr] of connectionCost) {
        const total = arr.reduce((s, e) => s + e.usd, 0);
        lines.push(`email_kb_cost_usd_total{connectionId="${connectionId}"} ${total}`);
    }
    return lines.join('\n');
}

function snapshot() {
    return {
        counters: Object.fromEntries(counters),
        durationSum: Object.fromEntries(durationSum),
        durationCount: Object.fromEntries(durationCount),
        connectionCosts: Object.fromEntries(
            Array.from(connectionCost.entries()).map(([id, arr]) => [id, arr.reduce((s, e) => s + e.usd, 0)])
        ),
    };
}

module.exports = {
    inc,
    recordSyncDuration,
    recordCost,
    getCost30d,
    renderTextFormat,
    snapshot,
};
