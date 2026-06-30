/**
 * runs.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, exec, getClient, pool } = require('./core');
const { rowToAutomation, rowToRun, rowToRunStep, safeParse, fromJsonb } = require('./rowMappers');
const { redactForPersistence } = require('../../automation/runLogRedaction');
const { truncatePayload } = require('../../automation/payloadTruncation');

// ── Runs ───────────────────────────────────────────────

async function createRun({ automationId, version, userId, triggerKind, triggerPayload = null, mode = 'live', parentRunId = null }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, trigger_payload, mode, status, started_at, parent_run_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',NOW(),$8)`,
        [id, automationId, version, userId, triggerKind, triggerPayload ? JSON.stringify(triggerPayload) : null, mode, parentRunId],
    );
    return getRun(id);
}

/**
 * Mark a run as cancel-requested. The runner reads this flag between steps
 * and short-circuits with status='cancelled'. Returns the updated row, or
 * null if no row matched.
 */
async function requestCancelRun(runId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automation_runs
            SET cancel_requested = TRUE
          WHERE id = $1
            AND status IN ('queued', 'running')
          RETURNING *`,
        [runId],
    );
    return rowToRun(rows[0]);
}

async function getRun(id) {
    await initDB();
    const r = await getOne('SELECT * FROM automation_runs WHERE id = $1', [id]);
    return rowToRun(r);
}

async function getRunsForAutomation(automationId, { limit = 50 } = {}) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_runs WHERE automation_id = $1 ORDER BY started_at DESC NULLS LAST LIMIT $2',
        [automationId, limit],
    );
    return rows.map(rowToRun);
}

// Map a run row (joined to its automation) to the FE shape used by the
// executions table: the base run + the automation's title/kind/icon/trigger so
// the table can show a Name column and badge Steps vs Automations.
function rowToRunWithAutomation(r) {
    return {
        ...rowToRun(r),
        automationTitle: r.automation_title || null,
        automationKind: r.automation_kind || 'automation',
        automationIcon: r.automation_icon || null,
        automationTriggerType: r.automation_trigger_type || null,
    };
}

// Encode/decode an opaque keyset cursor — (started_at, id) of the last row on
// the page. Base64url JSON keeps it tamper-evident-ish and URL-safe; a bad
// cursor decodes to null so the caller falls back to page 1 (never a 500).
function encodeRunCursor(row) {
    if (!row || !row.started_at) return null;
    const payload = { s: new Date(row.started_at).toISOString(), i: row.id };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function decodeRunCursor(cursor) {
    if (!cursor || typeof cursor !== 'string') return null;
    try {
        const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (o && o.s && o.i) return { startedAt: o.s, id: o.i };
    } catch { /* fall through */ }
    return null;
}

// Shared WHERE builder for the executions list + facets so the filter chips and
// the rows always agree. Returns { clause, params } starting at $startIdx.
// Filters: status/triggerKind (string or array), automationId, kind, since/until
// (ISO strings on started_at). user scoping is always applied.
function buildRunFilterWhere(userId, filters = {}, startIdx = 1) {
    const params = [];
    const clauses = [];
    let i = startIdx;
    const add = (sql, val) => { clauses.push(sql.replace('$$', `$${i}`)); params.push(val); i++; };

    add('r.user_id = $$', userId);
    const arr = (v) => (Array.isArray(v) ? v : [v]).filter(x => x != null && x !== '');
    if (filters.status != null && arr(filters.status).length) add('r.status = ANY($$)', arr(filters.status));
    if (filters.triggerKind != null && arr(filters.triggerKind).length) add('r.trigger_kind = ANY($$)', arr(filters.triggerKind));
    if (filters.mode != null && arr(filters.mode).length) add('r.mode = ANY($$)', arr(filters.mode));
    if (filters.automationId) add('r.automation_id = $$', filters.automationId);
    if (filters.kind) add('a.kind = $$', filters.kind);
    if (filters.sinceTs) add('r.started_at >= $$', filters.sinceTs);
    if (filters.untilTs) add('r.started_at < $$', filters.untilTs);
    return { clause: clauses.join(' AND '), params, nextIdx: i };
}

/**
 * Cross-automation / scoped run list for one user, newest-first, with keyset
 * (cursor) pagination + server-side filters. Powers the n8n-style executions
 * table for the global view, a single automation, and a single Step (the Step's
 * runs are just automation_runs with automation_id = the block id).
 *
 * Returns { runs, nextCursor }. JOINs automations for title/kind/icon/trigger.
 */
async function listRunsForUser(userId, filters = {}) {
    await initDB();
    const limit = Math.min(Math.max(parseInt(filters.limit, 10) || 50, 1), 100);
    const where = buildRunFilterWhere(userId, filters, 1);
    const params = [...where.params];
    let clause = where.clause;
    let idx = where.nextIdx;

    // Keyset: rows strictly older than the cursor in (started_at DESC, id DESC).
    const cur = decodeRunCursor(filters.cursor);
    if (cur) {
        clause += ` AND (r.started_at, r.id) < ($${idx}, $${idx + 1})`;
        params.push(cur.startedAt, cur.id);
        idx += 2;
    }

    const rows = await getAll(
        `SELECT r.*, a.title AS automation_title, a.kind AS automation_kind,
                a.icon AS automation_icon, a.trigger_type AS automation_trigger_type
           FROM automation_runs r
           JOIN automations a ON a.id = r.automation_id
          WHERE ${clause}
          ORDER BY r.started_at DESC NULLS LAST, r.id DESC
          LIMIT $${idx}`,
        [...params, limit + 1],
    );

    let nextCursor = null;
    if (rows.length > limit) {
        const last = rows[limit - 1];
        rows.length = limit; // drop the probe row
        nextCursor = encodeRunCursor(last);
    }
    return { runs: rows.map(rowToRunWithAutomation), nextCursor };
}

/**
 * Cross-automation recent runs for one user (back-compat wrapper around
 * listRunsForUser — keep the old { runs:[...] }-shape callers working).
 */
async function getRecentRunsForUser(userId, { limit = 50 } = {}) {
    const { runs } = await listRunsForUser(userId, { limit });
    return runs;
}

/**
 * Facet counts for the executions filter chips, over the SAME filtered set as
 * listRunsForUser (minus the dimension being counted is NOT excluded here — the
 * counts reflect the active filter, n8n-style). Returns
 * { status, triggerKind, automationId, errorClass } maps of value→count.
 */
async function getRunFacetsForUser(userId, filters = {}) {
    await initDB();
    const where = buildRunFilterWhere(userId, filters, 1);
    const rows = await getAll(
        `SELECT r.status, r.trigger_kind, r.automation_id, r.error_class
           FROM automation_runs r
           JOIN automations a ON a.id = r.automation_id
          WHERE ${where.clause}`,
        where.params,
    );
    const facets = { status: {}, triggerKind: {}, automationId: {}, errorClass: {} };
    const bump = (bucket, key) => { if (key == null) return; facets[bucket][key] = (facets[bucket][key] || 0) + 1; };
    for (const r of rows) {
        bump('status', r.status);
        bump('triggerKind', r.trigger_kind);
        bump('automationId', r.automation_id);
        bump('errorClass', r.error_class);
    }
    return facets;
}

/**
 * Stamp last_heartbeat_at so the stuck-run reaper sees the run as alive and the
 * SSE heartbeat has a persisted counterpart. Best-effort; never throws.
 */
async function touchRunHeartbeat(runId) {
    if (!runId) return false;
    try {
        await initDB();
        const { rowCount } = await run(
            `UPDATE automation_runs SET last_heartbeat_at = NOW()
              WHERE id = $1 AND status = 'running'`,
            [runId],
        );
        return rowCount > 0;
    } catch (_) { return false; }
}

/**
 * Active (running / awaiting_approval) runs for a user. Powers the
 * "● Running" dot in the routine list sidebar and the concurrent-run
 * guard. Joins to automations so the caller can match by automationId
 * without a second round-trip.
 */
async function getActiveRunsForUser(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT r.id, r.automation_id, r.status, r.started_at, r.trigger_kind
           FROM automation_runs r
          WHERE r.user_id = $1
            AND r.status IN ('queued', 'running', 'awaiting_approval')
          ORDER BY r.started_at DESC NULLS LAST`,
        [userId],
    );
    return rows.map(r => ({
        runId: r.id,
        automationId: r.automation_id,
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        triggerKind: r.trigger_kind || null,
    }));
}

