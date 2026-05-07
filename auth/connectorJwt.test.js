/**
 * Unit tests for the connector JWT verifier.
 *
 * These cover the security boundary in isolation — no DB, no fetch. The
 * full middleware path (configStore lookup, userStore lookup, req.session
 * mutation) is integration territory and lives in a separate suite.
 *
 * Run: node --test server/auth/connectorJwt.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { _verifyHs256 } = require('./connectorJwt');

const KEY = 'test-tenant-key-32-bytes-minimum-please';
const NOW = Math.floor(Date.now() / 1000);

function mintToken(payload, key = KEY, headerOverrides = {}) {
    const header = { alg: 'HS256', typ: 'JWT', ...headerOverrides };
    const enc = (obj) => Buffer.from(JSON.stringify(obj))
        .toString('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const h = enc(header);
    const p = enc(payload);
    const sig = crypto.createHmac('sha256', key)
        .update(`${h}.${p}`)
        .digest('base64')
        .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${h}.${p}.${sig}`;
}

test('accepts a valid token', () => {
    const token = mintToken({
        sub: 'alice',
        email: 'alice@example.com',
        iss: 'nextcloud-connector',
        aud: 'beeflow.ai',
        exp: NOW + 300,
    });
    const payload = _verifyHs256(token, KEY);
    assert.strictEqual(payload.email, 'alice@example.com');
    assert.strictEqual(payload.sub, 'alice');
});

test('rejects a token signed with the wrong key', () => {
    const token = mintToken({ email: 'a@b.c', exp: NOW + 60 }, 'wrong-key');
    assert.throws(() => _verifyHs256(token, KEY), /signature mismatch/);
});

test('rejects an expired token', () => {
    const token = mintToken({ email: 'a@b.c', exp: NOW - 10 });
    assert.throws(() => _verifyHs256(token, KEY), /expired/);
});

test('rejects a token not yet valid (nbf in future)', () => {
    const token = mintToken({ email: 'a@b.c', exp: NOW + 300, nbf: NOW + 60 });
    assert.throws(() => _verifyHs256(token, KEY), /not yet valid/);
});

test('rejects a malformed token', () => {
    assert.throws(() => _verifyHs256('not.a.jwt.but.has.dots', KEY), /malformed/);
    assert.throws(() => _verifyHs256('only-one-segment', KEY), /malformed/);
});

test('rejects unexpected algorithm (alg=none attack)', () => {
    const token = mintToken({ email: 'a@b.c', exp: NOW + 60 }, KEY, { alg: 'none' });
    assert.throws(() => _verifyHs256(token, KEY), /alg/);
});

test('rejects unexpected algorithm (alg=RS256 confusion)', () => {
    // Classic alg-confusion attack: HS256 verifier, attacker signs as RS256.
    // We pin to HS256 in the header check so this fails before verifier
    // even tries the HMAC.
    const token = mintToken({ email: 'a@b.c', exp: NOW + 60 }, KEY, { alg: 'RS256' });
    assert.throws(() => _verifyHs256(token, KEY), /alg/);
});

test('rejects wrong issuer', () => {
    const token = mintToken({ email: 'a@b.c', exp: NOW + 60, iss: 'attacker' });
    assert.throws(() => _verifyHs256(token, KEY), /iss/);
});

test('rejects wrong audience', () => {
    const token = mintToken({ email: 'a@b.c', exp: NOW + 60, aud: 'evil.example' });
    assert.throws(() => _verifyHs256(token, KEY), /aud/);
});

test('payload without iss/aud claims still verifies (legacy / strict-only check)', () => {
    // We only validate iss/aud when present. A forward-compat token without
    // them should still work, since the connector-side mint always sets
    // them — but a downgrade path via a connector that hasn't been updated
    // shouldn't break.
    const token = mintToken({ email: 'a@b.c', exp: NOW + 60 });
    const payload = _verifyHs256(token, KEY);
    assert.strictEqual(payload.email, 'a@b.c');
});
