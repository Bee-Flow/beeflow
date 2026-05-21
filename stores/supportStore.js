/**
 * Support Store — PostgreSQL-backed customer-support threads + messages.
 *
 * Used by the AI-first customer-support inbox: prospects (anonymous from the
 * marketing site) and logged-in tenants raise threads that the AI auto-responder
 * attempts to resolve, escalating to Bee Flow staff when it can't.
 *
 * Tables:
 *   support_threads  — one row per conversation, with status/assignee/SLA fields
 *   support_messages — append-only message log per thread
 *
 * Uses the shared pg Pool from db.js — same pattern as notificationStore.
 */

const crypto = require('crypto');
const { pool } = require('../db');

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS support_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT,
    requester_user_id TEXT,
    requester_email TEXT NOT NULL,
    requester_name TEXT,
    source TEXT NOT NULL CHECK (source IN ('in_app','marketing')),
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open','ai_responding','awaiting_user','awaiting_agent','resolved','closed')),
    priority TEXT NOT NULL DEFAULT 'normal'
        CHECK (priority IN ('low','normal','high','urgent')),
    assignee_user_id TEXT,
    ai_handled BOOLEAN DEFAULT false,
    ai_escalated_reason TEXT,
    first_response_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ DEFAULT now(),
    requester_ip TEXT,
    requester_ua TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_threads_status_last ON support_threads(status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_threads_org ON support_threads(organization_id);
CREATE INDEX IF NOT EXISTS idx_support_threads_email ON support_threads(requester_email);
CREATE INDEX IF NOT EXISTS idx_support_threads_assignee ON support_threads(assignee_user_id);
CREATE INDEX IF NOT EXISTS idx_support_threads_requester_user ON support_threads(requester_user_id);

-- iteration 2: rol-context. Denormalized so a renamed org or a removed user
-- doesn't erase what the ticket originally said about the requester.
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS requester_org_role TEXT;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS requester_org_name TEXT;

-- iteration 3: per-message email delivery status. JSONB shape:
--   { ok: true, at: '2026-…' } on success,
--   { ok: false, error: 'SMTP …', at: '2026-…' } on failure.
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS email_send_status JSONB;

-- iteration 3: append-only audit log of who-did-what on a thread.
CREATE TABLE IF NOT EXISTS support_thread_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
    actor_user_id TEXT,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('staff','system','requester')),
    action TEXT NOT NULL,
    payload JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_thread_events_thread ON support_thread_events(thread_id, created_at);

CREATE TABLE IF NOT EXISTS support_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES support_threads(id) ON DELETE CASCADE,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('requester','ai','staff','system')),
    author_user_id TEXT,
    author_display TEXT,
    body TEXT NOT NULL,
    body_html TEXT,
    internal_note BOOLEAN DEFAULT false,
    kb_citations JSONB DEFAULT '[]'::jsonb,
    ai_confidence NUMERIC(3,2),
    ai_model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_thread ON support_messages(thread_id, created_at);
