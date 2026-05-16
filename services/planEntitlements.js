/**
 * Plan Entitlements Service — propagates a subscription plan's
 * `allowed_integrations` and `allowed_beta_features` allow-lists onto the
 * org-level enablement columns.
 *
 * Two roles for these lists:
 *   1. Cap (ceiling). Used by adminRoutes /me/active-features when an org
 *      admin tries to enable something. Anything not in the plan list is
 *      stripped before being persisted.
 *   2. Default-on bundle. When a plan is first assigned (or auto-assigned
 *      via signup / trial-grant), the org's `org_enabled_*` lists are
 *      seeded from the plan's allow-lists.
 *
 * `null` allow-list on the plan means "unrestricted" — legacy / unbounded
 * plans behave exactly like before. Empty array `[]` means "nothing is
 * allowed" (a hard zero).
 */

function userStore() { return require('../stores/userStore'); }

function intersect(allowList, requested) {
    if (allowList == null) return [...new Set(requested)]; // unrestricted
    const allow = new Set(allowList);
    return [...new Set(requested.filter(id => allow.has(id)))];
}

/**
 * Apply a plan's entitlement allow-lists as the org's enabled set
 * (default-on). Existing org-level enablements that fall outside the
 * plan are dropped (cap behavior on plan change / downgrade).
 *
 * `mode`:
 *   - 'reset'   (default): replace org list with plan allow-list.
 *   - 'intersect': keep only the org's current enables that fit the cap.
 *     Used on plan *downgrade* when the admin asked not to widen the org.
 */
async function applyPlanToOrg(orgId, planId, { mode = 'reset' } = {}) {
    const store = userStore();
    if (!orgId || !planId) return false;

    const plan = await store.getPlan(planId);
    if (!plan) return false;

    // Integrations
    if (plan.allowed_integrations !== null && plan.allowed_integrations !== undefined) {
        if (mode === 'intersect') {
            const cur = await store.getOrgEnabledIntegrations(orgId);
            await store.setOrgEnabledIntegrations(orgId, intersect(plan.allowed_integrations, cur));
        } else {
            await store.setOrgEnabledIntegrations(orgId, plan.allowed_integrations);
        }
    }

    // Beta features
    if (plan.allowed_beta_features !== null && plan.allowed_beta_features !== undefined) {
        if (mode === 'intersect') {
            const cur = await store.getOrgEnabledBetaFeatures(orgId);
            await store.setOrgEnabledBetaFeatures(orgId, intersect(plan.allowed_beta_features, cur));
        } else {
            await store.setOrgEnabledBetaFeatures(orgId, plan.allowed_beta_features);
        }
    }
    return true;
}

/**
 * Compute the integration and beta-feature caps that apply to an org,
 * given its current subscription's plan. Returns `null` for either list
 * when the plan doesn't define one (= unrestricted).
 */
async function getOrgCaps(orgId) {
    const store = userStore();
    const sub = await store.getOrgSubscription(orgId);
    if (!sub?.plan_id) return { integrations: null, betaFeatures: null };
    const plan = await store.getPlan(sub.plan_id);
    if (!plan) return { integrations: null, betaFeatures: null };
    return {
        integrations: plan.allowed_integrations ?? null,
        betaFeatures: plan.allowed_beta_features ?? null,
    };
}

/**
 * Filter a requested set of integration / beta-feature IDs against the
 * org's plan cap. Pass-through when the cap is null (unrestricted).
 */
function applyCap(requested, cap) {
    if (cap == null) return [...new Set(requested)];
    return intersect(cap, requested);
}

module.exports = {
    applyPlanToOrg,
    getOrgCaps,
    applyCap,
};
