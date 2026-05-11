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
 *   const tier = await license.getTierForOrg(orgId);          // 'community' | 'pro' | ...
 *   const ok   = await license.hasFeature(orgId, 'automations');
 *   const lic  = await license.getLicenseStatus({ organizationId: orgId });
 */

const store = require('./store');
const verify = require('./verify');
const tiers = require('./tiers');

const COMMUNITY_FALLBACK = 'community';

/**
 * Resolve the effective tier for an organization. Returns 'community' when
 * no usable license is present.
 */
async function getTierForOrg(organizationId) {
    if (!organizationId) return COMMUNITY_FALLBACK;
    const lic = await store.getActiveLicenseForOrg(organizationId);
    return resolveTierFromLicense(lic);
}

async function getTierForUser(userId) {
    if (!userId) return COMMUNITY_FALLBACK;
    const lic = await store.getActiveLicenseForUser(userId);
    return resolveTierFromLicense(lic);
}

/**
 * Best tier across every license that touches the given set of orgs —
 * org-scoped licenses on those orgs OR consumer licenses held by users
 * whose primary org is one of those orgs. Spreads an admin's personal
 * license to the rest of the org so group-invited members don't get
 * `feature_locked` 403s while sharing a workspace with the licensee.
 */
async function getBestTierForOrgs(orgIds = []) {
    if (!Array.isArray(orgIds) || orgIds.length === 0) return COMMUNITY_FALLBACK;
    const licenses = await store.getActiveLicensesForOrgs(orgIds);
    let best = COMMUNITY_FALLBACK;
    for (const lic of licenses) {
        const t = resolveTierFromLicense(lic);
        if (tiers.tierRank(t) > tiers.tierRank(best)) best = t;
    }
    return best;
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
    return tiers.isValidTier(lic.tier) ? lic.tier : COMMUNITY_FALLBACK;
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
 */
async function getLicenseStatus({ organizationId = null, userId = null, orgIds = null } = {}) {
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

    const tier = resolveTierFromLicense(lic);
    return {
        tier,
        source: lic ? 'license_key' : 'default',
        scope,
        license: lic ? publicLicenseShape(lic) : null,
        features: tiers.getFeaturesForTier(tier),
        limits: tiers.getLimitsForTier(tier),
    };
}

/**
 * Strip server-internal fields (raw_token) before sending to the client.
 */
function publicLicenseShape(lic) {
    return {
        id: lic.id,
        tier: lic.tier,
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
async function activateLicense({ token, organizationId = null, userId = null, activatedBy = null }) {
    const result = verify.verifyToken(token);
    if (!result.valid) {
        const err = new Error(`License verification failed: ${result.error}`);
        err.code = result.error;
        throw err;
    }
    const p = result.payload;

    // Bind scope: prefer explicit args, fall back to claim 'sub'.
    const scope = userId ? 'consumer' : 'organization';
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
    return publicLicenseShape(lic);
}

/**
 * Deactivate (mark expired) the currently active license for the given scope.
 */
async function deactivateLicenseForScope({ organizationId = null, userId = null, deactivatedBy = null } = {}) {
    let lic = null;
    if (organizationId) lic = await store.getActiveLicenseForOrg(organizationId);
    else if (userId) lic = await store.getActiveLicenseForUser(userId);
    if (!lic) return false;
    return store.deactivateLicense(lic.id, deactivatedBy);
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
    // mutation
    activateLicense,
    deactivateLicenseForScope,
    // re-exports for convenience
    tiers,
    store,
    verify,
    COMMUNITY_FALLBACK,
};
