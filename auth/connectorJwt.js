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
 *   1. Spot the connector marker — if absent, fall through (cookie auth
 *      handles its own paths and we must not interfere with it).
 *   2. Resolve the tenant key. The connector signs with one specific
 *      customer's key, but the JWT body doesn't tell us which customer —
 *      that's the whole point of HS256 (we re-derive who it is by trying
 *      keys until one verifies). For a small number of tenants we iterate;
 *      at scale we'd index by a key hint in the JWT header (kid).
 *   3. Verify the signature, decode the payload, look up the user by email,
 *      populate req.session so downstream handlers see no difference from a
 *      cookie session.
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
const encryption = require('./encryption');
const orgRolesConfig = require('../config/orgRoles.json');

const TENANT_KEY_PREFIX = 'connector_tenant_key_';

// Default org-role for NC users auto-provisioned through the connector.
// `agent_editor` gives them what they expect coming from the embedded SPA:
// view + author agents/skills/knowledge, use notebooks — but no
// org-administration powers. An org-admin can override the default via
// org.nc_new_user_default_org_role and promote individual users later.
const VALID_ORG_ROLES = new Set(Object.keys(orgRolesConfig));
const DEFAULT_NC_USER_ORG_ROLE = 'agent_editor';

function resolveDefaultNcUserOrgRole(org) {
    const requested = String(org?.nc_new_user_default_org_role || '').trim();
    if (requested && VALID_ORG_ROLES.has(requested)) return requested;
    return DEFAULT_NC_USER_ORG_ROLE;
}

// In-memory cache of (orgId → tenant key) — avoids hitting configStore on
// every request. Invalidated on key rotation by the admin endpoint via
// invalidateTenantKeyCache().
const _keyCache = new Map();
const KEY_CACHE_TTL_MS = 60_000;

// Cache derived encryption keys per userId. The fallback key uses PBKDF2 with
// 210k iterations (~50-100ms each) — running that on every request is
// noticeable in chat latency. The derived key is fully determined by
// userId + MASTER_ENCRYPTION_KEY, both stable, so we cache forever (process
// lifetime). Cleared on server restart.
const _encKeyCache = new Map();

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
    if (payload.aud && payload.aud !== 'beeflow.nl') throw new Error(`unexpected aud: ${payload.aud}`);

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
    // configStore exports `getAllConfig` (singular) — match that. The earlier
    // typo caused this to silently return [] and reject every connector JWT
    // with "no matching tenant key" even when the tenant key was present.
    const fn = configStore.getAllConfig || configStore.getAllConfigs;
    if (typeof fn !== 'function') return [];
    const all = await fn();
    return Object.keys(all || {})
        .filter(k => k.startsWith(TENANT_KEY_PREFIX))
        .map(k => k.slice(TENANT_KEY_PREFIX.length));
}


