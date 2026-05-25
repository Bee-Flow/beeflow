/**
 * Automation Store — PostgreSQL-backed automation definitions, runs, and triggers.
 *
 * Sibling of aiTaskStore. Automations are typed-DAG workflows (the conversational
 * builder produces them); aiTaskStore stays as the prompt-only path.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec, getClient, pool } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;
    const migration = require('../migrations/automation-builder-2026-05-init');
    await migration.up();
    try { await require('../migrations/automation-locking-and-session-2026-05').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/automation-clear-first-run-confirm-2026-05').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/automation-timeout-and-subs-2026-05').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/automation-event-mode-2026-05').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/automation-approval-and-parallel-2026-06').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/automation-error-class-2026-06').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/automation-approval-expiry-2026-06').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/automation-heartbeat-2026-06').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/automation-alerts-2026-06').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/automation-extras-2026-06').up(); } catch (e) { /* tolerate */ }
    try { await require('../migrations/n8n-connections-2026-06').up(); } catch (e) { /* tolerate */ }
    initialized = true;
    console.log('[AutomationStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[AutomationStore] Init error:', err.message));

function rowToAutomation(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id,
        title: r.title,
        description: r.description,
        definition: typeof r.definition_json === 'string' ? safeParse(r.definition_json, {}) : (r.definition_json || {}),
        version: r.version,
        isActive: r.is_active,
        isDraft: r.is_draft,
        needsFirstRunConfirm: r.needs_first_run_confirm,
        triggerType: r.trigger_type,
        scheduleCron: r.schedule_cron,
        scheduleTz: r.schedule_tz,
        nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
        lastStatus: r.last_status,
        // Lock + retry columns added by automation-locking-and-session-2026-05.
        runningInstanceId: r.running_instance_id ?? null,
        runningStartedAt: r.running_started_at ? new Date(r.running_started_at).toISOString() : null,
        attempts: r.attempts ?? 0,
        // Per-automation timeout override (added by automation-timeout-and-subs-2026-05).
        // NULL means "use the runner's default".
        runTimeoutMs: r.run_timeout_ms ?? null,
        builderSession: typeof r.builder_session === 'string' ? safeParse(r.builder_session, null) : (r.builder_session ?? null),
        createdFromChatId: r.created_from_chat_id,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

function rowToRun(r) {
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        version: r.version,
        userId: r.user_id,
        triggerKind: r.trigger_kind,
        triggerPayload: typeof r.trigger_payload === 'string' ? safeParse(r.trigger_payload, null) : (r.trigger_payload || null),
        mode: r.mode,
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        durationMs: r.duration_ms,
        error: r.error,
        summary: r.summary,
        // Cancel + retry plumbing (added by automation-timeout-and-subs-2026-05).
        // parentRunId is the run a retry replays. cancelRequested is flipped
        // by the cancel endpoint and read by the runner between steps.
        parentRunId: r.parent_run_id ?? null,
        cancelRequested: !!r.cancel_requested,
        // Approval / resume plumbing (added by automation-approval-and-parallel-2026-06).
        awaitingStepId: r.awaiting_step_id ?? null,
        approvalToken: r.approval_token ?? null,
        // §27a — optional deadline on awaiting_approval. NULL means "no
        // expiry"; a past timestamp causes the approve route to 410.
        awaitingStepExpiresAt: r.awaiting_step_expires_at
            ? new Date(r.awaiting_step_expires_at).toISOString()
            : null,
        // §25 — typed error class persisted alongside the free-text error.
        errorClass: r.error_class ?? null,
    };
}

function rowToRunStep(r) {
    if (!r) return null;
    return {
        runId: r.run_id,
        stepId: r.step_id,
        stepType: r.step_type,
        attempts: r.attempts,
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        input: typeof r.input_json === 'string' ? safeParse(r.input_json, null) : (r.input_json ?? null),
        output: typeof r.output_json === 'string' ? safeParse(r.output_json, null) : (r.output_json ?? null),
        error: r.error,
    };
}

function safeParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
}

// ── Automations CRUD ───────────────────────────────────

