'use strict';

/**
 * Unit tests for runLogRedaction — the WS5.2 persistence-chokepoint masking.
 *
 * Run: node automation/runLogRedaction.test.js   (from server/)
 *
 * Pure module, no DB/network; plain assert like the sibling tests.
 */

const assert = require('assert');
const { redactForPersistence, SECRET_PATTERNS, SENSITIVE_KEY_RE, REDACTED_MARKER_RE } = require('./runLogRedaction');

function redact(value, secretValues = []) {
    return redactForPersistence(value, { secretValues });
}

// ── 1. Pattern table — secret-shaped strings get masked, by kind ────────
{
    const TABLE = [
        // [input, expected_output]
        ['Authorization: Bearer abcDEF123456789xyz', 'Authorization: Bearer «redacted:bearer»'],
        ['authorization: bearer abcDEF123456789xyz', 'authorization: bearer «redacted:bearer»'], // scheme case preserved
        ['Basic dXNlcjpwYXNzd29yZA==', 'Basic «redacted:basic»'],
        ['key=sk-abcdefghijklmnop1234', 'key=«redacted:sk-token»'],
        ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', '«redacted:sk-token»'],
        ['token ghp_AbCdEfGhIjKlMnOpQrSt123456789012345', 'token «redacted:github-token»'],
        ['gho_AbCdEfGhIjKlMnOpQrSt', '«redacted:github-token»'],
        ['github_pat_11ABCDEFG0_abcdefghijklmnop', '«redacted:github-token»'],
        ['xoxb-13012-1234567890-AbCdEfGh', '«redacted:slack-token»'],
        ['slack: xoxp-99999999-abc-def-0123456789ab done', 'slack: «redacted:slack-token» done'],
        ['aws AKIAIOSFODNN7EXAMPLE end', 'aws «redacted:aws-key» end'],
        ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM', '«redacted:jwt»'],
        ['-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', '«redacted:private-key»'],
        // Unterminated PEM block masks to end-of-string.
        ['x -----BEGIN PRIVATE KEY-----\nMIIEpAIBAAKCAQEA truncated', 'x «redacted:private-key»'],
        // Bearer wins over the raw JWT shape (value portion only is masked).
        ['Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpM', 'Bearer «redacted:bearer»'],
    ];
    for (const [input, expected] of TABLE) {
        const { value, redactions } = redact(input);
        assert.strictEqual(value, expected, `pattern mask for: ${input}`);
        assert.ok(redactions >= 1, `redactions counted for: ${input}`);
    }
}

// ── 2. Non-matches — short/dissimilar shapes survive untouched ──────────
{
    const CLEAN = [
        'Bearer short',                       // < 8 token chars
        'AKIAIOSFODN',                        // AKIA + fewer than 16 chars
        'sub.example.com',                    // dotted hostname is not a JWT
        'skf-not-a-key-prefix',
        'risk-assessment-2026 sk-12345',      // sk- tail too short
    ];
    for (const input of CLEAN) {
        const { value } = redact(input);
        assert.strictEqual(value, input, `should not mask: ${input}`);
    }
}

// ── 3. Key-name matches — value replaced wholesale ──────────────────────
{
    const KEYS = ['authorization', 'Authorization', 'x-api-key', 'apiKey', 'api_key', 'api-key',
        'password', 'passwd', 'secret', 'token', 'access_token', 'accessToken', 'refresh-token',
        'client_secret', 'private_key', 'privateKey'];
    for (const k of KEYS) {
        assert.ok(SENSITIVE_KEY_RE.test(k.replace(/([a-z])([A-Z])/g, '$1_$2')) || SENSITIVE_KEY_RE.test(k),
            `key regex should cover ${k}`);
    }
    const { value } = redact({
        password: 'hunter2',
        token: 12345,
        nested: { 'X-Api-Key': 'plain-looking-value', headers: { Authorization: 'whatever' } },
        secretFlag: 'untouched',            // key is "secretFlag", not "secret" — anchored regex
        secret: true,                        // boolean config flag stays
        tokens: ['not-a-sensitive-key'],     // plural key not matched
    });
    assert.deepStrictEqual(value, {
        password: '«redacted:key»',
        token: '«redacted:key»',
        nested: { 'X-Api-Key': '«redacted:key»', headers: { Authorization: '«redacted:key»' } },
        secretFlag: 'untouched',
        secret: true,
        tokens: ['not-a-sensitive-key'],
    });
}

