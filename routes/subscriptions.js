/**
 * Subscriptions API Routes — Plan and org subscription management
 * All routes require super admin access.
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
    // Check if user belongs to the requested org
    const orgId = req.params.orgId;
    const userId = req.session.user?.id;
    if (orgId && userId) {
        const user = userStore.getUser(userId);
        if (user?.organizationId === orgId) return next();
    }
    return res.status(403).json({ error: 'Admin access required' });
}

// Admin-only for plans and write operations; org members can read their own org sub
router.use((req, res, next) => {
    // GET /orgs/:orgId and /orgs/:orgId/usage — allow org members
    const orgMatch = req.path.match(/^\/orgs\/([^/]+)(\/usage)?$/);
    if (req.method === 'GET' && orgMatch) {
        req.params.orgId = req.params.orgId || orgMatch[1];
        return requireAuthOrOrgMember(req, res, next);
    }
    // Everything else requires super admin
    return requireAdmin(req, res, next);
});

// ═══════════════════════════════════════
//  Subscription Plans
// ═══════════════════════════════════════

// GET /api/subscriptions/plans
router.get('/plans', (req, res) => {
    try {
        res.json(userStore.getAllPlans());
    } catch (e) {
        console.error('[Subscriptions] getAllPlans error:', e);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/subscriptions/plans
router.post('/plans', (req, res) => {
    try {
        const plan = userStore.createPlan(req.body);
        if (!plan) return res.status(400).json({ error: 'Failed to create plan' });
        res.status(201).json(plan);
    } catch (e) {
        console.error('[Subscriptions] createPlan error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /api/subscriptions/plans/:id
router.put('/plans/:id', (req, res) => {
    try {
        const ok = userStore.updatePlan(req.params.id, req.body);
        if (!ok) return res.status(404).json({ error: 'Plan not found' });
        res.json(userStore.getPlan(req.params.id));
    } catch (e) {
        console.error('[Subscriptions] updatePlan error:', e);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/subscriptions/plans/:id
router.delete('/plans/:id', (req, res) => {
    try {
        const ok = userStore.deletePlan(req.params.id);
        if (!ok) return res.status(404).json({ error: 'Plan not found' });
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
router.get('/orgs', (req, res) => {
    try {
        const subs = userStore.getAllOrgSubscriptions();
        const orgs = userStore.getAllOrganizations();

        // Enrich each subscription with org info and current usage
        const result = subs.map(sub => {
            const org = orgs.find(o => o.id === sub.organization_id);
            const effective = userStore.getEffectiveLimits(sub.organization_id);
            // Get current month usage
            const now = new Date();
            const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
            const endDate = now.toISOString();
            let usage = {};
            try {
                usage = usageStore.getUsageSummary({ startDate, endDate, organizationId: sub.organization_id });
            } catch (_) { }

            return {
                ...sub,
                org_name: org?.name || 'Unknown',
                effective_limits: effective,
                current_usage: {
                    messages: usage.total_calls || 0,
                    tokens: usage.total_tokens || 0,
                    cost: usage.estimated_cost || 0,
                }
            };
        });

        res.json(result);
    } catch (e) {
        console.error('[Subscriptions] getAllOrgSubs error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/subscriptions/orgs/:orgId
router.get('/orgs/:orgId', (req, res) => {
    try {
        const sub = userStore.getOrgSubscription(req.params.orgId);
        if (!sub) return res.status(404).json({ error: 'No subscription for this org' });

        const effective = userStore.getEffectiveLimits(req.params.orgId);
        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const endDate = now.toISOString();
        let usage = {};
        try {
            usage = usageStore.getUsageSummary({ startDate, endDate, organizationId: req.params.orgId });
        } catch (_) { }

        res.json({
            ...sub,
            effective_limits: effective,
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
router.put('/orgs/:orgId', (req, res) => {
    try {
        const ok = userStore.setOrgSubscription(req.params.orgId, req.body);
        if (!ok) return res.status(400).json({ error: 'Failed to set subscription' });
        // Return the updated subscription
        const sub = userStore.getOrgSubscription(req.params.orgId);
        res.json(sub);
    } catch (e) {
        console.error('[Subscriptions] setOrgSub error:', e);
        res.status(500).json({ error: e.message });
    }
});

// DELETE /api/subscriptions/orgs/:orgId
router.delete('/orgs/:orgId', (req, res) => {
    try {
        const ok = userStore.deleteOrgSubscription(req.params.orgId);
        if (!ok) return res.status(404).json({ error: 'No subscription found' });
        res.json({ success: true });
    } catch (e) {
        console.error('[Subscriptions] deleteOrgSub error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/subscriptions/orgs/:orgId/usage — current period usage vs limits
router.get('/orgs/:orgId/usage', (req, res) => {
    try {
        const effective = userStore.getEffectiveLimits(req.params.orgId);
        if (!effective) return res.status(404).json({ error: 'No subscription' });

        const now = new Date();
        const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
        const endDate = now.toISOString();
        const usage = usageStore.getUsageSummary({ startDate, endDate, organizationId: req.params.orgId });

        res.json({
            limits: effective,
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

module.exports = router;
