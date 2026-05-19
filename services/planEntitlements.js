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

/**
 * Walk every active org subscription and report any beta-feature or
 * integration that the org has enabled but its current plan no longer
 * caps. This happens when a plan's `allowed_*` is narrowed *after* an
 * org has opted into a feature — the runtime keeps serving it because
 * `applyCap` only fires at toggle time.
 *
 * Returns a summary; emits an `access_audit_log` row per drifting feature
 * so compliance retains a record. Read-only by default — pass
 * `{ trim: true }` to also save the trimmed lists back via
 * setOrgEnabledBetaFeatures / setOrgEnabledIntegrations.
 */
async function auditPlanCapDrift({ trim = false } = {}) {
    const store = userStore();
    const subs = await store.getAllOrgSubscriptions().catch(() => []);
    let scanned = 0;
    let drifted = 0;
    let trimmed = 0;
    const drifts = [];

    for (const sub of (subs || [])) {
        if (!sub?.organization_id) continue;
        if (sub.status !== 'active') continue;
        scanned++;
        const caps = await getOrgCaps(sub.organization_id).catch(() => ({ integrations: null, betaFeatures: null }));
        const enabledIntegrations = await store.getOrgEnabledIntegrations(sub.organization_id).catch(() => []);
        const enabledBeta = await store.getOrgEnabledBetaFeatures(sub.organization_id).catch(() => []);
        const trimmedIntegrations = caps.integrations == null ? enabledIntegrations : intersect(caps.integrations, enabledIntegrations);
        const trimmedBeta = caps.betaFeatures == null ? enabledBeta : intersect(caps.betaFeatures, enabledBeta);
        const lostIntegrations = enabledIntegrations.filter(id => !trimmedIntegrations.includes(id));
        const lostBeta = enabledBeta.filter(id => !trimmedBeta.includes(id));
        if (lostIntegrations.length === 0 && lostBeta.length === 0) continue;

        drifted++;
        drifts.push({
            orgId: sub.organization_id,
            planId: sub.plan_id,
            lostIntegrations,
            lostBeta,
        });

        try {
            await store.logAccessAudit(
                'plan_cap_drift_detected',
                'organization',
                sub.organization_id,
                'system',
                { enabled_integrations: enabledIntegrations, enabled_beta_features: enabledBeta },
                { plan_id: sub.plan_id, lost_integrations: lostIntegrations, lost_beta_features: lostBeta, trimmed: trim },
                sub.organization_id,
            );
        } catch (_) { /* audit best-effort */ }

        if (trim) {
            try {
                if (lostIntegrations.length > 0) await store.setOrgEnabledIntegrations(sub.organization_id, trimmedIntegrations);
                if (lostBeta.length > 0) await store.setOrgEnabledBetaFeatures(sub.organization_id, trimmedBeta);
                trimmed++;
            } catch (e) {
                console.warn(`[PlanCapDrift] trim failed for org=${sub.organization_id}: ${e.message}`);
            }
        }
    }

    return { scanned, drifted, trimmed, drifts };
}

module.exports = {
    applyPlanToOrg,
    getOrgCaps,
    applyCap,
    auditPlanCapDrift,
};
