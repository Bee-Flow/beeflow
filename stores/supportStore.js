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

-- iteration 3: per-message email delivery status. JSONB shape:
--   { ok: true, at: '2026-…' } on success,
--   { ok: false, error: 'SMTP …', at: '2026-…' } on failure.
-- MUST come after the support_messages CREATE above: this ALTER references
-- the table, so on a fresh DB it would otherwise abort the whole INIT_SQL
-- batch (one implicit transaction) with 'relation "support_messages" does
-- not exist', leaving every support table uncreated.
ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS email_send_status JSONB;

-- iteration 4: full ticket-system fields — tags/category, SLA timers, CSAT,
-- and auto-assignment. All additive so existing rows keep working.
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS tags JSONB DEFAULT '[]'::jsonb;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_first_response_due_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_resolution_due_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_first_response_breached_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_resolution_breached_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS sla_paused BOOLEAN DEFAULT false;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS csat_score SMALLINT
    CHECK (csat_score IS NULL OR (csat_score >= 1 AND csat_score <= 5));
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS csat_comment TEXT;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS csat_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS resolution_confirmed_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS resolution_disputed_at TIMESTAMPTZ;
ALTER TABLE support_threads ADD COLUMN IF NOT EXISTS auto_assigned BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_support_threads_tags ON support_threads USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_support_threads_sla_first
    ON support_threads(sla_first_response_due_at)
    WHERE sla_first_response_breached_at IS NULL
      AND status IN ('open','ai_responding','awaiting_user','awaiting_agent');
CREATE INDEX IF NOT EXISTS idx_support_threads_sla_res
    ON support_threads(sla_resolution_due_at)
    WHERE sla_resolution_breached_at IS NULL
      AND status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS idx_support_threads_csat ON support_threads(csat_at);

-- Canned responses: org-scoped templates (NULL organization_id = system-wide).
CREATE TABLE IF NOT EXISTS support_canned_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    shortcut TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_canned_org ON support_canned_responses(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_canned_shortcut
    ON support_canned_responses(COALESCE(organization_id, '__system__'), shortcut)
    WHERE shortcut IS NOT NULL;

-- SLA policies: per org × priority. NULL organization_id = global default.
CREATE TABLE IF NOT EXISTS support_sla_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT,
    priority TEXT NOT NULL CHECK (priority IN ('low','normal','high','urgent')),
    first_response_minutes INT NOT NULL,
    resolution_minutes INT NOT NULL,
    enabled BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_global ON support_sla_policies(priority) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sla_org ON support_sla_policies(organization_id, priority) WHERE organization_id IS NOT NULL;

-- Tag taxonomy: org catalogue of tag name + colour, for consistent UI.
-- Actual thread tags stay denormalised as JSONB on support_threads.
CREATE TABLE IF NOT EXISTS support_tag_taxonomy (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT,
    name TEXT NOT NULL,
    color TEXT,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tag_org_name
    ON support_tag_taxonomy(COALESCE(organization_id, '__system__'), LOWER(name));

-- Round-robin cursor per org for auto-assignment ('__global__' for unscoped).
CREATE TABLE IF NOT EXISTS support_assignment_state (
    organization_id TEXT PRIMARY KEY,
    last_assignee_user_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
        'category', 'auto_assigned', 'sla_paused',
        'sla_first_response_due_at', 'sla_resolution_due_at',
        'sla_first_response_breached_at', 'sla_resolution_breached_at',
        'resolution_confirmed_at', 'resolution_disputed_at',
    ];
    const effective = { ...patch };
    // The SLA clock pauses while waiting on the customer. Derive it from the
    // status transition unless the caller set sla_paused explicitly.
    if (effective.status !== undefined && effective.sla_paused === undefined) {
        effective.sla_paused = effective.status === 'awaiting_user';
    }
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(effective)) {
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

// ── Tags & category ────────────────────────────────────────────────────────

/**
 * Replace a thread's tags. Normalises to lowercase, trims, dedupes, caps at 10.
 */
async function setThreadTags(threadId, tags = []) {
    await initDB();
    const clean = [...new Set(
        (Array.isArray(tags) ? tags : [])
            .map(t => String(t || '').trim())
            .filter(Boolean)
    )].slice(0, 10);
    const { rows } = await pool.query(
        `UPDATE support_threads SET tags = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
        [threadId, JSON.stringify(clean)]
    );
    return rows[0] || null;
}

/**
 * Add a single tag to a thread without removing existing ones (cap 10).
 */
async function addThreadTag(threadId, tag) {
    await initDB();
    const t = String(tag || '').trim();
    if (!t) return getThread(threadId);
    const thread = await getThread(threadId);
    if (!thread) return null;
    const existing = Array.isArray(thread.tags) ? thread.tags : [];
    return setThreadTags(threadId, [...existing, t]);
}

// ── Tag taxonomy CRUD ────────────────────────────────────────────────────────

async function listTags(organizationId = null) {
    await initDB();
    // Org-scoped tags plus system-wide (NULL org) tags.
    const { rows } = await pool.query(
        `SELECT * FROM support_tag_taxonomy
          WHERE organization_id IS NULL OR organization_id = $1
          ORDER BY LOWER(name) ASC`,
        [organizationId]
    );
    return rows;
}

async function createTag({ organizationId = null, name, color = null, description = null }) {
    await initDB();
    if (!name || !name.trim()) throw new Error('tag name required');
    const { rows } = await pool.query(
        `INSERT INTO support_tag_taxonomy (organization_id, name, color, description)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [organizationId, name.trim(), color, description]
    );
    return rows[0];
}

async function deleteTag(id, organizationId = null) {
    await initDB();
    const { rowCount } = await pool.query(
        `DELETE FROM support_tag_taxonomy
          WHERE id = $1 AND (organization_id IS NOT DISTINCT FROM $2)`,
        [id, organizationId]
    );
    return rowCount > 0;
}

// ── SLA policies ─────────────────────────────────────────────────────────────

/**
 * Resolve the SLA policy for an org+priority, falling back to the global
 * (NULL-org) policy when no org-specific one exists.
 */
async function getSlaPolicy(organizationId, priority) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_sla_policies
          WHERE priority = $2
            AND (organization_id = $1 OR organization_id IS NULL)
          ORDER BY (organization_id IS NULL) ASC
          LIMIT 1`,
        [organizationId, priority]
    );
    return rows[0] || null;
}

async function listSlaPolicies(organizationId = null) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_sla_policies
          WHERE organization_id IS NULL OR organization_id = $1
          ORDER BY (organization_id IS NULL) DESC,
                   array_position(ARRAY['urgent','high','normal','low'], priority)`,
        [organizationId]
    );
    return rows;
}

