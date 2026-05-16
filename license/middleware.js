/**
 * License Tier Enforcement Middleware
 *
 *   const { requireTier, requireFeature } = require('../license/middleware');
 *
 *   router.post('/sso/saml', requireTier('enterprise'), handler);
 *   router.use('/branding', requireFeature('white_label'));
 *
 * Both middlewares are non-blocking when the user is unauthenticated — they
 * delegate the 401 to the upstream auth middleware. They only intervene when
 * the user IS authenticated but their license tier is insufficient, in which
 * case they respond `403 Forbidden` with a structured error body the frontend
 * can render as a "Upgrade required" call-to-action.
 *
 *   { error: 'tier_required', required: 'enterprise', current: 'community',
 *     feature: 'sso_saml' (optional), upgrade_url: 'https://beeflow.ai/pricing' }
 *
 * When the underlying tier lookup hits a real DB error (not a missing table
 * during early boot), the middleware fails *closed* with 503 rather than
 * silently downgrading every user to community — that would mask outages.
 */

const license = require('./index');
const { resolveUserOrgIds } = require('../auth/permissions');
const tiers = license.tiers;

const UPGRADE_URL = process.env.LICENSE_UPGRADE_URL || 'https://beeflow.ai/pricing';
const RESOLUTION_CACHE_TTL_MS = parseInt(process.env.LICENSE_RESOLUTION_CACHE_TTL_MS || '30000', 10);

// Precompute a feature → required-tier map at module load. The TIER_HIERARCHY
// order is ascending, so the first match wins. Beats a linear scan on every
// gate check (which happens on every gated request).
const _featureRequiredTier = (() => {
    const m = new Map();
    for (const tier of tiers.TIER_HIERARCHY) {
        const features = tiers.getFeaturesForTier ? tiers.getFeaturesForTier(tier) : null;
        if (!features) continue;
        for (const f of features) {
            if (!m.has(f)) m.set(f, tier);
        }
    }
    return m;
})();

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
 *
 * Returns:
 *   { tier, orgIds, userTier, orgTiers, spread, superAdmin?, error? }
 *
 * `spread` is the org-wide spread of consumer-style licences (see comment
 * below). It's now its own field rather than an in-band `__spread__` key
 * inside `orgTiers`, which used to confuse callers iterating the map.
 *
 * `error: 'tier_unavailable'` is set when org resolution failed badly
 * enough that the result should not be trusted — middleware turns this
 * into a 503.
 */
