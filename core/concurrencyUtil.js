/**
 * Bounded-concurrency parallel mapper.
 *
 * Runs `fn(item)` for each item in `items`, with at most `concurrency` calls
 * in flight at any time. Resolves to an array of results in input order.
 *
 * Used by: ticketAssistantProcessor (per-email pipeline), swarmRuntime
 * (per-phase worker pool).
 */
async function mapWithConcurrency(items, concurrency, fn) {
    const list = Array.isArray(items) ? items : [];
    const out = new Array(list.length);
    let cursor = 0;
    const cap = Math.max(1, Math.min(concurrency || 1, list.length));
    const worker = async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= list.length) return;
            out[idx] = await fn(list[idx], idx);
        }
    };
    const workers = Array.from({ length: cap }, () => worker());
    await Promise.all(workers);
    return out;
}

module.exports = { mapWithConcurrency };
