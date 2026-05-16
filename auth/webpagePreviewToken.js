/**
 * Webpage Preview Tokens — short-lived HMAC-signed bearer tokens that let
 * the sandboxed preview iframe call back to the host API across origins.
 *
 * Why a token, not the session cookie:
 *   The preview iframe runs with `sandbox="allow-scripts"` (no
 *   `allow-same-origin`), giving it an opaque origin that can't carry the
 *   user's session cookie. Anything the iframe wants from the API has to be
 *   cross-origin and authenticated by some other means.
 *
 * Token shape:  base64url(payload) "." base64url(hmac_sha256(secret, payload))
 *               where payload = base64url(JSON({ u: userId, w: webpageId, e: expiresAtMs }))
 *
 * The signing secret is `WEBPAGE_PREVIEW_TOKEN_SECRET`. In dev, when unset,
 * we generate a random 32-byte key on first call and warn — that's enough to
 * make local dev work without leaking tokens between unrelated machines.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
let cachedSecret = null;

function getSecret() {
    if (cachedSecret) return cachedSecret;

    const fromEnv = process.env.WEBPAGE_PREVIEW_TOKEN_SECRET;
    if (fromEnv && fromEnv.length >= 32) {
        cachedSecret = Buffer.from(fromEnv, 'utf8');
        return cachedSecret;
    }

    // Production must have the env var. Falling back to a random secret
    // there would invalidate every active preview token on each restart;
    // we keep the warning loud so operators notice in their logs.
    if (process.env.NODE_ENV === 'production') {
        cachedSecret = crypto.randomBytes(32);
        console.warn(
            '[WebpagePreviewToken] WEBPAGE_PREVIEW_TOKEN_SECRET is not set in production. ' +
            'Preview tokens will be invalidated on every restart. Generate one with: ' +
            'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))" ' +
            'and add it to your environment.'
        );
        return cachedSecret;
    }

    // Dev: persist the generated secret to a per-project file in OS temp so
    // a nodemon restart keeps the same secret. Keyed on cwd so two checkouts
    // get distinct files; tmp is wiped on reboot which is fine for dev.
    // Silent by design — operators only see noise from this module when
    // something is actually wrong (production misconfig, write failure).
    const projHash = crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
    const cachePath = path.join(os.tmpdir(), `beeflow-webpage-preview-secret-${projHash}`);
    try {
        const stored = fs.readFileSync(cachePath);
        if (stored.length >= 32) {
            cachedSecret = stored;
            return cachedSecret;
        }
    } catch (_) { /* missing file — first run, fall through */ }

    cachedSecret = crypto.randomBytes(32);
    try {
        fs.writeFileSync(cachePath, cachedSecret, { mode: 0o600 });
    } catch (err) {
        // Persistence failed (read-only tmp, permission issue, …) — fall back
        // to in-memory only. Worth a warning because tokens will now reset on
        // every restart for this process.
        console.warn(
            `[WebpagePreviewToken] Could not persist dev secret (${err.message}); ` +
            'preview tokens will be invalidated on every restart.'
        );
    }
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

/**
 * Issue a token bound to (userId, webpageId) for `ttlMs` milliseconds.
 */
function issuePreviewToken({ userId, webpageId, ttlMs = DEFAULT_TTL_MS }) {
    if (!userId || !webpageId) throw new Error('userId and webpageId are required');
    const expiresAt = Date.now() + Math.max(60_000, ttlMs);
    const payload = JSON.stringify({ u: userId, w: webpageId, e: expiresAt });
    const payloadB64 = b64urlEncode(payload);
    const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
    return {
        token: `${payloadB64}.${b64urlEncode(sig)}`,
        expiresAt,
    };
}

/**
 * Verify a token. Returns `{ userId, webpageId, expiresAt }` on success or
 * `null` on any failure (bad shape, bad signature, expired). Use `null`
 * uniformly so the route just does `if (!claims) return 401`.
 */
function verifyPreviewToken(token) {
    if (typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot < 1 || dot === token.length - 1) return null;
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);

    let expectedSig;
    try {
        expectedSig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
    } catch (_) {
        return null;
    }
    let providedSig;
    try { providedSig = b64urlDecode(sigB64); } catch (_) { return null; }
    if (providedSig.length !== expectedSig.length) return null;
    if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;

    let payload;
    try { payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')); } catch (_) { return null; }
    if (!payload || typeof payload !== 'object') return null;
    if (!payload.u || !payload.w || typeof payload.e !== 'number') return null;
    if (payload.e < Date.now()) return null;

    return { userId: payload.u, webpageId: payload.w, expiresAt: payload.e };
}

/**
 * Express middleware that pulls a Bearer token off the Authorization header,
 * verifies it, and stashes `{ userId, webpageId }` on `req.previewClaims`.
 * Also enforces that the token's webpageId matches the URL's `:id` so a
 * token issued for one webpage can't be used to query another.
 */
function requirePreviewToken(req, res, next) {
    const auth = req.headers['authorization'] || req.headers['Authorization'];
    if (!auth || typeof auth !== 'string') {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Authorization must be Bearer <token>' });

    const claims = verifyPreviewToken(m[1].trim());
    if (!claims) return res.status(401).json({ error: 'Invalid or expired preview token' });

    const urlWebpageId = req.params?.id;
    if (urlWebpageId && claims.webpageId !== urlWebpageId) {
        return res.status(403).json({ error: 'Preview token does not match this webpage' });
    }
    req.previewClaims = claims;
    next();
}

module.exports = {
    issuePreviewToken,
    verifyPreviewToken,
    requirePreviewToken,
};
