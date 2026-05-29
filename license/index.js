/**
 * License Module — Public API
 *
 * Single entry point for resolving the active tier, feature set, and limits
 * for an org or consumer user. When no license is present (or the active
 * one is expired/revoked), this falls back to `community` tier — the
 * system must remain usable without activation.
 *
 * Typical usage:
 *
 *   const license = require('./license');
 *
 *   const tier = await license.getTierForOrg(orgId);          // 'community' | 'enterprise' | 'full'
 *   const ok   = await license.hasFeature(orgId, 'automations');
 *   const lic  = await license.getLicenseStatus({ organizationId: orgId });
 *
 * Legacy `pro` tier values (from old JWTs, admin blobs, or subscription rows
 * minted before the Pro tier was retired) are normalised to `enterprise` at
 * every output boundary via tiers.normalizeTier — see server/license/tiers.js.
 */

const store = require('./store');
const verify = require('./verify');
const tiers = require('./tiers');
const adminIssuance = require('./adminIssuance');
const { tierFromPlanName } = require('./issuance');

const COMMUNITY_FALLBACK = 'community';

// Lazy-required to avoid circular import (userStore is heavy and pulls in
// DB init that depends on this module being loadable first).
let _userStore = null;
function getUserStore() {
    if (!_userStore) _userStore = require('../stores/userStore');
    return _userStore;
}

// ── Server-wide licence override ────────────────────────────────────────
//
// A super-admin on a self-hosted install can activate ONE licence row
// with scope='server' and no org/user binding. While such a row is
// active, every per-org and per-user tier lookup short-circuits to that
// row's tier — the whole install runs at one tier.
//
// `_serverTierCache` memoises the lookup with a short TTL so the override
// adds at most one DB hit every N seconds, not one per request.
//
// `_serverLicenseVersion` is bumped on every activate/deactivate so the
// per-request resolution cache key in license/middleware.js can be
// invalidated install-wide without enumerating sessions. Middleware
// reads it via getServerLicenseVersion() and weaves it into its cache
// key — a bump immediately rotates every entry.
const SERVER_TIER_CACHE_TTL_MS = parseInt(process.env.LICENSE_SERVER_TIER_CACHE_TTL_MS || '30000', 10);
let _serverTierCache = { expiresAt: 0, tier: COMMUNITY_FALLBACK, license: null };
let _serverLicenseVersion = 0;

function getServerLicenseVersion() {
    return _serverLicenseVersion;
}

function bumpServerLicenseVersion() {
    _serverLicenseVersion += 1;
    _serverTierCache = { expiresAt: 0, tier: COMMUNITY_FALLBACK, license: null };
}

/**
 * Resolve the currently active server-wide licence. Returns
 * `{ tier, license }` — tier is COMMUNITY_FALLBACK when no server row
 * is active or the row is expired/revoked. The licence object is the
 * raw row (with rawToken stripped on its way to public shapes).
 */
async function _getServerLicenseSnapshot() {
    const now = Date.now();
    if (_serverTierCache.expiresAt > now) return _serverTierCache;
    let license = null;
    try {
        license = await store.getActiveLicenseForServer();
    } catch (e) {
        // Missing table during cold start is benign — fall through to
        // community. Anything else surfaces to the caller via the next
        // resolver call (which logs).
        if (!(e && e.code === '42P01')) throw e;
    }
    const tier = resolveTierFromLicense(license);
    _serverTierCache = { expiresAt: now + SERVER_TIER_CACHE_TTL_MS, tier, license };
    return _serverTierCache;
}

async function getServerLicenseTier() {
    const snap = await _getServerLicenseSnapshot();
    return snap.tier;
}

/**
 * Whether an active server-wide licence GOVERNS per-org / per-user billing.
 *
 * On Bee Flow Cloud every organisation pays its own Stripe subscription, so a
 * server-wide licence is the platform operator's own record only — it must NOT
 * exempt orgs from needing a subscription, hide their subscription UI, or grant
 * them paid tiers for free. The licence still exists and is shown in the admin
 * Server-licence panel; it simply doesn't override per-org resolution.
 *
 * On self-hosted / private-cloud the server-wide licence IS the paid-access
 * mechanism and governs the whole install (every org/user runs at its tier).
 *
 * Sourced from DEPLOYMENT_MODE (default 'cloud'). Whitelisted so an unknown
 * value never silently turns billing off.
 */