`;

let initialized = false;

async function initDB() {
    if (initialized) return;
    try {
        await pool.query(INIT_SQL);
        initialized = true;
        console.log('[SupportStore] PostgreSQL initialized');
    } catch (err) {
        console.error('[SupportStore] Init error:', err.message);
        throw err;
    }
}

initDB().catch(err => console.error('[SupportStore] Failed to init:', err.message));

// ── HMAC token for anonymous requesters ───────────────────────────────────
// Anonymous threads (created via marketing form) are addressable by URL using
// a short-lived HMAC of (threadId + requesterEmail) so the requester can come
// back and read the AI reply without an account.

function _secret() {
    const s = process.env.SESSION_SECRET;
    if (!s || s.length < 32) {
        throw new Error('[SupportStore] SESSION_SECRET must be set (≥32 chars) for support thread tokens.');
    }
    return s;
}

function buildAccessToken(threadId, email) {
    const h = crypto.createHmac('sha256', _secret());
    h.update(`${threadId}:${(email || '').toLowerCase()}`);
    return h.digest('hex').slice(0, 32);
}

function verifyAccessToken(threadId, email, token) {
    if (!token || typeof token !== 'string') return false;
    const expected = buildAccessToken(threadId, email);
    // Constant-time compare. Pad/truncate user-supplied token to the expected
    // length so timingSafeEqual sees buffers of equal size regardless of input
    // — removes the tiny early-return signal when lengths differ.
    const expectedBuf = Buffer.from(expected, 'utf8');
    const candidateBuf = Buffer.alloc(expectedBuf.length, 0);
    Buffer.from(token, 'utf8').copy(candidateBuf, 0, 0, expectedBuf.length);
    const eq = crypto.timingSafeEqual(candidateBuf, expectedBuf);
    // Still require exact length to match — the constant-time work above
    // happens regardless, so this length check is no longer an information leak.
    return eq && token.length === expected.length;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

async function createThread({
    organizationId = null,
    requesterUserId = null,
    requesterEmail,
    requesterName = null,
    requesterOrgRole = null,
    requesterOrgName = null,
    source,
    subject,
    priority = 'normal',
    requesterIp = null,
    requesterUa = null,
}) {
    await initDB();
    if (!requesterEmail) throw new Error('requesterEmail is required');
    if (!subject) throw new Error('subject is required');
    if (!['in_app', 'marketing'].includes(source)) throw new Error('invalid source');

    const { rows } = await pool.query(
        `INSERT INTO support_threads
            (organization_id, requester_user_id, requester_email, requester_name,
             requester_org_role, requester_org_name,
             source, subject, priority, requester_ip, requester_ua, status, last_message_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',now())
         RETURNING *`,
        [organizationId, requesterUserId, requesterEmail, requesterName,
            requesterOrgRole, requesterOrgName,
            source, subject, priority, requesterIp, requesterUa]
    );
    const row = rows[0];
    console.log(`[SupportStore] Thread created ${row.id} (${source}) for ${requesterEmail}`);
    return row;
}

async function getThread(id) {
    await initDB();
    const { rows } = await pool.query(`SELECT * FROM support_threads WHERE id = $1`, [id]);
    return rows[0] || null;
}

async function listThreads({
    status = null,
    statusIn = null,
    organizationId = null,
    requesterUserId = null,
    assigneeUserId = null,
    requesterEmail = null,
    q = null,
    limit = 100,
    offset = 0,
} = {}) {
    await initDB();
    const where = [];
    const params = [];
    if (status) { params.push(status); where.push(`status = $${params.length}`); }
    if (statusIn && statusIn.length) {
        params.push(statusIn);
        where.push(`status = ANY($${params.length}::text[])`);
    }
    if (organizationId) { params.push(organizationId); where.push(`organization_id = $${params.length}`); }
    if (requesterUserId) { params.push(requesterUserId); where.push(`requester_user_id = $${params.length}`); }
    if (assigneeUserId) { params.push(assigneeUserId); where.push(`assignee_user_id = $${params.length}`); }
    if (requesterEmail) { params.push(requesterEmail.toLowerCase()); where.push(`LOWER(requester_email) = $${params.length}`); }
    if (q) {
        params.push(`%${q}%`);
        where.push(`(subject ILIKE $${params.length} OR requester_email ILIKE $${params.length} OR requester_name ILIKE $${params.length})`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500));
    params.push(Math.max(parseInt(offset, 10) || 0, 0));
    const { rows } = await pool.query(
        `SELECT * FROM support_threads ${whereClause}
         ORDER BY last_message_at DESC NULLS LAST
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );
    return rows;
}

