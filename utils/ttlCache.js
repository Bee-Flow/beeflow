/**
 * ttlCache.js — tiny in-memory TTL cache with a size cap.
 *
 * Used to throttle outbound calls to the public MCP registry so repeated
 * marketplace searches don't hammer the upstream. Lazy expiry on read +
 * insertion-order ("oldest") eviction when the cap is hit. Not LRU — good
 * enough for short-TTL proxy caching.
 *
 *   const cache = createTtlCache({ ttlMs: 5 * 60 * 1000, max: 200 });
 *   cache.set('k', value);
 *   cache.get('k'); // value | undefined (after ttl)
 *
 * `now` is injectable for deterministic tests.
 */
function createTtlCache({ ttlMs = 5 * 60 * 1000, max = 500, now = Date.now } = {}) {
    const store = new Map();

    function get(key) {
        const entry = store.get(key);
        if (!entry) return undefined;
        if (entry.expires <= now()) {
            store.delete(key);
            return undefined;
        }
        return entry.value;
    }

    function set(key, value) {
        // Re-insert so the key moves to the newest position.
        store.delete(key);
        if (store.size >= max) {
            const oldest = store.keys().next().value;
            if (oldest !== undefined) store.delete(oldest);
        }
        store.set(key, { value, expires: now() + ttlMs });
        return value;
    }

    function del(key) { return store.delete(key); }
    function clear() { store.clear(); }

    return {
        get,
        set,
        del,
        clear,
        get size() { return store.size; },
    };
}

module.exports = { createTtlCache };