function serverLicenseGovernsOrgs() {
    const mode = process.env.DEPLOYMENT_MODE || 'cloud';
    return mode === 'self-hosted' || mode === 'private-cloud';
}

/**
 * Resolve the effective tier for an organization. Returns 'community' when
 * no usable license is present.
 *
 * Two sources, license_keys wins by tier rank:
 *   1. license_keys (admin blob or signed JWT) — primary
 *   2. organization_subscriptions (Stripe-paid SaaS) — fallback when no
 *      license_keys row exists. This bridges the Stripe checkout → tier
 *      flow without requiring a deployed JWT license-server.
 */
async function getTierForOrg(organizationId) {
    // Server-wide licence overrides per-org rows — but only when it governs
    // billing (self-hosted / private-cloud). On cloud each org pays its own
    // subscription, so we fall through to the per-org licence / Stripe sub.
    const serverTier = await getServerLicenseTier();
    if (serverLicenseGovernsOrgs() && serverTier !== COMMUNITY_FALLBACK) return serverTier;
    if (!organizationId) return COMMUNITY_FALLBACK;
    const lic = await store.getActiveLicenseForOrg(organizationId);
    const licTier = resolveTierFromLicense(lic);
    if (licTier !== COMMUNITY_FALLBACK) return licTier;
    const subTier = await resolveTierFromOrgSubscription(organizationId);
    return subTier || COMMUNITY_FALLBACK;
}

async function getTierForUser(userId) {
    // Server-wide licence overrides per-user rows — but only when it governs
    // billing (self-hosted / private-cloud). On cloud the user's own
    // subscription decides their tier.
    const serverTier = await getServerLicenseTier();
    if (serverLicenseGovernsOrgs() && serverTier !== COMMUNITY_FALLBACK) return serverTier;
    if (!userId) return COMMUNITY_FALLBACK;
    const lic = await store.getActiveLicenseForUser(userId);
    const licTier = resolveTierFromLicense(lic);
    if (licTier !== COMMUNITY_FALLBACK) return licTier;
    const subTier = await resolveTierFromConsumerSubscription(userId);
    return subTier || COMMUNITY_FALLBACK;
}

/**
 * Best tier across every license that touches the given set of orgs —
 * org-scoped licenses on those orgs OR consumer licenses held by users
 * whose primary org is one of those orgs. Spreads an admin's personal
 * license to the rest of the org so group-invited members don't get
 * `feature_locked` 403s while sharing a workspace with the licensee.
 *
 * Includes subscription-derived tiers for SaaS orgs without a license_keys row.
 */
async function getBestTierForOrgs(orgIds = []) {
    // Server-wide licence wins outright when it governs billing (self-hosted /
    // private-cloud); skip the org sweep. On cloud it doesn't override, so we
    // resolve from the orgs' own licences / subscriptions below.
    const serverTier = await getServerLicenseTier();
    if (serverLicenseGovernsOrgs() && serverTier !== COMMUNITY_FALLBACK) return serverTier;
    if (!Array.isArray(orgIds) || orgIds.length === 0) return COMMUNITY_FALLBACK;
    const licenses = await store.getActiveLicensesForOrgs(orgIds);
    let best = COMMUNITY_FALLBACK;
    for (const lic of licenses) {
        const t = resolveTierFromLicense(lic);
        if (tiers.tierRank(t) > tiers.tierRank(best)) best = t;
    }
    if (tiers.tierRank(best) >= tiers.tierRank('enterprise')) return best;
    for (const orgId of orgIds) {
        if (!orgId) continue;
        const t = await resolveTierFromOrgSubscription(orgId);
        if (t && tiers.tierRank(t) > tiers.tierRank(best)) best = t;
    }
    return best;
}

/**
 * Map a subscription row to a tier, honouring trial windows and payment status.
 * Returns null when the subscription is missing/inactive/expired.
 *
 * Active states that grant tier: 'active', 'trialing' (within trial_end_date).
 * Inactive: 'suspended', 'cancelled', 'past_due', expired trial without payment.
 */
