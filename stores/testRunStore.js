/**
 * Test Run Store — Playwright run lifecycle + durable outbox.
 *
 * Three tables:
 *   • test_runs           — one row per (re)play of a suite or explore session
 *   • test_run_artifacts  — screenshots / traces / videos / console blobs
 *   • test_run_jobs       — outbox the worker drains (claim_token, attempts, backoff)
 *
 * Pattern mirrors workers/paygDrain.js: createRun() writes the run row + outbox
 * row in one transaction so a process crash between them is impossible. The
 * worker uses SELECT ... FOR UPDATE SKIP LOCKED to claim rows safely under
 * concurrent drains.
 *
 * SSE: each run id gets an in-process EventEmitter channel; the route layer
 * subscribes to push live progress events to the browser. Channels are
 * removed automatically when finalized so listeners cannot leak.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { run, getOne, getAll, exec, getClient } = require('../db');

let initialized = false;

const VALID_MODES = new Set(['suite', 'explore', 'agent']);
const VALID_STATUSES = new Set(['queued', 'running', 'passed', 'failed', 'error', 'cancelled']);
const TERMINAL_STATUSES = new Set(['passed', 'failed', 'error', 'cancelled']);

async function initDB() {
    if (initialized) return;

    // test_runs has a FK to test_suites — make sure the parent table exists
    // first. testSuiteStore is idempotent so loading it here is cheap and
    // avoids ordering issues when a fresh schema is bootstrapped.
    try { await require('./testSuiteStore').initDB(); } catch (_) {}

    await exec(`
        CREATE TABLE IF NOT EXISTS test_runs (
            id TEXT PRIMARY KEY,
            suite_id TEXT REFERENCES test_suites(id) ON DELETE SET NULL,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            target_url TEXT NOT NULL,
            mode TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','passed','failed','error','cancelled')),
            report_json JSONB,
            metadata JSONB,
            error TEXT,
            stdout_tail TEXT DEFAULT '',
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            duration_ms INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_test_runs_suite ON test_runs(suite_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_test_runs_user_status ON test_runs(user_id, status);
    `);
    // Forward-compat: drop the legacy mode CHECK constraint (if present from
    // an older deploy) and ensure the metadata column exists. Both statements
    // are idempotent.
    try {
        await exec(`ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS test_runs_mode_check`);
    } catch (_) {}
    try {
        await exec(`ALTER TABLE test_runs ADD COLUMN IF NOT EXISTS metadata JSONB`);
    } catch (_) {}

    await exec(`
        CREATE TABLE IF NOT EXISTS test_run_artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            storage_key TEXT,
            mime_type TEXT,
            size_bytes BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_test_run_artifacts_run ON test_run_artifacts(run_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS test_run_jobs (
            id TEXT PRIMARY KEY,
            run_id TEXT UNIQUE NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
            claim_token TEXT,
            claimed_by TEXT,
            claimed_at TIMESTAMPTZ,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TIMESTAMPTZ,
            last_error TEXT,
            next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            delivered_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_test_run_jobs_next ON test_run_jobs(next_attempt_at) WHERE delivered_at IS NULL;
    `);

    initialized = true;
    console.log('[TestRunStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[TestRunStore] Init error:', err.message));

// ── SSE channel registry ──────────────────────────────────────────
// One emitter per active run id. Subscribers (route layer) attach on the
// SSE endpoint; the worker calls publishEvent() to push progress chunks.
// We drop the channel on finalization so listeners never leak past the
// run's lifetime.
const _channels = new Map();

function _channel(runId) {
    if (!_channels.has(runId)) _channels.set(runId, new EventEmitter());
    return _channels.get(runId);
}

function subscribe(runId, listener) {
    const ch = _channel(runId);
    ch.on('event', listener);
    return () => ch.off('event', listener);
}

function publishEvent(runId, type, data) {
    const ch = _channels.get(runId);
    if (!ch) return;
    try { ch.emit('event', { type, data, ts: Date.now() }); }
    catch (e) { console.warn('[TestRunStore] publish failed:', e.message); }
}

function _closeChannel(runId) {
    const ch = _channels.get(runId);
    if (!ch) return;
    try { ch.emit('event', { type: 'close', data: null, ts: Date.now() }); } catch (_) {}
    ch.removeAllListeners();
    _channels.delete(runId);
}

// ── Mappers ───────────────────────────────────────────────────────

function parseJSON(v, fallback) {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
}

function mapRunRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        suiteId: r.suite_id || null,
        userId: r.user_id,
        organizationId: r.organization_id || null,
        targetUrl: r.target_url,
        mode: r.mode,
        status: r.status,
        reportJson: parseJSON(r.report_json, null),
        metadata: parseJSON(r.metadata, null),
        error: r.error || null,
        stdoutTail: r.stdout_tail || '',
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

function mapArtifactRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        runId: r.run_id,
        kind: r.kind,
        storageKey: r.storage_key,
        mimeType: r.mime_type,
        sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

// ── Lifecycle ─────────────────────────────────────────────────────

/**
 * Atomically create a run row + matching outbox row in one transaction.
 * Returns the new run id.
 */