async function createAutomation({ userId, organizationId = null, title, description = '', definition, triggerType, scheduleCron = null, scheduleTz = 'Europe/Amsterdam', nextRunAt = null, createdFromChatId = null }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO automations (id, user_id, organization_id, title, description, definition_json,
            version, is_active, is_draft, needs_first_run_confirm, trigger_type, schedule_cron, schedule_tz, next_run_at, created_from_chat_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,FALSE,TRUE,TRUE,$7,$8,$9,$10,$11)`,
        [id, userId, organizationId, title, description, JSON.stringify(definition || {}),
            triggerType, scheduleCron, scheduleTz, nextRunAt, createdFromChatId],
    );
    return getAutomation(id);
}

async function getAutomation(id) {
    await initDB();
    const r = await getOne('SELECT * FROM automations WHERE id = $1', [id]);
    return rowToAutomation(r);
}

async function getAutomationsForUser(userId) {
    await initDB();
    const rows = await getAll('SELECT * FROM automations WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return rows.map(rowToAutomation);
}

async function getDueAutomations() {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automations
         WHERE is_active = TRUE
           AND is_draft = FALSE
           AND trigger_type = 'schedule'
           AND next_run_at IS NOT NULL
           AND next_run_at <= NOW()
           AND (last_status IS NULL OR last_status != 'running')
         ORDER BY next_run_at ASC LIMIT 20`,
    );
    return rows.map(rowToAutomation);
}

/**
 * Atomically claim due schedule-trigger automations for execution.
 *
 * Uses `FOR UPDATE SKIP LOCKED` so concurrent runner instances never claim
 * the same row. The claim sets `last_status='running'`, stamps the
 * instance/start time, and returns the rows so the caller can execute them.
 * Replaces the old read-then-mark pattern that allowed double-execution if
 * a runner crashed between read and mark.
 */
