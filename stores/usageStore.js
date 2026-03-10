/**
 * Usage Store - Tracks AI API usage (tokens, models, agents, tools)
 * PostgreSQL-backed logging for monitoring dashboard.
 */

const { run, getOne, getAll, exec } = require('../db');
const { computeCost } = require('../core/modelCosts');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS ai_usage_log (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            user_id TEXT,
            agent_id TEXT,
            agent_name TEXT,
            agent_type TEXT DEFAULT 'chat',
            model TEXT,
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0,
            tool_name TEXT,
            source TEXT DEFAULT 'unknown',
            duration_ms INTEGER DEFAULT 0,
            organization_id TEXT,
            estimated_cost REAL DEFAULT 0,
            conversation_id TEXT
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON ai_usage_log(timestamp)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_model ON ai_usage_log(model)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_agent ON ai_usage_log(agent_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_user ON ai_usage_log(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_org ON ai_usage_log(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_usage_conversation ON ai_usage_log(conversation_id)`);
    initialized = true;
}

initDB().catch(err => console.error('[UsageStore] Init error:', err.message));
console.log('[UsageStore] Initialized (PostgreSQL)');

// ============ Logging ============

async function logUsage(entry) {
    await initDB();
    try {
        const now = new Date().toISOString();
        const promptTokens = entry.prompt_tokens || 0;
        const completionTokens = entry.completion_tokens || 0;
        const model = entry.model || 'unknown';
        const cost = computeCost(model, promptTokens, completionTokens);
        await run(`
            INSERT INTO ai_usage_log (timestamp, user_id, agent_id, agent_name, agent_type, model, prompt_tokens, completion_tokens, total_tokens, tool_name, source, duration_ms, organization_id, estimated_cost, conversation_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        `, [
            entry.timestamp || now,
            entry.user_id || null,
            entry.agent_id || null,
            entry.agent_name || null,
            entry.agent_type || 'chat',
            model,
            promptTokens,
            completionTokens,
            entry.total_tokens || (promptTokens + completionTokens),
            entry.tool_name || null,
            entry.source || 'unknown',
            entry.duration_ms || 0,
            entry.organization_id || null,
            cost,
            entry.conversation_id || null
        ]);
    } catch (e) {
        console.error('[UsageStore] Failed to log usage:', e.message);
    }
}

// ============ Queries ============

function buildFilters(filters, startIdx = 1) {
    const conditions = [];
    const params = [];
    let idx = startIdx;
    if (filters?.startDate) {
        conditions.push(`timestamp >= $${idx++}`);
        params.push(filters.startDate);
    }
    if (filters?.endDate) {
        conditions.push(`timestamp <= $${idx++}`);
        params.push(filters.endDate);
    }
    if (filters?.organizationId) {
        conditions.push(`organization_id = $${idx++}`);
        params.push(filters.organizationId);
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

async function getUsageSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getOne(`
        SELECT
            COUNT(*) as total_calls,
            COALESCE(SUM(prompt_tokens), 0) as total_prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as total_completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COUNT(DISTINCT model) as unique_models,
            COUNT(DISTINCT agent_id) as unique_agents,
            COALESCE(SUM(estimated_cost), 0) as total_estimated_cost
        FROM ai_usage_log ${where}
    `, params);
}

async function getUsageByModel(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            model,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY model
        ORDER BY total_tokens DESC
    `, params);
}

async function getUsageByAgent(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            agent_id, agent_name, agent_type,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY agent_id, agent_name, agent_type
        ORDER BY total_tokens DESC
    `, params);
}

async function getUsageTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

async function getToolUsage(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    const toolWhere = where
        ? where + ' AND tool_name IS NOT NULL'
        : 'WHERE tool_name IS NOT NULL';
    return getAll(`
        SELECT
            tool_name,
            COUNT(*) as calls,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms
        FROM ai_usage_log ${toolWhere}
        GROUP BY tool_name
        ORDER BY calls DESC
    `, params);
}

async function getRecentCalls(limit = 50, filters = {}) {
    await initDB();
    const conditions = [];
    const params = [];
    let idx = 1;

    if (filters?.organizationId) {
        conditions.push(`organization_id = $${idx++}`);
        params.push(filters.organizationId);
    }
    if (filters?.source) {
        conditions.push(`source = $${idx++}`);
        params.push(filters.source);
    }
    if (filters?.model) {
        conditions.push(`model = $${idx++}`);
        params.push(filters.model);
    }
    if (filters?.search) {
        const term = `%${filters.search}%`;
        conditions.push(`(agent_name ILIKE $${idx} OR user_id ILIKE $${idx + 1} OR model ILIKE $${idx + 2})`);
        params.push(term, term, term);
        idx += 3;
    }
    if (filters?.startDate) {
        conditions.push(`timestamp >= $${idx++}`);
        params.push(filters.startDate);
    }
    if (filters?.endDate) {
        conditions.push(`timestamp <= $${idx++}`);
        params.push(filters.endDate);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return getAll(`
        SELECT * FROM ai_usage_log
        ${where}
        ORDER BY id DESC
        LIMIT $${idx}
    `, [...params, limit]);
}

async function getCostTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as calls,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens
        FROM ai_usage_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

async function getUsageSources() {
    await initDB();
    const rows = await getAll(`
        SELECT DISTINCT source FROM ai_usage_log
        WHERE source IS NOT NULL
        ORDER BY source ASC
    `);
    return rows.map(r => r.source);
}

async function getUsageModels() {
    await initDB();
    const rows = await getAll(`
        SELECT DISTINCT model FROM ai_usage_log
        WHERE model IS NOT NULL
        ORDER BY model ASC
    `);
    return rows.map(r => r.model);
}

async function getUsageBySource(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT source, COUNT(*) as calls,
            COALESCE(SUM(total_tokens), 0) as total_tokens
        FROM ai_usage_log ${where}
        GROUP BY source
        ORDER BY total_tokens DESC
    `, params);
}

async function getUsageByUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT user_id, COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY user_id
        ORDER BY total_tokens DESC
    `, params);
}

async function getUsageByConversation(filters = {}) {
    await initDB();
    const { where, params, nextIdx } = buildFilters(filters);
    const extraWhere = where ? where + ' AND conversation_id IS NOT NULL' : 'WHERE conversation_id IS NOT NULL';
    return getAll(`
        SELECT conversation_id, agent_name, agent_id,
            COUNT(*) as calls,
            COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) as completion_tokens,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            MIN(timestamp) as first_call,
            MAX(timestamp) as last_call,
            STRING_AGG(DISTINCT model, ', ') as models_used,
            STRING_AGG(DISTINCT source, ', ') as sources_used
        FROM ai_usage_log ${extraWhere}
        GROUP BY conversation_id, agent_name, agent_id
        ORDER BY last_call DESC
        LIMIT 200
    `, params);
}

async function getUsageByAgentType(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT COALESCE(agent_type, 'chat') as agent_type,
            COUNT(*) as calls,
            COALESCE(SUM(total_tokens), 0) as total_tokens,
            COALESCE(SUM(estimated_cost), 0) as estimated_cost
        FROM ai_usage_log ${where}
        GROUP BY agent_type
    `, params);
}

module.exports = {
    logUsage,
    getUsageSummary,
    getUsageByModel,
    getUsageByAgent,
    getUsageTimeline,
    getToolUsage,
    getRecentCalls,
    getUsageBySource,
    getUsageByUser,
    getCostTimeline,
    getUsageSources,
    getUsageModels,
    getUsageByConversation,
    getUsageByAgentType,
};
