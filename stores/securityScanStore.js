/**
 * Security Scan Store — security scan lifecycle + durable outbox.
 *
 * Three tables:
 *   • security_scans           — one row per scan (one or more engines)
 *   • security_scan_artifacts  — raw engine reports / blobs
 *   • security_scan_jobs       — outbox the worker drains (claim_token, attempts, backoff)
 *
 * Pattern mirrors stores/testRunStore.js: createScan() writes the scan row +
 * outbox row in one transaction so a process crash between them is impossible.
 * The worker uses SELECT ... FOR UPDATE SKIP LOCKED to claim rows safely under
 * concurrent drains.
 *
 * SSE: each scan id gets an in-process EventEmitter channel; the route layer
 * subscribes to push live progress events to the browser. Channels are
 * removed automatically when finalized so listeners cannot leak.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { run, getOne, getAll, exec, getClient } = require('../db');

let initialized = false;

const VALID_STATUSES = new Set(['queued', 'running', 'completed', 'error', 'cancelled']);
const TERMINAL_STATUSES = new Set(['completed', 'error', 'cancelled']);

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS security_scans (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            target_url TEXT NOT NULL,
            engines JSONB,
            mode TEXT NOT NULL DEFAULT 'quick',
            status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','error','cancelled')),
            report_json JSONB,
            report_webpage_id TEXT,
            severity_summary JSONB,
            authorized BOOLEAN NOT NULL DEFAULT FALSE,
            metadata JSONB,
            error TEXT,
            stdout_tail TEXT DEFAULT '',
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            duration_ms INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_security_scans_user_status ON security_scans(user_id, status);
        CREATE INDEX IF NOT EXISTS idx_security_scans_created ON security_scans(created_at DESC);
    `);
    // Forward-compat: ensure newer columns exist on older deploys. All
    // statements are idempotent.
    try {
        await exec(`ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS metadata JSONB`);
    } catch (_) {}
    try {
        await exec(`ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS report_webpage_id TEXT`);
    } catch (_) {}
    try {
        await exec(`ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS severity_summary JSONB`);
    } catch (_) {}
    try {
        await exec(`ALTER TABLE security_scans ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'quick'`);
    } catch (_) {}

    await exec(`
        CREATE TABLE IF NOT EXISTS security_scan_artifacts (
            id TEXT PRIMARY KEY,
            scan_id TEXT NOT NULL REFERENCES security_scans(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            storage_key TEXT,
            mime_type TEXT,
            size_bytes BIGINT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_security_scan_artifacts_scan ON security_scan_artifacts(scan_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS security_scan_jobs (
            id TEXT PRIMARY KEY,
            scan_id TEXT UNIQUE NOT NULL REFERENCES security_scans(id) ON DELETE CASCADE,
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
        CREATE INDEX IF NOT EXISTS idx_security_scan_jobs_next ON security_scan_jobs(next_attempt_at) WHERE delivered_at IS NULL;
    `);

    initialized = true;
    console.log('[SecurityScanStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[SecurityScanStore] Init error:', err.message));

// ── SSE channel registry ──────────────────────────────────────────
// One emitter per active scan id. Subscribers (route layer) attach on the
// SSE endpoint; the worker calls publishEvent() to push progress chunks.
// We drop the channel on finalization so listeners never leak past the
// scan's lifetime.
const _channels = new Map();

function _channel(scanId) {
    if (!_channels.has(scanId)) _channels.set(scanId, new EventEmitter());
    return _channels.get(scanId);
}

function subscribe(scanId, listener) {
    const ch = _channel(scanId);
    ch.on('event', listener);
    return () => ch.off('event', listener);
}

function publishEvent(scanId, type, data) {
    const ch = _channels.get(scanId);
    if (!ch) return;
    try { ch.emit('event', { type, data, ts: Date.now() }); }
    catch (e) { console.warn('[SecurityScanStore] publish failed:', e.message); }
}

function _closeChannel(scanId) {
    const ch = _channels.get(scanId);
    if (!ch) return;
    try { ch.emit('event', { type: 'close', data: null, ts: Date.now() }); } catch (_) {}
    ch.removeAllListeners();
    _channels.delete(scanId);
}

// ── Mappers ───────────────────────────────────────────────────────

function parseJSON(v, fallback) {
    if (v === null || v === undefined) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
}

function mapScanRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id || null,
        targetUrl: r.target_url,
        engines: parseJSON(r.engines, []),
        mode: r.mode || 'quick',
        status: r.status,
        reportJson: parseJSON(r.report_json, null),
        reportWebpageId: r.report_webpage_id || null,
        severitySummary: parseJSON(r.severity_summary, null),
        authorized: !!r.authorized,
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
        scanId: r.scan_id,
        kind: r.kind,
        storageKey: r.storage_key,
        mimeType: r.mime_type,
        sizeBytes: r.size_bytes != null ? Number(r.size_bytes) : null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

// ── Lifecycle ─────────────────────────────────────────────────────

/**
 * Atomically create a scan row + matching outbox row in one transaction.
 * Returns the new scan id.
 */