function resolveTierFromSubscription(sub) {
    if (!sub) return null;
    const status = sub.status;
    if (status === 'cancelled' || status === 'suspended' || status === 'past_due') return null;
    if (status === 'trialing') {
        if (!sub.trial_end_date) return null;
        const trialEnd = new Date(sub.trial_end_date).getTime();
        if (!Number.isFinite(trialEnd) || trialEnd <= Date.now()) {
            if (sub.payment_status !== 'paid') return null;
        }
    }
    const tier = sub.plan_tier || tierFromPlanName(sub.plan_name);
    if (!tier || !tiers.isValidTier(tier)) return null;
    return tiers.normalizeTier(tier);
}

async function resolveTierFromOrgSubscription(organizationId) {
    try {
        const sub = await getUserStore().getOrgSubscription(organizationId);
        return resolveTierFromSubscription(sub);
    } catch (e) {
        // Missing table (early boot, fresh install) is benign — return null and
        // let the next source provide a tier. Anything else is a real DB error
        // and should bubble so middleware can fail-closed with 503.
        if (e && e.code === '42P01') return null;
        throw e;
    }
}

async function resolveTierFromConsumerSubscription(userId) {
    try {
        const sub = await getUserStore().getConsumerSubscription(userId);
        return resolveTierFromSubscription(sub);
    } catch (e) {
        if (e && e.code === '42P01') return null;
        throw e;
    }
}

/**
 * Resolve the active tier from a license row. Performs a sanity-check on
 * `expires_at` so a stale "active" row doesn't accidentally grant access.
 */
function resolveTierFromLicense(lic) {
    if (!lic) return COMMUNITY_FALLBACK;
    if (lic.refreshStatus === 'expired' || lic.refreshStatus === 'revoked') {
        return COMMUNITY_FALLBACK;
    }
    if (lic.expiresAt && new Date(lic.expiresAt).getTime() <= Date.now()) {
        return COMMUNITY_FALLBACK;
    }
    return tiers.isValidTier(lic.tier) ? tiers.normalizeTier(lic.tier) : COMMUNITY_FALLBACK;
}

/**
 * Returns true when the org/user has access to a named feature given their
 * current tier. Both `organizationId` and `userId` may be passed; the
 * higher of the two tiers wins (covers single-user installs in an org).
 */
async function hasFeature(scope, feature) {
    const tier = await resolveTier(scope);
    return tiers.tierHasFeature(tier, feature);
}

async function hasTier(scope, requiredTier) {
    const tier = await resolveTier(scope);
    return tiers.tierAtLeast(tier, requiredTier);
}

async function resolveTier(scope) {
    if (typeof scope === 'string') return getTierForOrg(scope);
    if (!scope || typeof scope !== 'object') return COMMUNITY_FALLBACK;
    const orgTier = scope.organizationId ? await getTierForOrg(scope.organizationId) : COMMUNITY_FALLBACK;
    const userTier = scope.userId ? await getTierForUser(scope.userId) : COMMUNITY_FALLBACK;
    return tiers.tierRank(orgTier) >= tiers.tierRank(userTier) ? orgTier : userTier;
}

/**
 * Full status object for the UI. Always returns a populated object so the
 * frontend can render a stable shape even on a fresh install.
 *
 * Resolution order:
 *   1. Highest-tier license_keys row across the org set (admin blob or JWT).
 *   2. organization_subscriptions on any of those orgs (Stripe SaaS).
 *   3. consumer_subscriptions on userId.
 *   4. Community fallback.
 */
