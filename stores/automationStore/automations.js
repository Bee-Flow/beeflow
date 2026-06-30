/**
 * automations.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, exec, getClient, pool } = require('./core');
const { rowToAutomation, rowToRun, rowToRunStep, safeParse, fromJsonb } = require('./rowMappers');
const { summarizeDefinitionDiffLine } = require('../../automation/diffSummary');

async function createAutomation({ userId, organizationId = null, title, description = '', definition, triggerType, scheduleCron = null, scheduleTz = 'Europe/Amsterdam', nextRunAt = null, createdFromChatId = null }) {
    await initDB();
    const id = crypto.randomUUID();
    // Layers are inline (definition.layers) since the inline-layers
    // migration — every new row is a plain automation; the `kind` column's
    // default covers it (kept for legacy rows converted from standalone
    // layers).
    await run(
        `INSERT INTO automations (id, user_id, organization_id, title, description, definition_json,
            version, is_active, is_draft, needs_first_run_confirm, trigger_type, schedule_cron, schedule_tz, next_run_at, created_from_chat_id)
         VALUES ($1,$2,$3,$4,$5,$6,1,FALSE,TRUE,TRUE,$7,$8,$9,$10,$11)`,
        [id, userId, organizationId, title, description, JSON.stringify(definition || {}),
            triggerType, scheduleCron, scheduleTz, nextRunAt, createdFromChatId],
    );
    // Seed the v1 version snapshot so run history can render the flow exactly
    // as it was at run time, even for runs that fire before the first edit
    // (updateAutomation only inserts a version row on subsequent changes).
    await run(
        `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id, change_summary)
         VALUES ($1, $2, 1, $3, $4, $5)
         ON CONFLICT (automation_id, version) DO NOTHING`,
        [crypto.randomUUID(), id, JSON.stringify(definition || {}), userId, 'Created'],
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
    // Layers live in their own library — keep them out of the main list.
    const rows = await getAll(
        `SELECT * FROM automations WHERE user_id = $1 AND kind = 'automation' ORDER BY updated_at DESC`,
        [userId],
    );
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
 * §WS2.2 — Expire approval-paused runs past their deadline. Unlike
 * reapStuckAutomations (which works on the automations row), approval pauses
 * live on automation_runs: a run sits in status='awaiting_approval' with an
 * awaiting_step_expires_at deadline. This flips any run past its deadline to a
 * terminal error so paused runs can't accumulate forever and can no longer be
 * approved after the window. Returns the reaped runs so the caller can emit
 * run.failed lifecycle events.
 */
async function reapExpiredApprovals() {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automation_runs
            SET status = 'error',
                error_class = 'ApprovalExpired',
                error = COALESCE(error, 'Approval was not granted before the deadline'),
                summary = 'Approval expired — no decision was made before the deadline.',
                finished_at = NOW(),
                duration_ms = COALESCE(duration_ms, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int),
                awaiting_step_id = NULL,
                approval_token = NULL
          WHERE status = 'awaiting_approval'
            AND awaiting_step_expires_at IS NOT NULL
            AND awaiting_step_expires_at < NOW()
          RETURNING id, automation_id, user_id`,
    );
    return rows.map(r => ({ id: r.id, automationId: r.automation_id, userId: r.user_id }));
}

/**
 * §WS3.3 — Reap orphaned run rows. A run whose worker pod crashed stays in
 * status='running' forever (the stuck-automations reaper only touches the
 * automations row, not automation_runs), leaking into the active-runs UI /
 * concurrency guard. This finally READS last_heartbeat_at (previously a dead
 * column): a healthy long run heartbeats every 15s so it's never stale; a dead
 * run stops heartbeating and is flipped to error after the window. Falls back to
 * started_at for runs that died before their first heartbeat. Returns reaped runs
 * so the caller can emit run.failed lifecycle events.
 */
async function reapStuckRuns({ staleAfterMs = 6 * 60_000 } = {}) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automation_runs
            SET status = 'error',
                error_class = COALESCE(error_class, 'RunnerDied'),
                error = COALESCE(error, 'Run stopped heartbeating — the worker crashed or was killed.'),
                summary = COALESCE(summary, 'Run interrupted — the worker stopped responding.'),
                finished_at = NOW(),
                duration_ms = COALESCE(duration_ms, GREATEST(0, EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int)
          WHERE status = 'running'
            AND COALESCE(last_heartbeat_at, started_at) IS NOT NULL
            AND COALESCE(last_heartbeat_at, started_at) < NOW() - ($1::int * INTERVAL '1 millisecond')
          RETURNING id, automation_id, user_id`,
        [staleAfterMs],
    );
    return rows.map(r => ({ id: r.id, automationId: r.automation_id, userId: r.user_id }));
}

