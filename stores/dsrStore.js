/**
 * DSR Store — Data Subject Request persistence (GDPR Art. 15–22).
 *
 * Public POST /api/dsr/requests inserts here without auth (legal obligation).
 * Admin GET / fulfil endpoints in /api/dsr/* read & mutate.
 *
 * Request types: access | rectification | deletion | portability | restriction | objection
 * Status:        pending | in_progress | fulfilled | rejected
 */

const { run, getOne, getAll, exec } = require('../db');

let _initPromise = null;
async function initDB() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
        await exec(`
            CREATE TABLE IF NOT EXISTS dsr_requests (
                id SERIAL PRIMARY KEY,
                organization_id TEXT,
                request_type TEXT NOT NULL,
                subject_email TEXT NOT NULL,
                subject_user_id TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                notes TEXT,
                result_summary TEXT,
                result_payload JSONB,
                source_ip TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                fulfilled_at TIMESTAMPTZ,
                fulfilled_by TEXT
            )
        `);
        await exec(`CREATE INDEX IF NOT EXISTS idx_dsr_org_status ON dsr_requests(organization_id, status, created_at DESC)`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_dsr_subject_email ON dsr_requests(subject_email)`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_dsr_type_created ON dsr_requests(request_type, created_at DESC)`);
    })();
    return _initPromise;
}

initDB().catch(err => console.error('[DsrStore] Init error:', err.message));

const VALID_TYPES = new Set(['access', 'rectification', 'deletion', 'portability', 'restriction', 'objection']);
const VALID_STATUSES = new Set(['pending', 'in_progress', 'fulfilled', 'rejected']);

async function createRequest(input) {
    await initDB();
    if (!input || !input.subject_email) throw new Error('subject_email is required');
    const type = String(input.request_type || 'access').toLowerCase();
    if (!VALID_TYPES.has(type)) throw new Error(`invalid request_type "${type}"`);
    const { rows } = await run(`
        INSERT INTO dsr_requests
            (organization_id, request_type, subject_email, subject_user_id, notes, source_ip, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'pending')
        RETURNING id, created_at
    `, [
        input.organization_id || null,
        type,
        String(input.subject_email).trim().toLowerCase(),
        input.subject_user_id || null,
        input.notes || null,
        input.source_ip || null,
    ]);
    return rows[0];
}

async function listRequests(orgId, { status, limit = 200 } = {}) {
    await initDB();
    const params = [orgId];
    let where = `organization_id = $1`;
    if (status) {
        params.push(status);
        where += ` AND status = $${params.length}`;
    }
    params.push(limit);
    return getAll(`
        SELECT id, request_type, subject_email, subject_user_id, status, notes,
               result_summary, source_ip, created_at, fulfilled_at, fulfilled_by
        FROM dsr_requests
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length}
    `, params);
}

async function getRequest(orgId, id) {
    await initDB();
    return getOne(`
        SELECT * FROM dsr_requests
        WHERE organization_id = $1 AND id = $2
    `, [orgId, id]);
}

async function updateStatus(orgId, id, status, { fulfilledBy, resultSummary, resultPayload } = {}) {
    await initDB();
    if (!VALID_STATUSES.has(status)) throw new Error(`invalid status "${status}"`);
    const fulfilledAt = status === 'fulfilled' ? new Date() : null;
    const payloadJson = resultPayload === undefined ? null : JSON.stringify(resultPayload);
    await run(`
        UPDATE dsr_requests SET
            status = $3,
            fulfilled_at = COALESCE($4, fulfilled_at),
            fulfilled_by = COALESCE($5, fulfilled_by),
            result_summary = COALESCE($6, result_summary),
            result_payload = COALESCE($7::jsonb, result_payload)
        WHERE organization_id = $1 AND id = $2
    `, [orgId, id, status, fulfilledAt, fulfilledBy || null, resultSummary || null, payloadJson]);
    return getRequest(orgId, id);
}

/**
 * SLA aggregates for the Art-15 / Art-17 checks. Returns counts and average
 * fulfilment time in days for the requested type over the rolling window.
 */
async function getSlaStats(orgId, requestType, windowDays = 365) {
    await initDB();
    const row = await getOne(`
        SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'fulfilled')::int AS fulfilled,
            COUNT(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS open,
            COUNT(*) FILTER (
                WHERE status IN ('pending','in_progress')
                AND created_at < NOW() - INTERVAL '30 days'
            )::int AS overdue,
            COALESCE(AVG(
                EXTRACT(EPOCH FROM (fulfilled_at - created_at)) / 86400
            ) FILTER (WHERE status = 'fulfilled'), 0) AS avg_days_to_fulfil
        FROM dsr_requests
        WHERE organization_id = $1 AND request_type = $2
        AND created_at >= NOW() - ($3 || ' days')::interval
    `, [orgId, requestType, String(windowDays)]);
    return row || { total: 0, fulfilled: 0, open: 0, overdue: 0, avg_days_to_fulfil: 0 };
}

module.exports = {
    initDB,
    createRequest,
    listRequests,
    getRequest,
    updateStatus,
    getSlaStats,
};
