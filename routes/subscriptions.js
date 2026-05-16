/**
 * Subscriptions API Routes — Plan and org subscription management
 * All write routes require super admin access. Org members can read their own subscription.
 */

const express = require('express');
const userStore = require('../stores/userStore');
const usageStore = require('../stores/usageStore');

const router = express.Router();
const { hasPermission } = require('../auth/permissions');

async function isSuperAdmin(req) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    // Check RBAC: user may have admin_subscriptions or all permission via groups/roles
    const userId = req.session?.user?.id;
    if (!userId) return false;
    return await hasPermission(userId, 'admin_subscriptions', req.session);
}

async function requireAdmin(req, res, next) {
    if (!(await isSuperAdmin(req))) return res.status(403).json({ error: 'Admin access required' });
    next();
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

// Admin-only for plans and write operations; org members can read their own org sub
router.use((req, res, next) => {
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

            result.push({
                ...sub,
                org_name: org?.name || 'Unknown',
                org_trial_used_at: org?.trial_used_at || null,
                effective_limits: effective,
                billing_period: period,
                current_usage: {
                    messages: usage.total_calls || 0,
                    tokens: usage.total_tokens || 0,
                    cost: usage.estimated_cost || 0,
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

        res.json({
            ...sub,
            effective_limits: effective,
            billing_period: period,
            current_usage: {
                messages: usage.total_calls || 0,
                tokens: usage.total_tokens || 0,
                cost: usage.estimated_cost || 0,
            }
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

        const oldSub = await userStore.getOrgSubscription(req.params.orgId);
        const ok = await userStore.setOrgSubscription(req.params.orgId, payload);
        if (!ok) return res.status(400).json({ error: 'Failed to set subscription' });

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

        res.json({
            limits,
            usage: {
                total_calls: summary.total_calls || 0,
                total_tokens: summary.total_tokens || 0,
                total_estimated_cost: summary.total_estimated_cost || 0,
                by_type: byType || [],
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
        res.json({
            beta_features: (BETA_FEATURES || []).filter(f => !f.deprecated).map(f => ({
                id: f.id, name: f.name, description: f.description, license_feature: f.licenseFeature || null,
            })),
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

module.exports = router;