/**
 * §WS3.1 — Delete terminal runs older than the cutoff, in one bounded batch.
 * automation_run_steps cascade-delete via their FK. NEVER touches in-flight runs
 * (queued/running/awaiting_approval). Returns the number of runs deleted so the
 * caller can loop until a batch comes back short. Ordered oldest-first so repeated
 * batches drain the backlog deterministically.
 */
async function deleteRunsOlderThan(cutoffIso, { limit = 5000 } = {}) {
    await initDB();
    const { rowCount } = await pool.query(
        `DELETE FROM automation_runs
          WHERE id IN (
              SELECT id FROM automation_runs
               WHERE status IN ('success', 'error', 'cancelled')
                 AND COALESCE(finished_at, created_at) < $1
               ORDER BY COALESCE(finished_at, created_at) ASC
               LIMIT $2
          )`,
        [cutoffIso, limit],
    );
    return rowCount || 0;
}

/**
 * Reset the attempts counter after a successful run.
 */
async function resetAttempts(id) {
    await initDB();
    await run(`UPDATE automations SET attempts = 0 WHERE id = $1`, [id]);
}

async function updateAutomation(id, updates, savedByUserId) {
    await initDB();
    const fieldMap = {
        title: 'title',
        description: 'description',
        icon: 'icon',
        category: 'category',
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
    let definitionJson = null;
    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
        if (updates[jsKey] === undefined) continue;
        let v = updates[jsKey];
        if (jsKey === 'definition') {
            v = JSON.stringify(v || {});
            definitionChanged = true;
            definitionJson = v;
        }
        setClauses.push(`"${dbCol}" = $${idx++}`);
        params.push(v);
    }
    if (params.length === 0) return false;

    const client = await getClient();
    try {
        await client.query('BEGIN');
        // Snapshot the pre-update definition so we can summarize what
        // changed (steps/edges/fields) into the new version's change_summary.
        let prevDefinition = {};
        if (definitionChanged) {
            const prevRow = await client.query('SELECT definition_json FROM automations WHERE id = $1', [id]);
            const pj = prevRow.rows[0]?.definition_json;
            prevDefinition = typeof pj === 'string' ? safeParse(pj, {}) : (pj || {});
        }
        // Bump version when definition is mutated
        if (definitionChanged) {
            setClauses.push(`version = version + 1`);
            // Keep the builder-session snapshot's draft in lock-step with the
            // persisted definition. Visual edits (drag, layer ops, inspector
            // saves) update the row but NOT the snapshot the client rehydrates
            // from on refresh — without this the stale snapshot draft masks the
            // saved definition and the user's changes appear to vanish on
            // reload. Only touch the snapshot when one already exists.
            setClauses.push(`builder_session = CASE WHEN builder_session IS NULL THEN builder_session ELSE jsonb_set(builder_session, '{draft}', $${idx}::jsonb, true) END`);
            params.push(definitionJson);
            idx++;
        }
        params.push(id);
        const upd = await client.query(
            `UPDATE automations SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
            params,
        );
        const updatedRow = upd.rows[0];
        if (definitionChanged && updatedRow) {
            const nextDefinition = typeof updatedRow.definition_json === 'string'
                ? safeParse(updatedRow.definition_json, {})
                : (updatedRow.definition_json || {});
            let changeSummary = null;
            try { changeSummary = summarizeDefinitionDiffLine(prevDefinition, nextDefinition); }
            catch (_) { /* summary is best-effort — never block the save */ }
            await client.query(
                `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id, change_summary)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (automation_id, version) DO NOTHING`,
                [crypto.randomUUID(), id, updatedRow.version, JSON.stringify(nextDefinition), savedByUserId || updatedRow.user_id, changeSummary],
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

module.exports = { createAutomation, getAutomation, getAutomationsForUser, getDueAutomations, claimDueAutomations, markRunning, releaseAutomation, reapStuckAutomations, reapExpiredApprovals, reapStuckRuns, deleteRunsOlderThan, resetAttempts, updateAutomation, deleteAutomation };
