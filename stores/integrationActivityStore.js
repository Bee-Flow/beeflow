/**
 * Integration Activity Store — Tracks tool/integration usage for data sovereignty monitoring.
 * PostgreSQL-backed logging for the Usage & Monitoring dashboard.
 *
 * Logs which integrations are used, what server endpoints they connect to,
 * what data direction (sent/received), and what PII categories were detected.
 *
 * Geo-location is resolved at LOG TIME (fire-and-forget) and stored directly
 * in the DB — the dashboard reads pre-resolved data with zero extra lookups.
 */

const { run, getOne, getAll, exec } = require('../db');
const { resolveServerGeo } = require('../core/serverGeoResolver');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS integration_activity_log (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            organization_id TEXT,
            user_id TEXT,
            agent_id TEXT,
            agent_name TEXT,
            conversation_id TEXT,
            tool_name TEXT NOT NULL,
            integration_type TEXT,
            server_endpoint TEXT,
            data_direction TEXT DEFAULT 'sent',
            data_categories TEXT,
            pii_categories_detected TEXT,
            pii_scan_enabled BOOLEAN DEFAULT false,
            data_summary TEXT,
            source TEXT DEFAULT 'unknown',
            model TEXT,
            server_ip TEXT,
            country_code TEXT,
            country_name TEXT,
            is_eu BOOLEAN DEFAULT false
        )
    `);
    // Add geo columns if they don't exist (migration for existing tables)
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS server_ip TEXT`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS country_code TEXT`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS country_name TEXT`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS is_eu BOOLEAN DEFAULT false`).catch(() => {});

    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_timestamp ON integration_activity_log(timestamp DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_org ON integration_activity_log(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_org_timestamp ON integration_activity_log(organization_id, timestamp DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_user ON integration_activity_log(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_type ON integration_activity_log(integration_type)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_tool ON integration_activity_log(tool_name)`);
    initialized = true;
}

initDB().catch(err => console.error('[IntegrationActivityStore] Init error:', err.message));
console.log('[IntegrationActivityStore] Initialized (PostgreSQL)');

// ============ Logging ============

async function logIntegrationActivity(event) {
    await initDB();
    try {
        // Resolve geo at log time (non-blocking — runs in background)
        let serverIp = null, countryCode = null, countryName = null, isEu = false;
        if (event.server_endpoint) {
            try {
                const geo = await resolveServerGeo(event.server_endpoint);
                if (geo) {
                    serverIp = geo.ip;
                    countryCode = geo.country_code;
                    countryName = geo.country_name;
                    isEu = geo.is_eu;
                }
            } catch (geoErr) {
                // Geo resolution failed — log without geo data (fail-open)
            }
        }

        await run(`
            INSERT INTO integration_activity_log
                (timestamp, organization_id, user_id, agent_id, agent_name, conversation_id,
                 tool_name, integration_type, server_endpoint, data_direction,
                 data_categories, pii_categories_detected, pii_scan_enabled,
                 data_summary, source, model,
                 server_ip, country_code, country_name, is_eu)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        `, [
            event.timestamp || new Date().toISOString(),
            event.organization_id || null,
            event.user_id || null,
            event.agent_id || null,
            event.agent_name || null,
            event.conversation_id || null,
            event.tool_name || 'unknown',
            event.integration_type || null,
            event.server_endpoint || null,
            event.data_direction || 'sent',
            event.data_categories || null,
            event.pii_categories_detected || null,
            event.pii_scan_enabled || false,
            event.data_summary || null,
            event.source || 'unknown',
            event.model || null,
            serverIp,
            countryCode,
            countryName,
            isEu,
        ]);
    } catch (e) {
        console.error('[IntegrationActivityStore] Failed to log:', e.message);
    }
}

// ============ Query Helpers ============

