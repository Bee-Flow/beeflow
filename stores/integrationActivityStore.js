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
const { resolveServerGeo, geoFromIp } = require('../core/serverGeoResolver');
const { operatorForIp } = require('../core/ipOperators');

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
    // Probe columns — capture at socket connect time (see core/outboundProbe.js).
    // peer_ip duplicates the old server_ip when sourced from the probe, but its
    // companion peer_ip_source tells the dashboard whether to trust it.
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS peer_ip TEXT`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS peer_ip_source TEXT`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS tls_servername TEXT`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS connect_ms INTEGER`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS is_local BOOLEAN DEFAULT false`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS operator TEXT`).catch(() => {});
    // Automation/routine egress attribution — lets the run-detail UI show which
    // node sent what, and lets Compliance Hub exclude dry-run rows from "real egress".
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS automation_id TEXT`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS run_id TEXT`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS step_id TEXT`).catch(() => {});
    await exec(`ALTER TABLE integration_activity_log ADD COLUMN IF NOT EXISTS is_dry_run BOOLEAN DEFAULT false`).catch(() => {});

    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_timestamp ON integration_activity_log(timestamp DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_org ON integration_activity_log(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_org_timestamp ON integration_activity_log(organization_id, timestamp DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_user ON integration_activity_log(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_type ON integration_activity_log(integration_type)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_tool ON integration_activity_log(tool_name)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_run ON integration_activity_log(run_id)`).catch(() => {});
    await exec(`CREATE INDEX IF NOT EXISTS idx_integ_automation ON integration_activity_log(automation_id)`).catch(() => {});
    initialized = true;
}

initDB().catch(err => console.error('[IntegrationActivityStore] Init error:', err.message));
console.log('[IntegrationActivityStore] Initialized (PostgreSQL)');

// ============ Logging ============

