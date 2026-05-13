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
    if (!organizationId) return COMMUNITY_FALLBACK;
    const lic = await store.getActiveLicenseForOrg(organizationId);
    const licTier = resolveTierFromLicense(lic);
    if (licTier !== COMMUNITY_FALLBACK) return licTier;
    const subTier = await resolveTierFromOrgSubscription(organizationId);
    return subTier || COMMUNITY_FALLBACK;
}

async function getTierForUser(userId) {
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
    return tier;
}

async function resolveTierFromOrgSubscription(organizationId) {
    try {
        const sub = await getUserStore().getOrgSubscription(organizationId);
        return resolveTierFromSubscription(sub);
    } catch (_) { return null; }
}

async function resolveTierFromConsumerSubscription(userId) {
    try {
        const sub = await getUserStore().getConsumerSubscription(userId);
        return resolveTierFromSubscription(sub);
    } catch (_) { return null; }
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
 *
 * Resolution order:
 *   1. Highest-tier license_keys row across the org set (admin blob or JWT).
 *   2. organization_subscriptions on any of those orgs (Stripe SaaS).
 *   3. consumer_subscriptions on userId.
 *   4. Community fallback.
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
    };
}

function publicSubscriptionShape(sub) {
    if (!sub) return null;
    return {
        planId: sub.plan_id,
        planName: sub.plan_name,
        tier: sub.plan_tier || tierFromPlanName(sub.plan_name) || null,
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
    const result = await verify.verifyToken(token);
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
    getMaxSeatsForOrg,
    // mutation
    activateLicense,
    deactivateLicenseForScope,
    // helpers (exposed for tests)
    resolveTierFromSubscription,
    // re-exports for convenience
    tiers,
    store,
    verify,
    adminIssuance,
    COMMUNITY_FALLBACK,
};
