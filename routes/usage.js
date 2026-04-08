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

// 2. Timeline (supports ?interval=hour|day from frontend)
router.get('/timeline', async (req, res) => {
    try {
        const interval = req.query.interval === 'hour' ? 'hour' : 'day';
        const timeline = await usageStore.getUsageTimeline(req.usageFilters, interval);
        res.json(timeline || []);
    } catch (err) {
        console.error('[Usage API] /timeline error:', err.message);
        res.status(500).json({ error: 'Failed to fetch timeline data' });
    }
});

// 3. Cost Timeline
router.get('/cost-timeline', async (req, res) => {
    try {
        const interval = req.query.interval === 'hour' ? 'hour' : 'day';
        const data = await usageStore.getCostTimeline(req.usageFilters, interval);
        res.json(data || []);
    } catch (err) {
        console.error('[Usage API] /cost-timeline error:', err.message);
        res.status(500).json({ error: 'Failed to fetch cost timeline data' });
    }
});

// 4. Usage by User
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
// Alias: frontend calls /by-user
router.get('/by-user', async (req, res) => {
    try {
        const usersUsage = await usageStore.getUsageByUser(req.usageFilters);
        const userMap = await getUserMap();
        const enriched = (usersUsage || []).map(u => ({
            ...u,
            display_name: userMap.get(u.user_id) || u.user_id || 'Unknown'
        }));
        res.json(enriched);
    } catch (err) {
        console.error('[Usage API] /by-user error:', err.message);
        res.status(500).json({ error: 'Failed to fetch user usage' });
    }
});

// 5. Usage by App Area (Source)
router.get('/sources', async (req, res) => {
    try {
        const sources = await usageStore.getUsageBySource(req.usageFilters);
        res.json(sources || []);
    } catch (err) {
        console.error('[Usage API] /sources error:', err.message);
        res.status(500).json({ error: 'Failed to fetch source usage' });
    }
});

// 6. Usage by Agent
router.get('/agents', async (req, res) => {
    try {
        const agents = await usageStore.getUsageByAgent(req.usageFilters);
        res.json(enrichWithCostSplit(agents));
    } catch (err) {
        console.error('[Usage API] /agents error:', err.message);
        res.status(500).json({ error: 'Failed to fetch agent usage' });
    }
});
// Alias: frontend calls /by-agent
router.get('/by-agent', async (req, res) => {
    try {
        const agents = await usageStore.getUsageByAgent(req.usageFilters);
        res.json(enrichWithCostSplit(agents));
    } catch (err) {
        console.error('[Usage API] /by-agent error:', err.message);
        res.status(500).json({ error: 'Failed to fetch agent usage' });
    }
});

// 7. Usage by Model (with input/output cost)
router.get('/models', async (req, res) => {
    try {
        const models = await usageStore.getUsageByModel(req.usageFilters);
        res.json(enrichWithCostSplit(models));
    } catch (err) {
        console.error('[Usage API] /models error:', err.message);
        res.status(500).json({ error: 'Failed to fetch model usage' });
    }
});
// Alias: frontend calls /by-model
router.get('/by-model', async (req, res) => {
    try {
        const models = await usageStore.getUsageByModel(req.usageFilters);
        res.json(enrichWithCostSplit(models));
    } catch (err) {
        console.error('[Usage API] /by-model error:', err.message);
        res.status(500).json({ error: 'Failed to fetch model usage' });
    }
});

// 8. Usage by Conversation
router.get('/by-conversation', async (req, res) => {
    try {
        const data = await usageStore.getUsageByConversation(req.usageFilters);
        res.json(data || []);
    } catch (err) {
        console.error('[Usage API] /by-conversation error:', err.message);
        res.status(500).json({ error: 'Failed to fetch conversation usage' });
    }
});

// 9. Tool usage
router.get('/tools', async (req, res) => {
    try {
        const tools = await usageStore.getToolUsage(req.usageFilters);
        res.json(tools || []);
    } catch (err) {
        console.error('[Usage API] /tools error:', err.message);
        res.status(500).json({ error: 'Failed to fetch tool usage' });
    }
});

// 10. Recent calls
router.get('/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 100;
        const data = await usageStore.getRecentCalls(limit, req.usageFilters);
        res.json(data || []);
    } catch (err) {
        console.error('[Usage API] /recent error:', err.message);
        res.status(500).json({ error: 'Failed to fetch recent calls' });
    }
});

