/**
 * Subscriptions API Routes — Plan and org subscription management
 * All write routes require super admin access. Org members can read their own subscription.
 */

const express = require('express');
const userStore = require('../stores/userStore');
const usageStore = require('../stores/usageStore');

const router = express.Router();

function isSuperAdmin(req) {
    return req.session?.isAdmin || req.session?.user?.role === 'admin';
}

function requireAdmin(req, res, next) {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// Allow authenticated users to read their own org's subscription, super admins can access all
function requireAuthOrOrgMember(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    if (isSuperAdmin(req)) return next();
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

        const plan = await userStore.createPlan(req.body);
        if (!plan) return res.status(400).json({ error: 'Failed to create plan' });

        await userStore.logSubscriptionAudit('create_plan', 'plan', plan.id, getAdminId(req), null, { name: plan.name, price: plan.price, billing_interval: plan.billing_interval });
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

        const oldPlan = await userStore.getPlan(req.params.id);
        const ok = await userStore.updatePlan(req.params.id, req.body);
        if (!ok) return res.status(404).json({ error: 'Plan not found' });

        const updated = await userStore.getPlan(req.params.id);
        await userStore.logSubscriptionAudit('update_plan', 'plan', req.params.id, getAdminId(req), oldPlan, req.body);
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
        console.error('[Subscriptions] deletePlan error:', e);
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

        const oldSub = await userStore.getOrgSubscription(req.params.orgId);
        const ok = await userStore.setOrgSubscription(req.params.orgId, req.body);
        if (!ok) return res.status(400).json({ error: 'Failed to set subscription' });

        const action = oldSub ? 'update_subscription' : 'assign_subscription';
        await userStore.logSubscriptionAudit(action, 'org_subscription', req.params.orgId, getAdminId(req), oldSub, req.body);

        const sub = await userStore.getOrgSubscription(req.params.orgId);
        res.json(sub);
    } catch (e) {
        console.error('[Subscriptions] setOrgSub error:', e);
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
//  Consumer Account Usage
// ═══════════════════════════════════════

// GET /api/subscriptions/consumer/usage — consumer account limits + usage
router.get('/consumer/usage', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        // Get __consumer_default__ plan
        const allPlans = await userStore.getAllPlans();
        const consumerPlan = allPlans.find(p => p.name === '__consumer_default__');

        // Build limits from consumer plan (or return nulls = unlimited)
        const limits = {
            max_messages_per_month: consumerPlan?.max_messages_per_month ?? null,
            max_tokens_per_month: consumerPlan?.max_tokens_per_month ?? null,
            max_cost_per_month: consumerPlan?.max_cost_per_month ?? null,
            max_agents: consumerPlan?.max_agents ?? null,
            max_knowledge_sources: consumerPlan?.max_knowledge_sources ?? null,
            max_messages_by_type: consumerPlan?.max_messages_by_type ?? null,
            allowed_features: consumerPlan?.allowed_features ?? [],
            allowed_models: consumerPlan?.allowed_models ?? [],
            plan_name: consumerPlan?.name || 'Free',
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
        });
    } catch (e) {
        console.error('[Subscriptions] consumer usage error:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
