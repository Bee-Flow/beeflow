/**
 * Unit tests for the custom-integrations SSRF guard.
 *
 * Run: node core/customIntegrations/ssrfGuard.test.js
 *
 * No DB and no network — isForbiddenAddress/normalizeHostname are pure, and
 * assertPublicHttpsTarget is exercised with an injected mock lookup.
 */

const assert = require('assert');
const {
    isForbiddenAddress,
    normalizeHostname,
    assertPublicHttpsTarget,
} = require('./ssrfGuard');

// ── isForbiddenAddress: forbidden in every spelling ─────────────────────
{
    const FORBIDDEN = [
        '127.0.0.1',          // loopback
        '127.1',              // short-form loopback
        '2130706433',         // decimal 127.0.0.1
        '0x7f000001',         // hex 127.0.0.1
        '0177.0.0.1',         // octal 127.0.0.1
        '0.0.0.0',            // unspecified / "this network"
        '10.1',               // short-form 10.0.0.1
        '172.16.0.1',         // RFC1918 /12 lower edge
        '172.31.255.255',     // RFC1918 /12 upper edge
        '192.168.1.1',        // RFC1918 /16
        '169.254.169.254',    // link-local (cloud metadata)
        '100.64.0.1',         // CGNAT /10 lower edge
        '100.127.255.255',    // CGNAT /10 upper edge
        '255.255.255.255',    // broadcast
        '::1',                // v6 loopback
        '::',                 // v6 unspecified
        'fe80::1',            // v6 link-local
        'fc00::1',            // ULA
        'fd12::1',            // ULA (fd half of fc00::/7)
        '::ffff:127.0.0.1',   // v4-mapped loopback
        '::ffff:10.0.0.1',    // v4-mapped RFC1918
        '[::1]',              // bracketed form
    ];
    for (const ip of FORBIDDEN) {
        assert.strictEqual(isForbiddenAddress(ip), true, `must forbid ${ip}`);
    }
}

// ── isForbiddenAddress: public addresses stay allowed ───────────────────
{
    const ALLOWED = [
        '8.8.8.8',
        '172.32.0.1',         // just past 172.16/12
        '172.15.255.255',     // just before 172.16/12
        '100.128.0.1',        // just past CGNAT /10
        '100.63.255.255',     // just before CGNAT /10
        '1.1.1.1',
        '::ffff:8.8.8.8',     // v4-mapped public
        '2606:4700:4700::1111',
    ];
    for (const ip of ALLOWED) {
        assert.strictEqual(isForbiddenAddress(ip), false, `must allow ${ip}`);
    }
}

// ── isForbiddenAddress: fail-closed on non-IP / malformed input ─────────
{
    for (const bad of ['', 'example.com', '300.1.2.3', '0x', '1.2.3.4.5', ':::', null, undefined, 42]) {
        assert.strictEqual(isForbiddenAddress(bad), true, `must fail closed on ${String(bad)}`);
    }
}

// ── normalizeHostname: numeric IPv4 spellings canonicalize ──────────────
{
    const CASES = [
        ['127.0.0.1', '127.0.0.1'],
        ['127.1', '127.0.0.1'],
        ['10.1', '10.0.0.1'],
        ['2130706433', '127.0.0.1'],
        ['0x7f000001', '127.0.0.1'],
        ['0177.0.0.1', '127.0.0.1'],
        ['0x7F.0.0.1', '127.0.0.1'],         // mixed hex + dotted
        ['0xa9.0xfe.0xa9.0xfe', '169.254.169.254'],
        ['192.168.0x1.1', '192.168.1.1'],
        ['8.8.8.8', '8.8.8.8'],
        ['0', '0.0.0.0'],
    ];
    for (const [input, expected] of CASES) {
        const r = normalizeHostname(input);
        assert.strictEqual(r.kind, 'ip4', `${input} must be classified ip4`);
        assert.strictEqual(r.canonical, expected, `${input} → ${expected}`);
    }
}

// ── normalizeHostname: numeric-ambiguous garbage is NEVER a name ────────
{
    for (const input of ['300.300.300.300', '1.2.3.256', '08.0.0.1', '0x.1', '4294967296']) {
        const r = normalizeHostname(input);
        assert.strictEqual(r.kind, 'ip4', `${input} must not be treated as a DNS name`);
        assert.strictEqual(r.canonical, null, `${input} must not canonicalize`);
    }
}

// ── normalizeHostname: IPv6 forms ────────────────────────────────────────
{
    assert.deepStrictEqual(normalizeHostname('[::1]'), { kind: 'ip6', canonical: '::1' });
    assert.deepStrictEqual(normalizeHostname('::'), { kind: 'ip6', canonical: '::' });
    assert.deepStrictEqual(normalizeHostname('FE80::1'), { kind: 'ip6', canonical: 'fe80::1' });
    assert.deepStrictEqual(normalizeHostname('fe80::1%eth0'), { kind: 'ip6', canonical: 'fe80::1' });
    assert.deepStrictEqual(normalizeHostname('::ffff:127.0.0.1'), { kind: 'ip6', canonical: '::ffff:127.0.0.1' });
    assert.deepStrictEqual(normalizeHostname('0:0:0:0:0:0:0:1'), { kind: 'ip6', canonical: '::1' });
    assert.deepStrictEqual(normalizeHostname('2001:db8:0:0:0:0:0:1'), { kind: 'ip6', canonical: '2001:db8::1' });
    assert.strictEqual(normalizeHostname(':::').canonical, null, 'malformed v6 must not canonicalize');
}