async function createRun({ suiteId = null, userId, organizationId = null, targetUrl, mode, metadata = null }) {
    await initDB();
    if (!userId) throw new Error('userId required');
    if (!targetUrl) throw new Error('targetUrl required');
    if (!VALID_MODES.has(mode)) throw new Error(`invalid mode: ${mode}`);

    const runId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO test_runs (id, suite_id, user_id, organization_id, target_url, mode, status, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb)`,
            [runId, suiteId, userId, organizationId, targetUrl, mode, metadata ? JSON.stringify(metadata) : null]
        );
        await client.query(
            `INSERT INTO test_run_jobs (id, run_id, attempt_count, next_attempt_at)
             VALUES ($1, $2, 0, NOW())`,
            [jobId, runId]
        );
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
    return runId;
}

async function getRun(id, userId = null) {
    await initDB();
    if (userId) {
        return mapRunRow(await getOne(`SELECT * FROM test_runs WHERE id = $1 AND user_id = $2`, [id, userId]));
    }
    return mapRunRow(await getOne(`SELECT * FROM test_runs WHERE id = $1`, [id]));
}

async function listRunsForSuite(suiteId, userId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM test_runs WHERE suite_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [suiteId, userId, limit, offset]
    );
    return rows.map(mapRunRow);
}

async function hasActiveRunForUser(userId) {
    await initDB();
    const r = await getOne(
        `SELECT 1 FROM test_runs WHERE user_id = $1 AND status IN ('queued','running') LIMIT 1`,
        [userId]
    );
    return !!r;
}

async function getActiveRunForUser(userId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM test_runs WHERE user_id = $1 AND status IN ('queued','running')
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
    );
    return mapRunRow(r);
}

// All in-flight runs (queued + running) for a user — powers the multi-run
// sidebar so several concurrent runs are visible at once.
async function listActiveRunsForUser(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM test_runs WHERE user_id = $1 AND status IN ('queued','running')
         ORDER BY created_at DESC LIMIT 50`,
        [userId]
    );
    return rows.map(mapRunRow);
}

/**
 * Count active (claimed-and-undelivered, i.e. queued-claimed or running) runs
 * globally and for the given user/org. Used to decide whether a freshly created
 * run will start immediately or sit queued, and to surface counts in the UI.
 */
async function countActiveByScope(userId = null, organizationId = null) {
    await initDB();
    const r = await getOne(
        `SELECT
            COUNT(*)::int AS global_active,
            COUNT(*) FILTER (WHERE r.user_id = $1)::int AS user_active,
            COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND r.organization_id = $2)::int AS org_active
          FROM test_run_jobs j
          JOIN test_runs r ON r.id = j.run_id
         WHERE j.delivered_at IS NULL AND j.claim_token IS NOT NULL`,
        [userId, organizationId]
    );
    return {
        globalActive: r?.global_active || 0,
        userActive: r?.user_active || 0,
        orgActive: r?.org_active || 0,
    };
}

