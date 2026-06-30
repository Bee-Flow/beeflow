const test = require('node:test');
const assert = require('node:assert');

const A = require('./securityAggression');

test('LEVELS are ordered recon < passive < active < offensive', () => {
    assert.deepStrictEqual(A.LEVELS, ['recon', 'passive', 'active', 'offensive']);
    assert.ok(A.rank('recon') < A.rank('passive'));
    assert.ok(A.rank('passive') < A.rank('active'));
    assert.ok(A.rank('active') < A.rank('offensive'));
});

test('isValid accepts known levels, rejects junk', () => {
    assert.ok(A.isValid('active'));
    assert.ok(A.isValid('OFFENSIVE')); // case-insensitive
    assert.ok(!A.isValid('nuke'));
    assert.ok(!A.isValid(''));
    assert.ok(!A.isValid(null));
});

test('atLeast compares levels correctly', () => {
    assert.ok(A.atLeast('active', 'active'));
    assert.ok(A.atLeast('offensive', 'active'));
    assert.ok(!A.atLeast('passive', 'active'));
    assert.ok(!A.atLeast('recon', 'passive'));
});

test('clamp limits a requested level to the ceiling', () => {
    const prev = process.env.SECURITY_MAX_AGGRESSION;
    try {
        process.env.SECURITY_MAX_AGGRESSION = 'active';
        assert.strictEqual(A.clamp('offensive'), 'active'); // clamped down
        assert.strictEqual(A.clamp('passive'), 'passive');  // below ceiling, unchanged
        assert.strictEqual(A.clamp('garbage'), A.DEFAULT_AGGRESSION); // invalid -> default
        assert.ok(A.rank(A.clamp('garbage')) <= A.rank('active'));

        process.env.SECURITY_MAX_AGGRESSION = 'offensive';
        assert.strictEqual(A.clamp('offensive'), 'offensive');

        delete process.env.SECURITY_MAX_AGGRESSION;
        assert.strictEqual(A.ceiling(), 'offensive'); // default ceiling
    } finally {
        if (prev === undefined) delete process.env.SECURITY_MAX_AGGRESSION;
        else process.env.SECURITY_MAX_AGGRESSION = prev;
    }
});