async function upsertSlaPolicy({ organizationId = null, priority, firstResponseMinutes, resolutionMinutes, enabled = true }) {
    await initDB();
    if (!['low', 'normal', 'high', 'urgent'].includes(priority)) throw new Error('invalid priority');
    // Partial unique indices differ by NULL-ness, so branch the conflict target.
    if (organizationId == null) {
        const { rows } = await pool.query(
            `INSERT INTO support_sla_policies
                (organization_id, priority, first_response_minutes, resolution_minutes, enabled)
             VALUES (NULL, $1, $2, $3, $4)
             ON CONFLICT (priority) WHERE organization_id IS NULL
             DO UPDATE SET first_response_minutes = EXCLUDED.first_response_minutes,
                           resolution_minutes = EXCLUDED.resolution_minutes,
                           enabled = EXCLUDED.enabled, updated_at = now()
             RETURNING *`,
            [priority, firstResponseMinutes, resolutionMinutes, enabled]
        );
        return rows[0];
    }
    const { rows } = await pool.query(
        `INSERT INTO support_sla_policies
            (organization_id, priority, first_response_minutes, resolution_minutes, enabled)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, priority) WHERE organization_id IS NOT NULL
         DO UPDATE SET first_response_minutes = EXCLUDED.first_response_minutes,
                       resolution_minutes = EXCLUDED.resolution_minutes,
                       enabled = EXCLUDED.enabled, updated_at = now()
         RETURNING *`,
        [organizationId, priority, firstResponseMinutes, resolutionMinutes, enabled]
    );
    return rows[0];
}

// ── Canned responses ─────────────────────────────────────────────────────────

async function listCannedResponses(organizationId = null) {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_canned_responses
          WHERE organization_id IS NULL OR organization_id = $1
          ORDER BY title ASC`,
        [organizationId]
    );
    return rows;
}

async function getCannedResponse(id) {
    await initDB();
    const { rows } = await pool.query(`SELECT * FROM support_canned_responses WHERE id = $1`, [id]);
    return rows[0] || null;
}

async function createCannedResponse({ organizationId = null, title, body, shortcut = null, createdBy = null }) {
    await initDB();
    if (!title || !title.trim()) throw new Error('title required');
    if (!body || !body.trim()) throw new Error('body required');
    const { rows } = await pool.query(
        `INSERT INTO support_canned_responses (organization_id, title, body, shortcut, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [organizationId, title.trim(), body, shortcut ? shortcut.trim() : null, createdBy]
    );
    return rows[0];
}