// 11. Filter options: distinct sources
router.get('/filters/sources', async (req, res) => {
    try {
        const sources = await usageStore.getUsageSources();
        res.json(sources || []);
    } catch (err) {
        console.error('[Usage API] /filters/sources error:', err.message);
        res.status(500).json({ error: 'Failed to fetch source filters' });
    }
});

// 12. Filter options: distinct models
router.get('/filters/models', async (req, res) => {
    try {
        const models = await usageStore.getUsageModels();
        res.json(models || []);
    } catch (err) {
        console.error('[Usage API] /filters/models error:', err.message);
        res.status(500).json({ error: 'Failed to fetch model filters' });
    }
});

// 13. Organizations usage summary
router.get('/organizations', async (req, res) => {
    try {
        // Return empty array — org-level breakdown is only for multi-tenant setups
        res.json([]);
    } catch (err) {
        console.error('[Usage API] /organizations error:', err.message);
        res.status(500).json({ error: 'Failed to fetch organizations' });
    }
});

// 14. Model × Agent breakdown (with input/output cost)
router.get('/models-by-agent', async (req, res) => {
    try {
        const data = await usageStore.getUsageByModelAndAgent(req.usageFilters);
        res.json(enrichWithCostSplit(data));
    } catch (err) {
        console.error('[Usage API] /models-by-agent error:', err.message);
        res.status(500).json({ error: 'Failed to fetch model-agent data' });
    }
});

// 15. Model × User breakdown (with input/output cost + display names)
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

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL / SAFETY MONITORING ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════
const guardrailEventStore = require('../stores/guardrailEventStore');

// 16. Guardrail Summary
router.get('/guardrails/summary', async (req, res) => {
    try {
        const summary = await guardrailEventStore.getGuardrailSummary(req.usageFilters);
        res.json(summary || { total_events: 0, moderation_count: 0, pii_count: 0, regex_count: 0, input_count: 0, output_count: 0, unique_users: 0 });
    } catch (err) {
        console.error('[Usage API] /guardrails/summary error:', err.message);
        res.status(500).json({ error: 'Failed to fetch guardrail summary' });
    }
});

// 17. Guardrail Timeline
router.get('/guardrails/timeline', async (req, res) => {
    try {
        const interval = req.query.interval === 'hour' ? 'hour' : 'day';
        const timeline = await guardrailEventStore.getGuardrailTimeline(req.usageFilters, interval);
        res.json(timeline || []);
    } catch (err) {
        console.error('[Usage API] /guardrails/timeline error:', err.message);
        res.status(500).json({ error: 'Failed to fetch guardrail timeline' });
    }
});

// 18. Guardrail Events by User
router.get('/guardrails/by-user', async (req, res) => {
    try {
        const data = await guardrailEventStore.getGuardrailByUser(req.usageFilters);
        const userMap = await getUserMap();
        const enriched = (data || []).map(row => ({
            ...row,
            display_name: userMap.get(row.user_id) || row.user_id || 'Unknown'
        }));
        res.json(enriched);
    } catch (err) {
        console.error('[Usage API] /guardrails/by-user error:', err.message);
        res.status(500).json({ error: 'Failed to fetch guardrail user data' });
    }
});

// 19. Guardrail Events by Category
router.get('/guardrails/by-category', async (req, res) => {
    try {
        const data = await guardrailEventStore.getGuardrailByCategory(req.usageFilters);
        res.json(data || []);
    } catch (err) {
        console.error('[Usage API] /guardrails/by-category error:', err.message);
        res.status(500).json({ error: 'Failed to fetch guardrail category data' });
    }
});

