/**
 * Nextcloud Connector JWT Auth Middleware
 *
 * Handles requests originating from the Bee Flow Nextcloud ExApp connector
 * (see nextcloud-connector/src/auth.js). The connector mints a short-lived
 * HS256 JWT signed with the customer's tenant key and forwards it as
 * `Authorization: Bearer <jwt>` plus an `X-Beeflow-Source: nextcloud-connector`
 * marker.
 *
 * Flow on this side:
 *   1. Spot the connector marker — if absent, fall through (PAT / cookie auth
 *      handle their own paths and we must not interfere with them).
 *   2. Resolve the tenant key. The connector signs with one specific
 *      customer's key, but the JWT body doesn't tell us which customer —
 *      that's the whole point of HS256 (we re-derive who it is by trying
 *      keys until one verifies). For a small number of tenants we iterate;
 *      at scale we'd index by a key hint in the JWT header (kid).
 *   3. Verify the signature, decode the payload, look up the user by email,
 *      populate req.session exactly the way patAuth.js does so downstream
 *      handlers see no difference.
 *   4. Reject (403) if the email isn't provisioned — never auto-create users
 *      from the connector path.
 *
 * Tenant keys live in configStore as encrypted secrets keyed
 * `connector_tenant_key_<organizationId>`. They're minted by the admin
 * endpoint added in server/routes/adminRoutes.js (see relatedconnector PR).
 */

const crypto = require('crypto');
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');

const TENANT_KEY_PREFIX = 'connector_tenant_key_';

// In-memory cache of (orgId → tenant key) — avoids hitting configStore on
// every request. Invalidated on key rotation by the admin endpoint via
// invalidateTenantKeyCache().
const _keyCache = new Map();
const KEY_CACHE_TTL_MS = 60_000;

function _cacheGet(orgId) {
    const entry = _keyCache.get(orgId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        _keyCache.delete(orgId);
        return null;
    }
    return entry.key;
}

function _cacheSet(orgId, key) {
    _keyCache.set(orgId, { key, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
}

function invalidateTenantKeyCache(orgId) {
    if (orgId) _keyCache.delete(orgId);
    else _keyCache.clear();
}

function _b64urlDecode(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function _timingSafeEq(a, b) {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Verify an HS256 JWT against a candidate key. Returns the decoded payload
 * on success, throws on any failure (signature mismatch, expired, malformed).
 */
function _verifyHs256(token, key) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed JWT');
    const [hB64, pB64, sB64] = parts;

    const header = JSON.parse(_b64urlDecode(hB64).toString('utf8'));
    if (header.alg !== 'HS256') throw new Error(`unexpected alg: ${header.alg}`);
    if (header.typ && header.typ !== 'JWT') throw new Error(`unexpected typ: ${header.typ}`);

    const expected = crypto.createHmac('sha256', key)
        .update(`${hB64}.${pB64}`)
        .digest();
    const provided = _b64urlDecode(sB64);
    if (!_timingSafeEq(expected, provided)) throw new Error('signature mismatch');

    const payload = JSON.parse(_b64urlDecode(pB64).toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now >= payload.exp) throw new Error('token expired');
    if (payload.nbf && now < payload.nbf) throw new Error('token not yet valid');
    if (payload.iss && payload.iss !== 'nextcloud-connector') throw new Error(`unexpected iss: ${payload.iss}`);
    if (payload.aud && payload.aud !== 'beeflow.ai') throw new Error(`unexpected aud: ${payload.aud}`);

    return payload;
}

/**
 * Try every known tenant key until one verifies the JWT.
 *
 * For a single-digit number of tenants this is fine. Past ~50 we should
 * include a `kid` (key id) in the JWT header on the connector side and
 * index by that here.
 */
async function _resolveTenant(token) {
    const orgIds = await configStore.listKeysWithPrefix?.(TENANT_KEY_PREFIX)
        ?? await _listOrgIdsFallback();
    for (const orgId of orgIds) {
        let key = _cacheGet(orgId);
        if (!key) {
            key = await configStore.getSecret(TENANT_KEY_PREFIX + orgId);
            if (!key) continue;
            _cacheSet(orgId, key);
        }
        try {
            const payload = _verifyHs256(token, key);
            return { orgId, payload };
        } catch (_) {
            // try the next key
        }
    }
    return null;
}

/**
 * Fallback for configStore impls that lack listKeysWithPrefix. The
 * connector's expected scale is single-digit tenants for the first quarter,
 * so a full scan via getAllConfigs is acceptable.
 */
async function _listOrgIdsFallback() {
    if (typeof configStore.getAllConfigs !== 'function') return [];
    const all = await configStore.getAllConfigs();
    return Object.keys(all || {})
        .filter(k => k.startsWith(TENANT_KEY_PREFIX))
        .map(k => k.slice(TENANT_KEY_PREFIX.length));
}

async function connectorJwtMiddleware(req, res, next) {
    // Skip if the cookie session is already authenticated — let session take
    // precedence so users who log in normally aren't surprised.
    if (req.session?.isAuthenticated && req.session?.user?.id) {
        return next();
    }

    // Connector requests are tagged with this header. Without it, fall through
    // to patAuth and the rest of the chain.
    if (req.headers['x-beeflow-source'] !== 'nextcloud-connector') {
        return next();
    }

    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
        return next();
    }

    const token = authHeader.slice(7).trim();
    // Reject anything that isn't a JWT-shaped string before we hash-walk
    // tenant keys.
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        return next();
    }

    try {
        const resolved = await _resolveTenant(token);
        if (!resolved) {
            return res.status(401).json({ error: 'Connector token rejected: no matching tenant key' });
        }
        const { orgId, payload } = resolved;
        if (!payload.email) {
            return res.status(400).json({ error: 'Connector token missing email claim' });
        }

        const user = await userStore.getUserByEmail(payload.email);
        if (!user) {
            return res.status(403).json({
                error: 'Your Nextcloud account is not provisioned in Bee Flow yet. Ask your Bee Flow administrator to add you.',
            });
        }
        // Defence in depth: the JWT was signed with org X's key, so the user
        // it identifies must belong to org X. Refusing here prevents a stolen
        // tenant key from being used to act on users in other tenants.
        if (user.organizationId && user.organizationId !== orgId) {
            console.warn(`[ConnectorJWT] Cross-tenant rejection: user ${user.id} (org=${user.organizationId}) presented org=${orgId}'s key`);
            return res.status(403).json({ error: 'Token does not match user tenant' });
        }

        req.session.isAuthenticated = true;
        req.session.user = {
            id: user.id,
            email: user.email,
            displayName: user.displayName || user.id,
            role: user.role || 'user',
            organizationId: user.organizationId || orgId,
        };
        req.session.isAdmin = user.role === 'admin';
        req.connectorAuth = {
            orgId,
            ncUid: req.headers['x-beeflow-nc-uid'] || payload.sub || null,
        };
    } catch (err) {
        console.warn(`[ConnectorJWT] Auth failed for ${req.method} ${req.url}: ${err.message}`);
        return res.status(401).json({ error: 'Invalid connector token' });
    }

    next();
}

module.exports = connectorJwtMiddleware;
module.exports.invalidateTenantKeyCache = invalidateTenantKeyCache;
module.exports._verifyHs256 = _verifyHs256; // exported for tests
