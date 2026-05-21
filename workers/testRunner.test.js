/**
 * Unit tests for the Playwright test-runner worker.
 *
 * Covers:
 *   - SSRF guard (isPrivateTarget) rejects loopback / RFC1918 / link-local /
 *     non-HTTP schemes / malformed URLs.
 *   - Playwright JSON reporter → json-test-report mapping.
 *
 * Run:
 *   node server/workers/testRunner.test.js
 */

const assert = require('assert');

// Avoid pulling in the testRunStore (which connects to PG on require).
// We isolate the helpers by stubbing the store module before requiring
// the worker.
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
    exports: {
        getSuite: async () => null,
        updateSuite: async () => true,
    },
};

const { isPrivateTarget, _internals } = require('./testRunner');
const { buildReportFromPlaywright, mapPlaywrightStatus, formatDuration } = _internals;

(() => {
    // ── isPrivateTarget ───────────────────────────────────────────
    const PRIVATE = [
        'http://localhost',
        'https://localhost:8080',
        'http://127.0.0.1',
        'http://127.5.5.5/path',
        'http://10.0.0.1',
        'http://10.255.255.255',
        'http://192.168.1.1',
        'http://172.16.0.1',
        'http://172.31.255.255',
        'http://169.254.169.254/latest/meta-data', // EC2 metadata
        'http://[::1]/',
        'http://[fc00::1]/',
        'http://[fe80::1]/',
        'ftp://example.com',           // wrong protocol
        'file:///etc/passwd',          // wrong protocol
        'not a url at all',
    ];
    for (const url of PRIVATE) {
        assert.strictEqual(isPrivateTarget(url), true, `must block ${url}`);
    }

    const PUBLIC = [
        'https://example.com',
        'http://example.com',
        'https://app.example.com/path?q=1',
        'http://1.1.1.1',
        'https://172.32.0.1',  // outside 172.16-31 range
        'http://172.15.0.1',
        'http://11.0.0.1',
    ];
    for (const url of PUBLIC) {
        assert.strictEqual(isPrivateTarget(url), false, `must allow ${url}`);
    }
})();

(() => {
    // ── mapPlaywrightStatus ───────────────────────────────────────
    assert.strictEqual(mapPlaywrightStatus('passed'), 'passed');
    assert.strictEqual(mapPlaywrightStatus('failed'), 'failed');
    assert.strictEqual(mapPlaywrightStatus('timedOut'), 'failed');
    assert.strictEqual(mapPlaywrightStatus('TIMEDOUT'), 'failed');
    assert.strictEqual(mapPlaywrightStatus('skipped'), 'skipped');
    assert.strictEqual(mapPlaywrightStatus('flaky'), 'warning');
    assert.strictEqual(mapPlaywrightStatus(''), 'warning');
    assert.strictEqual(mapPlaywrightStatus(null), 'warning');
})();

(() => {
    // ── formatDuration ────────────────────────────────────────────
    assert.strictEqual(formatDuration(0), '0s');
    assert.strictEqual(formatDuration(-5), '0s');
    assert.strictEqual(formatDuration(900), '1s');
    assert.strictEqual(formatDuration(45_000), '45s');
    assert.strictEqual(formatDuration(125_000), '2m 5s');
})();

(() => {
    // ── buildReportFromPlaywright — basic mapping ─────────────────
    const fakeReport = {
        suites: [
            {
                specs: [
                    {
                        title: 'Login form',
                        file: 'login.spec.ts',
                        tests: [{
                            title: 'Login form',
                            results: [{ status: 'passed', duration: 1200, steps: [{ title: 'click submit' }] }],
                        }],
                    },
                    {
                        title: 'Bad credentials rejected',
                        file: 'login.spec.ts',
                        tests: [{
                            title: 'Bad credentials',
                            results: [{ status: 'failed', duration: 800, error: { message: 'expected visible' } }],
                        }],
                    },
                ],
            },
        ],
    };

    const out = buildReportFromPlaywright({
        report: fakeReport,
        targetUrl: 'https://example.com',
        stdoutTail: '',
        exitCode: 1,
    });

    assert.strictEqual(out.summary.passed, 1, 'one passed test');
    assert.strictEqual(out.summary.failed, 1, 'one failed test');
    assert.strictEqual(out.tests.length, 2, 'two test entries');

    const failed = out.tests.find(t => t.status === 'failed');
    assert.ok(failed, 'failed test exists');
    assert.strictEqual(failed.severity, 'major', 'failed tests get major severity by default');
    assert.strictEqual(failed.error, 'expected visible', 'error message propagates');
    assert.strictEqual(out.url, 'https://example.com');
    assert.match(out.title, /Playwright run — https:\/\/example\.com/);
})();

(() => {
    // ── buildReportFromPlaywright — empty / missing report ────────
    const out = buildReportFromPlaywright({
        report: null,
        targetUrl: 'https://example.com',
        stdoutTail: 'Error: playwright not installed',
        exitCode: 127,
    });
    assert.deepStrictEqual(out.summary, { passed: 0, failed: 0, skipped: 0, warnings: 0 });
    assert.strictEqual(out.tests.length, 0);
    assert.match(out.notes, /No test results were produced/);
    assert.match(out.notes, /Error: playwright not installed/);
})();

console.log('✓ server/workers/testRunner.test.js — all assertions passed');