async function createScan({ userId, organizationId = null, targetUrl, engines, authorized = false, metadata = null, mode = 'quick' }) {
    await initDB();
    if (!userId) throw new Error('userId required');
    if (!targetUrl) throw new Error('targetUrl required');
    if (!Array.isArray(engines) || engines.length === 0) throw new Error('engines required');

    const scanId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const client = await getClient();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO security_scans (id, user_id, organization_id, target_url, engines, mode, status, authorized, metadata)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'queued', $7, $8::jsonb)`,
            [scanId, userId, organizationId, targetUrl, JSON.stringify(engines), mode === 'agent' ? 'agent' : 'quick', !!authorized, metadata ? JSON.stringify(metadata) : null]
        );
        await client.query(
            `INSERT INTO security_scan_jobs (id, scan_id, attempt_count, next_attempt_at)
             VALUES ($1, $2, 0, NOW())`,
            [jobId, scanId]
        );
        await client.query('COMMIT');
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        client.release();
    }
    return scanId;
}

async function getScan(scanId, userId = null) {
    await initDB();
    if (userId) {
        return mapScanRow(await getOne(`SELECT * FROM security_scans WHERE id = $1 AND user_id = $2`, [scanId, userId]));
    }
    return mapScanRow(await getOne(`SELECT * FROM security_scans WHERE id = $1`, [scanId]));
}

// All in-flight scans (queued + running) for a user — powers the multi-scan
// sidebar so several concurrent scans are visible at once.
async function listActiveScansForUser(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM security_scans WHERE user_id = $1 AND status IN ('queued','running')
         ORDER BY created_at DESC LIMIT 50`,
        [userId]
    );
    return rows.map(mapScanRow);
}

/**
 * Count active (claimed-and-undelivered, i.e. queued-claimed or running) scans
 * globally and for the given user/org. Used to decide whether a freshly created
 * scan will start immediately or sit queued, and to surface counts in the UI.
 */
async function countActiveByScope({ userId = null, organizationId = null } = {}) {
    await initDB();
    const r = await getOne(
        `SELECT
            COUNT(*)::int AS global_active,
            COUNT(*) FILTER (WHERE s.user_id = $1)::int AS user_active,
            COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND s.organization_id = $2)::int AS org_active
          FROM security_scan_jobs j
          JOIN security_scans s ON s.id = j.scan_id
         WHERE j.delivered_at IS NULL AND j.claim_token IS NOT NULL`,
        [userId, organizationId]
    );
    return {
        global: r?.global_active || 0,
        user: r?.user_active || 0,
        org: r?.org_active || 0,
    };
}

// ── Cancellation ───────────────────────────────────────────────────
// Workers poll `isCancelRequested(scanId)` between steps; the route layer
// flips the flag and immediately marks the scan cancelled in the DB. Two
// channels (in-process flag + DB status) protect against a worker that
// has crashed and the route layer wanting to free the user's concurrency
// slot anyway.
const _cancelRequests = new Set();

function requestCancel(scanId) {
    _cancelRequests.add(scanId);
    publishEvent(scanId, 'progress', { line: '[cancel] cancel requested' });
}

function isCancelRequested(scanId) {
    return _cancelRequests.has(scanId);
}

function _clearCancel(scanId) {
    _cancelRequests.delete(scanId);
}