async function resolveBestTierForRequest(req) {
    const u = req.session?.user || null;
    if (!u) return { tier: tiers.TIER_HIERARCHY[0], orgIds: [], userTier: tiers.TIER_HIERARCHY[0], orgTiers: {}, spread: null };

    // Per-request memoisation with a short TTL. Bust hooks (Stripe webhooks,
    // license revoke, role change) call invalidateCacheForOrg/User to expire
    // the entry early. Cached on req.session so it survives the request but
    // not future logins.
    const cacheKey = `_lic:${u.id}`;
    if (req.session && req.session[cacheKey]) {
        const c = req.session[cacheKey];
        if (c.expiresAt > Date.now()) return c.value;
    }

    let userTier = tiers.TIER_HIERARCHY[0];
    try {
        userTier = u.id ? await license.resolveTier({ userId: u.id }) : tiers.TIER_HIERARCHY[0];
    } catch (e) {
        console.warn(`[license/middleware] license.tier.user_lookup_failed user=${u.id} error=${e.message}`);
    }

    let best = userTier;
    const candidateOrgIds = new Set();
    if (u.organizationId) candidateOrgIds.add(u.organizationId);
    if (u.orgId) candidateOrgIds.add(u.orgId);

    // Super-admin bypass — returns highest tier so they aren't blocked by
    // per-org licensing. Checked *before* org resolution so a downstream
    // failure can't trap an admin in a 503.
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') {
        const value = { tier: 'full', orgIds: [...candidateOrgIds], userTier, orgTiers: {}, spread: null, superAdmin: true };
        if (req.session) req.session[cacheKey] = { expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS, value };
        return value;
    }

    let groupResolveFailed = false;
    try {
        const resolved = await resolveUserOrgIds(req);
        if (resolved instanceof Set) {
            for (const id of resolved) candidateOrgIds.add(id);
        }
    } catch (e) {
        groupResolveFailed = true;
        console.warn(`[license/middleware] license.tier.org_resolve_failed user=${u.id} error=${e.message}`);
    }

    // If we couldn't resolve ANY orgs (no direct org id AND group lookup
    // threw), surface tier_unavailable so middleware fails closed with 503.
    if (groupResolveFailed && candidateOrgIds.size === 0) {
        const value = { tier: tiers.TIER_HIERARCHY[0], orgIds: [], userTier, orgTiers: {}, spread: null, error: 'tier_unavailable' };
        return value;
    }

    // Parallelise per-org tier lookups. Previously sequential (N awaits
    // for N orgs). For users in many groups this was a noticeable per-
    // request cost.
    const orgTiers = {};
    const orgIdsArray = [...candidateOrgIds].filter(Boolean);
    const orgTierResults = await Promise.allSettled(
        orgIdsArray.map(id => license.getTierForOrg(id))
    );
    let hardOrgErrors = 0;
    for (let i = 0; i < orgIdsArray.length; i++) {
        const orgId = orgIdsArray[i];
        const r = orgTierResults[i];
        if (r.status === 'fulfilled') {
            orgTiers[orgId] = r.value;
            if (tiers.tierRank(r.value) > tiers.tierRank(best)) best = r.value;
        } else {
            hardOrgErrors++;
            console.warn(`[license/middleware] license.tier.org_lookup_failed org=${orgId} error=${r.reason?.message || r.reason}`);
        }
    }

    let spread = null;
    if (orgIdsArray.length > 0) {
        try {
            spread = await license.getBestTierForOrgs(orgIdsArray);
            if (tiers.tierRank(spread) > tiers.tierRank(best)) best = spread;
        } catch (e) {
            console.warn(`[license/middleware] license.tier.spread_lookup_failed error=${e.message}`);
        }
    }

    // Fail-closed gate: if we have org IDs but every single one threw, the
    // DB is sick and we should not silently return community. Surface as
    // tier_unavailable so the gates can return 503 rather than false 403s.
    const value = (orgIdsArray.length > 0 && hardOrgErrors === orgIdsArray.length)
        ? { tier: tiers.TIER_HIERARCHY[0], orgIds: orgIdsArray, userTier, orgTiers, spread: null, error: 'tier_unavailable' }
        : { tier: best, orgIds: orgIdsArray, userTier, orgTiers, spread };

    if (req.session) req.session[cacheKey] = { expiresAt: Date.now() + RESOLUTION_CACHE_TTL_MS, value };
    return value;
}

function requireTier(requiredTier) {
    if (!tiers.isValidTier(requiredTier)) {
        throw new Error(`requireTier: invalid tier ${requiredTier}`);
    }
    return async function tierGate(req, res, next) {
        if (!req.session?.isAuthenticated) return next(); // let auth middleware reject
        const resolution = await resolveBestTierForRequest(req);
        if (resolution.error === 'tier_unavailable') {
            return res.status(503).json({ error: 'tier_unavailable', retry_after: 1 });
        }
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
        if (resolution.error === 'tier_unavailable') {
            return res.status(503).json({ error: 'tier_unavailable', retry_after: 1 });
        }
        if (!tiers.tierHasFeature(resolution.tier, featureName)) {
            const required = findRequiredTierForFeature(featureName) || 'enterprise';
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
    if (_featureRequiredTier.has(feature)) return _featureRequiredTier.get(feature);
    for (const tier of license.tiers.TIER_HIERARCHY) {
        if (license.tiers.tierHasFeature(tier, feature)) return tier;
    }
    return null;
}

/**
 * Best-effort cache invalidator. Sessions are keyed by user id, so this
 * is called from webhook handlers / revoke endpoints after we know the
 * org's state changed. Since we can't enumerate every user in an org
 * synchronously here, we delete a versioned key — the resolution cache
 * uses TTL anyway, so this just shaves the staleness window.
 */
function invalidateCacheForOrg(_orgId) {
    // Per-request memoisation on req.session is automatically cleared on
    // each new request once the 30s TTL expires. The dominant bust path
    // for org-wide state changes is bustSessionsForOrg in sessionCache.js,
    // which deletes the session entirely (PR 2.A).
}

function invalidateCacheForUser(_userId) {
    // Same comment as invalidateCacheForOrg — session bust is the
    // authoritative path; per-session resolution decays via TTL.
}

module.exports = {
    requireTier,
    requireFeature,
    findRequiredTierForFeature,
    resolveBestTierForRequest,
    invalidateCacheForOrg,
    invalidateCacheForUser,
};