async function getLicenseStatus({ organizationId = null, userId = null, orgIds = null } = {}) {
    // Snapshot the server-wide licence once. `serverLicense` is exposed on
    // every response (mode-independent) so the admin Server-licence panel can
    // always display it. Whether it OVERRIDES per-org billing depends on the
    // deployment mode — see serverLicenseGovernsOrgs().
    const serverSnap = await _getServerLicenseSnapshot();
    const serverLicense = serverSnap.license ? publicLicenseShape(serverSnap.license) : null;

    // Governing modes (self-hosted / private-cloud): the server licence covers
    // the whole install, so report it as the authoritative tier and tell the
    // per-org UI via `serverOverride: true` (no Stripe subscription needed).
    // On cloud this branch is skipped — orgs resolve their own subscription.
    if (serverLicenseGovernsOrgs() && serverSnap.tier !== COMMUNITY_FALLBACK && serverSnap.license) {
        return {
            tier: serverSnap.tier,
            source: 'license_key',
            scope: 'server',
            license: publicLicenseShape(serverSnap.license),
            subscription: null,
            features: tiers.getFeaturesForTier(serverSnap.tier),
            limits: tiers.getLimitsForTier(serverSnap.tier),
            serverOverride: true,
            serverLicense,
        };
    }

    let lic = null;
    let scope = null;

    // Build the candidate org set: explicit org, any extra orgIds (e.g. from
    // group memberships resolved via resolveUserOrgIds), in that order so the
    // user's direct org wins ties.
    const candidateOrgIds = [];
    if (organizationId) candidateOrgIds.push(organizationId);
    if (Array.isArray(orgIds)) {
        for (const id of orgIds) {
            if (id && !candidateOrgIds.includes(id)) candidateOrgIds.push(id);
        }
    } else if (orgIds instanceof Set) {
        for (const id of orgIds) {
            if (id && !candidateOrgIds.includes(id)) candidateOrgIds.push(id);
        }
    }

    // Pick the highest-tier active licence across every org the user touches,
    // including consumer licences held by users whose direct org is in that
    // set (so an admin's personal licence covers the rest of the org).
    if (candidateOrgIds.length > 0) {
        let best = null;
        let bestTier = tiers.TIER_HIERARCHY[0];
        const found = await store.getActiveLicensesForOrgs(candidateOrgIds);
        for (const candidate of found) {
            const t = resolveTierFromLicense(candidate);
            if (tiers.tierRank(t) > tiers.tierRank(bestTier)) {
                best = candidate;
                bestTier = t;
            }
        }
        if (best) {
            lic = best;
            scope = best.organizationId ? 'organization' : 'consumer';
        }
    }

    if (!lic && userId) {
        lic = await store.getActiveLicenseForUser(userId);
        scope = 'consumer';
    }

    let tier = resolveTierFromLicense(lic);

    // No license row beats community → consult Stripe subscriptions as fallback.
    let subscriptionShape = null;
    let subscriptionScope = null;
    if (tier === COMMUNITY_FALLBACK) {
        let bestSubTier = COMMUNITY_FALLBACK;
        let bestSubRow = null;
        for (const orgId of candidateOrgIds) {
            const sub = await getUserStore().getOrgSubscription(orgId).catch(() => null);
            const t = resolveTierFromSubscription(sub);
            if (t && tiers.tierRank(t) > tiers.tierRank(bestSubTier)) {
                bestSubTier = t;
                bestSubRow = sub;
                subscriptionScope = 'organization';
            }
        }
        if (bestSubTier === COMMUNITY_FALLBACK && userId) {
            const sub = await getUserStore().getConsumerSubscription(userId).catch(() => null);
            const t = resolveTierFromSubscription(sub);
            if (t && tiers.tierRank(t) > tiers.tierRank(bestSubTier)) {
                bestSubTier = t;
                bestSubRow = sub;
                subscriptionScope = 'consumer';
            }
        }
        if (bestSubTier !== COMMUNITY_FALLBACK) {
            tier = bestSubTier;
            subscriptionShape = publicSubscriptionShape(bestSubRow);
        }
    }

    const source = lic ? 'license_key' : (subscriptionShape ? 'stripe_subscription' : 'default');
    return {
        tier,
        source,
        scope: scope || subscriptionScope,
        license: lic ? publicLicenseShape(lic) : null,
        subscription: subscriptionShape,
        features: tiers.getFeaturesForTier(tier),
        limits: tiers.getLimitsForTier(tier),
        // `serverOverride` is false here (this path runs when no governing
        // server licence applies), but `serverLicense` still surfaces an
        // existing server row so the admin panel can show/manage it on cloud.
        serverOverride: false,
        serverLicense,
    };
}

