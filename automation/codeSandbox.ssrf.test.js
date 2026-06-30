/**
 * SSRF tests for the code-step sandbox's defaultFetchHttp().
 *
 * Covers:
 *   - https-only policy unchanged.
 *   - Private hosts (IP literals, localhost, metadata) fast-fail with the
 *     sandbox's structured { error } shape, before any network activity.
 *   - A public-looking hostname whose DNS resolves to a private IP is
 *     refused at connect time (DNS-rebinding path through the real
 *     ssrfGuard dispatcher with a stubbed lookup) and surfaces as the SAME
 *     structured { error } — not a thrown exception.
 *   - Response mapping (status/headers/body) and the 1MB-style responseCap
 *     truncation still work on the safeFetch path.
 *   - The 5-call http budget in runCode() is unchanged.
 *
 * No network access required. Run:
 *   node server/automation/codeSandbox.ssrf.test.js
 */

const assert = require('assert');

// Require the REAL guard first, then overlay safeFetch via the require
// cache so codeSandbox routes through a dispatcher with a stubbed DNS
// lookup ('internal.test' → 10.0.0.5) and a canned response for 'ok.test'.
// Everything else (isPrivateHostname, isPrivateAddressError, the
// validating-lookup + connector plumbing) stays real.
const realGuard = require('../utils/ssrfGuard');

let lookupCalls = 0;
const stubLookup = (hostname, options, cb) => {
    lookupCalls++;
    const reply = (address, family) => {
        if (options && options.all) return process.nextTick(cb, null, [{ address, family }]);
        process.nextTick(cb, null, address, family);
    };
    if (hostname === 'internal.test') return reply('10.0.0.5', 4);
    process.nextTick(cb, Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
};
const stubDispatcher = realGuard.makeSafeDispatcher({ lookup: stubLookup });

const fakeOkResponse = (bodyLength) => ({
    status: 200,
    headers: new Headers({ 'content-type': 'text/plain', 'x-test': '1' }),
    text: async () => 'A'.repeat(bodyLength),
});
let okBodyLength = 10;

const guardPath = require.resolve('../utils/ssrfGuard');
require.cache[guardPath].exports = {
    ...realGuard,
    safeFetch: async (url, opts) => {
        if (new URL(url).hostname === 'ok.test') return fakeOkResponse(okBodyLength);
        return realGuard.safeFetch(url, { ...opts, dispatcher: stubDispatcher });
    },
};

const { defaultFetchHttp, runCode, isAvailable } = require('./codeSandbox');

const REFUSED = 'Refused: target resolves to a private/internal address.';

(async () => {
    // ── https-only policy unchanged ───────────────────────────────
    assert.deepStrictEqual(await defaultFetchHttp('http://example.com'),
        { error: 'Only https:// URLs are allowed.' });
    assert.deepStrictEqual(await defaultFetchHttp('ftp://example.com'),
        { error: 'Only https:// URLs are allowed.' });
    assert.deepStrictEqual(await defaultFetchHttp(42),
        { error: 'Only https:// URLs are allowed.' });

    // ── private hosts fast-fail with the structured error ─────────
    const PRIVATE_URLS = [
        'https://127.0.0.1',
        'https://127.0.0.1:8443/admin',
        'https://[::1]/',
        'https://[fe80::1]/x',
        'https://localhost/secret',
        'https://10.0.0.1/',
        'https://192.168.1.1/',
        'https://169.254.169.254/latest/meta-data',
        'https://metadata.google.internal/computeMetadata/v1/',
        'https://localhost./',                       // trailing-dot bypass attempt
        'https://[::ffff:127.0.0.1]/',               // IPv4-mapped bypass attempt
    ];
    for (const url of PRIVATE_URLS) {
        assert.deepStrictEqual(await defaultFetchHttp(url), { error: REFUSED }, `must refuse ${url}`);
    }
    assert.strictEqual(lookupCalls, 0, 'fast-fail must not hit DNS at all');

    // ── DNS-rebinding: public-looking name → private IP ───────────
    // Refused at socket-connect time inside undici; must surface as the
    // same structured { error }, not a throw.
    const rebound = await defaultFetchHttp('https://internal.test/steal');
    assert.deepStrictEqual(rebound, { error: REFUSED }, 'connect-time refusal must keep the { error } shape');
    assert.ok(lookupCalls > 0, 'rebinding case must have gone through the lookup');

    // Unresolvable names keep returning ordinary fetch errors.
    const nx = await defaultFetchHttp('https://nope.test/');
    assert.ok(nx.error, 'ENOTFOUND surfaces as { error }');
    assert.notStrictEqual(nx.error, REFUSED);

    // ── response mapping + cap on the safeFetch path ──────────────
    okBodyLength = 10;
    const small = await defaultFetchHttp('https://ok.test/data');
    assert.strictEqual(small.status, 200);
    assert.strictEqual(small.body, 'A'.repeat(10));
    assert.strictEqual(small.truncated, false);
    assert.strictEqual(small.headers['x-test'], '1');

    okBodyLength = 2048;
    const capped = await defaultFetchHttp('https://ok.test/big', {}, { responseCap: 1000 });
    assert.strictEqual(capped.body.length, 1000, 'body truncated to responseCap');
    assert.strictEqual(capped.truncated, true);

    // ── http call budget in runCode unchanged ─────────────────────
    if (!isAvailable()) {
        console.log('… isolated-vm not installed — skipping budget test');
    } else {
        let bridgeCalls = 0;
        const out = await runCode({
            code: `async function main(inputs, ctx) {
                const results = [];
                for (let i = 0; i < 7; i++) results.push(await ctx.http('https://example.com/' + i));
                return results;
            }`,
            bridges: { fetchHttp: async () => { bridgeCalls++; return { status: 200, body: 'ok' }; } },
        });
        assert.strictEqual(bridgeCalls, 5, 'bridge called exactly budget times');
        assert.strictEqual(out.http.calls, 5);
        assert.strictEqual(out.result.length, 7);
        assert.deepStrictEqual(out.result[4], { status: 200, body: 'ok' });
        assert.deepStrictEqual(out.result[5], { error: 'http call budget exceeded (5)' });
        assert.deepStrictEqual(out.result[6], { error: 'http call budget exceeded (5)' });
    }

    console.log('✓ server/automation/codeSandbox.ssrf.test.js — all assertions passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
