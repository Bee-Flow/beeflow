/**
 * Guardrail Event Store — Tracks AI content moderation, PII detection, and regex guardrail events.
 * PostgreSQL-backed logging for the Usage & Monitoring dashboard.
 */

const { run, getOne, getAll, exec } = require('../db');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS guardrail_events (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            organization_id TEXT,
            user_id TEXT,
            agent_id TEXT,
            agent_name TEXT,
            conversation_id TEXT,
            violation_type TEXT NOT NULL,
            violation_categories TEXT,
            direction TEXT DEFAULT 'input',
            action_taken TEXT DEFAULT 'blocked',
            source TEXT DEFAULT 'unknown',
            model TEXT
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_guardrail_timestamp ON guardrail_events(timestamp DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_guardrail_org ON guardrail_events(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_guardrail_org_timestamp ON guardrail_events(organization_id, timestamp DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_guardrail_user ON guardrail_events(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_guardrail_type ON guardrail_events(violation_type)`);
    initialized = true;
}

initDB().catch(err => console.error('[GuardrailEventStore] Init error:', err.message));
console.log('[GuardrailEventStore] Initialized (PostgreSQL)');

// ============ Logging ============

async function logGuardrailEvent(event) {
    await initDB();
    try {
        await run(`
            INSERT INTO guardrail_events (timestamp, organization_id, user_id, agent_id, agent_name, conversation_id, violation_type, violation_categories, direction, action_taken, source, model)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
            event.timestamp || new Date().toISOString(),
            event.organization_id || null,
            event.user_id || null,
            event.agent_id || null,
            event.agent_name || null,
            event.conversation_id || null,
            event.violation_type || 'unknown',
            event.violation_categories || null,
            event.direction || 'input',
            event.action_taken || 'blocked',
            event.source || 'unknown',
            event.model || null,
        ]);
        console.log(`[GuardrailEventStore] Logged ${event.violation_type} event (${event.action_taken}) for user ${event.user_id || 'unknown'}`);
    } catch (e) {
        console.error('[GuardrailEventStore] Failed to log event:', e.message);
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
    if (filters?.userId) {
        conditions.push(`user_id = $${idx++}`);
        params.push(filters.userId);
    }
    if (filters?.violationType) {
        conditions.push(`violation_type = $${idx++}`);
        params.push(filters.violationType);
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

async function getGuardrailSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getOne(`
        SELECT
            COUNT(*) as total_events,
            COUNT(*) FILTER (WHERE violation_type = 'moderation') as moderation_count,
            COUNT(*) FILTER (WHERE violation_type = 'pii') as pii_count,
            COUNT(*) FILTER (WHERE violation_type = 'regex') as regex_count,
            COUNT(*) FILTER (WHERE violation_type = 'dlp_decision') as dlp_count,
            COUNT(*) FILTER (WHERE violation_type = 'dlp_decision' AND action_taken = 'allowed') as dlp_allowed,
            COUNT(*) FILTER (WHERE violation_type = 'dlp_decision' AND action_taken = 'redacted') as dlp_redacted,
            COUNT(*) FILTER (WHERE violation_type = 'dlp_decision' AND action_taken = 'blocked') as dlp_blocked,
            COUNT(*) FILTER (WHERE direction = 'input') as input_count,
            COUNT(*) FILTER (WHERE direction = 'output') as output_count,
            COUNT(DISTINCT user_id) as unique_users
        FROM guardrail_events ${where}
    `, params);
}

// ─── DLP-specific logger ───────────────────────────────────────────
// `violation_type: 'dlp_decision'` events are emitted when a prompt goes
// through pre-flight DLP scanning. `action_taken` is one of:
//   'allowed'  — no findings or user explicitly allowed raw text
//   'redacted' — tokenised before sending to the LLM
//   'blocked'  — user or policy blocked the prompt
//   'scan_failed' — PII service error (paired with fail-open/closed policy)
async function logDlpDecision(event) {
    return logGuardrailEvent({
        ...event,
        violation_type: 'dlp_decision',
        direction: 'outbound',
    });
}

async function getGuardrailTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE violation_type = 'moderation') as moderation,
            COUNT(*) FILTER (WHERE violation_type = 'pii') as pii,
            COUNT(*) FILTER (WHERE violation_type = 'regex') as regex
        FROM guardrail_events ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

async function getGuardrailByUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            user_id,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE violation_type = 'moderation') as moderation,
            COUNT(*) FILTER (WHERE violation_type = 'pii') as pii,
            COUNT(*) FILTER (WHERE violation_type = 'regex') as regex,
            MAX(timestamp) as last_event
        FROM guardrail_events ${where}
        GROUP BY user_id
        ORDER BY total DESC
    `, params);
}

async function getGuardrailByCategory(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    // Split comma-separated categories and count each
    const baseWhere = where ? `${where} AND` : 'WHERE';
    return getAll(`
        SELECT
            unnest(string_to_array(violation_categories, ', ')) as category,
            COUNT(*) as count,
            violation_type
        FROM guardrail_events ${baseWhere}
            violation_categories IS NOT NULL
            AND violation_categories != ''
        GROUP BY category, violation_type
        ORDER BY count DESC
    `, params);
}

async function getRecentGuardrailEvents(limit = 50, filters = {}) {
    await initDB();
    const conditions = [];
    const params = [];
    let idx = 1;

    if (filters?.organizationId) {
        conditions.push(`organization_id = $${idx++}`);
        params.push(filters.organizationId);
    }
    if (filters?.startDate) {
        conditions.push(`timestamp >= $${idx++}`);
        params.push(filters.startDate);
    }
    if (filters?.endDate) {
        conditions.push(`timestamp <= $${idx++}`);
        params.push(filters.endDate);
    }
    if (filters?.violationType) {
        conditions.push(`violation_type = $${idx++}`);
        params.push(filters.violationType);
    }
    // Default 30-day guard
    if (!filters?.startDate && !filters?.endDate) {
        conditions.push(`timestamp >= NOW() - INTERVAL '30 days'`);
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return getAll(`
        SELECT * FROM guardrail_events
        ${where}
        ORDER BY timestamp DESC
        LIMIT $${idx}
    `, [...params, limit]);
}

async function getGuardrailByAction(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            action_taken,
            violation_type,
            COUNT(*) as count
        FROM guardrail_events ${where}
        GROUP BY action_taken, violation_type
        ORDER BY count DESC
    `, params);
}

module.exports = {
    logGuardrailEvent,
    logDlpDecision,
    getGuardrailSummary,
    getGuardrailTimeline,
    getGuardrailByUser,
    getGuardrailByCategory,
    getGuardrailByAction,
    getRecentGuardrailEvents,
};
