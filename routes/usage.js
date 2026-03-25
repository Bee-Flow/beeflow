const express = require('express');
const router = express.Router();
const usageStore = require('../stores/usageStore');
const { requireAuth } = require('../auth/permissions');

router.use(requireAuth);

// Helper to get the user's primary organisation
function getOrg(req) {
    const orgs = req.session.user?.organizations || [];
    return orgs[0] || req.session.user?.id;
}

// Helper to parse days filter
function getDateFilters(daysAttr = '30') {
    const days = parseInt(daysAttr, 10) || 30;
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return { startDate: start.toISOString(), endDate: now.toISOString() };
}

// 1. Summary Overview
router.get('/summary', async (req, res) => {
    try {
        const filters = {
            organizationId: getOrg(req),
            ...getDateFilters(req.query.days)
        };
        const summary = await usageStore.getUsageSummary(filters);
        res.json(summary || { total_calls: 0, total_tokens: 0, total_estimated_cost: 0 });
    } catch (err) {
        console.error('[Usage API] /summary error:', err.message);
        res.status(500).json({ error: 'Failed to fetch usage summary' });
    }
});

// 2. Timeline (Sparkline data)
router.get('/timeline', async (req, res) => {
    try {
        const filters = {
            organizationId: getOrg(req),
            ...getDateFilters(req.query.days)
        };
        // If viewing 7 days or less, show by hour. Otherwise by day.
        const interval = (parseInt(req.query.days, 10) || 30) <= 7 ? 'hour' : 'day';
        const timeline = await usageStore.getUsageTimeline(filters, interval);
        res.json(timeline || []);
    } catch (err) {
        console.error('[Usage API] /timeline error:', err.message);
        res.status(500).json({ error: 'Failed to fetch timeline data' });
    }
});

// 3. Usage by User
router.get('/users', async (req, res) => {
    try {
        const orgId = getOrg(req);
        const filters = {
            organizationId: orgId,
            ...getDateFilters(req.query.days)
        };
        
        // Get raw usage grouped by user_id
        const usersUsage = await usageStore.getUsageByUser(filters);
        
        // Enhance with user display names
        const { getAll } = require('../db');
        const userRows = await getAll(`SELECT id, username, display_name FROM users WHERE organization_id = $1 OR id = $2`, [orgId, orgId]);
        const userMap = new Map(userRows.map(u => [u.id, u.display_name || u.username]));
        
        const enriched = usersUsage.map(u => ({
            ...u,
            display_name: userMap.get(u.user_id) || u.user_id
        }));
        
        res.json(enriched);
    } catch (err) {
        console.error('[Usage API] /users error:', err.message);
        res.status(500).json({ error: 'Failed to fetch user usage' });
    }
});

// 4. Usage by App Area (Source)
router.get('/sources', async (req, res) => {
    try {
        const filters = {
            organizationId: getOrg(req),
            ...getDateFilters(req.query.days)
        };
        const sources = await usageStore.getUsageBySource(filters);
        res.json(sources || []);
    } catch (err) {
        console.error('[Usage API] /sources error:', err.message);
        res.status(500).json({ error: 'Failed to fetch source usage' });
    }
});

// 5. Usage by Agent
router.get('/agents', async (req, res) => {
    try {
        const filters = {
            organizationId: getOrg(req),
            ...getDateFilters(req.query.days)
        };
        const agents = await usageStore.getUsageByAgent(filters);
        res.json(agents || []);
    } catch (err) {
        console.error('[Usage API] /agents error:', err.message);
        res.status(500).json({ error: 'Failed to fetch agent usage' });
    }
});

module.exports = router;
