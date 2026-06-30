/**
 * Unit tests — HMAC-derived certificate identifiers.
 *
 * certificateToken.js derives the human-facing serial ("BF-XXXX-XXXX-XXXX")
 * and the public verify token from the canonical issuance tuple, so both must
 * be deterministic per tuple, unforgeable without the secret, and distinct
 * from each other (different HMAC purposes). The module caches its secret on
 * first use, so LEARNING_CERT_SECRET is set BEFORE it is required — this also
 * makes hasDurableSecret() true without touching configStore or tmpfiles.
 *
 * Run: node --test server/auth/certificateToken.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

// Must be set before the module is required: getSecret() caches the secret
// the first time any derivation runs.
process.env.LEARNING_CERT_SECRET = 'x'.repeat(48);

const { makeSerial, makeVerifyToken, tokenHash, hasDurableSecret } = require('./certificateToken');

const SERIAL_RE = /^BF-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

test('makeSerial is deterministic per (certId, userId, day) and Crockford-formatted', () => {
    const a = makeSerial('cert-foundations', 'u1', '2026-06-10');
    const b = makeSerial('cert-foundations', 'u1', '2026-06-10');
    assert.equal(a, b, 'same tuple must reproduce the same serial (idempotent re-issue)');
    assert.match(a, SERIAL_RE, 'serial uses the Crockford alphabet (no I, L, O, U)');
});

test('makeSerial differs when any tuple component changes', () => {
    const base = makeSerial('cert-foundations', 'u1', '2026-06-10');
    assert.notEqual(makeSerial('cert-foundations', 'u2', '2026-06-10'), base, 'different userId');
    assert.notEqual(makeSerial('cert-builder', 'u1', '2026-06-10'), base, 'different certId');
    assert.notEqual(makeSerial('cert-foundations', 'u1', '2026-06-11'), base, 'different day');
});

test('makeVerifyToken is deterministic per (certId, userId) and base64url', () => {
    const t1 = makeVerifyToken('cert-foundations', 'u1');
    const t2 = makeVerifyToken('cert-foundations', 'u1');
    assert.equal(t1, t2, 'same tuple must reproduce the same token');
    assert.match(t1, /^[A-Za-z0-9_-]+$/, 'base64url alphabet only');
    assert.ok(!t1.includes('+') && !t1.includes('/') && !t1.includes('='),
        'no raw base64 characters or padding (URL-safe)');
    assert.equal(t1.length, 43, 'unpadded base64url of a 32-byte HMAC digest');
});

test('makeVerifyToken differs between users', () => {
    assert.notEqual(makeVerifyToken('cert-foundations', 'u1'), makeVerifyToken('cert-foundations', 'u2'));
});

test('serial and verifyToken for the same tuple do not collide (distinct HMAC purposes)', () => {
    const serial = makeSerial('cert-foundations', 'u1', '2026-06-10');
    const token = makeVerifyToken('cert-foundations', 'u1');
    assert.notEqual(serial, token);
    // The underlying digests are domain-separated ("serial|" vs "verify|"), so
    // even hashing both to a common representation must not collide.
    assert.notEqual(tokenHash(serial), tokenHash(token));
});

test('tokenHash is stable 64-char lowercase hex (sha256 of the token)', () => {
    const token = makeVerifyToken('cert-foundations', 'u1');
    const h1 = tokenHash(token);
    const h2 = tokenHash(token);
    assert.equal(h1, h2, 'stable across calls');
    assert.match(h1, /^[0-9a-f]{64}$/);
    const expected = crypto.createHash('sha256').update(token).digest('hex');
    assert.equal(h1, expected, 'plain sha256 — the public lookup index key');
});

test('hasDurableSecret is true when the env secret is set', () => {
    assert.equal(hasDurableSecret(), true);
});