// ── 4. Exact secret-value masking (pass a) ──────────────────────────────
{
    const secret = 'v3ry-s3cret-valu3';
    const { value, redactions } = redact(
        { msg: `posted with ${secret} twice: ${secret}`, arr: [secret, 'clean'] },
        [secret, 'ab', null, 42],            // short + non-string entries ignored
    );
    assert.deepStrictEqual(value, {
        msg: 'posted with «redacted:secret» twice: «redacted:secret»',
        arr: ['«redacted:secret»', 'clean'],
    });
    assert.strictEqual(redactions, 3);
    // Tiny values are not masked (would shred ordinary text).
    assert.strictEqual(redact('absolutely fine', ['ab']).value, 'absolutely fine');
}

// ── 5. Shape preservation + non-mutation ────────────────────────────────
{
    const input = {
        n: 42, f: 1.5, b: false, z: null, u: undefined,
        s: 'Bearer abcdefgh12345678',
        list: [1, 'two', { deep: ['sk-abcdefghijklmnop1234'] }],
    };
    const snapshot = JSON.parse(JSON.stringify({ ...input, u: 'sentinel' }));
    const { value } = redact(input);
    assert.notStrictEqual(value, input, 'returns a new tree');
    assert.strictEqual(value.n, 42);
    assert.strictEqual(value.f, 1.5);
    assert.strictEqual(value.b, false);
    assert.strictEqual(value.z, null);
    assert.strictEqual(value.u, undefined);
    assert.ok(Array.isArray(value.list) && value.list.length === 3);
    assert.strictEqual(value.s, 'Bearer «redacted:bearer»');
    assert.deepStrictEqual(value.list[2], { deep: ['«redacted:sk-token»'] });
    // Original untouched.
    assert.deepStrictEqual(JSON.parse(JSON.stringify({ ...input, u: 'sentinel' })), snapshot);
    // Scalars pass through identically.
    assert.strictEqual(redact(7).value, 7);
    assert.strictEqual(redact(null).value, null);
    assert.strictEqual(redact(true).value, true);
    // Non-plain objects pass through by reference (would be flattened otherwise).
    const d = new Date('2026-06-10T00:00:00Z');
    assert.strictEqual(redact({ when: d }).value.when, d);
}

// ── 6. Plain PII is NOT redacted (deliberate — see module docblock) ─────
{
    const pii = {
        email: 'jan.jansen@example.com',
        name: 'Jan Jansen',
        address: 'Bovenkerkerweg 6, 1185 XE Amstelveen',
        phone: '+31 6 12345678',
    };
    assert.deepStrictEqual(redact(pii).value, pii);
}

// ── 7. Idempotence — redact(redact(x)) deep-equals redact(x) ────────────
{
    const messy = {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpM',
        password: 'hunter22',
        body: 'AKIAIOSFODNN7EXAMPLE and xoxb-1-2-abcdefgh plus exact-secret-token-1234',
        pem: '-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----',
        nested: [{ token: 'ghp_AbCdEfGhIjKlMnOpQrSt' }],
    };
    const secrets = ['exact-secret-token-1234'];
    const once = redact(messy, secrets).value;
    const twice = redact(once, secrets).value;
    assert.deepStrictEqual(twice, once, 'second redaction is a no-op');
    assert.ok(REDACTED_MARKER_RE.test(once.password));
}

// ── 8. Determinism — same input, same output, same count ────────────────
{
    const input = { a: 'Bearer abcdefgh12345678', k: { secret: 's3cret-here' } };
    const r1 = redact(input, ['s3cret-here']);
    const r2 = redact(input, ['s3cret-here']);
    assert.deepStrictEqual(r1.value, r2.value);
    assert.strictEqual(r1.redactions, r2.redactions);
}

// ── 9. Exported pattern list sanity ─────────────────────────────────────
{
    assert.ok(Array.isArray(SECRET_PATTERNS) && SECRET_PATTERNS.length >= 8);
    for (const p of SECRET_PATTERNS) {
        assert.ok(typeof p.kind === 'string' && p.kind.length > 0);
        assert.ok(p.re instanceof RegExp && p.re.global, `${p.kind} regex must be global`);
    }
}

console.log('✓ server/automation/runLogRedaction.test.js — all assertions passed');