async function markCancelled(scanId, userId) {
    await initDB();
    const cur = await getOne(`SELECT user_id, status, started_at FROM security_scans WHERE id = $1`, [scanId]);
    if (!cur) return { ok: false, error: 'not_found' };
    if (userId && cur.user_id !== userId) return { ok: false, error: 'forbidden' };
    if (TERMINAL_STATUSES.has(cur.status)) return { ok: false, error: 'already_terminal', status: cur.status };

    requestCancel(scanId);

    const startedAt = cur.started_at ? new Date(cur.started_at).getTime() : Date.now();
    const durationMs = Math.max(0, Date.now() - startedAt);
    await run(
        `UPDATE security_scans
            SET status = 'cancelled',
                finished_at = NOW(),
                duration_ms = $2,
                error = COALESCE(error, 'Cancelled by user')
          WHERE id = $1 AND status NOT IN ('completed','error','cancelled')`,
        [scanId, durationMs]
    );
    await run(
        `UPDATE security_scan_jobs SET delivered_at = NOW(), last_error = 'cancelled' WHERE scan_id = $1`,
        [scanId]
    );
    publishEvent(scanId, 'done', { status: 'cancelled', reportJson: null, error: 'Cancelled by user', durationMs });
    _closeChannel(scanId);
    _clearCancel(scanId);
    return { ok: true };
}

// ── Worker-facing claim/finalize API ──────────────────────────────

/**
 * Claim outbox rows whose backoff window has elapsed, respecting concurrency
 * caps. A scan is "active" (counts toward caps) while its outbox job is claimed
 * and not yet delivered — i.e. queued-but-claimed or running. Eligible queued
 * candidates are ranked per user/org so a single user can't fill more than
 * their remaining slots in one batch, and the batch is capped at the remaining
 * global slots. Uses FOR UPDATE SKIP LOCKED so concurrent workers never grab
 * the same row.
 *
 * Caps default to effectively unlimited when not supplied (back-compat).
 * Returns the claimed rows joined with their parent scan rows.
 */
async function claimDueJobs({ batchSize = 5, perUserCap = 1e9, orgCap = 1e9, globalCap = 1e9, targetScanId = null, workerId = 'inproc' } = {}) {
    await initDB();
    const client = await getClient();
    let claimed = [];
    try {
        await client.query('BEGIN');
        // Lease window: once a claim_token is set we exclude the row for 10 min
        // to prevent a second worker from re-claiming an in-flight scan. Crashed
        // workers' claims release when the lease expires; markFinished sets
        // delivered_at and drops the row from eligibility altogether.
        const params = [perUserCap, orgCap, globalCap];
        let targetFilter = '';
        if (targetScanId) {
            params.push(targetScanId);
            targetFilter = ` AND j.scan_id = $${params.length}`;
        }
        // $1 perUserCap, $2 orgCap, $3 globalCap, [$4 targetScanId]
        const q = `
            WITH active AS (
                SELECT s.user_id, s.organization_id
                  FROM security_scan_jobs j
                  JOIN security_scans s ON s.id = j.scan_id
                 WHERE j.delivered_at IS NULL AND j.claim_token IS NOT NULL
            ),
            active_user AS (SELECT user_id, COUNT(*) c FROM active GROUP BY user_id),
            active_org AS (SELECT organization_id, COUNT(*) c FROM active WHERE organization_id IS NOT NULL GROUP BY organization_id),
            active_total AS (SELECT COUNT(*) c FROM active),
            candidates AS (
                SELECT j.id AS job_id, j.scan_id, j.attempt_count, j.next_attempt_at,
                       s.user_id, s.organization_id, s.target_url, s.engines, s.mode, s.status, s.authorized, s.metadata, s.created_at,
                       COALESCE(au.c, 0) AS user_active,
                       COALESCE(ao.c, 0) AS org_active,
                       ROW_NUMBER() OVER (PARTITION BY s.user_id ORDER BY j.next_attempt_at ASC) AS user_rank,
                       ROW_NUMBER() OVER (PARTITION BY s.organization_id ORDER BY j.next_attempt_at ASC) AS org_rank
                  FROM security_scan_jobs j
                  JOIN security_scans s ON s.id = j.scan_id
                  LEFT JOIN active_user au ON au.user_id = s.user_id
                  LEFT JOIN active_org ao ON ao.organization_id = s.organization_id
                 WHERE j.delivered_at IS NULL
                   AND s.status = 'queued'
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
            SELECT j.id AS job_id, j.scan_id, j.attempt_count,
                   s.user_id, s.organization_id, s.target_url, s.engines, s.mode, s.status, s.authorized, s.metadata, s.created_at
              FROM security_scan_jobs j
              JOIN security_scans s ON s.id = j.scan_id
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
                `UPDATE security_scan_jobs
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
        console.error('[SecurityScanStore] claim failed:', e.message);
        return [];
    } finally {
        client.release();
    }
    return claimed;
}