function publicSubscriptionShape(sub) {
    if (!sub) return null;
    const rawTier = sub.plan_tier || tierFromPlanName(sub.plan_name) || null;
    return {
        planId: sub.plan_id,
        planName: sub.plan_name,
        tier: rawTier ? tiers.normalizeTier(rawTier) : null,
        status: sub.status,
        paymentStatus: sub.payment_status,
        trialEndDate: sub.trial_end_date,
        billingCycleStart: sub.billing_cycle_start,
        stripeSubscriptionId: sub.stripe_subscription_id,
    };
}

/**
 * Strip server-internal fields (raw_token) before sending to the client.
 */
function publicLicenseShape(lic) {
    return {
        id: lic.id,
        tier: tiers.normalizeTier(lic.tier),
        issuer: lic.issuer,
        issuedAt: lic.issuedAt,
        expiresAt: lic.expiresAt,
        billingInterval: lic.billingInterval,
        lastRefreshAt: lic.lastRefreshAt,
        refreshStatus: lic.refreshStatus,
        revokedAt: lic.revokedAt,
        scope: lic.scope,
        metadata: lic.metadata || {},
    };
}

/**
 * Activate a license: verify the token, then persist it. Returns the
 * activated license row (without raw_token). Throws on verification failure.
 */
async function activateLicense({ token, organizationId = null, userId = null, activatedBy = null, scope: explicitScope = null }) {
    // Admin-issued blob path — no JWT verify, trust comes from the activate
    // endpoint's existing admin/org-admin gate.
    if (typeof token === 'string' && token.startsWith(adminIssuance.BLOB_PREFIX)) {
        let decoded;
        try {
            decoded = adminIssuance.decodeAdminLicenseBlob(token);
        } catch (e) {
            const err = new Error(`License verification failed: malformed_admin_blob`);
            err.code = 'malformed_admin_blob';
            throw err;
        }
        if (decoded.v !== 1) {
            const err = new Error(`License verification failed: unsupported_blob_version`);
            err.code = 'unsupported_blob_version';
            throw err;
        }
        if (!tiers.isValidTier(decoded.tier)) {
            const err = new Error(`License verification failed: invalid_tier`);
            err.code = 'invalid_tier';
            throw err;
        }
        const expMs = new Date(decoded.expires_at).getTime();
        if (!Number.isFinite(expMs) || expMs <= Date.now()) {
            const err = new Error(`License verification failed: token_expired`);
            err.code = 'token_expired';
            throw err;
        }
        // No ALLOW_ADMIN_FULL_TIER check here — issuance is the security
        // boundary. If an admin-issued blob carries tier=full, the receiver
        // honours it. Otherwise customers couldn't activate a Full-tier
        // license unless they set the env var locally too.

        // Explicit `scope: 'server'` from the caller takes precedence over
        // the legacy "infer from userId" rule. Used by the super-admin
        // server-wide activate path; everything else still falls through.
        let blobScope;
        if (explicitScope === 'server') blobScope = 'server';
        else if (userId) blobScope = 'consumer';
        else blobScope = 'organization';
        const orgIdResolved = blobScope === 'organization' ? (organizationId || decoded.organization_id || null) : null;
        const userIdResolved = blobScope === 'consumer' ? (userId || null) : null;
        if (blobScope === 'organization' && !orgIdResolved) {
            const err = new Error('No organization context for license activation');
            err.code = 'missing_org_context';
            throw err;
        }

        // Mint a fresh license_id so the receiver's row doesn't collide with
        // the issuer's row when both happen to live in the same DB (admin
        // minting and activating against their own org). The blob's original
        // license_id stays inside rawToken if anyone needs to trace it back.
        const lic = await store.upsertLicense({
            licenseId: require('crypto').randomUUID(),
            organizationId: orgIdResolved,
            userId: userIdResolved,
            scope: blobScope,
            rawToken: token,
            tier: decoded.tier,
            issuer: decoded.issuer || adminIssuance.ADMIN_ISSUER,
            issuedAt: decoded.issued_at,
            expiresAt: decoded.expires_at,
            billingInterval: decoded.billing_interval || 'yearly',
            activatedBy,
            metadata: decoded.metadata || {},
        });
        if (blobScope === 'server') bumpServerLicenseVersion();
        return publicLicenseShape(lic);
    }

    const result = await verify.verifyToken(token);
    if (!result.valid) {
        const err = new Error(`License verification failed: ${result.error}`);
        err.code = result.error;
        throw err;
    }
    const p = result.payload;

    // Bind scope: prefer explicit args, fall back to claim 'sub'.
    let scope;
    if (explicitScope === 'server') scope = 'server';
    else if (userId) scope = 'consumer';
    else scope = 'organization';
    const orgIdResolved = scope === 'organization' ? (organizationId || p.sub || null) : null;
    const userIdResolved = scope === 'consumer' ? (userId || p.sub || null) : null;

    if (scope === 'organization' && !orgIdResolved) {
        throw new Error('No organization context for license activation');
    }

    const issuedAt = p.iat ? new Date(p.iat * 1000).toISOString() : new Date().toISOString();
    const expiresAt = new Date(p.exp * 1000).toISOString();
    const billingInterval = p.billing_interval || 'monthly';

    const lic = await store.upsertLicense({
        licenseId: p.license_id,
        organizationId: orgIdResolved,
        userId: userIdResolved,
        scope,
        rawToken: token,
        tier: p.tier,
        issuer: p.iss,
        issuedAt,
        expiresAt,
        billingInterval,
        activatedBy,
        metadata: {
            features: p.features || [],
            limits: p.limits || {},
            max_seats: p.max_seats || null,
            branding: p.branding || {},
            refresh_required_after: p.refresh_required_after || null,
        },
    });
    if (scope === 'server') bumpServerLicenseVersion();
    return publicLicenseShape(lic);
}

