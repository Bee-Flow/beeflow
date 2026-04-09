/**
 * Azure Service Usage Store — tracks API calls to Azure services
 *
 * Logs usage for:
 *   • doc_intelligence  — Azure Document Intelligence (page-based)
 *   • content_safety    — Azure AI Content Safety (char-based)
 *   • pii_detection     — Azure PII Detection / Language API (char-based)
 *   • embedding         — Azure OpenAI Embeddings (token-based)
 *
 * PostgreSQL-backed. Supports the same filter patterns as usageStore.js.
 */

const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS azure_service_usage_log (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            service_type TEXT NOT NULL,
            user_id TEXT,
            organization_id TEXT,
            source TEXT DEFAULT 'unknown',
            input_chars INTEGER DEFAULT 0,
            pages INTEGER DEFAULT 0,
            tokens INTEGER DEFAULT 0,
            estimated_cost REAL DEFAULT 0,
            metadata JSONB
        )
    `);
    // Safe migration for existing tables
    try { await exec(`ALTER TABLE azure_service_usage_log ADD COLUMN IF NOT EXISTS tokens INTEGER DEFAULT 0`); } catch (_) {}
    await exec(`CREATE INDEX IF NOT EXISTS idx_azsvc_timestamp ON azure_service_usage_log(timestamp DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_azsvc_service ON azure_service_usage_log(service_type)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_azsvc_org ON azure_service_usage_log(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_azsvc_org_ts ON azure_service_usage_log(organization_id, timestamp DESC)`);
    initialized = true;
}

initDB().catch(err => console.error('[AzureServiceUsageStore] Init error:', err.message));
console.log('[AzureServiceUsageStore] Initialized (PostgreSQL)');

// ══════════════════════════════════════════════════════════════════════
// Logging
// ══════════════════════════════════════════════════════════════════════

/**
 * Log an Azure service usage event.
 * @param {object} entry
 * @param {string} entry.service_type — 'doc_intelligence' | 'content_safety' | 'pii_detection' | 'embedding'
 * @param {string} [entry.user_id]
 * @param {string} [entry.organization_id]
 * @param {string} [entry.source]           — 'kb_upload' | 'direct_chat' | 'agent_chat' | 'notebook'
 * @param {number} [entry.input_chars]      — characters processed (safety/PII)
 * @param {number} [entry.pages]            — pages processed (doc intelligence)
 * @param {number} [entry.tokens]           — tokens consumed (embeddings)
 * @param {number} [entry.estimated_cost]   — pre-calculated cost in USD
 * @param {object} [entry.metadata]         — additional info (filename, mime_type, etc.)
 */
async function logAzureServiceUsage(entry) {
    await initDB();
    try {
        await run(`
            INSERT INTO azure_service_usage_log
                (timestamp, service_type, user_id, organization_id, source, input_chars, pages, tokens, estimated_cost, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
            entry.timestamp || new Date().toISOString(),
            entry.service_type,
            entry.user_id || null,
            entry.organization_id || null,
            entry.source || 'unknown',
            entry.input_chars || 0,
            entry.pages || 0,
            entry.tokens || 0,
            entry.estimated_cost || 0,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
        ]);
    } catch (e) {
        console.error('[AzureServiceUsageStore] Failed to log usage:', e.message);
    }
}

// ══════════════════════════════════════════════════════════════════════
// Query helpers (same pattern as usageStore.js)
// ══════════════════════════════════════════════════════════════════════

function buildFilters(filters, startIdx = 1) {
    const conditions = [];
    const params = [];
    let idx = startIdx;
    if (filters?.startDate) { conditions.push(`timestamp >= $${idx++}`); params.push(filters.startDate); }
    if (filters?.endDate) { conditions.push(`timestamp <= $${idx++}`); params.push(filters.endDate); }
    if (filters?.organizationId) { conditions.push(`organization_id = $${idx++}`); params.push(filters.organizationId); }
    if (filters?.userId) { conditions.push(`user_id = $${idx++}`); params.push(filters.userId); }
    if (filters?.source) { conditions.push(`source = $${idx++}`); params.push(filters.source); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

/**
 * Get aggregate summary of Azure service usage.
 * Returns total calls, total cost, and per-service breakdown.
 */
async function getAzureServiceSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getOne(`
        SELECT
            COUNT(*) as total_calls,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            COALESCE(SUM(pages), 0) as total_pages,
            COALESCE(SUM(input_chars), 0) as total_chars,
            COALESCE(SUM(tokens), 0) as total_tokens,
            COUNT(DISTINCT service_type) as unique_services,
            COUNT(DISTINCT user_id) as unique_users
        FROM azure_service_usage_log ${where}
    `, params);
}

/**
 * Get usage breakdown by service type.
 */
async function getAzureServiceByType(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            service_type,
            COUNT(*) as calls,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            COALESCE(SUM(pages), 0) as total_pages,
            COALESCE(SUM(input_chars), 0) as total_chars,
            COALESCE(SUM(tokens), 0) as total_tokens
        FROM azure_service_usage_log ${where}
        GROUP BY service_type
        ORDER BY total_cost DESC
    `, params);
}

/**
 * Get usage breakdown by user.
 */
async function getAzureServiceByUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            user_id,
            COUNT(*) as calls,
            COALESCE(SUM(estimated_cost), 0) as total_cost,
            COALESCE(SUM(pages), 0) as total_pages,
            COALESCE(SUM(input_chars), 0) as total_chars,
            COALESCE(SUM(tokens), 0) as total_tokens
        FROM azure_service_usage_log ${where}
        GROUP BY user_id
        ORDER BY total_cost DESC
    `, params);
}

/**
 * Get daily/hourly timeline of Azure service costs.
 */
async function getAzureServiceTimeline(filters = {}, interval = 'day') {
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
            COALESCE(SUM(pages), 0) as total_pages,
            COALESCE(SUM(input_chars), 0) as total_chars,
            COALESCE(SUM(tokens), 0) as total_tokens
        FROM azure_service_usage_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

/**
 * Get recent Azure service usage events.
 */
async function getRecentAzureServiceUsage(limit = 50, filters = {}) {
    await initDB();
    const { where, params, nextIdx } = buildFilters(filters);
    return getAll(`
        SELECT * FROM azure_service_usage_log ${where}
        ORDER BY timestamp DESC
        LIMIT $${nextIdx}
    `, [...params, limit]);
}

module.exports = {
    logAzureServiceUsage,
    getAzureServiceSummary,
    getAzureServiceByType,
    getAzureServiceByUser,
    getAzureServiceTimeline,
    getRecentAzureServiceUsage,
};