async function updateRun(id, updates) {
    await initDB();
    const map = {
        status: 'status', startedAt: 'started_at', finishedAt: 'finished_at',
        durationMs: 'duration_ms', error: 'error', summary: 'summary',
        // Phase 2 approval flow
        awaitingStepId: 'awaiting_step_id',
        approvalToken: 'approval_token',
        // §27a — optional deadline on the awaiting_approval state.
        awaitingStepExpiresAt: 'awaiting_step_expires_at',
        // §25 — typed error class so the activity dashboard can filter
        // by error category without parsing the free-text message.
        errorClass: 'error_class',
        // §WS4 — count of step failures absorbed by on_error branches.
        handledErrorCount: 'handled_error_count',
    };
    const setClauses = []; const params = []; let idx = 1;
    for (const [jsKey, dbCol] of Object.entries(map)) {
        if (updates[jsKey] === undefined) continue;
        setClauses.push(`"${dbCol}" = $${idx++}`);
        params.push(updates[jsKey]);
    }
    if (params.length === 0) return false;
    params.push(id);
    const { rowCount } = await run(`UPDATE automation_runs SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
    return rowCount > 0;
}

async function recordRunStep({ runId, stepId, parentStepId = null, stepType, attempts = 1, status, startedAt, finishedAt, input, output, error, errorClass = null, branchIndex = null, secretValues = [] }) {
    await initDB();
    if (!runId || !stepId) {
        // Defensive: NOT NULL columns; skip rather than crash the whole run.
        console.warn(`[AutomationStore] recordRunStep called with null runId/stepId — skipping (runId=${runId}, stepId=${stepId})`);
        return;
    }
    // WS5.2 — this is the single persistence chokepoint for step payloads:
    // redact secrets BEFORE truncation so the truncation head sample is
    // already clean, then cap payload size. In-memory runState stays raw.
    const redact = (v) => redactForPersistence(v, { secretValues }).value;
    // NUL bytes can't live in jsonb/text columns — Postgres rejects them with
    // "unsupported Unicode escape sequence" and aborts the whole run record.
    // A single NUL in extracted tool output (e.g. a CID-font PDF) would
    // otherwise kill the run here, so scrub it at this persistence chokepoint.
    // JSON.stringify escapes NUL as the literal \u0000; strip that token.
    const stripJsonNul = (str) => (str == null ? str : str.replace(/\\u0000/g, ''));
    const inputJson = input != null ? stripJsonNul(JSON.stringify(truncatePayload(redact(input)).value)) : null;
    const outputJson = output != null ? stripJsonNul(JSON.stringify(truncatePayload(redact(output)).value)) : null;
    // eslint-disable-next-line no-control-regex
    const errorText = error ? redact(String(error)).replace(/\u0000/g, '') : null;
    // parent_step_id is set on INSERT only (deliberately absent from the
    // conflict-update list): a step's nesting parent is fixed by the graph
    // shape at dispatch time and never changes across attempt upserts.
    await run(
        `INSERT INTO automation_run_steps (run_id, step_id, parent_step_id, step_type, attempts, status, started_at, finished_at, input_json, output_json, error, error_class, branch_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (run_id, step_id, attempts) DO UPDATE SET
            status = EXCLUDED.status,
            finished_at = EXCLUDED.finished_at,
            output_json = EXCLUDED.output_json,
            error = EXCLUDED.error,
            error_class = EXCLUDED.error_class,
            branch_index = EXCLUDED.branch_index`,
        [
            runId, stepId, parentStepId || null, stepType, attempts, status,
            startedAt || null, finishedAt || null,
            inputJson,
            outputJson,
            errorText,
            errorClass || null,
            branchIndex,
        ],
    );
}

async function getRunSteps(runId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_run_steps WHERE run_id = $1 ORDER BY started_at NULLS LAST, step_id, attempts',
        [runId],
    );
    return rows.map(rowToRunStep);
}

module.exports = { createRun, getRun, getRunsForAutomation, getRecentRunsForUser, listRunsForUser, getRunFacetsForUser, touchRunHeartbeat, getActiveRunsForUser, updateRun, requestCancelRun, recordRunStep, getRunSteps, encodeRunCursor, decodeRunCursor, buildRunFilterWhere };