// ── Cancellation ───────────────────────────────────────────────────
// Workers poll `isCancelRequested(runId)` between steps; the route layer
// flips the flag and immediately marks the run cancelled in the DB. Two
// channels (in-process flag + DB status) protect against a worker that
// has crashed and the route layer wanting to free the user's concurrency
// slot anyway.
const _cancelRequests = new Set();

function requestCancel(runId) {
    _cancelRequests.add(runId);
    publishEvent(runId, 'progress', { line: '[cancel] cancel requested' });
}

function isCancelRequested(runId) {
    return _cancelRequests.has(runId);
}

function _clearCancel(runId) {
    _cancelRequests.delete(runId);
}

async function markCancelled(runId, userId) {
    await initDB();
    const cur = await getOne(`SELECT user_id, status, started_at FROM test_runs WHERE id = $1`, [runId]);
    if (!cur) return { ok: false, error: 'not_found' };
    if (userId && cur.user_id !== userId) return { ok: false, error: 'forbidden' };
    if (TERMINAL_STATUSES.has(cur.status)) return { ok: false, error: 'already_terminal', status: cur.status };

    requestCancel(runId);

    const startedAt = cur.started_at ? new Date(cur.started_at).getTime() : Date.now();
    const durationMs = Math.max(0, Date.now() - startedAt);
    await run(
        `UPDATE test_runs
            SET status = 'cancelled',
                finished_at = NOW(),
                duration_ms = $2,
                error = COALESCE(error, 'Cancelled by user')
          WHERE id = $1 AND status NOT IN ('passed','failed','error','cancelled')`,
        [runId, durationMs]
    );
    await run(
        `UPDATE test_run_jobs SET delivered_at = NOW(), last_error = 'cancelled' WHERE run_id = $1`,
        [runId]
    );
    publishEvent(runId, 'done', { status: 'cancelled', reportJson: null, error: 'Cancelled by user', durationMs });
    _closeChannel(runId);
    _clearCancel(runId);
    return { ok: true };
}

// ── Worker-facing claim/finalize API ──────────────────────────────

/**
 * Claim outbox rows whose backoff window has elapsed, respecting concurrency
 * caps. A run is "active" (counts toward caps) while its outbox job is claimed
 * and not yet delivered — i.e. queued-but-claimed or running. Eligible queued
 * candidates are ranked per user/org so a single user can't fill more than
 * their remaining slots in one batch, and the batch is capped at the remaining
 * global slots. Uses FOR UPDATE SKIP LOCKED so concurrent workers never grab
 * the same row.
 *
 * Caps default to effectively unlimited when not supplied (back-compat).
 * Returns the claimed rows joined with their parent run rows.
 */
