/**
 * Unit tests for the TTL cache.
 * Run: node utils/ttlCache.test.js
 */

const assert = require('assert');
const { createTtlCache } = require('./ttlCache');

(async () => {
    // ── basic set/get ─────────────────────────────────────────────────
    {
        let t = 1000;
        const c = createTtlCache({ ttlMs: 100, now: () => t });
        assert.strictEqual(c.get('a'), undefined, 'miss → undefined');
        c.set('a', 42);
        assert.strictEqual(c.get('a'), 42);
        assert.strictEqual(c.size, 1);
    }

    // ── expiry ────────────────────────────────────────────────────────
    {
        let t = 0;
        const c = createTtlCache({ ttlMs: 100, now: () => t });
        c.set('k', 'v');
        t = 99;
        assert.strictEqual(c.get('k'), 'v', 'still fresh before ttl');
        t = 100;
        assert.strictEqual(c.get('k'), undefined, 'expired exactly at ttl');
        assert.strictEqual(c.size, 0, 'expired entry evicted on read');
    }

    // ── size cap evicts oldest ────────────────────────────────────────
    {
        let t = 0;
        const c = createTtlCache({ ttlMs: 10000, max: 2, now: () => t });
        c.set('a', 1); c.set('b', 2);
        c.set('c', 3); // evicts 'a'
        assert.strictEqual(c.get('a'), undefined, 'oldest evicted');
        assert.strictEqual(c.get('b'), 2);
        assert.strictEqual(c.get('c'), 3);
        assert.strictEqual(c.size, 2);
    }

    // ── re-set refreshes recency ──────────────────────────────────────
    {
        let t = 0;
        const c = createTtlCache({ ttlMs: 10000, max: 2, now: () => t });
        c.set('a', 1); c.set('b', 2);
        c.set('a', 11);  // 'a' becomes newest
        c.set('c', 3);   // evicts 'b' (now oldest), not 'a'
        assert.strictEqual(c.get('a'), 11);
        assert.strictEqual(c.get('b'), undefined);
        assert.strictEqual(c.get('c'), 3);
    }

    // ── del / clear ───────────────────────────────────────────────────
    {
        const c = createTtlCache({ ttlMs: 1000 });
        c.set('x', 1);
        assert.strictEqual(c.del('x'), true);
        assert.strictEqual(c.get('x'), undefined);
        c.set('y', 1); c.set('z', 2);
        c.clear();
        assert.strictEqual(c.size, 0);
    }

    console.log('ttlCache.test.js: all tests passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
