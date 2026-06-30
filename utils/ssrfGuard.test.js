/**
 * Unit tests for the shared SSRF guard.
 *
 * Covers:
 *   - isPrivateIp range checks (RFC1918, loopback, link-local, CGNAT,
 *     0.0.0.0/8, IPv6 ULA/link-local/unspecified, IPv4-mapped IPv6).
 *   - isPrivateHostname literal screen (block/allow tables carried over
 *     from workers/testRunner.test.js, plus metadata hostnames and
 *     trailing-dot normalization).
 *   - validatingLookup: fast-fail on private hostnames, rejection when a
 *     stubbed dns.lookup resolves to a private IP (single and `all: true`
 *     shapes), pass-through for public results, and decimal/hex IPv4
 *     spellings caught at lookup (getaddrinfo parses them locally).
 *   - safeFetch fast-fail (no network).
 *
 * No network access required. Run:
 *   node server/utils/ssrfGuard.test.js
 */

const assert = require('assert');

const {
    isPrivateIp,
    isPrivateHostname,
    isPrivateAddressError,
    makeValidatingLookup,
    validatingLookup,
    safeFetch,
    PRIVATE_ADDRESS_ERROR_CODE,
} = require('./ssrfGuard');

(() => {
    // ── isPrivateIp — block table ─────────────────────────────────
    const PRIVATE_IPS = [
        '0.0.0.0', '0.255.255.255',                  // 0/8
        '10.0.0.1', '10.255.255.255',                // 10/8
        '127.0.0.1', '127.5.5.5',                    // loopback
        '100.64.0.1', '100.127.255.255',             // CGNAT 100.64/10
        '169.254.0.1', '169.254.169.254',            // link-local + metadata
        '172.16.0.1', '172.31.255.255',              // 172.16/12
        '192.168.1.1',                               // 192.168/16
        '::1', '::',                                 // v6 loopback / unspecified
        '0:0:0:0:0:0:0:1',                           // unabbreviated ::1
        'fc00::1', 'fd12:3456::1',                   // fc00::/7 ULA
        'fe80::1', 'febf::1', 'fe80::1%eth0',        // fe80::/10 link-local (+zone)
        '::ffff:127.0.0.1', '::ffff:10.0.0.1',       // IPv4-mapped, dotted
        '::ffff:192.168.1.1', '::ffff:169.254.169.254',
        '::ffff:7f00:1',                             // IPv4-mapped, hex form (127.0.0.1)
        '0:0:0:0:0:ffff:7f00:1',                     // …unabbreviated
        '[::1]',                                     // bracketed input tolerated
    ];
    for (const ip of PRIVATE_IPS) {
        assert.strictEqual(isPrivateIp(ip), true, `isPrivateIp must block ${ip}`);
    }

    const PUBLIC_IPS = [
        '1.1.1.1', '8.8.8.8', '11.0.0.1',
        '100.63.255.255', '100.128.0.0',             // just outside CGNAT
        '172.15.0.1', '172.32.0.1',                  // just outside 172.16/12
        '169.253.1.1', '169.255.1.1',                // just outside 169.254/16
        '193.168.1.1',
        '2606:4700:4700::1111',                      // public v6
        '::ffff:8.8.8.8',                            // IPv4-mapped public
        'fec0::1',                                   // outside fe80::/10
        'fbff::1',                                   // outside fc00::/7
    ];
    for (const ip of PUBLIC_IPS) {
        assert.strictEqual(isPrivateIp(ip), false, `isPrivateIp must allow ${ip}`);
    }

    // Non-IPs are not "private IPs" — hostname screening is a separate layer.
    assert.strictEqual(isPrivateIp('example.com'), false);
    assert.strictEqual(isPrivateIp(null), false);
})();

(() => {
    // ── isPrivateHostname — block/allow tables (from testRunner.test.js) ──
    const PRIVATE_HOSTS = [
        'localhost', 'LOCALHOST', 'localhost.',      // + trailing-dot normalization
        '127.0.0.1', '127.5.5.5',
        '10.0.0.1', '10.255.255.255',
        '192.168.1.1',
        '172.16.0.1', '172.31.255.255',
        '169.254.169.254',
        '::1', '[::1]',
        'fc00::1', 'fd00::1', 'fe80::1',
        'metadata.google.internal', 'metadata.google.internal.', 'METADATA.GOOGLE.INTERNAL',
        '0.0.0.0', '100.64.0.1',                     // beyond the regex screen: full IP check
        '::ffff:127.0.0.1',
        '',                                          // empty host → refuse
    ];
    for (const host of PRIVATE_HOSTS) {
        assert.strictEqual(isPrivateHostname(host), true, `must block host ${JSON.stringify(host)}`);
    }

    const PUBLIC_HOSTS = [
        'example.com', 'app.example.com', 'example.com.',
        '1.1.1.1', '11.0.0.1',
        '172.32.0.1', '172.15.0.1',                  // outside 172.16-31
        '100.63.0.1',
        'metadata.google.internal.example.com',      // only the exact metadata host
        '2606:4700:4700::1111',
    ];
    for (const host of PUBLIC_HOSTS) {
        assert.strictEqual(isPrivateHostname(host), false, `must allow host ${host}`);
    }
})();