/**
 * Return the seat cap from the active license metadata, or null when no
 * active license is present or the license does not set a cap. Useful for
 * enforcing per-license seat limits on user creation.
 */
async function getMaxSeatsForOrg(organizationId) {
    if (!organizationId) return null;
    const lic = await store.getActiveLicenseForOrg(organizationId);
    if (!lic) return null;
    if (lic.refreshStatus === 'expired' || lic.refreshStatus === 'revoked') return null;
    if (lic.expiresAt && new Date(lic.expiresAt).getTime() <= Date.now()) return null;
    const raw = lic.metadata && lic.metadata.max_seats;
    if (raw == null) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

/**
 * Deactivate (mark expired) the currently active license for the given scope.
 *
 * Passing `scope: 'server'` (or `organizationId` and `userId` both falsy
 * along with `scope: 'server'`) targets the server-wide override row.
 * Org/user lookups are unchanged for backward compatibility.
 */
async function deactivateLicenseForScope({ organizationId = null, userId = null, deactivatedBy = null, scope = null } = {}) {
    let lic = null;
    if (scope === 'server') {
        lic = await store.getActiveLicenseForServer();
    } else if (organizationId) {
        lic = await store.getActiveLicenseForOrg(organizationId);
    } else if (userId) {
        lic = await store.getActiveLicenseForUser(userId);
    }
    if (!lic) return false;
    const ok = await store.deactivateLicense(lic.id, deactivatedBy);
    // Bump the install-wide version so every cached per-request resolution
    // re-resolves on the next call (server licence vanished — every org
    // needs to fall back to its own row).
    if (ok && lic.scope === 'server') bumpServerLicenseVersion();
    return ok;
}

module.exports = {
    // resolution
    getTierForOrg,
    getTierForUser,
    getBestTierForOrgs,
    resolveTier,
    hasFeature,
    hasTier,
    getLicenseStatus,
    getMaxSeatsForOrg,
    getServerLicenseTier,
    serverLicenseGovernsOrgs,
    getServerLicenseVersion,
    // mutation
    activateLicense,
    deactivateLicenseForScope,
    bumpServerLicenseVersion, // exposed for tests + manual cache busting
    // helpers (exposed for tests)
    resolveTierFromSubscription,
    // re-exports for convenience
    tiers,
    store,
    verify,
    adminIssuance,
    COMMUNITY_FALLBACK,
};