// 20. Recent Guardrail Events
router.get('/guardrails/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 50;
        const data = await guardrailEventStore.getRecentGuardrailEvents(limit, req.usageFilters);
        const userMap = await getUserMap();
        const enriched = (data || []).map(row => ({
            ...row,
            display_name: userMap.get(row.user_id) || row.user_id || 'Unknown'
        }));
        res.json(enriched);
    } catch (err) {
        console.error('[Usage API] /guardrails/recent error:', err.message);
        res.status(500).json({ error: 'Failed to fetch recent guardrail events' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// INTEGRATION ACTIVITY MONITORING ENDPOINTS (Data Sovereignty)
// ════════════════════════════════════════════════════════════════════════════
const integrationActivityStore = require('../stores/integrationActivityStore');
const { batchResolveServerGeo } = require('../core/serverGeoResolver');

// 21. Integration Summary
router.get('/integrations/summary', async (req, res) => {
    try {
        const summary = await integrationActivityStore.getIntegrationSummary(req.usageFilters);
        res.json(summary || { total_calls: 0, unique_integrations: 0, unique_servers: 0, sent_count: 0, received_count: 0, pii_events: 0, unique_users: 0 });
    } catch (err) {
        console.error('[Usage API] /integrations/summary error:', err.message);
        res.status(500).json({ error: 'Failed to fetch integration summary' });
    }
});

// 22. Integration Timeline
router.get('/integrations/timeline', async (req, res) => {
    try {
        const interval = req.query.interval === 'hour' ? 'hour' : 'day';
        const timeline = await integrationActivityStore.getIntegrationTimeline(req.usageFilters, interval);
        res.json(timeline || []);
    } catch (err) {
        console.error('[Usage API] /integrations/timeline error:', err.message);
        res.status(500).json({ error: 'Failed to fetch integration timeline' });
    }
});

// 23. Integration by Type
router.get('/integrations/by-type', async (req, res) => {
    try {
        const data = await integrationActivityStore.getIntegrationByType(req.usageFilters);
        res.json(data || []);
    } catch (err) {
        console.error('[Usage API] /integrations/by-type error:', err.message);
        res.status(500).json({ error: 'Failed to fetch integration type data' });
    }
});

// 24. Integration by Tool
router.get('/integrations/by-tool', async (req, res) => {
    try {
        const data = await integrationActivityStore.getIntegrationByTool(req.usageFilters);
        res.json(data || []);
    } catch (err) {
        console.error('[Usage API] /integrations/by-tool error:', err.message);
        res.status(500).json({ error: 'Failed to fetch integration tool data' });
    }
});

// 25. Integration PII Summary
router.get('/integrations/pii-summary', async (req, res) => {
    try {
        const data = await integrationActivityStore.getIntegrationPiiSummary(req.usageFilters);
        res.json(data || []);
    } catch (err) {
        console.error('[Usage API] /integrations/pii-summary error:', err.message);
        res.status(500).json({ error: 'Failed to fetch integration PII data' });
    }
});

// 26. Integration Servers / Endpoints
router.get('/integrations/servers', async (req, res) => {
    try {
        const data = await integrationActivityStore.getIntegrationServers(req.usageFilters);
        // Enrich with geo-location data
        try {
            const endpoints = (data || []).map(d => d.server_endpoint).filter(Boolean);
            const geoMap = await batchResolveServerGeo(endpoints);
            for (const row of (data || [])) {
                const geo = geoMap.get(row.server_endpoint);
                if (geo) {
                    row.country_code = geo.country_code;
                    row.country_name = geo.country_name;
                    row.country_flag = geo.flag;
                    row.is_eu = geo.is_eu;
                    row.server_ip = geo.ip;
                    row.server_region = geo.region;
                    row.server_city = geo.city;
                }
            }
        } catch (geoErr) {
            console.warn('[Usage API] Geo enrichment failed (non-fatal):', geoErr.message);
        }
        res.json(data || []);
    } catch (err) {
        console.error('[Usage API] /integrations/servers error:', err.message);
        res.status(500).json({ error: 'Failed to fetch server data' });
    }
});

// 27. Recent Integration Activity
router.get('/integrations/recent', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 50;
        const data = await integrationActivityStore.getRecentIntegrationActivity(limit, req.usageFilters);
        const userMap = await getUserMap();
        const enriched = (data || []).map(row => ({
            ...row,
            display_name: userMap.get(row.user_id) || row.user_id || 'Unknown'
        }));
        // Enrich with geo-location data
        try {
            const endpoints = enriched.map(d => d.server_endpoint).filter(Boolean);
            const geoMap = await batchResolveServerGeo(endpoints);
            for (const row of enriched) {
                const geo = geoMap.get(row.server_endpoint);
                if (geo) {
                    row.country_code = geo.country_code;
                    row.country_name = geo.country_name;
                    row.country_flag = geo.flag;
                    row.is_eu = geo.is_eu;
                }
            }
        } catch (geoErr) {
            console.warn('[Usage API] Geo enrichment failed (non-fatal):', geoErr.message);
        }
        res.json(enriched);
    } catch (err) {
        console.error('[Usage API] /integrations/recent error:', err.message);
        res.status(500).json({ error: 'Failed to fetch recent integration activity' });
    }
});

module.exports = router;

