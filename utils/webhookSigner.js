/**
 * Outbound webhook signing.
 *
 * Any outbound webhook Bee Flow delivers — automation/rule subscribers,
 * custom integrations, agent event notifications — should go through
 * `signedFetch(orgId, url, body, opts)`. It:
 *
 *   1. Looks up or generates a per-org HMAC signing key (stored encrypted
 *      in configStore under `org_webhook_signing_key_{orgId}`).
 *   2. Computes `HMAC_SHA256(secret, "${ts}.${body}")` and sends:
 *        X-Beeflow-Timestamp: <unix-seconds>
 *        X-Beeflow-Signature: t=<unix-seconds>,v1=<hex-hmac>
 *   3. POSTs the body and returns the fetch response.
 *
 * Receivers verify by recomputing the same HMAC and rejecting any timestamp
 * older than ~5 minutes. The format mirrors Stripe's webhook signature
 * scheme so existing libraries can be adapted with minimal effort.
 *
 * The signing key is generated lazily on first use per org and rotated only
 * when an admin explicitly does so (no scheduled rotation yet — when one is
 * added, set the new key and keep the old key as `…_prev` for the verifier
 * grace window).
 */

const crypto = require('crypto');
const configStore = require('../stores/configStore');

const KEY_PREFIX = 'org_webhook_signing_key_';
const TIMESTAMP_HEADER = 'X-Beeflow-Timestamp';
const SIGNATURE_HEADER = 'X-Beeflow-Signature';
const VERSION = 'v1';

/**
 * Get the signing key for an org, creating one on first call. The key is
 * a 32-byte random value hex-encoded; configStore encrypts it at rest.
 *
 * @param {string} orgId
 * @returns {Promise<string>} hex-encoded HMAC key
 */
async function getOrCreateSigningKey(orgId) {
    if (!orgId) throw new Error('orgId required for webhook signing');
    const key = `${KEY_PREFIX}${orgId}`;
    try {
        const existing = await configStore.getSecret(key);
        if (existing && typeof existing === 'string' && existing.length >= 32) return existing;
    } catch (_) { /* fall through to create */ }
    // Lazy path. createOrganization pre-generates this; if we get here, it
    // means the pre-generation step failed or this org pre-dates that fix.
    // Log a warning so the discrepancy surfaces in logs.
    console.warn(`[WebhookSigner] lazy-creating signing key for org ${orgId} — pre-generation missing`);
    const fresh = crypto.randomBytes(32).toString('hex');
    try {
        await configStore.setSecret(key, fresh, { auditCtx: { actor: 'system', org: orgId, reason: 'lazy_init' } });
    } catch (e) {
        console.warn(`[WebhookSigner] failed to persist signing key for org ${orgId}: ${e.message}`);
    }
    return fresh;
}

/**
 * Compute the HMAC signature for a (timestamp, body) pair using the org's
 * signing key. Exposed separately so receivers can verify in-process.
 *
 * @param {string} secret hex-encoded HMAC key
 * @param {number|string} timestamp unix seconds
 * @param {string} body raw request body
 * @returns {string} hex-encoded HMAC-SHA256
 */
function computeSignature(secret, timestamp, body) {
    const h = crypto.createHmac('sha256', secret);
    h.update(`${timestamp}.${body}`);
    return h.digest('hex');
}

/**
 * Constant-time HMAC comparison. Verifies an `X-Beeflow-Signature` header
 * value (`t=<ts>,v1=<hmac>`) against a recomputed signature, and enforces a
 * timestamp tolerance to reject replays.
 *
 * @param {string} secret
 * @param {string} signatureHeader full header value
 * @param {string} body raw body
 * @param {number} toleranceSeconds default 300 (5 minutes)
 * @returns {boolean}
 */
function verifySignature(secret, signatureHeader, body, toleranceSeconds = 300) {
    if (!secret || !signatureHeader || typeof signatureHeader !== 'string') return false;
    const parts = Object.fromEntries(
        signatureHeader.split(',').map(p => p.split('=').map(s => s.trim()))
    );
    const ts = Number(parts.t);
    const v1 = parts[VERSION];
    if (!Number.isFinite(ts) || !v1) return false;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > toleranceSeconds) return false;
    const expected = computeSignature(secret, ts, body);
    try {
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(v1, 'hex');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch (_) { return false; }
}

/**
 * POST a signed webhook. The body is JSON-encoded (or passed through if
 * already a string). Returns the raw Response.
 *
 * @param {string} orgId
 * @param {string} url
 * @param {object|string} body
 * @param {{ method?: string, headers?: object, timeoutMs?: number }} opts
 */
async function signedFetch(orgId, url, body, opts = {}) {
    const secret = await getOrCreateSigningKey(orgId);
    const bodyString = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const ts = Math.floor(Date.now() / 1000);
    const sig = computeSignature(secret, ts, bodyString);

    const controller = new AbortController();
    const timeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 15000;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(url, {
            method: opts.method || 'POST',
            headers: {
                'Content-Type': 'application/json',
                [TIMESTAMP_HEADER]: String(ts),
                [SIGNATURE_HEADER]: `t=${ts},${VERSION}=${sig}`,
                ...(opts.headers || {}),
            },
            body: bodyString,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    getOrCreateSigningKey,
    computeSignature,
    verifySignature,
    signedFetch,
    HEADERS: { TIMESTAMP: TIMESTAMP_HEADER, SIGNATURE: SIGNATURE_HEADER },
};
