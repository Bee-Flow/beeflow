const express = require('express');
const router = express.Router();
const usageStore = require('../stores/usageStore');
const { resolveUserOrgIds } = require('../auth');

// Helper to parse days filter
function getDateFilters(daysParam = '30') {
    const days = parseInt(daysParam, 10) || 30;
    const now = new Date();
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return { startDate: start.toISOString(), endDate: now.toISOString() };
}

// Resolve org filter for usage queries
async function getOrgFilter(req) {
    const orgIds = await resolveUserOrgIds(req);
    // orgIds is null for super admins (no filter), or a Set of org IDs
    if (orgIds === null) return null; // super admin — no filter
    if (orgIds.size === 0) return '__none__'; // user has no org
    return Array.from(orgIds)[0]; // primary org
}

// 1. Summary Overview
router.get('/summary', async (req, res) => {
    try {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        const orgId = await getOrgFilter(req);
        const filters = {
            ...getDateFilters(req.query.days),
            ...(orgId ? { organizationId: orgId } : {})
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
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        const orgId = await getOrgFilter(req);
        const filters = {
            ...getDateFilters(req.query.days),
            ...(orgId ? { organizationId: orgId } : {})
        };
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
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        const orgId = await getOrgFilter(req);
        const filters = {
            ...getDateFilters(req.query.days),
            ...(orgId ? { organizationId: orgId } : {})
        };
        const usersUsage = await usageStore.getUsageByUser(filters);

        // Try to enrich with display names from userStore
        try {
            const userStore = require('../stores/userStore');
            const allUsers = await userStore.getAllUsers();
            const userMap = new Map();
            for (const u of allUsers) {
                userMap.set(u.id, u.display_name || u.username || u.id);
            }
            const enriched = (usersUsage || []).map(u => ({
                ...u,
                display_name: userMap.get(u.user_id) || u.user_id || 'Unknown'
            }));
            return res.json(enriched);
        } catch (e) {
            // Fallback: return without display names
            const enriched = (usersUsage || []).map(u => ({
                ...u,
                display_name: u.user_id || 'Unknown'
            }));
            return res.json(enriched);
        }
    } catch (err) {
        console.error('[Usage API] /users error:', err.message);
        res.status(500).json({ error: 'Failed to fetch user usage' });
    }
});

// 4. Usage by App Area (Source)
router.get('/sources', async (req, res) => {
    try {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        const orgId = await getOrgFilter(req);
        const filters = {
            ...getDateFilters(req.query.days),
            ...(orgId ? { organizationId: orgId } : {})
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
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
        const orgId = await getOrgFilter(req);
        const filters = {
            ...getDateFilters(req.query.days),
            ...(orgId ? { organizationId: orgId } : {})
        };
        const agents = await usageStore.getUsageByAgent(filters);
        res.json(agents || []);
    } catch (err) {
        console.error('[Usage API] /agents error:', err.message);
        res.status(500).json({ error: 'Failed to fetch agent usage' });
    }
});

module.exports = router;
