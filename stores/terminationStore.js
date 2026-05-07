/**
 * Termination Store — logs vroegtijdig beëindigde AI-taken (max_tokens,
 * max_iterations, errors, client aborts) naar PostgreSQL.
 *
 * Privacy contract: bevat alleen metadata, token-totalen, error categorie en
 * gesanitiseerde error class + eerste stack-regel. Géén kolommen voor user
 * messages, assistant content, tool args of tool output.
 */

const { run, getOne, getAll, exec } = require('../db');

const VALID_TYPES = new Set(['max_tokens', 'max_iterations', 'error', 'aborted']);

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS ai_task_termination_log (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            termination_type TEXT NOT NULL,
            error_code TEXT,
            error_class TEXT,
            error_first_line TEXT,
            stack_first_line TEXT,
            user_id TEXT,
            organization_id TEXT,
            agent_id TEXT,
            agent_name TEXT,
            model TEXT,
            source TEXT,
            conversation_id TEXT,
            swarm_run_id TEXT,
            parent_call_id TEXT,
            iteration_count INTEGER DEFAULT 0,
            duration_ms INTEGER DEFAULT 0,
            prompt_tokens INTEGER DEFAULT 0,
            completion_tokens INTEGER DEFAULT 0,
            total_tokens INTEGER DEFAULT 0
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_term_timestamp ON ai_task_termination_log(timestamp DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_term_type ON ai_task_termination_log(termination_type)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_term_org ON ai_task_termination_log(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_term_agent ON ai_task_termination_log(agent_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_term_org_timestamp ON ai_task_termination_log(organization_id, timestamp DESC)`);
    initialized = true;
}

initDB().catch(err => console.error('[TerminationStore] Init error:', err.message));
console.log('[TerminationStore] Initialized (PostgreSQL)');

/**
 * logTermination(entry)
 *
 * `entry` SHOULD only contain metadata fields (see schema). This function
 * defensively ignores any unexpected keys so a caller cannot accidentally
 * persist message bodies. The error_* fields are expected to come from
 * `errorSanitizer.sanitizeError(err)`.
 */
async function logTermination(entry) {
    await initDB();
    const type = String(entry?.termination_type || '').trim();
    if (!VALID_TYPES.has(type)) {
        console.warn(`[TerminationStore] Skipped log: invalid termination_type "${type}"`);
        return;
    }
    try {
        await run(`
            INSERT INTO ai_task_termination_log (
                timestamp, termination_type,
                error_code, error_class, error_first_line, stack_first_line,
                user_id, organization_id,
                agent_id, agent_name, model, source,
                conversation_id, swarm_run_id, parent_call_id,
                iteration_count, duration_ms,
                prompt_tokens, completion_tokens, total_tokens
            )
            VALUES (
                $1, $2,
                $3, $4, $5, $6,
                $7, $8,
                $9, $10, $11, $12,
                $13, $14, $15,
                $16, $17,
                $18, $19, $20
            )
        `, [
            entry.timestamp || new Date().toISOString(),
            type,
            entry.error_code || null,
            entry.error_class || null,
            entry.error_first_line || null,
            entry.stack_first_line || null,
            entry.user_id || null,
            entry.organization_id || null,
            entry.agent_id || null,
            entry.agent_name || null,
            entry.model || null,
            entry.source || null,
            entry.conversation_id || null,
            entry.swarm_run_id || null,
            entry.parent_call_id || null,
            Number.isFinite(entry.iteration_count) ? entry.iteration_count : 0,
            Number.isFinite(entry.duration_ms) ? entry.duration_ms : 0,
            Number.isFinite(entry.prompt_tokens) ? entry.prompt_tokens : 0,
            Number.isFinite(entry.completion_tokens) ? entry.completion_tokens : 0,
            Number.isFinite(entry.total_tokens) ? entry.total_tokens : 0,
        ]);
    } catch (e) {
        console.error('[TerminationStore] Failed to log termination:', e.message);
    }
}

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
    if (filters?.agentId) {
        conditions.push(`agent_id = $${idx++}`);
        params.push(filters.agentId);
    }
    if (filters?.userId) {
        conditions.push(`user_id = $${idx++}`);
        params.push(filters.userId);
    }
    if (filters?.type) {
        conditions.push(`termination_type = $${idx++}`);
        params.push(filters.type);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

async function getList(filters = {}, limit = 100) {
    await initDB();
    const { where, params, nextIdx } = buildFilters(filters, 1);
    params.push(Math.min(Math.max(limit, 1), 500));
    return getAll(`
        SELECT * FROM ai_task_termination_log
        ${where}
        ORDER BY timestamp DESC
        LIMIT $${nextIdx}
    `, params);
}

async function getSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1);
    const rows = await getAll(`
        SELECT termination_type, COUNT(*)::int AS count
        FROM ai_task_termination_log
        ${where}
        GROUP BY termination_type
    `, params);
    const by_type = { max_tokens: 0, max_iterations: 0, error: 0, aborted: 0 };
    let total = 0;
    for (const r of rows) {
        if (by_type[r.termination_type] !== undefined) by_type[r.termination_type] = r.count;
        total += r.count;
    }
    return { total, by_type };
}

async function getTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters, 1);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} AS period,
            termination_type,
            COUNT(*)::int AS count
        FROM ai_task_termination_log
        ${where}
        GROUP BY period, termination_type
        ORDER BY period ASC
    `, params);
}

async function getByAgent(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters, 1);
    return getAll(`
        SELECT
            agent_id, agent_name,
            COUNT(*)::int AS total,
            SUM(CASE WHEN termination_type = 'max_tokens'     THEN 1 ELSE 0 END)::int AS max_tokens,
            SUM(CASE WHEN termination_type = 'max_iterations' THEN 1 ELSE 0 END)::int AS max_iterations,
            SUM(CASE WHEN termination_type = 'error'          THEN 1 ELSE 0 END)::int AS errors,
            SUM(CASE WHEN termination_type = 'aborted'        THEN 1 ELSE 0 END)::int AS aborted
        FROM ai_task_termination_log
        ${where}
        GROUP BY agent_id, agent_name
        ORDER BY total DESC
        LIMIT 100
    `, params);
}

module.exports = {
    logTermination,
    getList,
    getSummary,
    getTimeline,
    getByAgent,
};
