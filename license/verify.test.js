/**
 * Unit tests for license/verify.js
 *
 * Generates an ephemeral RSA keypair per run, signs test JWTs with the
 * private key, and verifies them via the module's verifyToken function.
 *
 * Run: node license/verify.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const verify = require('./verify');

// ── Generate an ephemeral keypair ───────────────────────────────────────
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

verify._setPublicKeyForTesting(publicKey);

function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function sign(payload, { alg = 'RS256', headerOverrides = {} } = {}) {
    const header = { alg, typ: 'JWT', ...headerOverrides };
    const encHeader = b64url(JSON.stringify(header));
    const encPayload = b64url(JSON.stringify(payload));
    const signingInput = `${encHeader}.${encPayload}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    return `${signingInput}.${b64url(sig)}`;
}

const now = Math.floor(Date.now() / 1000);

(async () => {
// ── Happy path: valid pro license ───────────────────────────────────────
{
    const token = sign({
        iss: 'license.beeflow.ai',
        sub: 'org_test',
        tier: 'pro',
        license_id: 'lic_pro_1',
        iat: now,
        exp: now + 86400,
        billing_interval: 'monthly',
    });
    const r = await verify.verifyToken(token, { now });
    assert.strictEqual(r.valid, true, `expected valid, got: ${r.error}`);
    assert.strictEqual(r.payload.tier, 'pro');
    assert.strictEqual(r.payload.license_id, 'lic_pro_1');
}

// ── Expired token ───────────────────────────────────────────────────────
{
    const token = sign({
        iss: 'license.beeflow.ai',
        sub: 'org_test',
        tier: 'pro',
        license_id: 'lic_expired',
        iat: now - 7200,
        exp: now - 3600,
    });
    const r = await verify.verifyToken(token, { now });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'token_expired');
}

// ── Untrusted issuer ────────────────────────────────────────────────────
{
    const token = sign({
        iss: 'attacker.com',
        sub: 'org_test',
        tier: 'pro',
        license_id: 'lic_bad_iss',
        iat: now,
        exp: now + 86400,
    });
    const r = await verify.verifyToken(token, { now });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.startsWith('untrusted_issuer'), `got: ${r.error}`);
}

// ── Tampered signature ──────────────────────────────────────────────────
{
    const token = sign({
        iss: 'license.beeflow.ai',
        sub: 'org_test',
        tier: 'pro',
        license_id: 'lic_tamper',
        iat: now,
        exp: now + 86400,
    });
    const parts = token.split('.');
    const corrupted = `${parts[0]}.${parts[1]}.${b64url(Buffer.alloc(256, 0))}`;
    const r = await verify.verifyToken(corrupted, { now });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'invalid_signature');
}

// ── Wrong algorithm header ──────────────────────────────────────────────
{
    const token = sign({
        iss: 'license.beeflow.ai',
        sub: 'org_test',
        tier: 'pro',
        license_id: 'lic_alg',
        iat: now,
        exp: now + 86400,
    }, { headerOverrides: { alg: 'HS256' } });
    const r = await verify.verifyToken(token, { now });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.startsWith('unexpected_alg'));
}

// ── Invalid tier claim ──────────────────────────────────────────────────
{
    const token = sign({
        iss: 'license.beeflow.ai',
        sub: 'org_test',
        tier: 'starter',
        license_id: 'lic_invalid_tier',
        iat: now,
        exp: now + 86400,
    });
    const r = await verify.verifyToken(token, { now });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.startsWith('invalid_tier'));
}

// ── Missing license_id ──────────────────────────────────────────────────
{
    const token = sign({
        iss: 'license.beeflow.ai',
        sub: 'org_test',
        tier: 'pro',
        iat: now,
        exp: now + 86400,
    });
    const r = await verify.verifyToken(token, { now });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'missing_license_id');
}

// ── Full tier with WRONG (regular) issuer → rejected ────────────────────
{
    const token = sign({
        iss: 'license.beeflow.ai',         // regular issuer, not the internal one
        sub: 'org_test',
        tier: 'full',
        license_id: 'lic_full_forge',
        iat: now,
        exp: now + 86400,
    });
    const r = await verify.verifyToken(token, { now });
    assert.strictEqual(r.valid, false);
    assert.strictEqual(r.error, 'full_tier_requires_internal_issuer');
}

// ── Full tier with INTERNAL issuer → accepted ───────────────────────────
{
    const token = sign({
        iss: 'license.beeflow.ai/internal',
        sub: 'org_beeflow',
        tier: 'full',
        license_id: 'lic_full_internal',
        iat: now,
        exp: now + 86400,
    });
    const r = await verify.verifyToken(token, { now });
    assert.strictEqual(r.valid, true, `expected valid, got: ${r.error}`);
    assert.strictEqual(r.payload.tier, 'full');
}

// ── Malformed token ─────────────────────────────────────────────────────
{
    const r = await verify.verifyToken('not.a.jwt', { now });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.startsWith('decode_failed'), `got: ${r.error}`);
}
{
    const r = await verify.verifyToken('only-one-part', { now });
    assert.strictEqual(r.valid, false);
    assert.ok(r.error.startsWith('decode_failed'));
}

// ── Wrong public key (bundled fallback doesn't match the test signer) ──
// Previously this asserted `no_public_key_configured`, but the production
// build now ships a bundled-public-key.pem so that activation works
// out-of-the-box on self-hosted installs (Nextcloud-bundled, Docker, etc.).
// That means "no env key" no longer means "no key at all" — the loader
// falls back to the bundled one. A token signed by a different keypair
// therefore fails with invalid_signature, which is the realistic outcome.
{
    verify._setPublicKeyForTesting(null);
    const token = sign({
        iss: 'license.beeflow.ai',
        sub: 'org_test',
        tier: 'pro',
        license_id: 'lic_wrongkey',
        iat: now,
        exp: now + 86400,
    });
    const r = await verify.verifyToken(token, { now });
    assert.strictEqual(r.valid, false);
    assert.ok(['invalid_signature', 'no_public_key_configured'].includes(r.error),
        `expected invalid_signature or no_public_key_configured, got ${r.error}`);
    verify._setPublicKeyForTesting(publicKey); // restore
}

console.log('✓ license/verify.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ license/verify.test.js FAILED:', err);
    process.exit(1);
});