async function logIntegrationActivity(event) {
    await initDB();
    try {
        let peerIp = null, peerIpSource = null, tlsServername = null, connectMs = null, isLocal = false;
        let countryCode = null, countryName = null, isEu = false;

        // Preferred path: probe captured the peer IP at connect time.
        const probe = event.probe;
        if (probe) {
            peerIp = probe.peer_ip || null;
            peerIpSource = probe.peer_ip_source || null;
            tlsServername = probe.tls_servername || null;
            connectMs = Number.isInteger(probe.connect_ms) ? probe.connect_ms : null;
            isLocal = !!probe.is_local;
            if (peerIp) {
                const geo = await geoFromIp(peerIp).catch(() => null);
                if (geo) {
                    countryCode = geo.country_code;
                    countryName = geo.country_name;
                    isEu = geo.is_eu;
                }
            }
        }

        // Fallback: legacy post-call DNS resolution on server_endpoint. Only kicks
        // in when there's no probe (older callers, integrations not yet wired up).
        if (!peerIp && !isLocal && event.server_endpoint) {
            try {
                const geo = await resolveServerGeo(event.server_endpoint);
                if (geo) {
                    peerIp = geo.ip;
                    peerIpSource = 'dns_post_call';
                    countryCode = geo.country_code;
                    countryName = geo.country_name;
                    isEu = geo.is_eu;
                }
            } catch (_) { /* fail-open */ }
        }

        const operator = peerIp ? operatorForIp(peerIp) : null;

        await run(`
            INSERT INTO integration_activity_log
                (timestamp, organization_id, user_id, agent_id, agent_name, conversation_id,
                 tool_name, integration_type, server_endpoint, data_direction,
                 data_categories, pii_categories_detected, pii_scan_enabled,
                 data_summary, source, model,
                 server_ip, country_code, country_name, is_eu,
                 peer_ip, peer_ip_source, tls_servername, connect_ms, is_local, operator,
                 automation_id, run_id, step_id, is_dry_run)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
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
            peerIp,        // server_ip — keep filled for dashboards that still read it
            countryCode,
            countryName,
            isEu,
            peerIp,
            peerIpSource,
            tlsServername,
            connectMs,
            isLocal,
            operator,
            event.automation_id || null,
            event.run_id || null,
            event.step_id || null,
            event.is_dry_run || false,
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
    if (filters?.agentId) { conditions.push(`agent_id = $${idx++}`); params.push(filters.agentId); }
    if (filters?.piiCategory) {
        // Match the trimmed category against the comma-separated list.
        conditions.push(`pii_categories_detected ILIKE $${idx++}`);
        params.push(`%${filters.piiCategory}%`);
    }
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
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events,
            COUNT(*) FILTER (WHERE is_eu = true) as eu_count,
            COUNT(*) FILTER (WHERE is_local = true) as local_count,
            COUNT(*) FILTER (WHERE is_eu = false AND is_local = false) as non_eu_count,
            COUNT(*) FILTER (WHERE is_eu = false AND is_local = false
                                  AND pii_categories_detected IS NOT NULL
                                  AND pii_categories_detected != '') as pii_non_eu_count
        FROM integration_activity_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

/**
 * Sovereignty breakdown by one of four dimensions: user / integration / agent / pii.
 * Same row shape across all four so the frontend can render with one template.
 *
 * For pii: rows without detected PII categories don't contribute — the
 * denominator is "calls where any PII was detected", not "all calls".
 */
async function getSovereigntyByDimension(dimension, filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);

    // mode() returns the most-frequent operator per bucket — the "where most
    // of this bucket's data actually went" headline. pii_non_eu_count powers
    // the PII-weighted sovereignty score: each call leaking PII to a non-EU
    // server is the worst case and should cost double.
    const sharedSelect = `
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE is_eu = true)  as eu_count,
        COUNT(*) FILTER (WHERE is_local = true) as local_count,
        COUNT(*) FILTER (WHERE is_eu = false AND is_local = false) as non_eu_count,
        COUNT(*) FILTER (WHERE is_eu = false AND is_local = false
                              AND pii_categories_detected IS NOT NULL
                              AND pii_categories_detected != '') as pii_non_eu_count,
        MAX(timestamp) as last_seen,
        mode() WITHIN GROUP (ORDER BY operator) as top_operator
    `;

    if (dimension === 'user') {
        return getAll(`
            SELECT user_id as key, user_id as label, ${sharedSelect}
            FROM integration_activity_log ${where}
            ${where ? 'AND' : 'WHERE'} user_id IS NOT NULL
            GROUP BY user_id
            ORDER BY total DESC
        `, params);
    }
    if (dimension === 'agent') {
        return getAll(`
            SELECT
                COALESCE(agent_id, 'direct-chat') as key,
                COALESCE(NULLIF(agent_name, ''), agent_id, 'Direct Chat') as label,
                ${sharedSelect}
            FROM integration_activity_log ${where}
            GROUP BY key, label
            ORDER BY total DESC
        `, params);
    }
    if (dimension === 'integration') {
        return getAll(`
            SELECT integration_type as key, integration_type as label, ${sharedSelect}
            FROM integration_activity_log ${where}
            ${where ? 'AND' : 'WHERE'} integration_type IS NOT NULL
            GROUP BY integration_type
            ORDER BY total DESC
        `, params);
    }
    if (dimension === 'pii') {
        // Unnest the comma-separated PII category list; only rows with at
        // least one detected category contribute.
        return getAll(`
            SELECT
                trim(cat) as key,
                trim(cat) as label,
                ${sharedSelect}
            FROM integration_activity_log,
                 unnest(string_to_array(pii_categories_detected, ',')) AS cat
            ${where ? where + ' AND' : 'WHERE'} pii_categories_detected IS NOT NULL
                AND pii_categories_detected != ''
                AND trim(cat) != ''
            GROUP BY trim(cat)
            ORDER BY total DESC
        `, params);
    }
    throw new Error(`Unknown sovereignty dimension: ${dimension}`);
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
    // Group by the probe-captured tls_servername when available — that is
    // provably where the call went. Fall back to server_endpoint only when
    // there's no probe data (legacy rows / SDK gaps). This stops the
    // dashboard from claiming the call went to a stale hardcoded fallback
    // hostname (e.g. 'youtrack.cloud' for a self-hosted YouTrack).
    return getAll(`
        SELECT
            COALESCE(NULLIF(tls_servername, ''), server_endpoint) AS server_endpoint,
            COUNT(*) as total,
            COUNT(DISTINCT integration_type) as integration_count,
            array_agg(DISTINCT integration_type) as integrations,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received,
            MAX(timestamp) as last_contact,
            array_agg(DISTINCT COALESCE(peer_ip, server_ip)) FILTER (WHERE COALESCE(peer_ip, server_ip) IS NOT NULL) as server_ips,
            array_agg(DISTINCT country_code) FILTER (WHERE country_code IS NOT NULL) as country_codes,
            array_agg(DISTINCT country_name) FILTER (WHERE country_name IS NOT NULL) as country_names,
            bool_or(is_eu) as is_eu
        FROM integration_activity_log ${where}
            ${where ? 'AND' : 'WHERE'} COALESCE(NULLIF(tls_servername, ''), server_endpoint) IS NOT NULL
        GROUP BY COALESCE(NULLIF(tls_servername, ''), server_endpoint)
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

/**
 * Per-call data egress log — the authoritative "where did the data go" view.
 * Each row is one tool call. peer_ip is the actual destination (socket peer when
 * available, DNS-pre-call otherwise). peer_ip_source tells the caller how to
 * present it.
 */
async function getEgressLog(filters = {}, limit = 200) {
    await initDB();
    const conditions = [];
    const params = [];
    let idx = 1;
    if (filters.organizationId) { conditions.push(`organization_id = $${idx++}`); params.push(filters.organizationId); }
    if (filters.startDate) { conditions.push(`timestamp >= $${idx++}`); params.push(filters.startDate); }
    if (filters.endDate) { conditions.push(`timestamp <= $${idx++}`); params.push(filters.endDate); }
    if (filters.integrationType) { conditions.push(`integration_type = $${idx++}`); params.push(filters.integrationType); }
    if (filters.userId) { conditions.push(`user_id = $${idx++}`); params.push(filters.userId); }
    if (filters.agentId) { conditions.push(`agent_id = $${idx++}`); params.push(filters.agentId); }
    if (filters.piiCategory) {
        conditions.push(`pii_categories_detected ILIKE $${idx++}`);
        params.push(`%${filters.piiCategory}%`);
    }
    if (filters.euOnly === true) conditions.push(`is_eu = true`);
    if (filters.euOnly === false) conditions.push(`is_eu = false AND is_local = false`);
    if (filters.localOnly) conditions.push(`is_local = true`);
    if (!filters.startDate && !filters.endDate) {
        conditions.push(`timestamp >= NOW() - INTERVAL '90 days'`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    return getAll(`
        SELECT
            id, timestamp, organization_id, user_id, agent_id, agent_name,
            tool_name, integration_type, server_endpoint, data_direction,
            COALESCE(peer_ip, server_ip) AS peer_ip,
            COALESCE(peer_ip_source, CASE WHEN server_ip IS NOT NULL THEN 'dns_post_call' ELSE NULL END) AS peer_ip_source,
            tls_servername, connect_ms, is_local, operator,
            country_code, country_name, is_eu,
            pii_categories_detected
        FROM integration_activity_log
        ${where}
        ORDER BY timestamp DESC
        LIMIT $${idx}
    `, [...params, limit]);
}

/**
 * Per-run egress — every external call an automation run made, with destination,
 * geo/EU flag and detected PII categories, for the automation run-detail UI.
 * Ordered by step so it lines up with the run timeline.
 */
async function getEgressLogForRun(runId) {
    if (!runId) return [];
    await initDB();
    return getAll(`
        SELECT
            id, timestamp, step_id, tool_name, integration_type, server_endpoint, data_direction,
            data_categories, pii_categories_detected, is_dry_run,
            COALESCE(peer_ip, server_ip) AS peer_ip,
            country_code, country_name, is_eu, is_local, operator
        FROM integration_activity_log
        WHERE run_id = $1
        ORDER BY timestamp ASC
    `, [runId]);
}

/**
 * Operator-level summary — group by operator name (Google / Microsoft / Cloudflare / …)
 * with a count, distinct-IP count, and last-seen timestamp.
 */
async function getOperatorSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            COALESCE(operator, 'Unknown') AS operator,
            COUNT(*) AS total,
            COUNT(DISTINCT COALESCE(peer_ip, server_ip)) AS unique_ips,
            COUNT(DISTINCT integration_type) AS unique_integrations,
            bool_or(is_eu) AS any_eu,
            MAX(timestamp) AS last_seen
        FROM integration_activity_log
        ${where}
        ${where ? 'AND' : 'WHERE'} is_local = false
        GROUP BY operator
        ORDER BY total DESC
    `, params);
}

module.exports = {
    logIntegrationActivity,
    getEgressLogForRun,
    getIntegrationSummary,
    getIntegrationTimeline,
    getIntegrationByType,
    getIntegrationByTool,
    getIntegrationByUser,
    getIntegrationPiiSummary,
    getIntegrationServers,
    getRecentIntegrationActivity,
    getEgressLog,
    getOperatorSummary,
    getSovereigntyByDimension,
};