const fromCallback = (lookup, hostname, options) => new Promise((resolve) => {
    lookup(hostname, options, (err, address, family) => resolve({ err, address, family }));
});

(async () => {
    // ── validatingLookup — fast-fail, no base lookup call ─────────
    let baseCalled = false;
    const neverLookup = () => { baseCalled = true; throw new Error('base lookup must not be called'); };
    const guarded = makeValidatingLookup(neverLookup);
    const { err } = await fromCallback(guarded, 'localhost', {});
    assert.ok(err, 'localhost must be refused');
    assert.strictEqual(err.code, PRIVATE_ADDRESS_ERROR_CODE);
    assert.strictEqual(baseCalled, false, 'private hostnames fail before resolution');

    // ── stubbed dns.lookup → private IP rejected (DNS rebinding) ──
    const stubSingle = (host, options, cb) => process.nextTick(cb, null, '10.0.0.5', 4);
    const rebind = makeValidatingLookup(stubSingle);
    const r1 = await fromCallback(rebind, 'public-looking.example.com', { family: 4 });
    assert.ok(r1.err, 'name resolving to 10.0.0.5 must be refused');
    assert.strictEqual(r1.err.code, PRIVATE_ADDRESS_ERROR_CODE);

    // `all: true` shape (Happy Eyeballs): one private address poisons the set.
    const stubAll = (host, options, cb) => process.nextTick(cb, null, [
        { address: '93.184.216.34', family: 4 },
        { address: '169.254.169.254', family: 4 },
    ]);
    const rebindAll = makeValidatingLookup(stubAll);
    const r2 = await fromCallback(rebindAll, 'mixed.example.com', { all: true });
    assert.ok(r2.err, 'mixed public+private resolution must be refused');
    assert.strictEqual(r2.err.code, PRIVATE_ADDRESS_ERROR_CODE);
    assert.strictEqual(isPrivateAddressError(r2.err), true);

    // Public resolution passes through untouched.
    const stubPublic = (host, options, cb) => process.nextTick(cb, null, '93.184.216.34', 4);
    const ok = await fromCallback(makeValidatingLookup(stubPublic), 'example.com', {});
    assert.strictEqual(ok.err, null);
    assert.strictEqual(ok.address, '93.184.216.34');
    assert.strictEqual(ok.family, 4);

    // Resolver errors propagate as-is.
    const stubErr = (host, options, cb) => process.nextTick(cb, Object.assign(new Error('boom'), { code: 'ENOTFOUND' }));
    const failed = await fromCallback(makeValidatingLookup(stubErr), 'nx.example.com', {});
    assert.strictEqual(failed.err.code, 'ENOTFOUND');

    // ── decimal/hex IPv4 spellings caught at lookup ───────────────
    // These dodge the hostname regex screen, but getaddrinfo parses them
    // locally (inet_aton semantics) into 127.0.0.1 — no network involved.
    for (const sneaky of ['2130706433', '0x7f000001']) {
        const r = await fromCallback(validatingLookup, sneaky, {});
        assert.ok(r.err, `${sneaky} must be refused at lookup`);
        assert.strictEqual(r.err.code, PRIVATE_ADDRESS_ERROR_CODE, `${sneaky} → EPRIVATEADDRESS`);
    }

    // ── isPrivateAddressError walks cause chains (undici wraps) ───
    const wrapped = new TypeError('fetch failed');
    wrapped.cause = r1.err;
    assert.strictEqual(isPrivateAddressError(wrapped), true);
    assert.strictEqual(isPrivateAddressError(new Error('other')), false);
    assert.strictEqual(isPrivateAddressError(null), false);

    // ── safeFetch fast-fails on private hosts without dialing out ─
    for (const url of ['https://127.0.0.1/x', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data']) {
        await assert.rejects(safeFetch(url), (e) => isPrivateAddressError(e), `safeFetch must refuse ${url}`);
    }
    await assert.rejects(safeFetch('not a url at all'), TypeError, 'invalid URL still throws');

    console.log('✓ server/utils/ssrfGuard.test.js — all assertions passed');
})().catch((e) => { console.error(e); process.exit(1); });
