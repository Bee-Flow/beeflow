/**
 * Usage API Routes — AI monitoring endpoints
 * Org-scoped: non-admin users only see usage from their organization.
 */

const express = require('express');
const usageStore = require('../stores/usageStore');
const userStore = require('../stores/userStore');

const router = express.Router();

/**
 * Resolve the user's organization from their session.
 * Super admins (role=admin) get null → see everything by default.
 * But super admins can pass ?orgId=xxx to filter to a specific org.
 * Non-admins always get their own org.
 */
function resolveUserOrg(req) {
    const userId = req.session?.user?.id;
    if (!userId) return null;

    const isSuperAdmin = req.session?.isAdmin || req.session?.user?.role === 'admin';

    // Super admin: if explicit orgId filter is provided, use it
    if (isSuperAdmin) {
        const explicitOrg = req.query?.orgId;
        return explicitOrg || null;   // null = no filter (see everything)
    }

    // Regular user: resolve from their group membership
    try {
        const user = userStore.getUser(userId);
        if (!user) return null;

        let groupIds = [];
        if (Array.isArray(user.groups)) {
            groupIds = user.groups;
        } else {
            try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { }
        }

        const allGroups = userStore.getAllGroups();
        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            if (group?.organizationId) return group.organizationId;
        }
    } catch (_) { }
    return null;
}

function isSuperAdmin(req) {
    return req.session?.isAdmin || req.session?.user?.role === 'admin';
}

// GET /api/usage/organizations — per-org usage stats (admin only)
router.get('/organizations', async (req, res) => {
    try {
        if (!isSuperAdmin(req)) {
            return res.status(403).json({ error: 'Admin access required' });
        }

        const { startDate, endDate } = req.query;
        const orgsResult = await userStore.getAllOrganizations();
        const orgs = Array.isArray(orgsResult) ? orgsResult : [];
        const filters = { startDate, endDate };

        // Get per-org usage summary
        const result = await Promise.all(orgs.map(async (org) => {
            const orgSummary = await usageStore.getUsageSummary({ ...filters, organizationId: org.id });
            return {
                id: org.id,
                name: org.name,
                total_calls: orgSummary.total_calls || 0,
                total_tokens: orgSummary.total_tokens || 0,
                estimated_cost: orgSummary.estimated_cost || 0,
                unique_models: orgSummary.unique_models || 0,
            };
        }));

        // Add "unassigned" bucket (calls without org)
        const allSummary = await usageStore.getUsageSummary(filters);
        const assignedCalls = result.reduce((s, o) => s + o.total_calls, 0);
        if (allSummary.total_calls > assignedCalls) {
            result.push({
                id: '__unassigned',
                name: 'Unassigned',
                total_calls: allSummary.total_calls - assignedCalls,
                total_tokens: allSummary.total_tokens - result.reduce((s, o) => s + o.total_tokens, 0),
                estimated_cost: (allSummary.estimated_cost || 0) - result.reduce((s, o) => s + o.estimated_cost, 0),
                unique_models: 0,
            });
        }

        res.json(result);
    } catch (e) {
        console.error('[Usage API] organizations error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/by-conversation — per-conversation cost breakdown
router.get('/by-conversation', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const organizationId = resolveUserOrg(req);
        const data = await usageStore.getUsageByConversation({ startDate, endDate, organizationId });
        res.json(data);
    } catch (e) {
        console.error('[Usage API] by-conversation error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/summary
router.get('/summary', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const organizationId = resolveUserOrg(req);
        const summary = await usageStore.getUsageSummary({ startDate, endDate, organizationId });
        res.json(summary);
    } catch (e) {
        console.error('[Usage API] summary error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/by-model
router.get('/by-model', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const organizationId = resolveUserOrg(req);
        const data = await usageStore.getUsageByModel({ startDate, endDate, organizationId });
        res.json(data);
    } catch (e) {
        console.error('[Usage API] by-model error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/by-agent
router.get('/by-agent', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const organizationId = resolveUserOrg(req);
        const data = await usageStore.getUsageByAgent({ startDate, endDate, organizationId });
        res.json(data);
    } catch (e) {
        console.error('[Usage API] by-agent error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/timeline?interval=day|hour
router.get('/timeline', async (req, res) => {
    try {
        const { startDate, endDate, interval } = req.query;
        const organizationId = resolveUserOrg(req);
        const data = await usageStore.getUsageTimeline({ startDate, endDate, organizationId }, interval || 'day');
        res.json(data);
    } catch (e) {
        console.error('[Usage API] timeline error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/tools
router.get('/tools', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const organizationId = resolveUserOrg(req);
        const data = await usageStore.getToolUsage({ startDate, endDate, organizationId });
        res.json(data);
    } catch (e) {
        console.error('[Usage API] tools error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/by-source
router.get('/by-source', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const organizationId = resolveUserOrg(req);
        const data = await usageStore.getUsageBySource({ startDate, endDate, organizationId });
        res.json(data);
    } catch (e) {
        console.error('[Usage API] by-source error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/by-user
router.get('/by-user', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const organizationId = resolveUserOrg(req);
        const data = await usageStore.getUsageByUser({ startDate, endDate, organizationId });
        res.json(data);
    } catch (e) {
        console.error('[Usage API] by-user error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/recent?limit=50&source=&model=&search=
router.get('/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const organizationId = resolveUserOrg(req);
        const { startDate, endDate, source, model, search } = req.query;
        const data = await usageStore.getRecentCalls(Math.min(limit, 200), {
            organizationId, startDate, endDate, source, model, search
        });
        res.json(data);
    } catch (e) {
        console.error('[Usage API] recent error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/cost-timeline?interval=day|hour
router.get('/cost-timeline', async (req, res) => {
    try {
        const { startDate, endDate, interval } = req.query;
        const organizationId = resolveUserOrg(req);
        const data = await usageStore.getCostTimeline({ startDate, endDate, organizationId }, interval || 'day');
        res.json(data);
    } catch (e) {
        console.error('[Usage API] cost-timeline error:', e);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/filters/sources — distinct source types
router.get('/filters/sources', async (req, res) => {
    try {
        res.json(await usageStore.getUsageSources());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/usage/filters/models — distinct model names
router.get('/filters/models', async (req, res) => {
    try {
        res.json(await usageStore.getUsageModels());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;

