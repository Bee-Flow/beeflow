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
async function reapStuckAutomations({ staleAfterMs = 10 * 60_000, maxAttempts = 5 } = {}) {
    await initDB();
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
            AND running_started_at < NOW() - ($1 * INTERVAL '1 millisecond')
          RETURNING *`,
        [staleAfterMs, maxAttempts],
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

// ── Runs ───────────────────────────────────────────────

async function createRun({ automationId, version, userId, triggerKind, triggerPayload = null, mode = 'live' }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, trigger_payload, mode, status, started_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',NOW())`,
        [id, automationId, version, userId, triggerKind, triggerPayload ? JSON.stringify(triggerPayload) : null, mode],
    );
    return getRun(id);
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

async function updateRun(id, updates) {
    await initDB();
    const map = { status: 'status', startedAt: 'started_at', finishedAt: 'finished_at', durationMs: 'duration_ms', error: 'error', summary: 'summary' };
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

async function recordRunStep({ runId, stepId, stepType, attempts = 1, status, startedAt, finishedAt, input, output, error }) {
    await initDB();
    if (!runId || !stepId) {
        // Defensive: NOT NULL columns; skip rather than crash the whole run.
        console.warn(`[AutomationStore] recordRunStep called with null runId/stepId — skipping (runId=${runId}, stepId=${stepId})`);
        return;
    }
    await run(
        `INSERT INTO automation_run_steps (run_id, step_id, step_type, attempts, status, started_at, finished_at, input_json, output_json, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (run_id, step_id, attempts) DO UPDATE SET
            status = EXCLUDED.status,
            finished_at = EXCLUDED.finished_at,
            output_json = EXCLUDED.output_json,
            error = EXCLUDED.error`,
        [
            runId, stepId, stepType, attempts, status,
            startedAt || null, finishedAt || null,
            input != null ? JSON.stringify(input) : null,
            output != null ? JSON.stringify(output) : null,
            error || null,
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

async function createSubscription({ automationId, userId, provider, eventType, mode = 'webhook', externalRef = null, expiresAt = null, lastCursor = null, filter = null }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO automation_event_subscriptions
            (id, automation_id, user_id, provider, event_type, mode, external_ref, expires_at, last_cursor, filter_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, automationId, userId, provider, eventType, mode, externalRef, expiresAt, lastCursor, filter ? JSON.stringify(filter) : null],
    );
    return getSubscription(id);
}

async function getSubscription(id) {
    await initDB();
    const r = await getOne('SELECT * FROM automation_event_subscriptions WHERE id = $1', [id]);
    if (!r) return null;
    return {
        id: r.id, automationId: r.automation_id, userId: r.user_id,
        provider: r.provider, eventType: r.event_type, mode: r.mode,
        externalRef: r.external_ref, expiresAt: r.expires_at,
        lastCursor: r.last_cursor, lastPolledAt: r.last_polled_at,
        filter: typeof r.filter_json === 'string' ? safeParse(r.filter_json, null) : r.filter_json,
    };
}

async function getSubscriptionsForProvider(provider, eventType) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_event_subscriptions WHERE provider = $1 AND event_type = $2',
        [provider, eventType],
    );
    return rows.map(r => ({
        id: r.id, automationId: r.automation_id, userId: r.user_id,
        provider: r.provider, eventType: r.event_type, mode: r.mode,
        externalRef: r.external_ref, expiresAt: r.expires_at,
        lastCursor: r.last_cursor, lastPolledAt: r.last_polled_at,
        filter: typeof r.filter_json === 'string' ? safeParse(r.filter_json, null) : r.filter_json,
    }));
}

/**
 * All subscriptions for one automation. Used by activate/deactivate to
 * dedupe and clean up, and by an automation's settings panel to show
 * which event sources are wired up.
 */
async function getSubscriptionsForAutomation(automationId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_event_subscriptions WHERE automation_id = $1',
        [automationId],
    );
    return rows.map(r => ({
        id: r.id, automationId: r.automation_id, userId: r.user_id,
        provider: r.provider, eventType: r.event_type, mode: r.mode,
        externalRef: r.external_ref, expiresAt: r.expires_at,
        lastCursor: r.last_cursor, lastPolledAt: r.last_polled_at,
        filter: typeof r.filter_json === 'string' ? safeParse(r.filter_json, null) : r.filter_json,
    }));
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

async function getPollingSubscriptions({ olderThanMs = 60_000 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automation_event_subscriptions
         WHERE mode = 'polling'
           AND (last_polled_at IS NULL OR last_polled_at < NOW() - ($1 * INTERVAL '1 millisecond'))
         LIMIT 50`,
        [olderThanMs],
    );
    return rows.map(r => ({
        id: r.id, automationId: r.automation_id, userId: r.user_id,
        provider: r.provider, eventType: r.event_type, mode: r.mode,
        externalRef: r.external_ref, expiresAt: r.expires_at,
        lastCursor: r.last_cursor, lastPolledAt: r.last_polled_at,
        filter: typeof r.filter_json === 'string' ? safeParse(r.filter_json, null) : r.filter_json,
    }));
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
    return rows.map(r => ({
        id: r.id, automationId: r.automation_id, userId: r.user_id,
        provider: r.provider, eventType: r.event_type, mode: r.mode,
        externalRef: r.external_ref, expiresAt: r.expires_at,
        lastCursor: r.last_cursor, lastPolledAt: r.last_polled_at,
        filter: typeof r.filter_json === 'string' ? safeParse(r.filter_json, null) : r.filter_json,
    }));
}

async function updateSubscription(id, updates) {
    await initDB();
    const map = { externalRef: 'external_ref', expiresAt: 'expires_at', lastCursor: 'last_cursor', lastPolledAt: 'last_polled_at' };
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
    createRun,
    getRun,
    getRunsForAutomation,
    updateRun,
    recordRunStep,
    getRunSteps,
    createWebhook,
    getWebhook,
    getWebhooksForAutomation,
    touchWebhook,
    checkAndStoreNonce,
    createSubscription,
    getSubscription,
    getSubscriptionsForProvider,
    getSubscriptionsForAutomation,
    deleteSubscriptionsForAutomation,
    getPollingSubscriptions,
    getExpiringSubscriptions,
    updateSubscription,
    deleteSubscription,
};