function buildFilters(filters, startIdx = 1) {
    const conditions = [];
    const params = [];
    let idx = startIdx;
    if (filters?.startDate) { conditions.push(`timestamp >= $${idx++}`); params.push(filters.startDate); }
    if (filters?.endDate) { conditions.push(`timestamp <= $${idx++}`); params.push(filters.endDate); }
    if (filters?.organizationId) { conditions.push(`organization_id = $${idx++}`); params.push(filters.organizationId); }
    if (filters?.userId) { conditions.push(`user_id = $${idx++}`); params.push(filters.userId); }
    if (filters?.integrationType) { conditions.push(`integration_type = $${idx++}`); params.push(filters.integrationType); }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

// ============ Queries ============

async function getIntegrationSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getOne(`
        SELECT
            COUNT(*) as total_calls,
            COUNT(DISTINCT integration_type) as unique_integrations,
            COUNT(DISTINCT server_endpoint) as unique_servers,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent_count,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received_count,
            COUNT(*) FILTER (WHERE data_direction = 'both') as both_count,
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events,
            COUNT(DISTINCT user_id) as unique_users
        FROM integration_activity_log ${where}
    `, params);
}

async function getIntegrationTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received,
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events
        FROM integration_activity_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

async function getIntegrationByType(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            integration_type,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received,
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events,
            MAX(timestamp) as last_used
        FROM integration_activity_log ${where}
        GROUP BY integration_type
        ORDER BY total DESC
    `, params);
}

async function getIntegrationByTool(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            tool_name,
            integration_type,
            server_endpoint,
            data_direction,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events,
            MAX(timestamp) as last_used
        FROM integration_activity_log ${where}
        GROUP BY tool_name, integration_type, server_endpoint, data_direction
        ORDER BY total DESC
    `, params);
}

async function getIntegrationByUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            user_id,
            COUNT(*) as total,
            COUNT(DISTINCT integration_type) as integrations_used,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received,
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events,
            MAX(timestamp) as last_activity
        FROM integration_activity_log ${where}
        GROUP BY user_id
        ORDER BY total DESC
    `, params);
}

async function getIntegrationPiiSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    const baseWhere = where ? `${where} AND` : 'WHERE';
    return getAll(`
        SELECT
            unnest(string_to_array(pii_categories_detected, ', ')) as pii_category,
            COUNT(*) as count,
            integration_type
        FROM integration_activity_log ${baseWhere}
            pii_categories_detected IS NOT NULL
            AND pii_categories_detected != ''
        GROUP BY pii_category, integration_type
        ORDER BY count DESC
    `, params);
}

async function getIntegrationServers(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            server_endpoint,
            COUNT(*) as total,
            COUNT(DISTINCT integration_type) as integration_count,
            array_agg(DISTINCT integration_type) as integrations,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received,
            MAX(timestamp) as last_contact,
            -- Geo data (from the most recent record for this endpoint)
            (array_agg(server_ip ORDER BY timestamp DESC))[1] as server_ip,
            (array_agg(country_code ORDER BY timestamp DESC))[1] as country_code,
            (array_agg(country_name ORDER BY timestamp DESC))[1] as country_name,
            bool_or(is_eu) as is_eu
        FROM integration_activity_log ${where}
            ${where ? 'AND' : 'WHERE'} server_endpoint IS NOT NULL
        GROUP BY server_endpoint
        ORDER BY total DESC
    `, params);
}

async function getRecentIntegrationActivity(limit = 50, filters = {}) {
    await initDB();
    const conditions = [];
    const params = [];
    let idx = 1;
    if (filters?.organizationId) { conditions.push(`organization_id = $${idx++}`); params.push(filters.organizationId); }
    if (filters?.startDate) { conditions.push(`timestamp >= $${idx++}`); params.push(filters.startDate); }
    if (filters?.endDate) { conditions.push(`timestamp <= $${idx++}`); params.push(filters.endDate); }
    if (filters?.integrationType) { conditions.push(`integration_type = $${idx++}`); params.push(filters.integrationType); }
    if (!filters?.startDate && !filters?.endDate) {
        conditions.push(`timestamp >= NOW() - INTERVAL '90 days'`);
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return getAll(`
        SELECT * FROM integration_activity_log
        ${where}
        ORDER BY timestamp DESC
        LIMIT $${idx}
    `, [...params, limit]);
}

module.exports = {
    logIntegrationActivity,
    getIntegrationSummary,
    getIntegrationTimeline,
    getIntegrationByType,
    getIntegrationByTool,
    getIntegrationByUser,
    getIntegrationPiiSummary,
    getIntegrationServers,
    getRecentIntegrationActivity,
};