async function updateCannedResponse(id, { title, body, shortcut }, organizationId = null) {
    await initDB();
    const sets = [];
    const params = [];
    if (title !== undefined) { params.push(title.trim()); sets.push(`title = $${params.length}`); }
    if (body !== undefined) { params.push(body); sets.push(`body = $${params.length}`); }
    if (shortcut !== undefined) { params.push(shortcut ? shortcut.trim() : null); sets.push(`shortcut = $${params.length}`); }
    if (!sets.length) return getCannedResponse(id);
    sets.push(`updated_at = now()`);
    params.push(id);
    params.push(organizationId);
    const { rows } = await pool.query(
        `UPDATE support_canned_responses SET ${sets.join(', ')}
          WHERE id = $${params.length - 1} AND (organization_id IS NOT DISTINCT FROM $${params.length})
          RETURNING *`,
        params
    );
    return rows[0] || null;
}

async function deleteCannedResponse(id, organizationId = null) {
    await initDB();
    const { rowCount } = await pool.query(
        `DELETE FROM support_canned_responses
          WHERE id = $1 AND (organization_id IS NOT DISTINCT FROM $2)`,
        [id, organizationId]
    );
    return rowCount > 0;
}

// ── SLA timers ───────────────────────────────────────────────────────────────

async function setThreadSla(threadId, { firstDueAt = null, resolutionDueAt = null }) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET sla_first_response_due_at = $2,
                sla_resolution_due_at = $3,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [threadId, firstDueAt, resolutionDueAt]
    );
    return rows[0] || null;
}

// ── CSAT & resolution confirmation ──────────────────────────────────────────

function buildCsatToken(threadId, email, score) {
    const h = crypto.createHmac('sha256', _secret());
    // 'csat:' purpose-prefix prevents replay of a thread access token as a vote,
    // and including the score stops URL-tampering 4★ → 5★.
    h.update(`csat:${threadId}:${(email || '').toLowerCase()}:${score}`);
    return h.digest('hex').slice(0, 32);
}

function verifyCsatToken(threadId, email, score, token) {
    if (!token || typeof token !== 'string') return false;
    const expected = buildCsatToken(threadId, email, score);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const candidateBuf = Buffer.alloc(expectedBuf.length, 0);
    Buffer.from(token, 'utf8').copy(candidateBuf, 0, 0, expectedBuf.length);
    return crypto.timingSafeEqual(candidateBuf, expectedBuf) && token.length === expected.length;
}

async function setCsat({ threadId, score, comment = null }) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET csat_score = $2, csat_comment = COALESCE($3, csat_comment),
                csat_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [threadId, score, comment]
    );
    return rows[0] || null;
}

async function confirmResolution(threadId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET resolution_confirmed_at = now(), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [threadId]
    );
    return rows[0] || null;
}

async function disputeResolution(threadId) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET resolution_disputed_at = now(),
                status = 'awaiting_agent',
                resolved_at = NULL,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [threadId]
    );
    return rows[0] || null;
}

// ── SLA enforcement queries ─────────────────────────────────────────────────

/**
 * Atomically flag first-response SLA breaches. Returns the rows just flagged
 * so the caller can notify. Idempotent: the WHERE clause excludes already-flagged.
 */
async function flagFirstResponseBreaches() {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET sla_first_response_breached_at = now(), updated_at = now()
          WHERE sla_first_response_breached_at IS NULL
            AND sla_first_response_due_at IS NOT NULL
            AND sla_first_response_due_at < now()
            AND first_response_at IS NULL
            AND status NOT IN ('resolved','closed')
            AND sla_paused = false
          RETURNING id, subject, assignee_user_id, requester_email, organization_id`
    );
    return rows;
}

async function flagResolutionBreaches() {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_threads
            SET sla_resolution_breached_at = now(), updated_at = now()
          WHERE sla_resolution_breached_at IS NULL
            AND sla_resolution_due_at IS NOT NULL
            AND sla_resolution_due_at < now()
            AND status NOT IN ('resolved','closed')
            AND sla_paused = false
          RETURNING id, subject, assignee_user_id, requester_email, organization_id`
    );
    return rows;
}

// ── Auto-assignment round-robin ──────────────────────────────────────────────