async function claimDueAutomations(instanceId, limit = 20) {
    await initDB();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const sel = await client.query(
            `SELECT id FROM automations
             WHERE is_active = TRUE
               AND is_draft = FALSE
               AND trigger_type = 'schedule'
               AND next_run_at IS NOT NULL
               AND next_run_at <= NOW()
               AND (last_status IS NULL OR last_status != 'running')
             ORDER BY next_run_at ASC
             LIMIT $1
             FOR UPDATE SKIP LOCKED`,
            [limit],
        );
        if (sel.rows.length === 0) {
            await client.query('COMMIT');
            return [];
        }
        const ids = sel.rows.map(r => r.id);
        const upd = await client.query(
            `UPDATE automations
                SET last_status = 'running',
                    running_instance_id = $1,
                    running_started_at = NOW()
              WHERE id = ANY($2::text[])
              RETURNING *`,
            [instanceId, ids],
        );
        await client.query('COMMIT');
        return upd.rows.map(rowToAutomation);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Mark an automation row as running for non-scheduled paths (manual run,
 * event trigger). The schedule tick uses claimDueAutomations() instead;
 * this is for paths that already know they want to run a specific row.
 *
 * Returns false if the row was already marked running (i.e. another path
 * is mid-execution) so callers can decide whether to skip or queue.
 */
async function markRunning(id, instanceId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automations
            SET last_status = 'running',
                running_instance_id = $1,
                running_started_at = NOW()
          WHERE id = $2
            AND (last_status IS NULL OR last_status != 'running')
          RETURNING id`,
        [instanceId, id],
    );
    return rows.length > 0;
}

/**
 * Clear the running marker on an automation. Called from the runner's
 * finally block so a crash mid-execution leaves running_started_at set
 * for the reaper to find.
 */
async function releaseAutomation(id) {
    await initDB();
    await run(
        `UPDATE automations
            SET running_instance_id = NULL,
                running_started_at = NULL
          WHERE id = $1`,
        [id],
    );
}

/**
 * Reset rows stuck in `running` for longer than `staleAfterMs` (a runner
 * crash, OOM, or process kill leaves them this way). The reset bumps
 * `attempts`; the caller decides what status to leave them in.
 *
 * Returns the rows that were reset so the runner can decide whether to
 * retry now, schedule a backoff, or notify the owner.
 */
async function reapStuckAutomations({ staleAfterMs = 10 * 60_000, maxAttempts = 5, bufferMs = 60_000 } = {}) {
    await initDB();
    // Per-row stale window: max(floor, run_timeout_ms + buffer). A row with
    // a custom 30-min timeout gets a 31-min reaper window; rows with no
    // override fall back to the floor. This keeps short defaults reaping
    // fast while still leaving room for legitimately long automations.
    const { rows } = await pool.query(
        `UPDATE automations
            SET last_status = CASE
                    WHEN attempts + 1 >= $2 THEN 'error'
                    ELSE 'pending'
                END,
                running_instance_id = NULL,
                running_started_at = NULL,
                attempts = attempts + 1
          WHERE last_status = 'running'
            AND running_started_at IS NOT NULL
            AND running_started_at < NOW() - (
                GREATEST($1::int, COALESCE(run_timeout_ms, 0) + $3::int) * INTERVAL '1 millisecond'
            )
            -- Approval-paused runs are tracked on the automation_runs row,
            -- not the automation row, so they don't appear here. The
            -- automation row should NOT be 'running' while an approval
            -- waits — runner sets last_status='pending' before pausing.
          RETURNING *`,
        [staleAfterMs, maxAttempts, bufferMs],
    );
    return rows.map(rowToAutomation);
}

/**
 * Reset the attempts counter after a successful run.
 */
async function resetAttempts(id) {
    await initDB();
    await run(`UPDATE automations SET attempts = 0 WHERE id = $1`, [id]);
}

// ── Builder session snapshot ───────────────────────────────────────────
//
// The builder loop persists a small snapshot {sessionId, version, messages,
// draft, lastValidation} into automations.builder_session after every
// mutation. On SSE reconnect the client rehydrates from the latest snapshot
// so the chat history isn't lost when the connection drops.
//
// `version` is a monotonically-increasing integer used for optimistic
// locking: setBuilderSession only succeeds when the caller's expected
// version matches the persisted one. Two-tab edits get a 409 on the second
// write so the loser can refresh instead of clobbering.

const SNAPSHOT_MAX_BYTES = 64 * 1024;

function trimSnapshot(snapshot) {
    if (!snapshot) return null;
    let payload = JSON.stringify(snapshot);
    if (payload.length <= SNAPSHOT_MAX_BYTES) return snapshot;
    // Drop oldest non-trigger messages until we fit. Keep the most recent
    // assistant turn intact so resume always shows the user the latest
    // model output.
    const trimmed = { ...snapshot, messages: Array.isArray(snapshot.messages) ? [...snapshot.messages] : [] };
    while (trimmed.messages.length > 2) {
        trimmed.messages.shift();
        payload = JSON.stringify(trimmed);
        if (payload.length <= SNAPSHOT_MAX_BYTES) break;
    }
    return trimmed;
}

async function getBuilderSession(automationId, userId) {
    await initDB();
    const r = await getOne(
        'SELECT builder_session, user_id FROM automations WHERE id = $1',
        [automationId],
    );
    if (!r) return null;
    if (userId && r.user_id !== userId) return null;
    const raw = typeof r.builder_session === 'string' ? safeParse(r.builder_session, null) : (r.builder_session ?? null);
    return raw;
}

/**
 * Persist a builder-session snapshot. When `expectedVersion` is provided,
 * the write only succeeds if the persisted snapshot's version matches —
 * mismatches return { ok: false, conflict: true, current }. When omitted,
 * the write is unconditional and the version increments by 1.
 */
async function setBuilderSession(automationId, userId, snapshot, { expectedVersion = null } = {}) {
    await initDB();
    const trimmed = trimSnapshot(snapshot) || {};
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            'SELECT user_id, builder_session FROM automations WHERE id = $1 FOR UPDATE',
            [automationId],
        );
        if (cur.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, notFound: true };
        }
        if (userId && cur.rows[0].user_id !== userId) {
            await client.query('ROLLBACK');
            return { ok: false, forbidden: true };
        }
        const currentSnap = (typeof cur.rows[0].builder_session === 'string'
            ? safeParse(cur.rows[0].builder_session, null)
            : (cur.rows[0].builder_session ?? null)) || {};
        const currentVersion = Number.isFinite(currentSnap.version) ? currentSnap.version : 0;
        if (expectedVersion != null && currentVersion !== expectedVersion) {
            await client.query('ROLLBACK');
            return { ok: false, conflict: true, current: currentSnap };
        }
        const next = { ...trimmed, version: currentVersion + 1 };
        await client.query(
            `UPDATE automations SET builder_session = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(next), automationId],
        );
        await client.query('COMMIT');
        return { ok: true, snapshot: next };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