async function connectorJwtMiddleware(req, res, next) {
    // Skip if the cookie session is already authenticated — let session take
    // precedence so users who log in normally aren't surprised.
    // BUT: if the session claims a user that no longer exists in the DB
    // (e.g. admin deleted the org, dev `reset` wiped users) the connector
    // headers should be allowed to re-establish the session. Otherwise the
    // SPA sits on the login form forever even though the connector is
    // sending valid headers.
    if (req.session?.isAuthenticated && req.session?.user?.id) {
        const stillExists = await userStore.getUser(req.session.user.id).catch(() => null);
        if (stillExists) return next();
        // Stale session — destroy it and fall through to header-based auth.
        console.log(`[ConnectorJWT] Dropping stale session for missing user ${req.session.user.id}`);
        await new Promise(resolve => req.session.destroy(() => resolve()));
    }

    // Connector requests are tagged with this header. Without it, fall through
    // to the rest of the chain.
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

        let user = await userStore.getUserByEmail(payload.email);
        if (!user) {
            // Auto-provision: org's sync_mode determines whether we silently
            // create the user (active vs pending) or reject. This is the path
            // every NC user takes on their first click of the Bee Flow icon
            // after the org is bootstrapped — see plan/connector docs.
            const org = await userStore.getOrganization(orgId);
            if (!org) {
                return res.status(403).json({ error: 'Connector tenant has no organization' });
            }
            // Hold auto-provision until the org-admin has finished the App
            // Store onboarding wizard. Otherwise users would land here with
            // pre-wizard defaults (mirror_all + active) which the admin may
            // be about to switch to pending-approval / selective_groups.
            // The SPA-side render gate translates this 403 into a friendly
            // "Setup in progress" screen.
            if (org.nc_instance_id && !org.nc_onboarding_completed_at) {
                return res.status(403).json({
                    error: 'Setup in progress — your organization administrator is finalising the Bee Flow setup. Please refresh in a few minutes.',
                    code: 'NC_ONBOARDING_PENDING',
                });
            }
            const mode = org.nc_sync_mode || 'mirror_all';
            if (mode === 'manual') {
                return res.status(403).json({
                    error: 'Your Nextcloud account is not provisioned in Bee Flow yet. Ask your Bee Flow administrator to invite you.',
                });
            }
            const ncUid = String(req.headers['x-beeflow-nc-uid'] || payload.sub || '').trim();
            const status = (org.nc_new_user_default_status === 'pending') ? 'pending' : 'active';
            const userId = `nc_${orgId}_${(ncUid || payload.email).replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40)}`;
            const defaultOrgRole = resolveDefaultNcUserOrgRole(org);
            const r = await userStore.createUserWithSeatCheck({
                id: userId,
                username: payload.email,
                email: payload.email,
                displayName: payload.name || ncUid || payload.email,
                role: 'user',
                orgRole: defaultOrgRole,
                organizationId: orgId,
                ncUid: ncUid || null,
                provider: 'nextcloud_connector',
                autoProvisioned: true,
                status,
            }, { strict: false });
            if (!r.created) {
                if (r.reason === 'seat_cap') {
                    return res.status(403).json({
                        error: 'Your organization has reached its user seat limit. Ask your Bee Flow administrator to upgrade.',
                        code: 'seat_cap_exceeded',
                    });
                }
                console.warn(`[ConnectorJWT] auto-provision failed userId=${userId} reason=${r.reason}`);
                return res.status(500).json({ error: 'Failed to provision user' });
            }
            user = await userStore.getUser(userId);
            console.log(`[ConnectorJWT] Auto-provisioned user ${userId} (org=${orgId}, status=${status})`);
            if (status === 'pending') {
                return res.status(403).json({
                    error: 'Your account has been created in Bee Flow but requires admin approval. Please contact your organization administrator.',
                });
            }
        } else if (user.organizationId && user.organizationId !== orgId) {
            // Defence in depth: the JWT was signed with org X's key, so the user
            // it identifies must belong to org X. Refusing here prevents a stolen
            // tenant key from being used to act on users in other tenants.
            console.warn(`[ConnectorJWT] Cross-tenant rejection: user ${user.id} (org=${user.organizationId}) presented org=${orgId}'s key`);
            return res.status(403).json({ error: 'Token does not match user tenant' });
        }
        if (user.status === 'pending') {
            return res.status(403).json({ error: 'Account is pending admin approval' });
        }

        // Observability: surface data-corruption — a user marked as connector-
        // sourced should always live under an NC-bound org. If we ever see
        // provider=nextcloud_connector under an org without nc_instance_id,
        // that's a sign of broken state (manual edit, failed migration, or a
        // standalone-tenant data leak). Pure log; behaviour unchanged. Only
        // resolves the org for connector-sourced users so non-NC traffic
        // doesn't pay an extra DB roundtrip.
        if (user.provider === 'nextcloud_connector') {
            const orgForCheck = await userStore.getOrganization(user.organizationId || orgId).catch(() => null);
            if (orgForCheck && !orgForCheck.nc_instance_id) {
                console.warn(`[ConnectorJWT] Data anomaly: user ${user.id} has provider=nextcloud_connector but org ${orgForCheck.id} has no nc_instance_id`);
            }
        }

        const ncUid = user.nc_uid || req.headers['x-beeflow-nc-uid'] || payload.sub || null;
        req.session.isAuthenticated = true;
        req.session.user = {
            id: user.id,
            email: user.email,
            displayName: user.displayName || user.id,
            role: user.role || 'user',
            orgRole: user.orgRole || '',
            organizationId: user.organizationId || orgId,
            ncUid,
            provider: user.provider || 'nextcloud_connector',
        };
        req.session.isAdmin = user.role === 'admin';
        // Populate the connector binding so server/integrations/nextcloudClient.js
        // resolveConnectorAuth() can route NC calls through the connector's
        // /nc/* proxy without per-request DB lookups.
        req.session.connectorOrgId = orgId;
        req.session.connectorNcUid = ncUid;
        req.connectorAuth = { orgId, ncUid };

        // Inject encryptionKey for endpoints that read encrypted user state
        // (chat history, agent conversations). The connector path acts like
        // an SSO provider — we trust the upstream Nextcloud session, so we
        // try SSO-recovery first (matches oauthRoutes.js:262 / adminRoutes.js:366),
        // and fall back to the deterministic master-key derivation. Without
        // this, chat.js:239 reads `req.session?.encryptionKey === undefined`
        // and fails on encrypted-conversation lookup.
        //
        // Cached: PBKDF2 with 210k iterations is too expensive to do on
        // every request. Both the SSO-recovery DEK and the deterministic
        // fallback are stable for the user's lifetime (until they explicitly
        // rotate via the encryption-pin flow), so first computation wins.
        try {
            let cachedEnc = _encKeyCache.get(user.id);
            if (!cachedEnc) {
                const sso = await encryption.getOrCreateSSOUserDEKCompat(user.id, true);
                if (sso?.encryptionKey) {
                    cachedEnc = sso.encryptionKey;
                } else if (process.env.MASTER_ENCRYPTION_KEY) {
                    cachedEnc = encryption.getFallbackEncryptionKey(user.id);
                }
                if (cachedEnc) _encKeyCache.set(user.id, cachedEnc);
            }
            if (cachedEnc) req.session.encryptionKey = cachedEnc;
        } catch (e) {
            console.warn(`[ConnectorJWT] EncryptionKey derivation failed for user ${user.id}: ${e.message}`);
        }

        // Persist the session row to PostgreSQL before continuing. Without
        // this, express-session (saveUninitialized: false) drops the
        // populated session and every subsequent SPA request from the
        // iframe arrives unauthenticated → 401 storm.
        req.session.save((saveErr) => {
            if (saveErr) {
                console.error('[ConnectorJWT] Session save failed:', saveErr.message);
                return res.status(500).json({ error: 'Session persistence failed' });
            }
            next();
        });
        return;
    } catch (err) {
        console.warn(`[ConnectorJWT] Auth failed for ${req.method} ${req.url}: ${err.message}`);
        return res.status(401).json({ error: 'Invalid connector token' });
    }
}

module.exports = connectorJwtMiddleware;
module.exports.invalidateTenantKeyCache = invalidateTenantKeyCache;
module.exports._verifyHs256 = _verifyHs256; // exported for tests
