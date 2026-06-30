/**
 * Subscriptions API Routes — Plan and org subscription management
 * All write routes require super admin access. Org members can read their own subscription.
 */

const express = require('express');
const userStore = require('../stores/userStore');
const usageStore = require('../stores/usageStore');

const router = express.Router();
const { hasPermission } = require('../auth/permissions');

// Self-hosted installs use license keys, not Stripe subscriptions. Block the
// entire subscriptions API up front so neither the admin Plans CRUD nor
// per-org/consumer reads accidentally bleed cloud SaaS concepts into a
// customer-run server. Cloud (DEPLOYMENT_MODE=cloud, default) is unchanged.
router.use((req, res, next) => {
    if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted') {
        return res.status(404).json({ error: 'not_available_in_self_hosted', message: 'Subscriptions are a Bee Flow Cloud feature. Self-hosted installs use license keys.' });
    }
    next();
});

// Operational gate for write routes (plan CRUD, audit, etc.). Honours the
// hardcoded "admin" account plus any RBAC grant of admin_subscriptions /
// `all`. Do NOT use this to decide whether a payload should be redacted —
// privacy decisions live next to their response builders and use a
// strict-id check instead, because `hasPermission(_, 'admin_subscriptions')`
// short-circuits truthy for anyone holding the `all` wildcard.
async function isSuperAdmin(req) {
    if (req.session?.user?.id === 'admin') return true;
    const userId = req.session?.user?.id;
    if (!userId) return false;
    return await hasPermission(userId, 'admin_subscriptions', req.session);
}

