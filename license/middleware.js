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

const UPGRADE_URL = process.env.LICENSE_UPGRADE_URL || 'https://beeflow.ai/pricing';

function getScope(req) {
    const u = req.session?.user || null;
    if (!u) return null;
    const orgId = u.organizationId || u.orgId || null;
    return { organizationId: orgId, userId: u.id };
}

function requireTier(requiredTier) {
    if (!license.tiers.isValidTier(requiredTier)) {
        throw new Error(`requireTier: invalid tier ${requiredTier}`);
    }
    return async function tierGate(req, res, next) {
        if (!req.session?.isAuthenticated) return next(); // let auth middleware reject
        const scope = getScope(req);
        const ok = await license.hasTier(scope, requiredTier);
        if (!ok) {
            const current = await license.resolveTier(scope);
            return res.status(403).json({
                error: 'tier_required',
                required: requiredTier,
                current,
                upgrade_url: UPGRADE_URL,
            });
        }
        next();
    };
}

function requireFeature(featureName) {
    return async function featureGate(req, res, next) {
        if (!req.session?.isAuthenticated) return next();
        const scope = getScope(req);
        const ok = await license.hasFeature(scope, featureName);
        if (!ok) {
            const current = await license.resolveTier(scope);
            // Find the lowest tier that grants this feature, for the UI.
            const required = findRequiredTierForFeature(featureName) || 'pro';
            return res.status(403).json({
                error: 'feature_locked',
                feature: featureName,
                required,
                current,
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
