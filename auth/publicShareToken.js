/**
 * Public-share viewer auth — three signed tokens, all HMAC-SHA256:
 *
 *   1. Magic-link `k` query param  — emailed to an allow-listed recipient,
 *      proves "this email holder asked to view this share". Short TTL.
 *   2. Unlock cookie                — set by the server after a successful
 *      password-unlock or magic-link redemption; lets the viewer skip the
 *      gate on subsequent navigations to the same share. Bound to the
 *      share ID, NOT the raw token, so the cookie is useless if the share
 *      is revoked then re-issued with a new token.
 *   3. CSRF token                   — for the password-unlock POST.
 *
 * All three are derived from the same secret (PUBLIC_SHARE_TOKEN_SECRET),
 * but with distinct purpose prefixes so a token of one type cannot be
 * replayed as another. Dev-mode falls back to a persisted random key on
 * disk (same trick as webpagePreviewToken).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAGIC_LINK_TTL_MS = 24 * 60 * 60 * 1000;        // 24h
const UNLOCK_COOKIE_TTL_MS = 6 * 60 * 60 * 1000;      // 6h
const CSRF_TTL_MS = 30 * 60 * 1000;                   // 30m

let cachedSecret = null;

function getSecret() {
    if (cachedSecret) return cachedSecret;
    const fromEnv = process.env.PUBLIC_SHARE_TOKEN_SECRET;
    if (fromEnv && fromEnv.length >= 32) {
        cachedSecret = Buffer.from(fromEnv, 'utf8');
        return cachedSecret;
    }
    if (process.env.NODE_ENV === 'production') {
        cachedSecret = crypto.randomBytes(32);
        console.warn(
            '[PublicShareToken] PUBLIC_SHARE_TOKEN_SECRET is not set in production. ' +
            'Magic links + unlock cookies will be invalidated on every restart. ' +
            'Generate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
        );
        return cachedSecret;
    }
    const projHash = crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
    const cachePath = path.join(os.tmpdir(), `beeflow-public-share-secret-${projHash}`);
    try {
        const stored = fs.readFileSync(cachePath);
        if (stored.length >= 32) { cachedSecret = stored; return cachedSecret; }
    } catch (_) { /* first run */ }
    cachedSecret = crypto.randomBytes(32);
    try { fs.writeFileSync(cachePath, cachedSecret, { mode: 0o600 }); }
    catch (err) { console.warn(`[PublicShareToken] Could not persist dev secret (${err.message})`); }
    return cachedSecret;
}

function b64urlEncode(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function signPayload(purpose, payload) {
    const payloadStr = JSON.stringify({ p: purpose, ...payload });
    const payloadB64 = b64urlEncode(payloadStr);
    const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
    return `${payloadB64}.${b64urlEncode(sig)}`;
}

function verifyPayload(purpose, token) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot < 1) return null;
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    let expectedSig;
    try { expectedSig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest(); }
    catch (_) { return null; }
    let providedSig;
    try { providedSig = b64urlDecode(sigB64); } catch (_) { return null; }
    if (providedSig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;
    let payload;
    try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); }
    catch (_) { return null; }
    if (!payload || payload.p !== purpose) return null;
    if (typeof payload.e === 'number' && payload.e < Date.now()) return null;
    return payload;
}

// ── Magic link (email-gated mode) ──────────────────────────────────

function issueMagicLink({ shareId, email }) {
    return signPayload('magic', {
        s: shareId,
        m: String(email).trim().toLowerCase(),
        e: Date.now() + MAGIC_LINK_TTL_MS,
    });
}

function verifyMagicLink(token, expectedShareId) {
    const p = verifyPayload('magic', token);
    if (!p) return null;
    if (p.s !== expectedShareId) return null;
    return { email: p.m, expiresAt: p.e };
}

// ── Unlock cookie ──────────────────────────────────────────────────

function issueUnlockCookie({ shareId, email }) {
    return signPayload('unlock', {
        s: shareId,
        ...(email ? { m: String(email).trim().toLowerCase() } : {}),
        e: Date.now() + UNLOCK_COOKIE_TTL_MS,
    });
}

function verifyUnlockCookie(token, expectedShareId) {
    const p = verifyPayload('unlock', token);
    if (!p) return null;
    if (p.s !== expectedShareId) return null;
    return { email: p.m || null, expiresAt: p.e };
}

// ── CSRF (password-unlock form) ────────────────────────────────────

function issueCsrf(shareId) {
    return signPayload('csrf', { s: shareId, e: Date.now() + CSRF_TTL_MS });
}

function verifyCsrf(token, expectedShareId) {
    const p = verifyPayload('csrf', token);
    return !!(p && p.s === expectedShareId);
}

module.exports = {
    issueMagicLink,
    verifyMagicLink,
    issueUnlockCookie,
    verifyUnlockCookie,
    issueCsrf,
    verifyCsrf,
    UNLOCK_COOKIE_TTL_MS,
    MAGIC_LINK_TTL_MS,
};
