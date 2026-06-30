// HMAC-based identifiers for Learning Center certificates.
//
// Two derived values, both HMAC-SHA256 over the canonical issuance tuple so they
// are DETERMINISTIC (re-issuing the same certificate to the same user reproduces
// the same serial and verify token — idempotency for free) and UNFORGEABLE without
// the server secret:
//
//   serial      — human-facing "BF-XXXX-XXXX-XXXX" printed on the certificate.
//   verifyToken — the secret in the public /verify/:token URL. The public lookup
//                 index is keyed by sha256(verifyToken) so a leaked configStore
//                 dump yields no working URLs (same property as publicViewer).
//
// Secret precedence: LEARNING_CERT_SECRET || PUBLIC_SHARE_TOKEN_SECRET, then a
// configStore-persisted secret bootstrapped at startup (ensureDurableSecret),
// with the same on-disk dev fallback as publicShareToken.js. The per-process
// random fallback is last resort only — it breaks every public verify link on
// restart, so issuance refuses makePublic while it's active (hasDurableSecret).

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

let cachedSecret = null;
let durableSecret = false;

function getSecret() {
    if (cachedSecret) return cachedSecret;
    const fromEnv = process.env.LEARNING_CERT_SECRET || process.env.PUBLIC_SHARE_TOKEN_SECRET;
    if (fromEnv && fromEnv.length >= 32) {
        cachedSecret = Buffer.from(fromEnv, 'utf8');
        durableSecret = true;
        return cachedSecret;
    }
    if (process.env.NODE_ENV === 'production') {
        cachedSecret = crypto.randomBytes(32);
        console.error('[CertificateToken] LEARNING_CERT_SECRET / PUBLIC_SHARE_TOKEN_SECRET not set and the startup bootstrap has not run — certificate serials and verify links will change on every restart. Set LEARNING_CERT_SECRET (32+ chars) to fix this permanently.');
        return cachedSecret;
    }
    const projHash = crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
    const cachePath = path.join(os.tmpdir(), `beeflow-learning-cert-secret-${projHash}`);
    try {
        const stored = fs.readFileSync(cachePath);
        if (stored.length >= 32) { cachedSecret = stored; durableSecret = true; return cachedSecret; }
    } catch (_) { /* first run */ }
    cachedSecret = crypto.randomBytes(32);
    try { fs.writeFileSync(cachePath, cachedSecret, { mode: 0o600 }); durableSecret = true; }
    catch (err) { console.warn(`[CertificateToken] Could not persist dev secret (${err.message})`); }
    return cachedSecret;
}

// True when serials/verify tokens survive a restart (env, bootstrapped, or
// persisted dev secret). The issue endpoint refuses public certificates when
// this is false rather than minting links that will silently die.
function hasDurableSecret() {
    if (!cachedSecret) getSecret();
    return durableSecret;
}

// Startup bootstrap for installs that never set the env var: persist a random
// secret in configStore once, and use it for every subsequent boot. Called from
// server startup; safe to call repeatedly (setSecretIfAbsent is ON CONFLICT DO
// NOTHING). Env secrets always win — installs that set one are untouched.
async function ensureDurableSecret() {
    const fromEnv = process.env.LEARNING_CERT_SECRET || process.env.PUBLIC_SHARE_TOKEN_SECRET;
    if (fromEnv && fromEnv.length >= 32) return true;
    try {
        const configStore = require('../stores/configStore');
        const stored = await configStore.setSecretIfAbsent('learning_cert_secret', crypto.randomBytes(48).toString('hex'));
        if (stored && stored.length >= 32) {
            cachedSecret = Buffer.from(stored, 'utf8');
            durableSecret = true;
            return true;
        }
    } catch (err) {
        console.error('[CertificateToken] Could not bootstrap a durable secret:', err.message);
    }
    return hasDurableSecret();
}

function hmac(input) {
    return crypto.createHmac('sha256', getSecret()).update(input).digest();
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // no I,L,O,U — unambiguous
function toBase32(buf, len) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (let i = 0; i < buf.length && out.length < len; i += 1) {
        value = (value << 8) | buf[i];
        bits += 8;
        while (bits >= 5 && out.length < len) {
            out += CROCKFORD[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    return out;
}

// "BF-XXXX-XXXX-XXXX" — deterministic per (certId, userId, issuedDayUTC).
function makeSerial(certId, userId, issuedDayUTC) {
    const digest = hmac(`serial|${certId}|${userId}|${issuedDayUTC}`);
    const body = toBase32(digest, 12);
    return `BF-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

// Deterministic public verify token (base64url) per (certId, userId).
function makeVerifyToken(certId, userId) {
    const digest = hmac(`verify|${certId}|${userId}`);
    return digest.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Public lookup key: clients present the verifyToken; we index by its hash so the
// stored index reveals nothing usable on its own.
function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { makeSerial, makeVerifyToken, tokenHash, hasDurableSecret, ensureDurableSecret };
