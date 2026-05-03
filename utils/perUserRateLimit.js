// Lightweight per-user sliding-window rate limiter for LLM-backed endpoints.
// Avoids pulling in express-rate-limit as an explicit dep (it's only present
// transitively today). In-memory only — fine for single-instance deployments;
// for horizontally-scaled deploys this should move to Redis.
//
// Usage:
//   const limiter = perUserRateLimit({ windowMs: 60_000, max: 30 });
//   router.post('/path', limiter, handler);

function perUserRateLimit({ windowMs, max, keyFn }) {
    const buckets = new Map(); // userId → array of recent request timestamps (ms)

    // Periodic cleanup so a quiet user's bucket doesn't sit forever.
    const sweep = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [k, arr] of buckets) {
            const filtered = arr.filter(t => t > cutoff);
            if (filtered.length === 0) buckets.delete(k);
            else if (filtered.length !== arr.length) buckets.set(k, filtered);
        }
    }, Math.max(60_000, windowMs));
    if (sweep.unref) sweep.unref();

    return function rateLimitMiddleware(req, res, next) {
        const key = (typeof keyFn === 'function' ? keyFn(req) : null)
            || req.session?.user?.id
            || req.ip
            || 'anon';
        const now = Date.now();
        const cutoff = now - windowMs;
        const arr = (buckets.get(key) || []).filter(t => t > cutoff);
        if (arr.length >= max) {
            const retryAfter = Math.ceil((arr[0] + windowMs - now) / 1000);
            res.set('Retry-After', String(Math.max(1, retryAfter)));
            return res.status(429).json({
                error: `Too many requests — limit is ${max} per ${Math.round(windowMs / 1000)}s. Retry in ~${retryAfter}s.`,
            });
        }
        arr.push(now);
        buckets.set(key, arr);
        next();
    };
}

module.exports = { perUserRateLimit };