async function markRunning(scanId) {
    await initDB();
    const cur = await getOne(`SELECT status FROM security_scans WHERE id = $1`, [scanId]);
    if (!cur) return false;
    if (TERMINAL_STATUSES.has(cur.status)) return false;
    if (cur.status === 'running') return true;
    const { rowCount } = await run(
        `UPDATE security_scans SET status = 'running', started_at = COALESCE(started_at, NOW()) WHERE id = $1 AND status = 'queued'`,
        [scanId]
    );
    if (rowCount > 0) publishEvent(scanId, 'status', { status: 'running' });
    return rowCount > 0;
}

async function appendProgress(scanId, line) {
    await initDB();
    if (!line) return;
    // stdout_tail is capped to ~16 KB so a chatty scanner run can't blow up
    // the row. The latest tail is what users see — older lines stream via SSE.
    await run(
        `UPDATE security_scans
            SET stdout_tail = RIGHT(COALESCE(stdout_tail,'') || $2, 16384)
          WHERE id = $1`,
        [scanId, String(line).slice(0, 4000) + '\n']
    );
    publishEvent(scanId, 'progress', { line: String(line).slice(0, 4000) });
}

async function markFinished(scanId, { status, reportJson = null, reportWebpageId = null, severitySummary = null, error = null }) {
    await initDB();
    if (!VALID_STATUSES.has(status) || !TERMINAL_STATUSES.has(status)) {
        throw new Error(`invalid terminal status: ${status}`);
    }
    const cur = await getOne(`SELECT started_at, status FROM security_scans WHERE id = $1`, [scanId]);
    if (!cur) return false;
    if (TERMINAL_STATUSES.has(cur.status)) return false;
    const startedAt = cur.started_at ? new Date(cur.started_at).getTime() : Date.now();
    const durationMs = Math.max(0, Date.now() - startedAt);
    await run(
        `UPDATE security_scans
            SET status = $2,
                report_json = $3::jsonb,
                report_webpage_id = $4,
                severity_summary = $5::jsonb,
                error = $6,
                finished_at = NOW(),
                duration_ms = $7
          WHERE id = $1`,
        [scanId, status, reportJson ? JSON.stringify(reportJson) : null, reportWebpageId,
         severitySummary ? JSON.stringify(severitySummary) : null, error, durationMs]
    );
    await run(
        `UPDATE security_scan_jobs SET delivered_at = NOW(), last_error = NULL WHERE scan_id = $1`,
        [scanId]
    );
    // Bubble status + final report to subscribers, then drop the channel so
    // the next subscriber (a refresh after completion) reads the DB instead.
    publishEvent(scanId, 'done', { status, reportJson, reportWebpageId, severitySummary, error, durationMs });
    _closeChannel(scanId);
    return true;
}

async function markRetryable(scanId, errorMessage) {
    await initDB();
    await run(
        `UPDATE security_scan_jobs
            SET attempt_count = attempt_count + 1,
                last_attempt_at = NOW(),
                last_error = $2
          WHERE scan_id = $1`,
        [scanId, String(errorMessage || '').slice(0, 500)]
    );
    publishEvent(scanId, 'progress', { line: `[retry] ${errorMessage}` });
}

// ── Artifacts ─────────────────────────────────────────────────────

async function addArtifact({ scanId, kind, storageKey, mimeType, sizeBytes }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO security_scan_artifacts (id, scan_id, kind, storage_key, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, scanId, kind, storageKey || null, mimeType || null, sizeBytes != null ? Number(sizeBytes) : null]
    );
    return { id, scanId, kind, storageKey, mimeType, sizeBytes };
}

async function listArtifacts(scanId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM security_scan_artifacts WHERE scan_id = $1 ORDER BY created_at ASC`,
        [scanId]
    );
    return rows.map(mapArtifactRow);
}

async function getArtifact(scanId, artifactId) {
    await initDB();
    return mapArtifactRow(await getOne(
        `SELECT * FROM security_scan_artifacts WHERE id = $1 AND scan_id = $2`,
        [artifactId, scanId]
    ));
}

module.exports = {
    initDB,
    createScan,
    getScan,
    listActiveScansForUser,
    countActiveByScope,
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
    _internals: { TERMINAL_STATUSES, VALID_STATUSES },
};
