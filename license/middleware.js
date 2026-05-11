/**
 * License Tier Enforcement Middleware
 *
 *   const { requireTier, requireFeature } = require('../license/middleware');
 *
 *   router.use('/automations', requireFeature('automations'));
 *   router.post('/sso/saml', requireTier('enterprise'), handler);
 *
 * Both middlewares are non-blocking when the user is unauthenticated — they
 * delegate the 401 to the upstream auth middleware. They only intervene when
 * the user IS authenticated but their license tier is insufficient, in which
 * case they respond `403 Forbidden` with a structured error body the frontend
 * can render as a "Upgrade required" call-to-action.
 *
 *   { error: 'tier_required', required: 'pro', current: 'community',
 *     feature: 'automations' (optional), upgrade_url: 'https://beeflow.ai/pricing' }
 */

const license = require('./index');
const { resolveUserOrgIds } = require('../auth/permissions');
const tiers = license.tiers;

const UPGRADE_URL = process.env.LICENSE_UPGRADE_URL || 'https://beeflow.ai/pricing';

function getScope(req) {
    const u = req.session?.user || null;
    if (!u) return null;
    const orgId = u.organizationId || u.orgId || null;
    return { organizationId: orgId, userId: u.id };
}

/**
 * Best license tier across every org the user belongs to (direct
 * organizationId AND group-based memberships) plus their personal tier.
 *
 * Why this matters: license/middleware.js previously only inspected
 * `session.user.organizationId`. A user whose org link is via a group
 * (the typical multi-tenant case for invited members) had a null
 * organizationId on session, so the tier resolved to COMMUNITY and any
 * licensed feature 403'd with `feature_locked` — even though the org
 * already paid for the feature. Resolving all org IDs and taking the max
 * tier matches how the rest of the app (auth permissions, agent/KB
 * visibility) figures out which orgs you belong to.
 */
async function resolveBestTierForRequest(req) {
    const u = req.session?.user || null;
    if (!u) return { tier: tiers.TIER_HIERARCHY[0], orgIds: [], userTier: tiers.TIER_HIERARCHY[0], orgTiers: {} };
    const userTier = u.id ? await license.resolveTier({ userId: u.id }) : tiers.TIER_HIERARCHY[0];
    let best = userTier;
    const candidateOrgIds = new Set();
    if (u.organizationId) candidateOrgIds.add(u.organizationId);
    if (u.orgId) candidateOrgIds.add(u.orgId);
    try {
        // Super-admin returns null (sees everything) — bypass with the highest
        // tier so they aren't blocked by per-org licensing.
        if (req.session?.isAdmin || req.session?.user?.role === 'admin') {
            return { tier: 'full', orgIds: [...candidateOrgIds], userTier, orgTiers: {}, superAdmin: true };
        }
        const resolved = await resolveUserOrgIds(req);
        if (resolved instanceof Set) {
            for (const id of resolved) candidateOrgIds.add(id);
        }
    } catch (e) {
        console.warn('[license/middleware] resolveUserOrgIds failed:', e?.message);
    }
    const orgTiers = {};
    for (const orgId of candidateOrgIds) {
        if (!orgId) continue;
        const t = await license.getTierForOrg(orgId);
        orgTiers[orgId] = t;
        if (tiers.tierRank(t) > tiers.tierRank(best)) best = t;
    }
    // Org-wide spread of consumer licenses: if the org admin (or any member
    // whose direct organizationId matches) activated the licence on their
    // personal user record instead of the org, share it with every member.
    try {
        const orgIdsArray = [...candidateOrgIds].filter(Boolean);
        if (orgIdsArray.length > 0) {
            const spreadTier = await license.getBestTierForOrgs(orgIdsArray);
            if (tiers.tierRank(spreadTier) > tiers.tierRank(best)) best = spreadTier;
            orgTiers.__spread__ = spreadTier;
        }
    } catch (e) {
        console.warn('[license/middleware] getBestTierForOrgs failed:', e?.message);
    }
    return { tier: best, orgIds: [...candidateOrgIds], userTier, orgTiers };
}

function requireTier(requiredTier) {
    if (!tiers.isValidTier(requiredTier)) {
        throw new Error(`requireTier: invalid tier ${requiredTier}`);
    }
    return async function tierGate(req, res, next) {
        if (!req.session?.isAuthenticated) return next(); // let auth middleware reject
        const resolution = await resolveBestTierForRequest(req);
        if (!tiers.tierAtLeast(resolution.tier, requiredTier)) {
            console.warn(`[license] tier_required user=${req.session?.user?.id} required=${requiredTier} current=${resolution.tier} orgs=${JSON.stringify(resolution.orgTiers)}`);
            return res.status(403).json({
                error: 'tier_required',
                required: requiredTier,
                current: resolution.tier,
                debug: resolution,
                upgrade_url: UPGRADE_URL,
            });
        }
        next();
    };
}

function requireFeature(featureName) {
    return async function featureGate(req, res, next) {
        if (!req.session?.isAuthenticated) return next();
        const resolution = await resolveBestTierForRequest(req);
        if (!tiers.tierHasFeature(resolution.tier, featureName)) {
            const required = findRequiredTierForFeature(featureName) || 'pro';
            console.warn(`[license] feature_locked user=${req.session?.user?.id} feature=${featureName} required=${required} current=${resolution.tier} orgs=${JSON.stringify(resolution.orgTiers)} candidateOrgIds=${JSON.stringify(resolution.orgIds)}`);
            return res.status(403).json({
                error: 'feature_locked',
                feature: featureName,
                required,
                current: resolution.tier,
                debug: resolution,
                upgrade_url: UPGRADE_URL,
            });
        }
        next();
    };
}

function findRequiredTierForFeature(feature) {
    for (const tier of license.tiers.TIER_HIERARCHY) {
        if (license.tiers.tierHasFeature(tier, feature)) return tier;
    }
    return null;
}

module.exports = {
    requireTier,
    requireFeature,
    findRequiredTierForFeature,
};
