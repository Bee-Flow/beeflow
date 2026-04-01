/**
 * Redis Session Cache — write-through cache layer over connect-pg-simple
 *
 * Strategy:
 *   READ  → check Redis first (cache hit: ~0.3ms, no DB)
 *           on miss → delegate to pgStore → write result back to Redis
 *   WRITE → write to pgStore (durable) + set Redis key with TTL
 *   TOUCH → extend TTL in both stores
 *   DESTROY → delete from both stores
 *
 * PostgreSQL remains the **source of truth** and sessions survive Redis
 * restarts / container wipes. Redis is a pure performance overlay — if it
 * is down, every method falls back transparently to the pgStore.
 *
 * Usage:
 *   const { wrapWithRedisCache } = require('./auth/sessionCache');
 *   sessionStore = wrapWithRedisCache(pgStore, redisClient);
 */

const CACHE_PREFIX = 'bf:sess:';
const CACHE_TTL_SECONDS = 15 * 60; // 15 min — same order as session prune interval

/**
 * Wrap a connect-pg-simple store with a Redis read-through cache.
 *
 * @param {object} pgStore    - Instance of connect-pg-simple
 * @param {object} redis      - ioredis or node-redis client (already connected)
 * @returns {object}          - A drop-in session store replacement
 */
function wrapWithRedisCache(pgStore, redis) {
    // If Redis is not available return the pgStore unwrapped
    if (!redis) return pgStore;

    const key = (sid) => `${CACHE_PREFIX}${sid}`;

    // IMPORTANT: Save references to the original PG methods BEFORE wrapping.
    // When the caller patches sessionStore.set = cached.set and sessionStore
    // IS the same object as pgStore, we'd get infinite recursion if we called
    // pgStore.set inside the wrapper. These bound copies are immune to that.
    const _pgGet     = pgStore.get.bind(pgStore);
    const _pgSet     = pgStore.set.bind(pgStore);
    const _pgTouch   = pgStore.touch ? pgStore.touch.bind(pgStore) : null;
    const _pgDestroy = pgStore.destroy.bind(pgStore);


    // ── helpers ─────────────────────────────────────────────────────────────────

    async function cacheGet(sid) {
        try {
            const raw = await redis.get(key(sid));
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            // Redis upset — degrade gracefully, fall through to PG
            console.warn('[SessionCache] Redis GET error:', e.message);
            return null;
        }
    }

    async function cacheSet(sid, session, ttl) {
        try {
            const t = ttl || CACHE_TTL_SECONDS;
            await redis.set(key(sid), JSON.stringify(session), 'EX', t);
        } catch (e) {
            console.warn('[SessionCache] Redis SET error:', e.message);
        }
    }

    async function cacheDel(sid) {
        try {
            await redis.del(key(sid));
        } catch (e) {
            console.warn('[SessionCache] Redis DEL error:', e.message);
        }
    }

    function ttlFromSession(session) {
        if (session?.cookie?.expires) {
            const ms = new Date(session.cookie.expires) - Date.now();
            if (ms > 0) return Math.min(Math.floor(ms / 1000), CACHE_TTL_SECONDS);
        }
        return CACHE_TTL_SECONDS;
    }

    // ── Cached store ─────────────────────────────────────────────────────────────

    const cachedStore = Object.create(pgStore);

    /**
     * GET — check Redis first, fall back to PG, write back on miss
     */
    cachedStore.get = function (sid, cb) {
        cacheGet(sid).then(cached => {
            if (cached) {
                return cb(null, cached);
            }
            // Cache miss → go to PG
            _pgGet(sid, (err, session) => {
                if (err || !session) return cb(err, session);
                // Write back to Redis so next request is a cache hit
                cacheSet(sid, session, ttlFromSession(session));
                cb(null, session);
            });
        }).catch(err => {
            // Redis completely failed — fall straight to PG
            _pgGet(sid, cb);
        });
    };

    /**
     * SET — write to PG (durable), then update Redis cache
     */
    cachedStore.set = function (sid, session, cb) {
        _pgSet(sid, session, (err) => {
            if (!err) {
                // Best-effort Redis write — don't block the response on failure
                cacheSet(sid, session, ttlFromSession(session));
            }
            cb(err);
        });
    };

    /**
     * TOUCH — extend expiry in both stores
     */
    cachedStore.touch = function (sid, session, cb) {
        if (!_pgTouch) { if (cb) cb(); return; }
        _pgTouch(sid, session, (err) => {
            if (!err) {
                cacheSet(sid, session, ttlFromSession(session));
            }
            if (cb) cb(err);
        });
    };

    /**
     * DESTROY — delete from Redis first (fast), then from PG
     */
    cachedStore.destroy = function (sid, cb) {
        _pgDestroy(sid, (err) => {
            cacheDel(sid); // best-effort, don't wait
            if (cb) cb(err);
        });
    };

    console.log('[SessionCache] Redis session cache layer active (TTL:', CACHE_TTL_SECONDS, 's)');
    return cachedStore;
}

module.exports = { wrapWithRedisCache };