async function claimDueJobs({ batchSize = 5, perUserCap = 1e9, orgCap = 1e9, globalCap = 1e9, targetRunId = null, workerId = 'inproc' } = {}) {
    await initDB();
    const client = await getClient();
    let claimed = [];
    try {
        await client.query('BEGIN');
        // Lease window: once a claim_token is set we exclude the row for 10 min
        // to prevent a second worker from re-claiming an in-flight run. Crashed
        // workers' claims release when the lease expires; markFinished sets
        // delivered_at and drops the row from eligibility altogether.
        const params = [perUserCap, orgCap, globalCap];
        let targetFilter = '';
        if (targetRunId) {
            params.push(targetRunId);
            targetFilter = ` AND j.run_id = $${params.length}`;
        }
        // $1 perUserCap, $2 orgCap, $3 globalCap, [$4 targetRunId]
        const q = `
            WITH active AS (
                SELECT r.user_id, r.organization_id
                  FROM test_run_jobs j
                  JOIN test_runs r ON r.id = j.run_id
                 WHERE j.delivered_at IS NULL AND j.claim_token IS NOT NULL
            ),
            active_user AS (SELECT user_id, COUNT(*) c FROM active GROUP BY user_id),
            active_org AS (SELECT organization_id, COUNT(*) c FROM active WHERE organization_id IS NOT NULL GROUP BY organization_id),
            active_total AS (SELECT COUNT(*) c FROM active),
            candidates AS (
                SELECT j.id AS job_id, j.run_id, j.attempt_count, j.next_attempt_at,
                       r.suite_id, r.user_id, r.organization_id, r.target_url, r.mode, r.status, r.metadata, r.created_at,
                       COALESCE(au.c, 0) AS user_active,
                       COALESCE(ao.c, 0) AS org_active,
                       ROW_NUMBER() OVER (PARTITION BY r.user_id ORDER BY j.next_attempt_at ASC) AS user_rank,
                       ROW_NUMBER() OVER (PARTITION BY r.organization_id ORDER BY j.next_attempt_at ASC) AS org_rank
                  FROM test_run_jobs j
                  JOIN test_runs r ON r.id = j.run_id
                  LEFT JOIN active_user au ON au.user_id = r.user_id
                  LEFT JOIN active_org ao ON ao.organization_id = r.organization_id
                 WHERE j.delivered_at IS NULL
                   AND r.status = 'queued'
                   AND (j.claimed_at IS NULL OR j.claimed_at < NOW() - INTERVAL '10 minutes')
                   AND (j.last_attempt_at IS NULL
                        OR j.last_attempt_at < NOW() - (POWER(2, LEAST(j.attempt_count, 12)) * INTERVAL '1 second'))
                   ${targetFilter}
            ),
            eligible AS (
                SELECT job_id
                  FROM candidates
                 WHERE user_active + user_rank <= $1::int
                   AND (organization_id IS NULL OR org_active + org_rank <= $2::int)
                 ORDER BY next_attempt_at ASC
                 LIMIT GREATEST(0, $3::int - (SELECT c FROM active_total))::int
            )
            SELECT j.id AS job_id, j.run_id, j.attempt_count,
                   r.suite_id, r.user_id, r.organization_id, r.target_url, r.mode, r.status, r.metadata, r.created_at
              FROM test_run_jobs j
              JOIN test_runs r ON r.id = j.run_id
             WHERE j.id IN (SELECT job_id FROM eligible)
             ORDER BY j.next_attempt_at ASC
             LIMIT ${Math.max(1, batchSize | 0)}
             FOR UPDATE OF j SKIP LOCKED`;
        const result = await client.query(q, params);
        claimed = result.rows;

        if (claimed.length > 0) {
            const token = crypto.randomBytes(8).toString('hex');
            const ids = claimed.map(c => c.job_id);
            await client.query(
                `UPDATE test_run_jobs
                    SET claim_token = $1,
                        claimed_by = $2,
                        claimed_at = NOW()
                  WHERE id = ANY($3::text[])`,
                [token, workerId, ids]
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        console.error('[TestRunStore] claim failed:', e.message);
        return [];
    } finally {
        client.release();
    }
    return claimed;
}

async function markRunning(runId) {
    await initDB();
    const cur = await getOne(`SELECT status FROM test_runs WHERE id = $1`, [runId]);
    if (!cur) return false;
    if (TERMINAL_STATUSES.has(cur.status)) return false;
    if (cur.status === 'running') return true;
    const { rowCount } = await run(
        `UPDATE test_runs SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1 AND status = 'queued'`,
        [runId]
    );
    if (rowCount > 0) publishEvent(runId, 'status', { status: 'running' });
    return rowCount > 0;
}

async function appendProgress(runId, line) {
    await initDB();
    if (!line) return;
    // stdout_tail is capped to ~16 KB so a chatty Playwright run can't blow up
    // the row. The latest tail is what users see — older lines stream via SSE.
    await run(
        `UPDATE test_runs
            SET stdout_tail = RIGHT(COALESCE(stdout_tail,'') || $2, 16384)
          WHERE id = $1`,
        [runId, String(line).slice(0, 4000) + '\n']
    );
    publishEvent(runId, 'progress', { line: String(line).slice(0, 4000) });
}

async function markFinished(runId, { status, reportJson = null, error = null }) {
    await initDB();
    if (!VALID_STATUSES.has(status) || !TERMINAL_STATUSES.has(status)) {
        throw new Error(`invalid terminal status: ${status}`);
    }
    const cur = await getOne(`SELECT started_at, status FROM test_runs WHERE id = $1`, [runId]);
    if (!cur) return false;
    if (TERMINAL_STATUSES.has(cur.status)) return false;
    const startedAt = cur.started_at ? new Date(cur.started_at).getTime() : Date.now();
    const durationMs = Math.max(0, Date.now() - startedAt);
    await run(
        `UPDATE test_runs
            SET status = $2,
                report_json = $3::jsonb,
                error = $4,
                finished_at = NOW(),
                duration_ms = $5
          WHERE id = $1`,
        [runId, status, reportJson ? JSON.stringify(reportJson) : null, error, durationMs]
    );
    await run(
        `UPDATE test_run_jobs SET delivered_at = NOW(), last_error = NULL WHERE run_id = $1`,
        [runId]
    );
    // Bubble status + final report to subscribers, then drop the channel so
    // the next subscriber (a refresh after completion) reads the DB instead.
    publishEvent(runId, 'done', { status, reportJson, error, durationMs });
    _closeChannel(runId);
    return true;
}

async function markRetryable(runId, errorMessage) {
    await initDB();
    await run(
        `UPDATE test_run_jobs
            SET attempt_count = attempt_count + 1,
                last_attempt_at = NOW(),
                last_error = $2
          WHERE run_id = $1`,
        [runId, String(errorMessage || '').slice(0, 500)]
    );
    publishEvent(runId, 'progress', { line: `[retry] ${errorMessage}` });
}

// ── Insights ──────────────────────────────────────────────────────

/**
 * Account-wide overview: suite count, run volume, pass rate, in-flight counts,
 * and a recent-activity feed. Scoped to the user.
 */
async function getInsightsOverview(userId) {
    await initDB();
    const [suiteRow, runStats, recent, active] = await Promise.all([
        getOne(`SELECT COUNT(*)::int AS c FROM test_suites WHERE user_id = $1`, [userId]).catch(() => ({ c: 0 })),
        getOne(
            `SELECT
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int  AS runs_7d,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS runs_30d,
                COUNT(*) FILTER (WHERE status = 'passed' AND created_at > NOW() - INTERVAL '30 days')::int AS passed_30d,
                COUNT(*) FILTER (WHERE status = 'failed' AND created_at > NOW() - INTERVAL '30 days')::int AS failed_30d
              FROM test_runs WHERE user_id = $1`,
            [userId]
        ),
        getAll(
            `SELECT id, suite_id, target_url, mode, status, duration_ms, created_at
               FROM test_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 15`,
            [userId]
        ),
        countActiveByScope(userId),
    ]);

    const passed = runStats?.passed_30d || 0;
    const failed = runStats?.failed_30d || 0;
    const denom = passed + failed;
    return {
        suiteCount: suiteRow?.c || 0,
        runs7d: runStats?.runs_7d || 0,
        runs30d: runStats?.runs_30d || 0,
        passRate30d: denom > 0 ? Math.round((passed / denom) * 100) : null,
        activeCount: active.userActive,
        recent: recent.map(r => ({
            id: r.id,
            suiteId: r.suite_id || null,
            targetUrl: r.target_url,
            mode: r.mode,
            status: r.status,
            durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
            createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        })),
    };
}

/** Per-run pass/fail/duration time series for a suite (oldest first). */
async function getSuiteTrends(suiteId, userId, { limit = 50 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT id, status, duration_ms, report_json, created_at
           FROM test_runs
          WHERE suite_id = $1 AND user_id = $2 AND status IN ('passed','failed','error','cancelled')
          ORDER BY created_at DESC LIMIT $3`,
        [suiteId, userId, limit]
    );
    return rows.reverse().map(r => {
        const report = parseJSON(r.report_json, null);
        const s = report?.summary || {};
        return {
            id: r.id,
            status: r.status,
            durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
            passed: s.passed || 0,
            failed: s.failed || 0,
            warnings: s.warnings || 0,
            createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        };
    });
}

/**
 * Flakiness: aggregate per-test outcomes across a suite's recent runs and rank
 * tests that flip between pass and fail. A test that both passed and failed
 * across runs is flaky; flipRate weights how often it changed outcome.
 */
async function getSuiteFlakiness(suiteId, userId, { limit = 50 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT report_json, created_at
           FROM test_runs
          WHERE suite_id = $1 AND user_id = $2 AND report_json IS NOT NULL
          ORDER BY created_at DESC LIMIT $3`,
        [suiteId, userId, limit]
    );
    // name → ordered list of outcomes (oldest→newest)
    const byName = new Map();
    for (const r of rows.reverse()) {
        const report = parseJSON(r.report_json, null);
        for (const t of (report?.tests || [])) {
            if (!t?.name) continue;
            if (!byName.has(t.name)) byName.set(t.name, []);
            byName.get(t.name).push(t.status === 'passed' ? 'passed' : (t.status === 'failed' ? 'failed' : 'other'));
        }
    }
    const out = [];
    for (const [name, outcomes] of byName) {
        const runs = outcomes.length;
        const passed = outcomes.filter(o => o === 'passed').length;
        const failed = outcomes.filter(o => o === 'failed').length;
        let flips = 0;
        for (let i = 1; i < outcomes.length; i++) {
            if (outcomes[i] !== outcomes[i - 1]) flips++;
        }
        const flaky = passed > 0 && failed > 0;
        out.push({
            name,
            runs,
            passed,
            failed,
            flips,
            flipRate: runs > 1 ? Math.round((flips / (runs - 1)) * 100) : 0,
            flaky,
        });
    }
    // Flaky first, then by flip rate, then by failure share.
    out.sort((a, b) => (Number(b.flaky) - Number(a.flaky)) || (b.flipRate - a.flipRate) || (b.failed - a.failed));
    return out;
}

async function addArtifact(runId, { kind, storageKey, mimeType, sizeBytes }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO test_run_artifacts (id, run_id, kind, storage_key, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, runId, kind, storageKey || null, mimeType || null, sizeBytes != null ? Number(sizeBytes) : null]
    );
    return { id, runId, kind, storageKey, mimeType, sizeBytes };
}

async function listArtifacts(runId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM test_run_artifacts WHERE run_id = $1 ORDER BY created_at ASC`,
        [runId]
    );
    return rows.map(mapArtifactRow);
}

async function getArtifact(artifactId) {
    await initDB();
    return mapArtifactRow(await getOne(`SELECT * FROM test_run_artifacts WHERE id = $1`, [artifactId]));
}

module.exports = {
    initDB,
    createRun,
    getRun,
    listRunsForSuite,
    hasActiveRunForUser,
    getActiveRunForUser,
    listActiveRunsForUser,
    countActiveByScope,
    getInsightsOverview,
    getSuiteTrends,
    getSuiteFlakiness,
    requestCancel,
    isCancelRequested,
    markCancelled,
    claimDueJobs,
    markRunning,
    appendProgress,
    markFinished,
    markRetryable,
    addArtifact,
    listArtifacts,
    getArtifact,
    subscribe,
    publishEvent,
    // for tests
    _internals: { TERMINAL_STATUSES, VALID_STATUSES, VALID_MODES },
};
