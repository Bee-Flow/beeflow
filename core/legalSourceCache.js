/**
 * Legal source cache — a tiny per-process TTL cache for citation verification.
 *
 * The verifier re-hits the same ECLI/CELEX many times (per draft, across verify
 * passes, across matters). A 24h in-memory cache keyed by the citation token
 * avoids hammering the public gov endpoints. Plain Map + TTL, no Redis — the
 * data is public and cheap to re-fetch, so a cold process just repopulates.
 *
 * Only STABLE outcomes should be cached by callers (a confirmed hit or a
 * definitive not-found). Transient failures must NOT be cached, or a momentary
 * upstream blip would mark a real citation unverified for 24h.
 */

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

const store = new Map(); // key -> { value, expires }

function get(key) {
    const e = store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) { store.delete(key); return undefined; }
    return e.value;
}

function set(key, value, ttl = DEFAULT_TTL_MS) {
    // FIFO eviction once full — Map preserves insertion order.
    if (store.size >= MAX_ENTRIES && !store.has(key)) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { value, expires: Date.now() + ttl });
    return value;
}

function clear() { store.clear(); }

module.exports = { get, set, clear };