async function requireAdmin(req, res, next) {
    if (!(await isSuperAdmin(req))) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// Lifecycle actions (upgrade/cancel/reactivate) are allowed for org-admins of
// the same org plus super-admins. Distinct from `requireAuthOrOrgMember` —
// regular org members can read the subscription but must not be able to
// change the billing relationship.
async function isOrgAdminForOrg(req, orgId) {
    if (await isSuperAdmin(req)) return true;
    const u = req.session?.user;
    if (!u) return false;
    const userOrgId = u.organizationId || u.orgId;
    if (userOrgId !== orgId) return false;
    return u.role === 'admin' || u.orgRole === 'org_admin' || u.orgRole === 'admin';
}

// Allow authenticated users to read their own org's subscription, super admins can access all
async function requireAuthOrOrgMember(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    if (await isSuperAdmin(req)) return next();
    const orgId = req.params.orgId;
    const sessionUser = req.session.user;
    if (orgId && sessionUser) {
        const userOrgId = sessionUser.organizationId || sessionUser.orgId;
        if (userOrgId === orgId) return next();
    }
    return res.status(403).json({ error: 'Admin access required' });
}

function getAdminId(req) {
    return req.session?.user?.id || req.session?.user?.username || 'unknown';
}

// Admin-only for plans and write operations; org members can read their own
// org sub; org-admins can drive lifecycle actions on their own org.
router.use(async (req, res, next) => {
    // GET /orgs/:orgId and /orgs/:orgId/usage — allow org members
    const orgMatch = req.path.match(/^\/orgs\/([^/]+)(\/usage)?$/);
    if (req.method === 'GET' && orgMatch) {
        req.params.orgId = req.params.orgId || orgMatch[1];
        return requireAuthOrOrgMember(req, res, next);
    }
    // GET /consumer/usage — allow any authenticated user (consumer accounts)
    if (req.method === 'GET' && req.path === '/consumer/usage') {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        return next();
    }
    // POST /orgs/:orgId/{upgrade|cancel|reactivate} — org-admin of that org
    const orgLifecycle = req.path.match(/^\/orgs\/([^/]+)\/(upgrade|cancel|reactivate)$/);
    if (req.method === 'POST' && orgLifecycle) {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        if (await isOrgAdminForOrg(req, orgLifecycle[1])) return next();
        return res.status(403).json({ error: 'Org admin access required' });
    }
    // POST /consumer/:userId/{upgrade|cancel|reactivate} — the owner only
    const consumerLifecycle = req.path.match(/^\/consumer\/([^/]+)\/(upgrade|cancel|reactivate)$/);
    if (req.method === 'POST' && consumerLifecycle) {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        if (req.session.user?.id === consumerLifecycle[1]) return next();
        if (await isSuperAdmin(req)) return next();
        return res.status(403).json({ error: 'Owner access required' });
    }
    // Everything else requires super admin
    return requireAdmin(req, res, next);
});

// ═══════════════════════════════════════
//  Subscription Plans
// ═══════════════════════════════════════

// GET /api/subscriptions/plans
router.get('/plans', async (req, res) => {
    try {
        const plans = await userStore.getAllPlans();
        res.json(plans);
    } catch (e) {
        console.error('[Subscriptions] getAllPlans error:', e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/subscriptions/plans
router.post('/plans', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'Plan name is required' });
        }
        // Validate numeric fields are non-negative when provided
        const numericFields = ['max_messages_per_month', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources', 'price', 'trial_days', 'sort_order'];
        for (const field of numericFields) {
            if (req.body[field] !== undefined && req.body[field] !== null && req.body[field] < 0) {
                return res.status(400).json({ error: `${field} must be non-negative` });
            }
        }
        if (req.body.billing_interval && !['monthly', 'yearly'].includes(req.body.billing_interval)) {
            return res.status(400).json({ error: 'billing_interval must be "monthly" or "yearly"' });
        }
        if (req.body.billing_model !== undefined && !['fixed', 'metered'].includes(req.body.billing_model)) {
            return res.status(400).json({ error: 'billing_model must be "fixed" or "metered"' });
        }
        if (req.body.markup_percent !== undefined) {
            const m = Number(req.body.markup_percent);
            if (!Number.isFinite(m) || m < 0 || m > 1000) {
                return res.status(400).json({ error: 'markup_percent must be a number between 0 and 1000' });
            }
        }
        if (req.body.billing_model === 'metered' && req.body.trial_days && req.body.trial_days > 0) {
            return res.status(400).json({ error: 'PAYG plans cannot have trial_days — Stripe requires a payment method up front' });
        }

        const plan = await userStore.createPlan(req.body);
        if (!plan) return res.status(400).json({ error: 'Failed to create plan' });

        await userStore.logSubscriptionAudit('create_plan', 'plan', plan.id, getAdminId(req), null, { name: plan.name, price: plan.price, billing_interval: plan.billing_interval, billing_model: plan.billing_model });

        // Auto-sync to Stripe if enabled. PAYG plans always sync (price is
        // irrelevant for metered); fixed plans only sync when they carry a price.
        const isPayg = plan.billing_model === 'metered';
        if (isPayg || plan.price > 0) {
            try {
                const stripeService = require('../services/stripeService');
                if (await stripeService.isEnabled()) {
                    const result = isPayg
                        ? await stripeService.syncPaygPlanToStripe(plan)
                        : await stripeService.syncPlanToStripe(plan);
                    const updates = { stripe_product_id: result.productId, stripe_price_id: result.priceId };
                    if (isPayg) {
                        updates.stripe_meter_id = result.meterId;
                        updates.stripe_meter_event_name = result.meterEventName;
                    }
                    await userStore.updatePlan(plan.id, updates);
                    Object.assign(plan, updates);
                    console.log(`[Subscriptions] Auto-synced plan ${plan.id} to Stripe: ${result.productId} (${isPayg ? 'metered' : 'fixed'})`);
                }
            } catch (err) {
                console.warn(`[Subscriptions] Stripe auto-sync failed for plan ${plan.id}:`, err.message);
                // Don't fail the plan creation — Stripe sync is optional
            }
        }

        res.status(201).json(plan);
    } catch (e) {
        console.error('[Subscriptions] createPlan error:', e);
        res.status(400).json({ error: e.message });
    }
});

// PUT /api/subscriptions/plans/:id
router.put('/plans/:id', async (req, res) => {
    try {
        if (req.body.name !== undefined && (!req.body.name || typeof req.body.name !== 'string' || !req.body.name.trim())) {
            return res.status(400).json({ error: 'Plan name cannot be empty' });
        }
        const numericFields = ['max_messages_per_month', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources', 'price', 'trial_days', 'sort_order'];
        for (const field of numericFields) {
            if (req.body[field] !== undefined && req.body[field] !== null && req.body[field] < 0) {
                return res.status(400).json({ error: `${field} must be non-negative` });
            }
        }
        if (req.body.billing_interval && !['monthly', 'yearly'].includes(req.body.billing_interval)) {
            return res.status(400).json({ error: 'billing_interval must be "monthly" or "yearly"' });
        }
        if (req.body.billing_model !== undefined && !['fixed', 'metered'].includes(req.body.billing_model)) {
            return res.status(400).json({ error: 'billing_model must be "fixed" or "metered"' });
        }
        if (req.body.markup_percent !== undefined) {
            const m = Number(req.body.markup_percent);
            if (!Number.isFinite(m) || m < 0 || m > 1000) {
                return res.status(400).json({ error: 'markup_percent must be a number between 0 and 1000' });
            }
        }
        if (req.body.billing_model === 'metered' && req.body.trial_days && req.body.trial_days > 0) {
            return res.status(400).json({ error: 'PAYG plans cannot have trial_days — Stripe requires a payment method up front' });
        }

        const oldPlan = await userStore.getPlan(req.params.id);
        const ok = await userStore.updatePlan(req.params.id, req.body);
        if (!ok) return res.status(404).json({ error: 'Plan not found' });

        const updated = await userStore.getPlan(req.params.id);
        await userStore.logSubscriptionAudit('update_plan', 'plan', req.params.id, getAdminId(req), oldPlan, req.body);

        // Bust stale entitlement snapshots for orgs on this plan. The resolver
        // memoises per-session for ~30s (keys `_ent:…:v{ver}` / `_lic:…:v{ver}`),
        // and plan edits never went through the org/group grant-write path that
        // calls bustSessionsForOrg — so a feature toggled here (e.g. Notebooks)
        // was served from a stale snapshot for up to 30s, making it look like the
        // change "sometimes works". Bumping the install-wide licence version
        // changes those cache keys so the next request re-resolves from the DB.
        // Only fires when an entitlement-bearing list actually changed — price /
        // name edits don't need it.
        const ENT_FIELDS = ['allowed_features', 'allowed_beta_features', 'allowed_integrations', 'allowed_models'];
        const entChanged = ENT_FIELDS.some(f =>
            req.body[f] !== undefined &&
            JSON.stringify(req.body[f] ?? null) !== JSON.stringify(oldPlan?.[f] ?? null)
        );
        if (entChanged) {
            try { require('../license').bumpServerLicenseVersion(); } catch (_) { /* best-effort cache bust */ }
        }

        // Auto-sync to Stripe if enabled.
        // Fixed plans: trigger on price / name / interval change AND price > 0.
        // PAYG plans:  trigger on name / interval / currency change OR first sync.
        const isPayg = updated.billing_model === 'metered';
        const priceChanged = req.body.price !== undefined && req.body.price !== oldPlan?.price;
        const nameChanged = req.body.name !== undefined && req.body.name !== oldPlan?.name;
        const intervalChanged = req.body.billing_interval !== undefined && req.body.billing_interval !== oldPlan?.billing_interval;
        const currencyChanged = req.body.currency !== undefined && req.body.currency !== oldPlan?.currency;
        const billingModelChanged = req.body.billing_model !== undefined && req.body.billing_model !== oldPlan?.billing_model;
        const needsFixedSync = !isPayg && updated.price > 0 && (priceChanged || nameChanged || intervalChanged || billingModelChanged);
        const needsPaygSync = isPayg && (nameChanged || intervalChanged || currencyChanged || billingModelChanged || !updated.stripe_price_id);
        if (needsFixedSync || needsPaygSync) {
            try {
                const stripeService = require('../services/stripeService');
                if (await stripeService.isEnabled()) {
                    const result = isPayg
                        ? await stripeService.syncPaygPlanToStripe(updated)
                        : await stripeService.syncPlanToStripe(updated);
                    const updates = { stripe_product_id: result.productId, stripe_price_id: result.priceId };
                    if (isPayg) {
                        updates.stripe_meter_id = result.meterId;
                        updates.stripe_meter_event_name = result.meterEventName;
                    }
                    await userStore.updatePlan(updated.id, updates);
                    Object.assign(updated, updates);
                    console.log(`[Subscriptions] Auto-synced plan ${updated.id} to Stripe: ${result.productId} (${isPayg ? 'metered' : 'fixed'})`);
                }
            } catch (err) {
                console.warn(`[Subscriptions] Stripe auto-sync failed for plan ${updated.id}:`, err.message);
            }
        }

        res.json(updated);
    } catch (e) {
        console.error('[Subscriptions] updatePlan error:', e);
        res.status(400).json({ error: e.message });
    }
});

// DELETE /api/subscriptions/plans/:id
router.delete('/plans/:id', async (req, res) => {
    try {
        const oldPlan = await userStore.getPlan(req.params.id);
        const ok = await userStore.deletePlan(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Plan not found' });

        await userStore.logSubscriptionAudit('delete_plan', 'plan', req.params.id, getAdminId(req), oldPlan, null);
        res.json({ success: true });
    } catch (e) {
        if (e instanceof userStore.PlanInUseError) {
            return res.status(409).json({
                error: 'plan_in_use',
                message: `Plan is referenced by ${e.affectedOrgs.length} org subscription(s) and ${e.affectedConsumers.length} consumer subscription(s). Migrate them to a different plan first.`,
                affected_orgs: e.affectedOrgs,
                affected_consumers: e.affectedConsumers,
            });
        }
        console.error('[Subscriptions] deletePlan error:', e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/subscriptions/plans/:id/sync-stripe — Manually sync a plan to Stripe
router.post('/plans/:id/sync-stripe', async (req, res) => {
    try {
        const stripeService = require('../services/stripeService');
        if (!(await stripeService.isEnabled())) {
            return res.status(400).json({ error: 'Stripe is not enabled. Configure Stripe in the Stripe settings tab first.' });
        }

        const plan = await userStore.getPlan(req.params.id);
        if (!plan) return res.status(404).json({ error: 'Plan not found' });
        const isPayg = plan.billing_model === 'metered';
        if (!isPayg && (!plan.price || plan.price <= 0)) {
            return res.status(400).json({ error: 'Fixed-price plans must have a price greater than 0 to sync to Stripe' });
        }

        const result = isPayg
            ? await stripeService.syncPaygPlanToStripe(plan)
            : await stripeService.syncPlanToStripe(plan);
        const updates = { stripe_product_id: result.productId, stripe_price_id: result.priceId };
        if (isPayg) {
            updates.stripe_meter_id = result.meterId;
            updates.stripe_meter_event_name = result.meterEventName;
        }
        await userStore.updatePlan(plan.id, updates);

        await userStore.logSubscriptionAudit('update_plan', 'plan', plan.id, getAdminId(req), null, updates);

        res.json({ success: true, ...updates });
    } catch (e) {
        console.error('[Subscriptions] syncPlanToStripe error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════
//  Organization Subscriptions
// ═══════════════════════════════════════

// GET /api/subscriptions/orgs — list all org subscriptions with current usage
router.get('/orgs', async (req, res) => {
    try {
        const subs = await userStore.getAllOrgSubscriptions();
        const orgs = await userStore.getAllOrganizations();

        // Enrich each subscription with org info and current usage
        const result = [];
        for (const sub of subs) {
            const org = orgs.find(o => o.id === sub.organization_id);
            const effective = await userStore.getEffectiveLimits(sub.organization_id);
            // Use billing period for usage calculation
            const period = userStore.getBillingPeriod(sub);
            let usage = {};
            try {
                usage = await usageStore.getUsageSummary({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: sub.organization_id });
            } catch (_) { }

            const plan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
            const markup = Number(plan?.markup_percent) || 0;
            const billedCost = (Number(usage.total_estimated_cost) || 0) * (1 + markup / 100);

            result.push({
                ...sub,
                org_name: org?.name || 'Unknown',
                org_trial_used_at: org?.trial_used_at || null,
                effective_limits: effective,
                billing_period: period,
                current_usage: {
                    messages: usage.total_calls || 0,
                    tokens: usage.total_tokens || 0,
                    cost: billedCost,
                }
            });
        }

        res.json(result);
    } catch (e) {
        console.error('[Subscriptions] getAllOrgSubs error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/subscriptions/orgs/:orgId
router.get('/orgs/:orgId', async (req, res) => {
    try {
        const sub = await userStore.getOrgSubscription(req.params.orgId);
        if (!sub) return res.status(404).json({ error: 'No subscription for this org' });

        const effective = await userStore.getEffectiveLimits(req.params.orgId);
        const period = userStore.getBillingPeriod(sub);
        let usage = {};
        try {
            usage = await usageStore.getUsageSummary({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: req.params.orgId });
        } catch (_) { }

        const plan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
        const markup = Number(plan?.markup_percent) || 0;
        const rawCost = Number(usage.total_estimated_cost) || 0;
        const billedCost = rawCost * (1 + markup / 100);

        // Effective cost cap: explicit subscription override > plan-price ×
        // seats (or flat plan price) > unlimited. Customers see this as
        // their AI-usage ceiling; markup stays internal so the cap aligns
        // with what they actually pay each cycle.
        // Prefer the live active-user count so seat changes show up
        // immediately on the customer's License page; Stripe still catches
        // up via the existing 15-min sync timer.
        let seatQty;
        try {
            seatQty = Math.max(1, await userStore.getActiveSeatCount(req.params.orgId));
        } catch (_) {
            seatQty = Number(sub.stripe_seat_quantity) || Number(effective?.seat_count) || 1;
        }
        const planPrice = Number(plan?.price) || 0;
        const isPerSeat = !!plan?.per_seat;
        const derivedCap = planPrice > 0
            ? (isPerSeat ? planPrice * seatQty : planPrice)
            : null;
        // Read the genuine subscription override from the raw row — `effective`
        // now already carries the seat-scaled cap from getEffectiveLimits, so
        // checking it here would just echo that. Using `sub` lets the displayed
        // cap track the LIVE seat count (derivedCap) for immediacy, while a real
        // admin override still wins. Display and enforcement share the price ×
        // seats formula and converge as soon as the seat sync lands.
        const explicitCap = Number(sub?.max_cost_per_month);
        const effectiveCostCap = (Number.isFinite(explicitCap) && explicitCap > 0)
            ? explicitCap
            : derivedCap;
        if (effectiveCostCap != null) {
            effective.max_cost_per_month = effectiveCostCap;
        }

        // Pooled / per-user toggle lives on the organization row. '1' is
        // the pre-migration default (pooled). When per-user, the client
        // renders an additional slice (`per_user_cap`) per active seat so
        // the dashboard can show personal budgets.
        let usagePooled = true;
        try {
            const orgRow = await userStore.getOrganization(req.params.orgId);
            usagePooled = (orgRow?.usage_pooled ?? '1') !== '0' && orgRow?.usagePooled !== false;
        } catch (_) { /* keep default = true */ }

        const billing = plan ? {
            plan_price: planPrice || null,
            plan_currency: plan.currency || 'EUR',
            billing_interval: plan.billing_interval || 'monthly',
            per_seat: isPerSeat,
            seat_quantity: isPerSeat ? seatQty : null,
            subscription_total: planPrice > 0
                ? (isPerSeat ? planPrice * seatQty : planPrice)
                : 0,
            usage_pooled: usagePooled,
            per_user_cap: !usagePooled
                && Number.isFinite(Number(effective?.max_cost_per_month))
                && Number(effective.max_cost_per_month) > 0
                ? Number(effective.max_cost_per_month) / Math.max(1, seatQty)
                : null,
        } : null;

        // Privacy gate (not the operational permission used elsewhere): raw
        // tokens / messages are only returned to the hardcoded platform
        // operator account. Everyone else — including admin_subscriptions
        // RBAC holders and org admins — gets the marked-up cost only.
        const isPlatformOperator = req.session?.user?.id === 'admin';
        const currentUsage = isPlatformOperator
            ? { messages: usage.total_calls || 0, tokens: usage.total_tokens || 0, cost: billedCost }
            : { cost: billedCost };

        // Upgradeable plans: same scope + interval, strictly higher price.
        // The frontend uses this list directly to render the Upgrade picker —
        // doing the filter server-side prevents the UI from ever offering a
        // downgrade just because the client logic drifts.
        let upgradeable_plans = [];
        try {
            const allPlans = await userStore.getAllPlans();
            upgradeable_plans = (allPlans || [])
                .filter(p => p.is_active !== false
                    && p.stripe_price_id
                    && (p.plan_type || 'organization') === (plan?.plan_type || 'organization')
                    && p.billing_interval === plan?.billing_interval
                    && Number(p.price) > planPrice)
                .sort((a, b) => Number(a.price) - Number(b.price))
                .map(p => ({
                    id: p.id,
                    name: p.name,
                    description: p.description,
                    price: p.price,
                    currency: p.currency || 'eur',
                    billing_interval: p.billing_interval,
                    max_users: p.max_users,
                    max_agents: p.max_agents,
                    max_knowledge_sources: p.max_knowledge_sources,
                    per_seat: !!p.per_seat,
                    has_stripe_price: !!p.stripe_price_id,
                }));
        } catch (e) {
            console.warn('[Subscriptions] upgradeable_plans compute failed:', e.message);
        }

        // Changeable plans: both directions (upgrade + downgrade), same scope +
        // interval, with a Stripe price and a non-zero price (downgrade-to-free
        // is "cancel", not a plan change). Each is tagged with its direction so
        // the in-app Change-plan picker can label and confirm appropriately.
        let changeable_plans = [];
        try {
            const allPlans = await userStore.getAllPlans();
            changeable_plans = (allPlans || [])
                .filter(p => p.is_active !== false
                    && p.stripe_price_id
                    && Number(p.price) > 0
                    && p.id !== plan?.id
                    && (p.plan_type || 'organization') === (plan?.plan_type || 'organization')
                    && p.billing_interval === plan?.billing_interval
                    && Number(p.price) !== planPrice)
                .sort((a, b) => Number(a.price) - Number(b.price))
                .map(p => ({
                    id: p.id,
                    name: p.name,
                    description: p.description,
                    price: p.price,
                    currency: p.currency || 'eur',
                    billing_interval: p.billing_interval,
                    max_users: p.max_users,
                    max_agents: p.max_agents,
                    max_knowledge_sources: p.max_knowledge_sources,
                    per_seat: !!p.per_seat,
                    has_stripe_price: !!p.stripe_price_id,
                    direction: Number(p.price) > planPrice ? 'upgrade' : 'downgrade',
                }));
        } catch (e) {
            console.warn('[Subscriptions] changeable_plans compute failed:', e.message);
        }

        // Resolve the friendly name of a pending (scheduled) downgrade target.
        let pending_plan_name = null;
        if (sub.pending_plan_id) {
            try { pending_plan_name = (await userStore.getPlan(sub.pending_plan_id))?.name || null; } catch (_) { /* ignore */ }
        }

        res.json({
            ...sub,
            cancel_at_period_end: !!sub.cancel_at_period_end,
            cancel_at: sub.cancel_at || null,
            current_period_end: sub.current_period_end || null,
            pending_plan_id: sub.pending_plan_id || null,
            pending_plan_effective: sub.pending_plan_effective || null,
            pending_plan_name,
            effective_limits: effective,
            billing_period: period,
            billing,
            current_usage: currentUsage,
            upgradeable_plans,
            changeable_plans,
        });
    } catch (e) {
        console.error('[Subscriptions] getOrgSub error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/subscriptions/orgs/:orgId — assign or update subscription
router.put('/orgs/:orgId', async (req, res) => {
    try {
        // Validate status if provided
        if (req.body.status && !['active', 'suspended', 'cancelled', 'trialing', 'past_due'].includes(req.body.status)) {
            return res.status(400).json({ error: 'Invalid status. Must be: active, suspended, cancelled, trialing, past_due' });
        }
        const numericFields = ['max_messages_per_month', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources'];
        for (const field of numericFields) {
            if (req.body[field] !== undefined && req.body[field] !== null && req.body[field] < 0) {
                return res.status(400).json({ error: `${field} must be non-negative` });
            }
        }

        // Manual-override window: an admin can lock the subscription against
        // Stripe webhook clobbering for up to a week (default 24h). Pass
        // override_hours: 0 to clear an existing override.
        const payload = { ...req.body };
        const adminId = getAdminId(req);
        if (Object.prototype.hasOwnProperty.call(req.body, 'override_hours')) {
            const h = Number(req.body.override_hours);
            if (!Number.isFinite(h) || h < 0 || h > 168) {
                return res.status(400).json({ error: 'override_hours must be between 0 and 168' });
            }
            payload.manual_override_until = h > 0 ? new Date(Date.now() + h * 3600 * 1000).toISOString() : null;
            payload.manual_override_by = h > 0 ? (adminId || 'admin') : null;
            delete payload.override_hours;
        }

        // Atomic read-modify-write: serialises two admins racing on the same
        // org and reports when this write displaced another admin's active
        // override. Both attempts are then visible in the audit log.
        const lockResult = await userStore.setOrgSubscriptionWithLock(req.params.orgId, payload);
        if (!lockResult.ok) return res.status(400).json({ error: 'Failed to set subscription' });
        const oldSub = lockResult.snapshot;

        // Propagate plan entitlements (integrations + beta features) when the
        // plan changes. Use 'intersect' on downgrade-style updates so admins
        // can opt into widening explicitly elsewhere if needed.
        if (payload.plan_id && payload.plan_id !== oldSub?.plan_id) {
            try {
                await require('../services/planEntitlements').applyPlanToOrg(req.params.orgId, payload.plan_id, { mode: 'reset' });
            } catch (e) {
                console.warn('[Subscriptions] applyPlanToOrg failed:', e.message);
            }
        }

        const action = oldSub ? 'update_subscription' : 'assign_subscription';
        await userStore.logSubscriptionAudit(action, 'org_subscription', req.params.orgId, adminId, oldSub, payload);
        if (payload.manual_override_until !== undefined) {
            await userStore.logSubscriptionAudit('manual_override_set', 'org_subscription', req.params.orgId, adminId, null, { manual_override_until: payload.manual_override_until });
        }
        if (lockResult.displaced) {
            // Surface the loser-of-race in audit so the previous admin's
            // override timestamp + identity isn't silently lost.
            await userStore.logSubscriptionAudit(
                'manual_override_displaced',
                'org_subscription',
                req.params.orgId,
                adminId,
                {
                    previous_override_by: oldSub.manual_override_by,
                    previous_override_until: oldSub.manual_override_until,
                },
                { manual_override_until: payload.manual_override_until, manual_override_by: payload.manual_override_by },
            );
        }

        const sub = await userStore.getOrgSubscription(req.params.orgId);
        res.json(sub);
    } catch (e) {
        console.error('[Subscriptions] setOrgSub error:', e);
        res.status(400).json({ error: e.message });
    }
});

// POST /api/subscriptions/orgs/:orgId/start-trial — one-time trial via Stripe
router.post('/orgs/:orgId/start-trial', async (req, res) => {
    try {
        const orgId = req.params.orgId;
        const { plan_id } = req.body || {};
        if (!plan_id) return res.status(400).json({ error: 'plan_id is required' });

        const trialService = require('../services/trialService');
        const sub = await trialService.startOrgTrial(orgId, plan_id, { changedBy: getAdminId(req) });
        res.json(sub);
    } catch (e) {
        if (e.code === 'trial_already_used') {
            return res.status(409).json({ error: 'trial_already_used' });
        }
        console.error('[Subscriptions] startOrgTrial error:', e);
        res.status(400).json({ error: e.message });
    }
});

// POST /api/subscriptions/orgs/:orgId/reissue-license — manually re-attempt
// the license server call for an existing org subscription. Use when a
// previous issuance failed (the audit log will have a `license_issuance_failed`
// row); calling this retries against the current subscription state.
router.post('/orgs/:orgId/reissue-license', async (req, res) => {
    try {
        const orgId = req.params.orgId;
        const sub = await userStore.getOrgSubscription(orgId);
        if (!sub) return res.status(404).json({ error: 'No subscription found' });
        const planId = sub.plan_id;
        if (!planId) return res.status(400).json({ error: 'Subscription has no plan_id' });
        const plan = await userStore.getPlan(planId);
        const { issueLicenseFromCheckout, tierFromPlanName } = require('../license/issuance');
        const tier = tierFromPlanName(plan?.name) || tierFromPlanName(plan?.description);
        if (!tier) return res.status(400).json({ error: 'Plan does not map to a license tier' });
        try {
            const result = await issueLicenseFromCheckout({
                scope: 'organization',
                organizationId: orgId,
                planId,
                tier,
                stripeCustomerId: sub.stripe_customer_id || null,
                stripeSubscriptionId: sub.stripe_subscription_id || null,
            });
            await userStore.logSubscriptionAudit(
                'license_issuance_succeeded', 'organization', orgId, getAdminId(req), null,
                { plan_id: planId, tier, stripe_subscription_id: sub.stripe_subscription_id || null, license_id: result?.licenseId || null, manual: true }
            );
            res.json({ success: true, license_id: result?.licenseId || null });
        } catch (e) {
            await userStore.logSubscriptionAudit(
                'license_issuance_failed', 'organization', orgId, getAdminId(req), null,
                { plan_id: planId, error_code: e.code || null, error: String(e.message || e).slice(0, 500), stripe_subscription_id: sub.stripe_subscription_id || null, manual: true }
            );
            res.status(502).json({ error: e.message, code: e.code || null });
        }
    } catch (e) {
        console.error('[Subscriptions] reissueLicense (org) error:', e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/subscriptions/consumer/:userId/reissue-license — same as above for
// individual / consumer subscriptions.
router.post('/consumer/:userId/reissue-license', async (req, res) => {
    try {
        const userId = req.params.userId;
        const sub = await userStore.getConsumerSubscription(userId);
        if (!sub) return res.status(404).json({ error: 'No subscription found' });
        const planId = sub.plan_id;
        if (!planId) return res.status(400).json({ error: 'Subscription has no plan_id' });
        const plan = await userStore.getPlan(planId);
        const { issueLicenseFromCheckout, tierFromPlanName } = require('../license/issuance');
        const tier = tierFromPlanName(plan?.name) || tierFromPlanName(plan?.description);
        if (!tier) return res.status(400).json({ error: 'Plan does not map to a license tier' });
        try {
            const result = await issueLicenseFromCheckout({
                scope: 'consumer',
                userId,
                planId,
                tier,
                stripeCustomerId: sub.stripe_customer_id || null,
                stripeSubscriptionId: sub.stripe_subscription_id || null,
            });
            await userStore.logSubscriptionAudit(
                'license_issuance_succeeded', 'consumer', userId, getAdminId(req), null,
                { plan_id: planId, tier, stripe_subscription_id: sub.stripe_subscription_id || null, license_id: result?.licenseId || null, manual: true }
            );
            res.json({ success: true, license_id: result?.licenseId || null });
        } catch (e) {
            await userStore.logSubscriptionAudit(
                'license_issuance_failed', 'consumer', userId, getAdminId(req), null,
                { plan_id: planId, error_code: e.code || null, error: String(e.message || e).slice(0, 500), stripe_subscription_id: sub.stripe_subscription_id || null, manual: true }
            );
            res.status(502).json({ error: e.message, code: e.code || null });
        }
    } catch (e) {
        console.error('[Subscriptions] reissueLicense (consumer) error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ── Subscription lifecycle (upgrade / cancel / reactivate) ────────────────
// In-app actions for the org admin. Drives `stripe.subscriptions.update`
// directly so the customer stays on the same subscription (no new Checkout
// session). Downgrades are intentionally rejected — the funnel only opens
// upward and cancellations end the relationship at period boundary.

const lifecycleErrorMessages = {
    same_plan: 'You are already on this plan.',
    no_price_change: 'The selected plan has the same price as your current plan.',
    interval_mismatch: 'Switching between monthly and yearly billing is not available here. Contact info@beeflow.nl.',
    wrong_plan_type: 'This plan does not match your account type.',
    'Subscription is not Stripe-managed': 'This subscription has no active payment yet. Choose a paid plan below to subscribe.',
    'Plan not configured for payment': 'That plan is not available for self-service billing yet.',
};

// Translate Stripe payment errors that surface during a synchronous
// subscription.update — e.g. proration invoice declined — into HTTP 402 so
// the UI can show a clear "update your payment method" prompt instead of a
// generic 500.
function stripePaymentErrorStatus(err) {
    if (!err) return null;
    if (err.statusCode === 402) return 402;
    if (err.code === 'card_declined' || err.code === 'authentication_required') return 402;
    if (err.type === 'StripeCardError') return 402;
    return null;
}

// Generalised in-app plan change. Upgrades (higher price) apply immediately
// with a prorated charge; downgrades (lower price) are scheduled to take
// effect at the end of the current billing period via a Stripe Subscription
// Schedule — no mid-cycle credit. Entitlements for a scheduled downgrade are
// (deliberately) NOT applied now: the customer.subscription.updated webhook
// applies them when the new price actually becomes active at the boundary.
async function performOrgPlanChange(orgId, planId, adminId) {
    const stripeService = require('../services/stripeService');
    const sub = await userStore.getOrgSubscription(orgId);
    if (!sub) { const e = new Error('No subscription found'); e.status = 404; throw e; }
    if (!sub.stripe_subscription_id) { const e = new Error('Subscription is not Stripe-managed'); e.status = 404; throw e; }
    const newPlan = await userStore.getPlan(planId);
    if (!newPlan) { const e = new Error('Plan not found'); e.status = 404; throw e; }
    if (!newPlan.stripe_price_id) { const e = new Error('Plan not configured for payment'); e.status = 400; throw e; }
    const currentPlan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
    if (!currentPlan) { const e = new Error('Current plan is not resolvable'); e.status = 409; throw e; }

    if (newPlan.id === currentPlan.id) { const e = new Error('same_plan'); e.status = 400; throw e; }
    const newPrice = Number(newPlan.price) || 0;
    const curPrice = Number(currentPlan.price) || 0;
    if (newPrice === curPrice) { const e = new Error('no_price_change'); e.status = 400; throw e; }
    if (newPlan.billing_interval !== currentPlan.billing_interval) { const e = new Error('interval_mismatch'); e.status = 400; throw e; }
    if ((newPlan.plan_type || 'organization') !== (currentPlan.plan_type || 'organization')) { const e = new Error('wrong_plan_type'); e.status = 400; throw e; }

    const quantity = newPlan.per_seat ? Math.max(1, await userStore.getActiveSeatCount(orgId)) : 1;
    const isUpgrade = newPrice > curPrice;

    if (isUpgrade) {
        // Re-upgrading cancels any pending downgrade cleanly before switching.
        if (sub.stripe_schedule_id) {
            await stripeService.releaseSubscriptionSchedule(sub.stripe_schedule_id);
        }
        let stripeSub;
        try {
            stripeSub = await stripeService.updateSubscriptionPlan({
                stripeSubscriptionId: sub.stripe_subscription_id,
                newPriceId: newPlan.stripe_price_id,
                quantity,
            });
        } catch (e) {
            const status = stripePaymentErrorStatus(e);
            if (status === 402) {
                await userStore.logSubscriptionAudit(
                    'upgrade_subscription_payment_failed', 'organization', orgId, adminId,
                    { plan_id: currentPlan.id },
                    { plan_id: newPlan.id, stripe_subscription_id: sub.stripe_subscription_id, error: String(e.message || e).slice(0, 500) }
                );
                const err = new Error('payment_required'); err.status = 402; throw err;
            }
            throw e;
        }

        // Optimistic local mirror — the customer.subscription.updated webhook
        // will re-confirm shortly. Clear any pending-downgrade bookkeeping.
        await userStore.setOrgSubscription(orgId, {
            plan_id: newPlan.id,
            status: 'active',
            payment_status: 'paid',
            stripe_seat_quantity: quantity,
            pending_plan_id: null,
            pending_plan_effective: null,
            stripe_schedule_id: null,
            ...(stripeSub.current_period_end
                ? { current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString() }
                : {}),
        });

        try {
            await require('../services/planEntitlements').applyPlanToOrg(orgId, newPlan.id, { mode: 'reset' });
        } catch (e) {
            console.warn('[Subscriptions] applyPlanToOrg (upgrade) failed:', e.message);
        }

        await userStore.logSubscriptionAudit(
            'upgrade_subscription', 'organization', orgId, adminId,
            { plan_id: currentPlan.id },
            { plan_id: newPlan.id, stripe_subscription_id: sub.stripe_subscription_id, quantity }
        );

        return userStore.getOrgSubscription(orgId);
    }

    // DOWNGRADE → schedule the switch at period end.
    const result = await stripeService.scheduleDowngradeAtPeriodEnd({
        stripeSubscriptionId: sub.stripe_subscription_id,
        newPriceId: newPlan.stripe_price_id,
        quantity,
    });
    await userStore.setOrgSubscription(orgId, {
        pending_plan_id: newPlan.id,
        pending_plan_effective: result.effective,
        stripe_schedule_id: result.scheduleId,
    });
    await userStore.logSubscriptionAudit(
        'downgrade_scheduled', 'organization', orgId, adminId,
        { plan_id: currentPlan.id },
        { pending_plan_id: newPlan.id, effective: result.effective, schedule_id: result.scheduleId, quantity }
    );
    return userStore.getOrgSubscription(orgId);
}

// Upgrade OR downgrade — the route name stays /upgrade for back-compat but
// the handler picks the right behaviour from the price delta.
router.post('/orgs/:orgId/upgrade', async (req, res) => {
    try {
        const { planId } = req.body || {};
        if (!planId) return res.status(400).json({ error: 'planId is required' });
        const result = await performOrgPlanChange(req.params.orgId, planId, getAdminId(req));
        res.json(result);
    } catch (e) {
        const status = e.status || 500;
        if (status === 500) console.error('[Subscriptions] orgs/:orgId/upgrade error:', e);
        const msg = lifecycleErrorMessages[e.message] || e.message;
        res.status(status).json({ error: e.message, message: msg });
    }
});

// Preview the cost impact of a plan change before the customer confirms.
// Upgrades return the prorated charge that will hit today; downgrades return
// the new recurring total and the date it takes effect (no charge now).
router.post('/orgs/:orgId/preview-change', async (req, res) => {
    try {
        const stripeService = require('../services/stripeService');
        const { planId } = req.body || {};
        if (!planId) return res.status(400).json({ error: 'planId is required' });
        const orgId = req.params.orgId;
        const sub = await userStore.getOrgSubscription(orgId);
        if (!sub) return res.status(404).json({ error: 'No subscription found' });
        if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
        const newPlan = await userStore.getPlan(planId);
        if (!newPlan || !newPlan.stripe_price_id) return res.status(400).json({ error: 'Plan not configured for payment' });
        const currentPlan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
        const newPrice = Number(newPlan.price) || 0;
        const curPrice = Number(currentPlan?.price) || 0;
        const quantity = newPlan.per_seat ? Math.max(1, await userStore.getActiveSeatCount(orgId)) : 1;
        const direction = newPrice > curPrice ? 'upgrade' : 'downgrade';
        const nextRenewalTotal = newPrice * quantity;
        const common = {
            direction,
            currency: (newPlan.currency || 'EUR').toUpperCase(),
            plan_name: newPlan.name,
            per_seat: !!newPlan.per_seat,
            seat_quantity: quantity,
            next_renewal_total: nextRenewalTotal,
        };
        if (direction === 'upgrade') {
            const preview = await stripeService.previewPlanChange({
                stripeSubscriptionId: sub.stripe_subscription_id,
                newPriceId: newPlan.stripe_price_id,
                quantity,
            });
            return res.json({ ...common, currency: preview.currency || common.currency, proration_amount: preview.proration_amount, effective: 'now' });
        }
        return res.json({ ...common, proration_amount: 0, effective: sub.current_period_end || null });
    } catch (e) {
        const status = stripePaymentErrorStatus(e) || 500;
        if (status === 500) console.error('[Subscriptions] orgs/:orgId/preview-change error:', e);
        res.status(status).json({ error: e.message });
    }
});

// Undo a scheduled (end-of-period) downgrade — releases the Stripe schedule
// and clears the local pending bookkeeping so the org stays on its plan.
router.post('/orgs/:orgId/cancel-downgrade', async (req, res) => {
    try {
        const stripeService = require('../services/stripeService');
        const orgId = req.params.orgId;
        const sub = await userStore.getOrgSubscription(orgId);
        if (!sub) return res.status(404).json({ error: 'No subscription found' });
        if (!sub.pending_plan_id) return res.status(409).json({ error: 'no_pending_change', message: 'No scheduled change to cancel.' });
        if (sub.stripe_schedule_id) await stripeService.releaseSubscriptionSchedule(sub.stripe_schedule_id);
        await userStore.setOrgSubscription(orgId, { pending_plan_id: null, pending_plan_effective: null, stripe_schedule_id: null });
        await userStore.logSubscriptionAudit(
            'downgrade_cancelled', 'organization', orgId, getAdminId(req),
            { pending_plan_id: sub.pending_plan_id }, null
        );
        res.json(await userStore.getOrgSubscription(orgId));
    } catch (e) {
        console.error('[Subscriptions] orgs/:orgId/cancel-downgrade error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/orgs/:orgId/cancel', async (req, res) => {
    try {
        const stripeService = require('../services/stripeService');
        const orgId = req.params.orgId;
        const sub = await userStore.getOrgSubscription(orgId);
        if (!sub) return res.status(404).json({ error: 'No subscription found' });
        if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
        if (sub.cancel_at_period_end) return res.status(409).json({ error: 'already_scheduled', message: 'Cancellation already scheduled.' });

        // A pending downgrade schedule must be released first, otherwise Stripe
        // refuses to cancel a schedule-governed subscription.
        if (sub.stripe_schedule_id) {
            await stripeService.releaseSubscriptionSchedule(sub.stripe_schedule_id);
            await userStore.setOrgSubscription(orgId, { pending_plan_id: null, pending_plan_effective: null, stripe_schedule_id: null });
        }

        const stripeSub = await stripeService.cancelSubscriptionAtPeriodEnd(sub.stripe_subscription_id);
        await userStore.setOrgSubscription(orgId, {
            cancel_at_period_end: true,
            cancel_at: stripeSub.cancel_at ? new Date(stripeSub.cancel_at * 1000).toISOString() : null,
            current_period_end: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000).toISOString() : null,
        });
        await userStore.logSubscriptionAudit(
            'cancel_subscription_scheduled', 'organization', orgId, getAdminId(req), null,
            { stripe_subscription_id: sub.stripe_subscription_id, cancel_at: stripeSub.cancel_at }
        );
        res.json(await userStore.getOrgSubscription(orgId));
    } catch (e) {
        console.error('[Subscriptions] orgs/:orgId/cancel error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/orgs/:orgId/reactivate', async (req, res) => {
    try {
        const stripeService = require('../services/stripeService');
        const orgId = req.params.orgId;
        const sub = await userStore.getOrgSubscription(orgId);
        if (!sub) return res.status(404).json({ error: 'No subscription found' });
        if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
        if (!sub.cancel_at_period_end) return res.status(409).json({ error: 'not_scheduled', message: 'Subscription is not scheduled to cancel.' });

        await stripeService.reactivateSubscription(sub.stripe_subscription_id);
        await userStore.setOrgSubscription(orgId, {
            cancel_at_period_end: false,
            cancel_at: null,
        });
        await userStore.logSubscriptionAudit(
            'cancel_subscription_undone', 'organization', orgId, getAdminId(req), null,
            { stripe_subscription_id: sub.stripe_subscription_id }
        );
        res.json(await userStore.getOrgSubscription(orgId));
    } catch (e) {
        console.error('[Subscriptions] orgs/:orgId/reactivate error:', e);
        res.status(500).json({ error: e.message });
    }
});

// Consumer (individual) lifecycle — mirror of the org trio.

async function performConsumerUpgrade(userId, planId, actorId) {
    const stripeService = require('../services/stripeService');
    const sub = await userStore.getConsumerSubscription(userId);
    if (!sub) { const e = new Error('No subscription found'); e.status = 404; throw e; }
    if (!sub.stripe_subscription_id) { const e = new Error('Subscription is not Stripe-managed'); e.status = 404; throw e; }
    const newPlan = await userStore.getPlan(planId);
    if (!newPlan) { const e = new Error('Plan not found'); e.status = 404; throw e; }
    if (!newPlan.stripe_price_id) { const e = new Error('Plan not configured for payment'); e.status = 400; throw e; }
    const currentPlan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
    if (!currentPlan) { const e = new Error('Current plan is not resolvable'); e.status = 409; throw e; }

    if (newPlan.id === currentPlan.id) { const e = new Error('same_plan'); e.status = 400; throw e; }
    const newPrice = Number(newPlan.price) || 0;
    const curPrice = Number(currentPlan.price) || 0;
    if (newPrice < curPrice) { const e = new Error('downgrade_not_supported'); e.status = 400; throw e; }
    if (newPrice === curPrice) { const e = new Error('no_price_change'); e.status = 400; throw e; }
    if (newPlan.billing_interval !== currentPlan.billing_interval) { const e = new Error('interval_mismatch'); e.status = 400; throw e; }
    if ((newPlan.plan_type || 'consumer') !== (currentPlan.plan_type || 'consumer')) { const e = new Error('wrong_plan_type'); e.status = 400; throw e; }

    let stripeSub;
    try {
        stripeSub = await stripeService.updateSubscriptionPlan({
            stripeSubscriptionId: sub.stripe_subscription_id,
            newPriceId: newPlan.stripe_price_id,
            quantity: 1,
        });
    } catch (e) {
        const status = stripePaymentErrorStatus(e);
        if (status === 402) {
            await userStore.logSubscriptionAudit(
                'upgrade_subscription_payment_failed', 'consumer', userId, actorId,
                { plan_id: currentPlan.id },
                { plan_id: newPlan.id, stripe_subscription_id: sub.stripe_subscription_id, error: String(e.message || e).slice(0, 500) }
            );
            const err = new Error('payment_required'); err.status = 402; throw err;
        }
        throw e;
    }

    await userStore.setConsumerSubscription(userId, {
        plan_id: newPlan.id,
        status: 'active',
        payment_status: 'paid',
        ...(stripeSub.current_period_end
            ? { current_period_end: new Date(stripeSub.current_period_end * 1000).toISOString() }
            : {}),
    });

    await userStore.logSubscriptionAudit(
        'upgrade_subscription', 'consumer', userId, actorId,
        { plan_id: currentPlan.id },
        { plan_id: newPlan.id, stripe_subscription_id: sub.stripe_subscription_id }
    );

    return userStore.getConsumerSubscription(userId);
}

router.post('/consumer/:userId/upgrade', async (req, res) => {
    try {
        const { planId } = req.body || {};
        if (!planId) return res.status(400).json({ error: 'planId is required' });
        const result = await performConsumerUpgrade(req.params.userId, planId, getAdminId(req));
        res.json(result);
    } catch (e) {
        const status = e.status || 500;
        if (status === 500) console.error('[Subscriptions] consumer/:userId/upgrade error:', e);
        const msg = lifecycleErrorMessages[e.message] || e.message;
        res.status(status).json({ error: e.message, message: msg });
    }
});

router.post('/consumer/:userId/cancel', async (req, res) => {
    try {
        const stripeService = require('../services/stripeService');
        const userId = req.params.userId;
        const sub = await userStore.getConsumerSubscription(userId);
        if (!sub) return res.status(404).json({ error: 'No subscription found' });
        if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
        if (sub.cancel_at_period_end) return res.status(409).json({ error: 'already_scheduled', message: 'Cancellation already scheduled.' });

        const stripeSub = await stripeService.cancelSubscriptionAtPeriodEnd(sub.stripe_subscription_id);
        await userStore.setConsumerSubscription(userId, {
            cancel_at_period_end: true,
            cancel_at: stripeSub.cancel_at ? new Date(stripeSub.cancel_at * 1000).toISOString() : null,
            current_period_end: stripeSub.current_period_end ? new Date(stripeSub.current_period_end * 1000).toISOString() : null,
        });
        await userStore.logSubscriptionAudit(
            'cancel_subscription_scheduled', 'consumer', userId, getAdminId(req), null,
            { stripe_subscription_id: sub.stripe_subscription_id, cancel_at: stripeSub.cancel_at }
        );
        res.json(await userStore.getConsumerSubscription(userId));
    } catch (e) {
        console.error('[Subscriptions] consumer/:userId/cancel error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/consumer/:userId/reactivate', async (req, res) => {
    try {
        const stripeService = require('../services/stripeService');
        const userId = req.params.userId;
        const sub = await userStore.getConsumerSubscription(userId);
        if (!sub) return res.status(404).json({ error: 'No subscription found' });
        if (!sub.stripe_subscription_id) return res.status(404).json({ error: 'Subscription is not Stripe-managed' });
        if (!sub.cancel_at_period_end) return res.status(409).json({ error: 'not_scheduled', message: 'Subscription is not scheduled to cancel.' });

        await stripeService.reactivateSubscription(sub.stripe_subscription_id);
        await userStore.setConsumerSubscription(userId, {
            cancel_at_period_end: false,
            cancel_at: null,
        });
        await userStore.logSubscriptionAudit(
            'cancel_subscription_undone', 'consumer', userId, getAdminId(req), null,
            { stripe_subscription_id: sub.stripe_subscription_id }
        );
        res.json(await userStore.getConsumerSubscription(userId));
    } catch (e) {
        console.error('[Subscriptions] consumer/:userId/reactivate error:', e);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/subscriptions/orgs/:orgId
router.delete('/orgs/:orgId', async (req, res) => {
    try {
        const oldSub = await userStore.getOrgSubscription(req.params.orgId);
        const ok = await userStore.deleteOrgSubscription(req.params.orgId);
        if (!ok) return res.status(404).json({ error: 'No subscription found' });

        await userStore.logSubscriptionAudit('remove_subscription', 'org_subscription', req.params.orgId, getAdminId(req), oldSub, null);
        res.json({ success: true });
    } catch (e) {
        console.error('[Subscriptions] deleteOrgSub error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/subscriptions/orgs/:orgId/usage — current period usage vs limits
router.get('/orgs/:orgId/usage', async (req, res) => {
    try {
        const sub = await userStore.getOrgSubscription(req.params.orgId);
        const effective = await userStore.getEffectiveLimits(req.params.orgId);
        if (!effective) return res.status(404).json({ error: 'No subscription' });

        // Use billing period instead of calendar month
        const period = userStore.getBillingPeriod(sub);
        const usage = await usageStore.getUsageSummary({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: req.params.orgId });

        res.json({
            limits: effective,
            billing_period: period,
            billing_model: sub?.billing_model || 'fixed',
            usage: {
                messages: usage.total_calls || 0,
                tokens: usage.total_tokens || 0,
                cost: usage.estimated_cost || 0,
            },
            percentages: {
                messages: effective.max_messages_per_month ? Math.round((usage.total_calls || 0) / effective.max_messages_per_month * 100) : null,
                tokens: effective.max_tokens_per_month ? Math.round((usage.total_tokens || 0) / effective.max_tokens_per_month * 100) : null,
                cost: effective.max_cost_per_month ? Math.round((usage.estimated_cost || 0) / effective.max_cost_per_month * 100) : null,
            }
        });
    } catch (e) {
        console.error('[Subscriptions] getOrgUsage error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/subscriptions/orgs/:orgId/effective-access — resolved, read-only
// view of which compound-gated features actually WORK for the org under its
// current plan. Mirrors the `canUseFeature` derivation in
// loginRoutes.js (/auth/my-permissions) exactly — reuses the same helpers so
// the admin view never drifts from what users really get.
router.get('/orgs/:orgId/effective-access', requireAuthOrOrgMember, async (req, res) => {
    try {
        const { orgId } = req.params;
        const license = require('../license');
        const licenseTiers = require('../license/tiers');
        const { listCompoundGatedFeatures, getEffectiveOrgBetaAllowList } = require('../core/betaFeatures');

        const tier = await license.resolveTier({ organizationId: orgId });
        // getOrgGrantedFeatures already unions the plan's allowed_features AND
        // (on cloud) the licence features derived from the plan's beta
        // allow-list — same source the licence gate reads.
        const granted = new Set(await license.getOrgGrantedFeatures(orgId));
        const betaAllow = new Set(await getEffectiveOrgBetaAllowList(orgId));

        const features = listCompoundGatedFeatures().map(g => {
            const hasLicense = licenseTiers.tierHasFeature(tier, g.licenseFeature) || granted.has(g.licenseFeature);
            const betaAllowed = betaAllow.has(g.id);
            return {
                id: g.id,
                name: g.name,
                licenseFeature: g.licenseFeature,
                hasLicense,
                betaAllowed,
                effective: hasLicense && betaAllowed,
            };
        });
        res.json({ tier, features });
    } catch (e) {
        console.error('[Subscriptions] effective-access error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════
//  Audit Log
// ═══════════════════════════════════════

// GET /api/subscriptions/audit — subscription changes audit log
router.get('/audit', async (req, res) => {
    try {
        const { targetType, targetId, limit = 50, offset = 0 } = req.query;
        const logs = await userStore.getAuditLog({
            targetType, targetId,
            limit: Math.min(parseInt(limit) || 50, 200),
            offset: parseInt(offset) || 0,
        });
        res.json(logs);
    } catch (e) {
        console.error('[Subscriptions] getAuditLog error:', e);
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════
//  Consumer Account Usage & Subscription
// ═══════════════════════════════════════

// GET /api/subscriptions/consumer/usage — consumer account limits + usage + subscription status
router.get('/consumer/usage', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        // Check if user has a paid consumer subscription
        const consumerSub = await userStore.getConsumerSubscription(userId);
        let activePlan = null;

        if (consumerSub && consumerSub.plan_id && ['active', 'trialing'].includes(consumerSub.status)) {
            activePlan = await userStore.getPlan(consumerSub.plan_id);
        }

        // Fallback to the default consumer plan
        if (!activePlan) {
            const allPlans = await userStore.getAllPlans();
            activePlan = allPlans.find(p => p.plan_type === 'consumer' && p.is_default)
                || allPlans.find(p => p.name === '__consumer_default__');
        }

        // Build limits from active plan (or return nulls = unlimited)
        const limits = {
            max_messages_per_month: activePlan?.max_messages_per_month ?? null,
            max_tokens_per_month: activePlan?.max_tokens_per_month ?? null,
            max_cost_per_month: activePlan?.max_cost_per_month ?? null,
            max_agents: activePlan?.max_agents ?? null,
            max_knowledge_sources: activePlan?.max_knowledge_sources ?? null,
            max_messages_by_type: activePlan?.max_messages_by_type ?? null,
            allowed_features: activePlan?.allowed_features ?? [],
            allowed_models: activePlan?.allowed_models ?? [],
            plan_name: activePlan?.name === '__consumer_default__' ? 'Free' : (activePlan?.name || 'Free'),
        };

        // Get current period usage for this user
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const endDate = now.toISOString();
        const summary = await usageStore.getUsageSummary({ startDate, endDate, userId });
        const byType = await usageStore.getUsageByAgentType({ startDate, endDate, userId });

        const markup = Number(activePlan?.markup_percent) || 0;
        const billedFactor = 1 + markup / 100;
        const billedCost = (Number(summary.total_estimated_cost) || 0) * billedFactor;
        const redactedByType = (byType || []).map(t => {
            const row = { ...t };
            row.billed_cost = (Number(row.estimated_cost) || 0) * billedFactor;
            delete row.estimated_cost;
            delete row.total_calls;
            delete row.calls;
            delete row.total_tokens;
            delete row.prompt_tokens;
            delete row.completion_tokens;
            return row;
        });

        res.json({
            limits,
            usage: {
                total_billed_cost: billedCost,
                by_type: redactedByType,
            },
            billing_period: {
                start: startDate,
                end: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
            },
            // Plan billing model is hoisted to the top level so the usage
            // panel can hide €/cost when on a flat-rate plan even when there
            // is no consumer_subscriptions row (free / default consumer plan).
            billing_model: activePlan?.billing_model || 'fixed',
            subscription: consumerSub ? {
                status: consumerSub.status,
                plan_id: consumerSub.plan_id,
                plan_name: consumerSub.plan_name,
                payment_status: consumerSub.payment_status,
                stripe_customer_id: !!consumerSub.stripe_customer_id,
                stripe_subscription_id: !!consumerSub.stripe_subscription_id,
                trial_end_date: consumerSub.trial_end_date,
                billing_model: consumerSub.billing_model || activePlan?.billing_model || 'fixed',
            } : null,
        });
    } catch (e) {
        console.error('[Subscriptions] consumer usage error:', e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/subscriptions/consumer/:userId/start-trial — one-time consumer trial via Stripe
router.post('/consumer/:userId/start-trial', async (req, res) => {
    try {
        const userId = req.params.userId;
        const { plan_id } = req.body || {};
        if (!plan_id) return res.status(400).json({ error: 'plan_id is required' });

        const trialService = require('../services/trialService');
        const sub = await trialService.startConsumerTrial(userId, plan_id, { changedBy: getAdminId(req) });
        res.json(sub);
    } catch (e) {
        if (e.code === 'trial_already_used') {
            return res.status(409).json({ error: 'trial_already_used' });
        }
        console.error('[Subscriptions] startConsumerTrial error:', e);
        res.status(400).json({ error: e.message });
    }
});

// GET /api/subscriptions/registries — master lists used by the Plan editor
// (beta features registry; integration catalog is a frontend constant).
router.get('/registries', async (req, res) => {
    try {
        const { BETA_FEATURES } = require('../core/betaFeatures');

        // Installed MCP servers — surfaced to the Plan editor as INTEGRATION
        // options. IDs are `mcp:<id>` and the editor saves selected ones into the
        // plan's `allowed_integrations` (MCP servers are integrations now; opt-in
        // per subscription — never part of an unrestricted/null cap).
        let mcp_servers = [];
        try {
            const servers = await require('../stores/mcpStore').listServers();
            mcp_servers = (servers || []).map(s => ({
                id: `mcp:${s.id}`,
                name: s.name || s.id,
                description: s.description || '',
                category: 'MCP servers',
                enabled: s.enabled !== false,
            }));
        } catch (e) {
            console.warn('[Subscriptions] registries: mcp list unavailable:', e.message);
        }

        res.json({
            beta_features: (BETA_FEATURES || []).filter(f => !f.deprecated).map(f => ({
                id: f.id, name: f.name, description: f.description, license_feature: f.licenseFeature || null,
            })),
            mcp_servers,
        });
    } catch (e) {
        console.error('[Subscriptions] registries error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/subscriptions/trial-config — read which plans are offered as trial
router.get('/trial-config', async (req, res) => {
    try {
        const trialService = require('../services/trialService');
        res.json(await trialService.getTrialConfig());
    } catch (e) {
        console.error('[Subscriptions] getTrialConfig error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/subscriptions/trial-config — pick the default trial plans (org + consumer)
router.put('/trial-config', async (req, res) => {
    try {
        const trialService = require('../services/trialService');
        const payload = req.body || {};

        // Validate referenced plans exist, are trial-ready, and are the right type
        for (const [field, expectedType] of [
            ['default_org_trial_plan_id', 'organization'],
            ['default_consumer_trial_plan_id', 'consumer'],
        ]) {
            const id = payload[field];
            if (!id) continue; // empty string / null clears the slot
            const plan = await userStore.getPlan(id);
            if (!plan) return res.status(400).json({ error: `${field}: plan not found` });
            if (!plan.trial_days || plan.trial_days <= 0) {
                return res.status(400).json({ error: `${field}: plan must have trial_days > 0` });
            }
            if (!plan.stripe_price_id) {
                return res.status(400).json({ error: `${field}: plan must be synced to Stripe first` });
            }
            const planType = plan.plan_type || 'organization';
            if (planType !== expectedType) {
                return res.status(400).json({ error: `${field}: plan_type must be "${expectedType}", got "${planType}"` });
            }
        }

        const oldCfg = await trialService.getTrialConfig();
        const newCfg = await trialService.setTrialConfig(payload);
        await userStore.logSubscriptionAudit('update_trial_config', 'trial_config', 'global', getAdminId(req), oldCfg, newCfg);
        res.json(newCfg);
    } catch (e) {
        console.error('[Subscriptions] setTrialConfig error:', e);
        res.status(400).json({ error: e.message });
    }
});

// GET /api/subscriptions/license-issuance-failures — unresolved-only.
// A "failure" is a `license_issuance_failed` audit row that does NOT have a
// later `license_issuance_succeeded` row for the same target_id. Used by the
// admin sidebar badge and the audit-view Retry UI. Returns the most recent
// 50 failures with target metadata so the UI can render the list inline.
router.get('/license-issuance-failures', async (req, res) => {
    try {
        const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
        const rows = await userStore.getUnresolvedLicenseIssuanceFailures(limit);
        res.json(rows);
    } catch (e) {
        console.error('[Subscriptions] getUnresolvedLicenseIssuanceFailures error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/subscriptions/currency-rates — admin-configurable USD→X rates
// applied at usage-log time to convert LiteLLM USD costs into the plan's
// billing currency. Missing rates fall back to 1.0 (no conversion).
router.get('/currency-rates', async (req, res) => {
    try {
        const currency = require('../core/currency');
        res.json(await currency.getAllConfiguredRates());
    } catch (e) {
        console.error('[Subscriptions] getCurrencyRates error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/subscriptions/currency-rates — body: { eur: 0.92, gbp: 0.78, ... }
// Each value is a USD → <currency> multiplier. Persists via configStore
// and audits the diff. Also clears the PAYG resolver cache so the next AI
// call sees the new rate immediately rather than after the 60s TTL.
router.put('/currency-rates', async (req, res) => {
    try {
        const currency = require('../core/currency');
        const payload = req.body && typeof req.body === 'object' ? req.body : {};
        const before = await currency.getAllConfiguredRates();
        const applied = {};
        for (const [code, rate] of Object.entries(payload)) {
            if (typeof code !== 'string' || !/^[a-z]{3}$/i.test(code)) {
                return res.status(400).json({ error: `Invalid currency code: ${code}` });
            }
            const numeric = Number(rate);
            if (!Number.isFinite(numeric) || numeric <= 0) {
                return res.status(400).json({ error: `Invalid rate for ${code}: ${rate}` });
            }
            const r = await currency.setUsdToCurrencyRate(code, numeric);
            applied[r.currency.toLowerCase()] = r.rate;
        }
        // Drop any PAYG-cache entries so freshly converted rates take effect now.
        try { require('../stores/usageStore').invalidatePaygCache(null, null); } catch (_) { /* circular-load safe */ }
        const after = await currency.getAllConfiguredRates();
        await userStore.logSubscriptionAudit('update_currency_rates', 'currency_rates', 'global', getAdminId(req), before, after);
        res.json(after);
    } catch (e) {
        console.error('[Subscriptions] setCurrencyRates error:', e);
        res.status(400).json({ error: e.message });
    }
});

module.exports = router;

