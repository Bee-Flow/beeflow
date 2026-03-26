const express = require('express');
const router = express.Router();
const usageStore = require('../stores/usageStore');
const { resolveUserOrgIds } = require('../auth');
const { computeCostSplit } = require('../core/modelCosts');

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
    if (orgIds === null) return null;
    if (orgIds.size === 0) return '__none__';
    return Array.from(orgIds)[0];
}

// Build filters from request query params
function buildRequestFilters(req) {
    const filters = { ...getDateFilters(req.query.days) };
    if (req.query.user) filters.userId = req.query.user;
    if (req.query.agent) filters.agentId = req.query.agent;
    if (req.query.model) filters.model = req.query.model;
    if (req.query.source) filters.source = req.query.source;
    return filters;
}

// Middleware: attach org filter
async function attachOrgFilter(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    const orgId = await getOrgFilter(req);
    req.usageFilters = buildRequestFilters(req);
    if (orgId) req.usageFilters.organizationId = orgId;
    next();
}

router.use(attachOrgFilter);

// Helper to load user display names
async function getUserMap() {
    try {
        const userStore = require('../stores/userStore');
        const allUsers = await userStore.getAllUsers();
        const map = new Map();
        for (const u of allUsers) map.set(u.id, u.display_name || u.username || u.id);
        return map;
    } catch { return new Map(); }
}

// Helper: enrich model-level rows with input/output cost split
function enrichWithCostSplit(rows) {
    return (rows || []).map(row => {
        const { input_cost, output_cost } = computeCostSplit(row.model, row.prompt_tokens || 0, row.completion_tokens || 0);
        return { ...row, input_cost, output_cost };
    });
}

// 1. Summary Overview (enriched with input/output cost)
router.get('/summary', async (req, res) => {
    try {
        const summary = await usageStore.getUsageSummary(req.usageFilters);
        // Compute aggregated input/output costs from per-model data
        const modelData = await usageStore.getUsageByModel(req.usageFilters);
        let total_input_cost = 0, total_output_cost = 0;
        for (const m of (modelData || [])) {
            const { input_cost, output_cost } = computeCostSplit(m.model, m.prompt_tokens || 0, m.completion_tokens || 0);
            total_input_cost += input_cost;
            total_output_cost += output_cost;
        }
        res.json({
            ...(summary || { total_calls: 0, total_tokens: 0, total_estimated_cost: 0, total_prompt_tokens: 0, total_completion_tokens: 0 }),
            total_input_cost,
            total_output_cost,
        });
    } catch (err) {
        console.error('[Usage API] /summary error:', err.message);
        res.status(500).json({ error: 'Failed to fetch usage summary' });
    }
});

// 2. Timeline
router.get('/timeline', async (req, res) => {
    try {
        const interval = (parseInt(req.query.days, 10) || 30) <= 7 ? 'hour' : 'day';
        const timeline = await usageStore.getUsageTimeline(req.usageFilters, interval);
        res.json(timeline || []);
    } catch (err) {
        console.error('[Usage API] /timeline error:', err.message);
        res.status(500).json({ error: 'Failed to fetch timeline data' });
    }
});

// 3. Usage by User
router.get('/users', async (req, res) => {
    try {
        const usersUsage = await usageStore.getUsageByUser(req.usageFilters);
        const userMap = await getUserMap();
        const enriched = (usersUsage || []).map(u => ({
            ...u,
            display_name: userMap.get(u.user_id) || u.user_id || 'Unknown'
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
        const sources = await usageStore.getUsageBySource(req.usageFilters);
        res.json(sources || []);
    } catch (err) {
        console.error('[Usage API] /sources error:', err.message);
        res.status(500).json({ error: 'Failed to fetch source usage' });
    }
});

// 5. Usage by Agent
router.get('/agents', async (req, res) => {
    try {
        const agents = await usageStore.getUsageByAgent(req.usageFilters);
        res.json(enrichWithCostSplit(agents));
    } catch (err) {
        console.error('[Usage API] /agents error:', err.message);
        res.status(500).json({ error: 'Failed to fetch agent usage' });
    }
});

// 6. Usage by Model (with input/output cost)
router.get('/models', async (req, res) => {
    try {
        const models = await usageStore.getUsageByModel(req.usageFilters);
        res.json(enrichWithCostSplit(models));
    } catch (err) {
        console.error('[Usage API] /models error:', err.message);
        res.status(500).json({ error: 'Failed to fetch model usage' });
    }
});

// 7. Model × Agent breakdown (with input/output cost)
router.get('/models-by-agent', async (req, res) => {
    try {
        const data = await usageStore.getUsageByModelAndAgent(req.usageFilters);
        res.json(enrichWithCostSplit(data));
    } catch (err) {
        console.error('[Usage API] /models-by-agent error:', err.message);
        res.status(500).json({ error: 'Failed to fetch model-agent data' });
    }
});

// 8. Model × User breakdown (with input/output cost + display names)
router.get('/models-by-user', async (req, res) => {
    try {
        const data = await usageStore.getUsageByModelAndUser(req.usageFilters);
        const userMap = await getUserMap();
        const enriched = enrichWithCostSplit(data).map(row => ({
            ...row,
            display_name: userMap.get(row.user_id) || row.user_id || 'Unknown'
        }));
        res.json(enriched);
    } catch (err) {
        console.error('[Usage API] /models-by-user error:', err.message);
        res.status(500).json({ error: 'Failed to fetch model-user data' });
    }
});

module.exports = router;
