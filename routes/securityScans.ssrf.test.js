/**
 * Smoke test — /api/security/scans rejects internal-network target URLs.
 *
 * We don't boot Express or the DB; we exercise the SSRF predicate directly
 * because the scan route reuses the worker's `isPrivateTarget()`, which the
 * scan worker re-exports from the Playwright test worker (single source of
 * truth for the private-address blocklist). A full Express integration test is
 * out of scope for the beta — see the plan file's "Verification" section for
 * the manual smoke.
 *
 * Run: node server/routes/securityScans.ssrf.test.js
 */

const assert = require('assert');

// Keep the worker's require()s from touching the DB. The scan worker requires
// ../stores/securityScanStore and ./testRunner (which pulls in the test
// stores); stub them all so requiring the worker stays side-effect free.
require.cache[require.resolve('../stores/securityScanStore')] = {
    exports: {
        appendProgress: async () => {},
        markFinished: async () => true,
        markRunning: async () => true,
        markRetryable: async () => {},
        markCancelled: async () => ({ ok: true }),
        isCancelRequested: () => false,
        getScan: async () => null,
        claimDueJobs: async () => [],
    },
};
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

const { isPrivateTarget } = require('../workers/scanRunner');

const TABLE = [
    // [url, expected_block]
    ['http://localhost', true],
    ['http://127.0.0.1:3000', true],
    ['http://192.168.1.42', true],
    ['http://10.1.1.1', true],
    ['http://172.20.0.1', true],
    ['http://169.254.169.254/latest/meta-data', true],   // cloud metadata endpoint
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

console.log('✓ server/routes/securityScans.ssrf.test.js — all assertions passed');
