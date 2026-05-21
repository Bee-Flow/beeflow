/**
 * Smoke test — /api/tests/runs rejects internal-network target URLs.
 *
 * We don't boot Express or the DB; we exercise the worker's SSRF predicate
 * directly because the route reuses `testRunner.isPrivateTarget()`. A full
 * Express integration test is out of scope for the beta — see the plan
 * file's "Verification" section for the manual smoke.
 *
 * Run: node server/routes/tests.ssrf.test.js
 */

const assert = require('assert');

// Same stub trick as testRunner.test.js — keep the worker's `require()`s
// from touching the DB.
require.cache[require.resolve('../stores/testRunStore')] = {
    exports: {
        appendProgress: async () => {},
        markFinished: async () => true,
        markRunning: async () => true,
        markRetryable: async () => {},
        claimDueJobs: async () => [],
    },
};
require.cache[require.resolve('../stores/testSuiteStore')] = {
    exports: { getSuite: async () => null, updateSuite: async () => true },
};

const { isPrivateTarget } = require('../workers/testRunner');

const TABLE = [
    // [url, expected_block]
    ['http://localhost', true],
    ['http://127.0.0.1:3000', true],
    ['http://192.168.1.42', true],
    ['http://10.1.1.1', true],
    ['http://172.20.0.1', true],
    ['http://169.254.169.254/latest/meta-data', true],
    ['http://[::1]', true],
    ['file:///etc/passwd', true],
    ['javascript:alert(1)', true],
    ['https://example.com', false],
    ['https://172.32.0.1', false],     // outside 172.16-31
    ['http://1.2.3.4', false],
];

for (const [url, expected] of TABLE) {
    const got = isPrivateTarget(url);
    assert.strictEqual(got, expected, `SSRF check for ${url}: expected ${expected} got ${got}`);
}

console.log('✓ server/routes/tests.ssrf.test.js — all assertions passed');