// ── normalizeHostname: real names stay names ─────────────────────────────
{
    assert.deepStrictEqual(normalizeHostname('Example.COM.'), { kind: 'name', canonical: 'example.com' });
    assert.deepStrictEqual(normalizeHostname('api.example.com'), { kind: 'name', canonical: 'api.example.com' });
    // Mixed alpha-numeric labels are names (DNS will be checked separately).
    assert.strictEqual(normalizeHostname('1e100.net').kind, 'name');
}

// ── assertPublicHttpsTarget (async, mocked DNS) ──────────────────────────
const PUBLIC_A = [{ address: '93.184.216.34', family: 4 }];
const publicLookup = async () => PUBLIC_A;
function neverLookup() {
    return async () => { throw new Error('lookup must not be called for literal-IP hosts'); };
}

async function rejectsSafely(promise, label) {
    let threw = null;
    try {
        await promise;
    } catch (err) {
        threw = err;
    }
    assert.ok(threw instanceof Error, `${label}: must throw`);
    // Safe message: generic, never echoes the target host/IP.
    assert.ok(!/10\.0\.0|127\.0|internal-only|secret/.test(threw.message),
        `${label}: message must not echo internal detail (got: ${threw.message})`);
    return threw;
}

(async () => {
    // Scheme: http rejected by default…
    await rejectsSafely(
        assertPublicHttpsTarget('http://example.com/', { lookup: publicLookup }),
        'http scheme'
    );
    // …allowed with requireHttps:false (still resolving public).
    {
        const r = await assertPublicHttpsTarget('http://example.com/x', { requireHttps: false, lookup: publicLookup });
        assert.deepStrictEqual(r.addresses, ['93.184.216.34']);
        assert.strictEqual(r.url.pathname, '/x');
    }
    // Non-http(s) schemes always rejected.
    await rejectsSafely(assertPublicHttpsTarget('ftp://example.com/', { requireHttps: false }), 'ftp scheme');
    await rejectsSafely(assertPublicHttpsTarget('file:///etc/passwd'), 'file scheme');
    await rejectsSafely(assertPublicHttpsTarget('not a url'), 'malformed url');

    // Userinfo rejected.
    await rejectsSafely(assertPublicHttpsTarget('https://user:pass@example.com/'), 'userinfo');
    await rejectsSafely(assertPublicHttpsTarget('https://user@example.com/'), 'username only');

    // Literal forbidden IPs rejected without any DNS call.
    for (const host of ['127.0.0.1', '0x7f000001', '2130706433', '169.254.169.254', '[::1]', '[::ffff:10.0.0.1]', '0177.0.0.1', '100.64.0.1']) {
        await rejectsSafely(
            assertPublicHttpsTarget(`https://${host}/`, { lookup: neverLookup() }),
            `literal ${host}`
        );
    }

    // Literal public IP allowed without DNS.
    {
        const r = await assertPublicHttpsTarget('https://8.8.8.8/dns', { lookup: neverLookup() });
        assert.deepStrictEqual(r.addresses, ['8.8.8.8']);
    }

    // Name resolving only to public addresses → ok, addresses returned.
    {
        const r = await assertPublicHttpsTarget('https://api.example.com/v1', {
            lookup: async (host, opts) => {
                assert.strictEqual(host, 'api.example.com');
                assert.strictEqual(opts.all, true);
                return [{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1', family: 6 }];
            },
        });
        assert.deepStrictEqual(r.addresses, ['93.184.216.34', '2606:4700::1']);
    }

    // Name where ANY resolved address is forbidden → rejected (rebinding mix).
    await rejectsSafely(
        assertPublicHttpsTarget('https://internal-only.example.com/', {
            lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }],
        }),
        'mixed public+private resolution'
    );
    // Name resolving to v4-mapped private → rejected.
    await rejectsSafely(
        assertPublicHttpsTarget('https://mapped.example.com/', {
            lookup: async () => [{ address: '::ffff:192.168.1.1', family: 6 }],
        }),
        'v4-mapped private resolution'
    );
    // DNS failure / empty answers → rejected.
    await rejectsSafely(
        assertPublicHttpsTarget('https://nx.example.com/', { lookup: async () => { throw new Error('ENOTFOUND nx.example.com'); } }),
        'lookup failure'
    );
    await rejectsSafely(
        assertPublicHttpsTarget('https://empty.example.com/', { lookup: async () => [] }),
        'empty resolution'
    );

    console.log('✓ server/core/customIntegrations/ssrfGuard.test.js — all assertions passed');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