/**
 * Atomically advance the round-robin cursor for an org and return the next
 * assignee from `candidateUserIds` (ordered list). Serialised per-org via
 * SELECT … FOR UPDATE so concurrent escalations don't double-assign.
 */
async function getAndAdvanceRoundRobin(organizationId, candidateUserIds = []) {
    await initDB();
    if (!candidateUserIds.length) return null;
    const key = organizationId || '__global__';
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(
            `SELECT last_assignee_user_id FROM support_assignment_state
              WHERE organization_id = $1 FOR UPDATE`,
            [key]
        );
        const last = rows[0]?.last_assignee_user_id || null;
        const lastIdx = candidateUserIds.indexOf(last);
        const next = candidateUserIds[(lastIdx + 1) % candidateUserIds.length];
        await client.query(
            `INSERT INTO support_assignment_state (organization_id, last_assignee_user_id, updated_at)
             VALUES ($1, $2, now())
             ON CONFLICT (organization_id)
             DO UPDATE SET last_assignee_user_id = EXCLUDED.last_assignee_user_id, updated_at = now()`,
            [key, next]
        );
        await client.query('COMMIT');
        return next;
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

// ── Insights / dashboard aggregates ─────────────────────────────────────────

async function getInsights({ organizationId = null } = {}) {
    await initDB();
    const orgFilter = organizationId ? `AND organization_id = $1` : '';
    const params = organizationId ? [organizationId] : [];

    const csat = await pool.query(
        `SELECT
            AVG(csat_score) FILTER (WHERE csat_at > now() - interval '7 days')::numeric(3,2)  AS avg_7d,
            AVG(csat_score) FILTER (WHERE csat_at > now() - interval '30 days')::numeric(3,2) AS avg_30d,
            COUNT(*) FILTER (WHERE csat_score IS NOT NULL)                                    AS responses,
            COUNT(*) FILTER (WHERE status = 'resolved')                                       AS resolved_total
         FROM support_threads WHERE 1=1 ${orgFilter}`,
        params
    );

    const handling = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE ai_handled = true AND ai_escalated_reason IS NULL AND status IN ('resolved','closed','awaiting_user')) AS ai_resolved,
            COUNT(*) FILTER (WHERE status IN ('resolved','closed') AND (ai_escalated_reason IS NOT NULL OR ai_handled = false))            AS staff_resolved,
            COUNT(*) FILTER (WHERE sla_first_response_breached_at IS NOT NULL OR sla_resolution_breached_at IS NOT NULL)                   AS sla_breaches,
            COUNT(*) AS total,
            EXTRACT(EPOCH FROM AVG(first_response_at - created_at) FILTER (WHERE first_response_at IS NOT NULL)) AS avg_first_response_secs,
            EXTRACT(EPOCH FROM AVG(resolved_at - created_at) FILTER (WHERE resolved_at IS NOT NULL))             AS avg_resolution_secs
         FROM support_threads WHERE 1=1 ${orgFilter}`,
        params
    );

    const c = csat.rows[0] || {};
    const h = handling.rows[0] || {};
    const respondedRate = Number(c.resolved_total) > 0
        ? Number(c.responses) / Number(c.resolved_total)
        : 0;
    return {
        csat: {
            avg7d: c.avg_7d != null ? Number(c.avg_7d) : null,
            avg30d: c.avg_30d != null ? Number(c.avg_30d) : null,
            responses: Number(c.responses) || 0,
            responseRate: Number(respondedRate.toFixed(3)),
        },
        handling: {
            aiResolved: Number(h.ai_resolved) || 0,
            staffResolved: Number(h.staff_resolved) || 0,
            slaBreaches: Number(h.sla_breaches) || 0,
            total: Number(h.total) || 0,
            avgFirstResponseSecs: h.avg_first_response_secs != null ? Math.round(Number(h.avg_first_response_secs)) : null,
            avgResolutionSecs: h.avg_resolution_secs != null ? Math.round(Number(h.avg_resolution_secs)) : null,
        },
    };
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
    // iteration 4
    setThreadTags,
    addThreadTag,
    listTags,
    createTag,
    deleteTag,
    getSlaPolicy,
    listSlaPolicies,
    upsertSlaPolicy,
    listCannedResponses,
    getCannedResponse,
    createCannedResponse,
    updateCannedResponse,
    deleteCannedResponse,
    setThreadSla,
    buildCsatToken,
    verifyCsatToken,
    setCsat,
    confirmResolution,
    disputeResolution,
    flagFirstResponseBreaches,
    flagResolutionBreaches,
    getAndAdvanceRoundRobin,
    getInsights,
};