async function clearBuilderSession(automationId, userId) {
    await initDB();
    if (userId) {
        await run(
            `UPDATE automations SET builder_session = NULL WHERE id = $1 AND user_id = $2`,
            [automationId, userId],
        );
    } else {
        await run(`UPDATE automations SET builder_session = NULL WHERE id = $1`, [automationId]);
    }
}

async function updateAutomation(id, updates, savedByUserId) {
    await initDB();
    const fieldMap = {
        title: 'title',
        description: 'description',
        definition: 'definition_json',
        isActive: 'is_active',
        isDraft: 'is_draft',
        needsFirstRunConfirm: 'needs_first_run_confirm',
        triggerType: 'trigger_type',
        scheduleCron: 'schedule_cron',
        scheduleTz: 'schedule_tz',
        nextRunAt: 'next_run_at',
        lastRunAt: 'last_run_at',
        lastStatus: 'last_status',
        runTimeoutMs: 'run_timeout_ms',
    };
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;
    let definitionChanged = false;
    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
        if (updates[jsKey] === undefined) continue;
        let v = updates[jsKey];
        if (jsKey === 'definition') {
            v = JSON.stringify(v || {});
            definitionChanged = true;
        }
        setClauses.push(`"${dbCol}" = $${idx++}`);
        params.push(v);
    }
    if (params.length === 0) return false;

    const client = await getClient();
    try {
        await client.query('BEGIN');
        // Bump version when definition is mutated
        if (definitionChanged) {
            setClauses.push(`version = version + 1`);
        }
        params.push(id);
        const upd = await client.query(
            `UPDATE automations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
            params,
        );
        const updatedRow = upd.rows[0];
        if (definitionChanged && updatedRow) {
            await client.query(
                `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (automation_id, version) DO NOTHING`,
                [crypto.randomUUID(), id, updatedRow.version, JSON.stringify(updatedRow.definition_json || {}), savedByUserId || updatedRow.user_id],
            );
        }
        await client.query('COMMIT');
        return rowToAutomation(updatedRow);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

async function deleteAutomation(id) {
    await initDB();
    const { rowCount } = await run('DELETE FROM automations WHERE id = $1', [id]);
    return rowCount > 0;
}

async function listVersions(automationId) {
    await initDB();
    const rows = await getAll(
        'SELECT id, automation_id, version, saved_by_user_id, saved_at FROM automation_versions WHERE automation_id = $1 ORDER BY version DESC',
        [automationId],
    );
    return rows.map(r => ({
        id: r.id, automationId: r.automation_id, version: r.version,
        savedByUserId: r.saved_by_user_id, savedAt: r.saved_at,
    }));
}

/**
 * Fetch one version by id (the version row contains a JSONB definition).
 * Used by the restore endpoint to load the historical definition before
 * we apply it through the regular updateAutomation path (which also
 * validates and bumps the version counter).
 */
async function getVersion(versionId) {
    await initDB();
    const r = await getOne(
        'SELECT id, automation_id, version, definition_json, saved_by_user_id, saved_at FROM automation_versions WHERE id = $1',
        [versionId],
    );
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        version: r.version,
        definition: typeof r.definition_json === 'string' ? safeParse(r.definition_json, {}) : (r.definition_json || {}),
        savedByUserId: r.saved_by_user_id,
        savedAt: r.saved_at,
    };
}

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

/**
 * Cross-automation recent runs for one user. Powers the "All runs" view
 * shown when no specific automation is selected — gives the user a single
 * timeline of recent activity instead of forcing them to click into each
 * automation to find a fresh failure.
 *
 * Joins back to `automations` so the caller can render the title /
 * trigger type without a second round-trip.
 */
async function getRecentRunsForUser(userId, { limit = 50 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT r.*, a.title AS automation_title, a.trigger_type AS automation_trigger_type
           FROM automation_runs r
           JOIN automations a ON a.id = r.automation_id
          WHERE r.user_id = $1
          ORDER BY r.started_at DESC NULLS LAST
          LIMIT $2`,
        [userId, limit],
    );
    return rows.map(r => ({
        ...rowToRun(r),
        automationTitle: r.automation_title || null,
        automationTriggerType: r.automation_trigger_type || null,
    }));
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

async function recordRunStep({ runId, stepId, stepType, attempts = 1, status, startedAt, finishedAt, input, output, error, branchIndex = null }) {
    await initDB();
    if (!runId || !stepId) {
        // Defensive: NOT NULL columns; skip rather than crash the whole run.
        console.warn(`[AutomationStore] recordRunStep called with null runId/stepId — skipping (runId=${runId}, stepId=${stepId})`);
        return;
    }
    await run(
        `INSERT INTO automation_run_steps (run_id, step_id, step_type, attempts, status, started_at, finished_at, input_json, output_json, error, branch_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (run_id, step_id, attempts) DO UPDATE SET
            status = EXCLUDED.status,
            finished_at = EXCLUDED.finished_at,
            output_json = EXCLUDED.output_json,
            error = EXCLUDED.error,
            branch_index = EXCLUDED.branch_index`,
        [
            runId, stepId, stepType, attempts, status,
            startedAt || null, finishedAt || null,
            input != null ? JSON.stringify(input) : null,
            output != null ? JSON.stringify(output) : null,
            error || null,
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

// ── Webhooks ──────────────────────────────────────────

async function createWebhook(automationId) {
    await initDB();
    const id = crypto.randomBytes(12).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    await run(
        `INSERT INTO automation_webhooks (id, automation_id, secret) VALUES ($1, $2, $3)`,
        [id, automationId, secret],
    );
    return { id, automationId, secret };
}

async function getWebhook(id) {
    await initDB();
    const r = await getOne('SELECT * FROM automation_webhooks WHERE id = $1', [id]);
    if (!r) return null;
    return { id: r.id, automationId: r.automation_id, secret: r.secret, allowMethods: r.allow_methods, lastSeenAt: r.last_seen_at };
}

async function getWebhooksForAutomation(automationId) {
    await initDB();
    const rows = await getAll('SELECT id, automation_id, allow_methods, last_seen_at, created_at FROM automation_webhooks WHERE automation_id = $1', [automationId]);
    return rows.map(r => ({ id: r.id, automationId: r.automation_id, allowMethods: r.allow_methods, lastSeenAt: r.last_seen_at, createdAt: r.created_at }));
}

async function touchWebhook(id) {
    await initDB();
    await run(`UPDATE automation_webhooks SET last_seen_at = NOW() WHERE id = $1`, [id]);
}

/**
 * Rotate the HMAC secret for a webhook. The webhook's URL stays the same;
 * only the secret used for signature verification changes — so any caller
 * still using the old secret immediately starts getting 401s, while a
 * newly-issued secret takes effect on the next inbound request.
 */
async function rotateWebhookSecret(webhookId, automationId) {
    await initDB();
    const newSecret = crypto.randomBytes(32).toString('hex');
    const { rowCount } = await run(
        `UPDATE automation_webhooks
            SET secret = $1
          WHERE id = $2 AND automation_id = $3`,
        [newSecret, webhookId, automationId],
    );
    if (rowCount === 0) return null;
    return { id: webhookId, automationId, secret: newSecret };
}

async function deleteWebhook(webhookId, automationId) {
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM automation_webhooks WHERE id = $1 AND automation_id = $2`,
        [webhookId, automationId],
    );
    return rowCount > 0;
}

async function checkAndStoreNonce(nonce) {
    await initDB();
    // Garbage-collect old nonces (> 24h) opportunistically.
    await run(`DELETE FROM automation_webhook_seen_nonces WHERE seen_at < NOW() - INTERVAL '24 hours'`).catch(() => {});
    try {
        await run(`INSERT INTO automation_webhook_seen_nonces (nonce) VALUES ($1)`, [nonce]);
        return true;
    } catch {
        return false; // duplicate
    }
}

// ── Event subscriptions ───────────────────────────────

async function createSubscription({ automationId, userId, provider, eventType, mode = 'webhook', externalRef = null, expiresAt = null, lastCursor = null, filter = null, clientState = null }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO automation_event_subscriptions
            (id, automation_id, user_id, provider, event_type, mode, external_ref, expires_at, last_cursor, filter_json, client_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, automationId, userId, provider, eventType, mode, externalRef, expiresAt, lastCursor, filter ? JSON.stringify(filter) : null, clientState],
    );
    return getSubscription(id);
}

function rowToSubscription(r) {
    if (!r) return null;
    return {
        id: r.id, automationId: r.automation_id, userId: r.user_id,
        provider: r.provider, eventType: r.event_type, mode: r.mode,
        externalRef: r.external_ref, expiresAt: r.expires_at,
        lastCursor: r.last_cursor, lastPolledAt: r.last_polled_at,
        filter: typeof r.filter_json === 'string' ? safeParse(r.filter_json, null) : r.filter_json,
        // Failure tracking + MS Graph clientState (added by automation-timeout-and-subs-2026-05).
        consecutiveFailures: r.consecutive_failures ?? 0,
        errorNotifiedAt: r.error_notified_at ? new Date(r.error_notified_at).toISOString() : null,
        clientState: r.client_state ?? null,
        // Push/poll preference (added by automation-event-mode-2026-05).
        // 'hybrid' = push when connector available, polling as backstop;
        // 'webhook' = push only (used by msgraph + nextcloud connector);
        // 'polling' = legacy polling-only path.
        modePreference: r.mode_preference ?? 'hybrid',
        lastPushAt: r.last_push_at ? new Date(r.last_push_at).toISOString() : null,
    };
}

async function getSubscription(id) {
    await initDB();
    const r = await getOne('SELECT * FROM automation_event_subscriptions WHERE id = $1', [id]);
    return rowToSubscription(r);
}

/**
 * Look up a subscription by provider + externalRef. Used by the MS Graph
 * notification handler to validate clientState against the row that owns
 * this subscriptionId — without it, anyone who learns the notificationUrl
 * can forge events on behalf of another tenant.
 */
async function getSubscriptionByExternalRef(provider, externalRef) {
    await initDB();
    if (!externalRef) return null;
    const r = await getOne(
        'SELECT * FROM automation_event_subscriptions WHERE provider = $1 AND external_ref = $2 LIMIT 1',
        [provider, externalRef],
    );
    return rowToSubscription(r);
}

async function getSubscriptionsForProvider(provider, eventType) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_event_subscriptions WHERE provider = $1 AND event_type = $2',
        [provider, eventType],
    );
    return rows.map(rowToSubscription);
}

/**
 * All subscriptions for one automation. Used by activate/deactivate to
 * dedupe and clean up, and by an automation's settings panel to show
 * which event sources are wired up.
 */
/**
 * Subscriptions for one user + provider + event. Used by the push-event
 * webhook handler to find every automation listening for this NC event
 * for this user, so it can dispatch and stamp last_push_at on each row.
 */
async function getSubscriptionsForUserAndEvent(userId, provider, eventType) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_event_subscriptions WHERE user_id = $1 AND provider = $2 AND event_type = $3',
        [userId, provider, eventType],
    );
    return rows.map(rowToSubscription);
}

async function getSubscriptionsForAutomation(automationId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_event_subscriptions WHERE automation_id = $1',
        [automationId],
    );
    return rows.map(rowToSubscription);
}

/**
 * Delete every subscription for an automation. Called from /deactivate
 * (and /delete) so the poller stops firing for paused / removed
 * automations the moment the user toggles them off.
 */
async function deleteSubscriptionsForAutomation(automationId) {
    await initDB();
    await run('DELETE FROM automation_event_subscriptions WHERE automation_id = $1', [automationId]);
}

async function getPollingSubscriptions({ olderThanMs = 60_000, webhookStaleMs = 15 * 60_000 } = {}) {
    await initDB();
    // Two cases:
    //  1. mode='polling'  → poll on every tick where last_polled_at is old enough
    //  2. mode='webhook'  → poll as crash-recovery when last_push_at is stale
    //                       (push pipeline may be down — connector crashed,
    //                        AppAPI events_listener silently dropped, etc.).
    //     Healthy webhook subs are skipped entirely; this only kicks in
    //     after `webhookStaleMs` of silence.
    const rows = await getAll(
        `SELECT * FROM automation_event_subscriptions
         WHERE (
                  mode = 'polling'
                  AND (last_polled_at IS NULL OR last_polled_at < NOW() - ($1 * INTERVAL '1 millisecond'))
              )
            OR (
                  mode = 'webhook'
                  AND (last_push_at IS NULL OR last_push_at < NOW() - ($2 * INTERVAL '1 millisecond'))
                  AND (last_polled_at IS NULL OR last_polled_at < NOW() - ($1 * INTERVAL '1 millisecond'))
              )
         LIMIT 50`,
        [olderThanMs, webhookStaleMs],
    );
    return rows.map(rowToSubscription);
}

async function getExpiringSubscriptions({ withinMs = 5 * 60_000 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automation_event_subscriptions
         WHERE mode = 'webhook'
           AND expires_at IS NOT NULL
           AND expires_at < NOW() + ($1 * INTERVAL '1 millisecond')`,
        [withinMs],
    );
    return rows.map(rowToSubscription);
}

async function updateSubscription(id, updates) {
    await initDB();
    const map = {
        externalRef: 'external_ref',
        expiresAt: 'expires_at',
        lastCursor: 'last_cursor',
        lastPolledAt: 'last_polled_at',
        consecutiveFailures: 'consecutive_failures',
        errorNotifiedAt: 'error_notified_at',
        clientState: 'client_state',
        modePreference: 'mode_preference',
        lastPushAt: 'last_push_at',
    };
    const setClauses = []; const params = []; let idx = 1;
    for (const [jsKey, dbCol] of Object.entries(map)) {
        if (updates[jsKey] === undefined) continue;
        setClauses.push(`"${dbCol}" = $${idx++}`);
        params.push(updates[jsKey]);
    }
    if (params.length === 0) return false;
    params.push(id);
    const { rowCount } = await run(`UPDATE automation_event_subscriptions SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
    return rowCount > 0;
}

/**
 * Atomically increment `consecutive_failures` and return the new value.
 * Used by the polling/renewal paths to drive the failure-escalation
 * notification: callers compare the returned count to the threshold
 * (5 for polling, 2 for renewal) and notify once when it crosses.
 */
async function incrementSubscriptionFailures(id) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automation_event_subscriptions
            SET consecutive_failures = consecutive_failures + 1
          WHERE id = $1
          RETURNING consecutive_failures, error_notified_at`,
        [id],
    );
    if (!rows[0]) return { consecutiveFailures: 0, errorNotifiedAt: null };
    return {
        consecutiveFailures: rows[0].consecutive_failures,
        errorNotifiedAt: rows[0].error_notified_at ? new Date(rows[0].error_notified_at).toISOString() : null,
    };
}

async function resetSubscriptionFailures(id) {
    await initDB();
    await run(
        `UPDATE automation_event_subscriptions
            SET consecutive_failures = 0,
                error_notified_at = NULL
          WHERE id = $1
            AND (consecutive_failures > 0 OR error_notified_at IS NOT NULL)`,
        [id],
    );
}

async function deleteSubscription(id) {
    await initDB();
    const { rowCount } = await run('DELETE FROM automation_event_subscriptions WHERE id = $1', [id]);
    return rowCount > 0;
}

module.exports = {
    initDB,
    createAutomation,
    getAutomation,
    getAutomationsForUser,
    getDueAutomations,
    claimDueAutomations,
    markRunning,
    releaseAutomation,
    reapStuckAutomations,
    resetAttempts,
    getBuilderSession,
    setBuilderSession,
    clearBuilderSession,
    updateAutomation,
    deleteAutomation,
    listVersions,
    getVersion,
    createRun,
    getRun,
    getRunsForAutomation,
    getRecentRunsForUser,
    getActiveRunsForUser,
    updateRun,
    requestCancelRun,
    recordRunStep,
    getRunSteps,
    createWebhook,
    getWebhook,
    getWebhooksForAutomation,
    touchWebhook,
    rotateWebhookSecret,
    deleteWebhook,
    checkAndStoreNonce,
    createSubscription,
    getSubscription,
    getSubscriptionByExternalRef,
    getSubscriptionsForProvider,
    getSubscriptionsForUserAndEvent,
    getSubscriptionsForAutomation,
    deleteSubscriptionsForAutomation,
    getPollingSubscriptions,
    getExpiringSubscriptions,
    updateSubscription,
    incrementSubscriptionFailures,
    resetSubscriptionFailures,
    deleteSubscription,
};