async function updateThread(id, patch = {}) {
    await initDB();
    const allowed = [
        'status', 'priority', 'assignee_user_id', 'ai_handled', 'ai_escalated_reason',
        'first_response_at', 'resolved_at', 'last_message_at', 'subject',
    ];
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(patch)) {
        if (!allowed.includes(k)) continue;
        params.push(v);
        sets.push(`${k} = $${params.length}`);
    }
    if (!sets.length) return getThread(id);
    sets.push(`updated_at = now()`);
    params.push(id);
    const { rows } = await pool.query(
        `UPDATE support_threads SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params
    );
    return rows[0] || null;
}

async function appendMessage({
    threadId,
    authorKind,
    authorUserId = null,
    authorDisplay = null,
    body,
    bodyHtml = null,
    internalNote = false,
    kbCitations = [],
    aiConfidence = null,
    aiModel = null,
}) {
    await initDB();
    if (!['requester', 'ai', 'staff', 'system'].includes(authorKind)) {
        throw new Error('invalid authorKind');
    }
    if (!body || !body.trim()) throw new Error('body required');

    const { rows } = await pool.query(
        `INSERT INTO support_messages
            (thread_id, author_kind, author_user_id, author_display,
             body, body_html, internal_note, kb_citations, ai_confidence, ai_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
         RETURNING *`,
        [threadId, authorKind, authorUserId, authorDisplay,
            body, bodyHtml, internalNote, JSON.stringify(kbCitations || []), aiConfidence, aiModel]
    );
    // Only non-internal messages bump last_message_at (internal notes are
    // staff-only and shouldn't move the SLA clock from the requester's POV).
    if (!internalNote) {
        await pool.query(
            `UPDATE support_threads SET last_message_at = now(), updated_at = now() WHERE id = $1`,
            [threadId]
        );
    }
    return rows[0];
}

async function getThreadMessages(threadId, { includeInternal = false } = {}) {
    await initDB();
    const where = includeInternal
        ? `thread_id = $1`
        : `thread_id = $1 AND internal_note = false`;
    const { rows } = await pool.query(
        `SELECT * FROM support_messages WHERE ${where} ORDER BY created_at ASC`,
        [threadId]
    );
    return rows;
}

async function countThreadsByStatus({ organizationId = null } = {}) {
    await initDB();
    const params = [];
    let where = '';
    if (organizationId) { params.push(organizationId); where = `WHERE organization_id = $1`; }
    const { rows } = await pool.query(
        `SELECT status, COUNT(*)::int AS count FROM support_threads ${where} GROUP BY status`,
        params
    );
    const out = {};
    for (const r of rows) out[r.status] = r.count;
    return out;
}

/**
 * Atomically transition a thread to "first staff reply" state. Sets
 * `first_response_at` only if it was NULL, picks the calling staff as
 * assignee if none assigned yet, and flips status → `awaiting_user`.
 *
 * Race-safe: if two staff replies arrive concurrently, the database guarantees
 * exactly one timestamp/assignee wins. Returns the updated row.
 */
async function firstStaffReplyTransition(threadId, staffUserId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET first_response_at = COALESCE(first_response_at, now()),
                assignee_user_id = COALESCE(assignee_user_id, $2),
                status = 'awaiting_user',
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [threadId, staffUserId || null]
    );
    return rows[0] || null;
}

/**
 * Annotate a single message with email delivery outcome.
 */
async function setMessageEmailStatus(messageId, status) {
    await initDB();
    await pool.query(
        `UPDATE support_messages SET email_send_status = $1::jsonb WHERE id = $2`,
        [JSON.stringify(status || {}), messageId]
    );
}

/**
 * Append an audit-log event for a thread. Append-only, used by route handlers
 * and the AI responder. Failures here must never break the caller — wrap.
 */
async function recordThreadEvent({ threadId, actorUserId = null, actorKind, action, payload = {} }) {
    await initDB();
    if (!threadId || !actorKind || !action) return null;
    if (!['staff', 'system', 'requester'].includes(actorKind)) {
        throw new Error('invalid actorKind');
    }
    const { rows } = await pool.query(
        `INSERT INTO support_thread_events (thread_id, actor_user_id, actor_kind, action, payload)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING *`,
        [threadId, actorUserId, actorKind, action, JSON.stringify(payload || {})]
    );
    return rows[0];
}

async function listThreadEvents(threadId, { limit = 200 } = {}) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_thread_events WHERE thread_id = $1 ORDER BY created_at ASC LIMIT $2`,
        [threadId, Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000)]
    );
    return rows;
}

async function findSlaAtRiskThreads({ olderThanMinutes = 60 } = {}) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_threads
         WHERE status = 'awaiting_agent'
           AND first_response_at IS NULL
           AND created_at < now() - ($1::int * interval '1 minute')
         ORDER BY created_at ASC
         LIMIT 50`,
        [olderThanMinutes]
    );
    return rows;
}

module.exports = {
    initDB,
    createThread,
    getThread,
    listThreads,
    updateThread,
    appendMessage,
    getThreadMessages,
    countThreadsByStatus,
    findSlaAtRiskThreads,
    buildAccessToken,
    verifyAccessToken,
    firstStaffReplyTransition,
    setMessageEmailStatus,
    recordThreadEvent,
    listThreadEvents,
};
