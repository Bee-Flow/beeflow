/**
 * Support Inbox Store — connected support mailboxes for the tenant Support
 * studio (Studio → Support). One row per connected mailbox (support@, sales@…),
 * org-scoped and team-shared. Holds the per-inbox AI config (agent, KBs, reply
 * mode, threshold, signature) and the incremental-sync cursors.
 *
 * This is a SEPARATE product from the ITIL Ticket Assistant
 * (`ticket_assistant_connections`, which ingests email into a KB). It reuses the
 * same proven primitives — AES-256-GCM token encryption, row-level sync locks,
 * Gmail historyId / Graph deltaLink cursors — but produces SUPPORT TICKETS
 * (support_threads / support_messages), not KB documents.
 *
 * Tenancy: `organization_id` is NOT NULL. Tenant inboxes are always non-null;
 * Bee Flow's own company support inbox lives in support_threads with
 * inbox_id IS NULL and is never represented here.
 */

const { pool } = require('../db');
const crypto = require('crypto');

const ENCRYPTION_KEY_SOURCE = process.env.SESSION_SECRET;
if (!ENCRYPTION_KEY_SOURCE || ENCRYPTION_KEY_SOURCE.length < 32) {
    throw new Error('[SupportInboxStore] SESSION_SECRET must be set (≥32 chars) — it derives the AES-256 key for mailbox OAuth-token encryption. See .env.example.');
}

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS support_inboxes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('gmail','outlook')),
    email_address TEXT,                              -- set at OAuth callback
    display_name TEXT DEFAULT '',
    encrypted_tokens TEXT,                           -- AES-256-GCM blob {accessToken,refreshToken,...}
    auth_method TEXT DEFAULT 'oauth',
    provider_config JSONB DEFAULT '{}'::jsonb,       -- e.g. { sharedMailbox, tenantId }
    default_agent_id TEXT,                           -- agentStore agent used to draft replies
    kb_ids JSONB DEFAULT '[]'::jsonb,                -- KB UUIDs the agent searches
    reply_mode TEXT NOT NULL DEFAULT 'draft'
        CHECK (reply_mode IN ('draft','auto_confident','autonomous')),
    autoresolve_threshold NUMERIC(3,2) DEFAULT 0.78,
    tools_enabled BOOLEAN DEFAULT false,             -- expose read-only SUPPORT_TOOLS to the agent loop
    signature TEXT,                                  -- appended to outbound replies (HTML)
    folder_filter JSONB DEFAULT '["INBOX"]'::jsonb,
    sync_interval_minutes INT DEFAULT 2,
    gmail_history_id TEXT,
    graph_delta_link TEXT,
    sync_after TIMESTAMPTZ,                           -- bootstrap anchor: ignore mail before this
    sync_status TEXT DEFAULT 'idle' CHECK (sync_status IN ('idle','syncing','error')),
    sync_error TEXT,
    sync_locked_until TIMESTAMPTZ,
    last_sync_at TIMESTAMPTZ,
    active BOOLEAN DEFAULT false,                     -- true after OAuth completes
    kb_ingest_enabled BOOLEAN DEFAULT false,          -- distil resolved tickets into a KB
    kb_ingest_kb_id UUID,                             -- target knowledge base for ingestion
    kb_ingest_routine_id UUID,                        -- the auto-provisioned routine (one per inbox)
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_inboxes_org ON support_inboxes(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_support_inbox_org_addr
    ON support_inboxes(organization_id, lower(email_address)) WHERE email_address IS NOT NULL;
`;

let initialized = false;

async function initDB() {
    if (initialized) return;
    try {
        await pool.query(INIT_SQL);
        // Additive migrations for existing installs (CREATE TABLE IF NOT EXISTS
        // won't add columns to a pre-existing table). Tolerate failure.
        for (const sql of [
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS kb_ingest_enabled BOOLEAN DEFAULT false`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS kb_ingest_kb_id UUID`,
            `ALTER TABLE support_inboxes ADD COLUMN IF NOT EXISTS kb_ingest_routine_id UUID`,
        ]) {
            await pool.query(sql).catch(e => console.warn('[SupportInboxStore] migration skipped:', e.message));
        }
        initialized = true;
        console.log('[SupportInboxStore] PostgreSQL initialized');
    } catch (err) {
        console.error('[SupportInboxStore] Init error:', err.message);
        throw err;
    }
}

initDB().catch(err => console.error('[SupportInboxStore] Failed to init:', err.message));

// ── Token encryption (AES-256-GCM, distinct salt from ticket-assistant) ──────

function deriveKey() {
    // Distinct salt so a SESSION_SECRET compromise scoped to one feature's
    // ciphertext doesn't trivially decrypt the other's, and to avoid any
    // accidental cross-feature blob reuse.
    return crypto.scryptSync(ENCRYPTION_KEY_SOURCE, 'support-inbox-salt', 32);
}

function encryptTokens(tokens) {
    const key = deriveKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(JSON.stringify(tokens), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptTokens(encryptedStr) {
    try {
        if (!encryptedStr) return null;
        const key = deriveKey();
        const [ivHex, tagHex, data] = encryptedStr.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        let decrypted = decipher.update(data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return JSON.parse(decrypted);
    } catch (err) {
        console.error('[SupportInboxStore] Token decryption failed:', err.message);
        return null;
    }
}

// Columns safe to return to the client (never the encrypted token blob).
const PUBLIC_COLS = `id, organization_id, created_by, provider, email_address, display_name,
    auth_method, provider_config, default_agent_id, kb_ids, reply_mode, autoresolve_threshold,
    tools_enabled, signature, folder_filter, sync_interval_minutes, sync_status, sync_error,
    last_sync_at, active, kb_ingest_enabled, kb_ingest_kb_id, kb_ingest_routine_id,
    created_at, updated_at,
    (encrypted_tokens IS NOT NULL) AS connected`;

// ── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Create a shell inbox row (pre-OAuth). active stays false until the OAuth
 * callback stores tokens + the mailbox address.
 */
async function createInbox({
    organizationId, createdBy, provider,
    displayName = '', defaultAgentId = null, kbIds = [],
    replyMode = 'draft', autoresolveThreshold = 0.78, toolsEnabled = false,
    signature = null, folderFilter = ['INBOX'], syncIntervalMinutes = 2,
    providerConfig = {},
}) {
    await initDB();
    if (!organizationId) throw new Error('organizationId required');
    if (!['gmail', 'outlook'].includes(provider)) throw new Error('invalid provider');
    if (!['draft', 'auto_confident', 'autonomous'].includes(replyMode)) throw new Error('invalid replyMode');
    const { rows } = await pool.query(
        `INSERT INTO support_inboxes
            (organization_id, created_by, provider, display_name, default_agent_id, kb_ids,
             reply_mode, autoresolve_threshold, tools_enabled, signature, folder_filter,
             sync_interval_minutes, provider_config)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::jsonb,$12,$13::jsonb)
         RETURNING ${PUBLIC_COLS}`,
        [organizationId, createdBy, provider, displayName, defaultAgentId,
            JSON.stringify(kbIds || []), replyMode, autoresolveThreshold, !!toolsEnabled,
            signature, JSON.stringify(folderFilter || ['INBOX']), syncIntervalMinutes,
            JSON.stringify(providerConfig || {})]
    );
    return rows[0];
}

async function listInboxes(organizationId) {
    await initDB();
    if (!organizationId) return [];
    const { rows } = await pool.query(
        `SELECT ${PUBLIC_COLS} FROM support_inboxes WHERE organization_id = $1 ORDER BY created_at ASC`,
        [organizationId]
    );
    return rows;
}

async function getInbox(id) {
    await initDB();
    const { rows } = await pool.query(`SELECT ${PUBLIC_COLS} FROM support_inboxes WHERE id = $1`, [id]);
    return rows[0] || null;
}

/** Full row incl. decrypted tokens — for the sync engine / mailer ONLY. */
async function getInboxWithTokens(id) {
    await initDB();
    const { rows } = await pool.query(`SELECT * FROM support_inboxes WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    row.tokens = decryptTokens(row.encrypted_tokens);
    delete row.encrypted_tokens;
    return row;
}

const UPDATABLE = ['display_name', 'default_agent_id', 'reply_mode', 'autoresolve_threshold',
    'tools_enabled', 'signature', 'folder_filter', 'sync_interval_minutes', 'active',
    'provider_config', 'email_address'];

async function updateInbox(id, updates = {}, organizationId = null) {
    await initDB();
    const sets = [];
    const vals = [id];
    let idx = 2;
    for (const key of UPDATABLE) {
        if (updates[key] === undefined) continue;
        const isJsonb = key === 'folder_filter' || key === 'provider_config';
        sets.push(isJsonb ? `${key} = $${idx}::jsonb` : `${key} = $${idx}`);
        vals.push(isJsonb ? JSON.stringify(updates[key]) : updates[key]);
        idx++;
    }
    // kb_ids handled explicitly (JSONB array)
    if (updates.kb_ids !== undefined || updates.kbIds !== undefined) {
        sets.push(`kb_ids = $${idx}::jsonb`);
        vals.push(JSON.stringify(updates.kb_ids ?? updates.kbIds ?? []));
        idx++;
    }
    if (!sets.length) return getInbox(id);
    sets.push('updated_at = now()');
    let where = `WHERE id = $1`;
    if (organizationId) { vals.push(organizationId); where += ` AND organization_id = $${vals.length}`; }
    const { rows } = await pool.query(
        `UPDATE support_inboxes SET ${sets.join(', ')} ${where} RETURNING ${PUBLIC_COLS}`,
        vals
    );
    return rows[0] || null;
}

/**
 * Set the KB-ingestion config (enable flag, target KB, provisioned routine id)
 * for an inbox. Kept off the public PATCH allowlist so clients can only change
 * it via the dedicated /kb-automation endpoint (which provisions the routine).
 * Only provided keys are written; pass null to clear kbId / routineId.
 */
async function setKbAutomation(id, { enabled, kbId, routineId } = {}, organizationId = null) {
    await initDB();
    const sets = [];
    const vals = [id];
    let idx = 2;
    if (enabled !== undefined) { sets.push(`kb_ingest_enabled = $${idx}`); vals.push(!!enabled); idx++; }
    if (kbId !== undefined) { sets.push(`kb_ingest_kb_id = $${idx}`); vals.push(kbId); idx++; }
    if (routineId !== undefined) { sets.push(`kb_ingest_routine_id = $${idx}`); vals.push(routineId); idx++; }
    if (!sets.length) return getInbox(id);
    sets.push('updated_at = now()');
    let where = `WHERE id = $1`;
    if (organizationId) { vals.push(organizationId); where += ` AND organization_id = $${vals.length}`; }
    const { rows } = await pool.query(
        `UPDATE support_inboxes SET ${sets.join(', ')} ${where} RETURNING ${PUBLIC_COLS}`,
        vals
    );
    return rows[0] || null;
}

/** Persist OAuth tokens + the resolved mailbox address, and activate the inbox. */
async function updateTokens(id, tokens, { emailAddress } = {}) {
    await initDB();
    const enc = encryptTokens(tokens);
    const sets = ['encrypted_tokens = $2', 'active = true', 'updated_at = now()'];
    const vals = [id, enc];
    if (emailAddress) { vals.push(emailAddress); sets.push(`email_address = $${vals.length}`); }
    await pool.query(`UPDATE support_inboxes SET ${sets.join(', ')} WHERE id = $1`, vals);
}

async function deleteInbox(id, organizationId = null) {
    await initDB();
    const vals = [id];
    let where = `WHERE id = $1`;
    if (organizationId) { vals.push(organizationId); where += ` AND organization_id = $2`; }
    const { rowCount } = await pool.query(`DELETE FROM support_inboxes ${where}`, vals);
    // App-managed orphan handling: detach threads from the removed inbox.
    if (rowCount > 0) {
        await pool.query(`UPDATE support_threads SET inbox_id = NULL WHERE inbox_id = $1`, [id]).catch(() => {});
    }
    return rowCount > 0;
}

// ── Sync engine helpers ───────────────────────────────────────────────────────

async function getDueInboxes() {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM support_inboxes
          WHERE active = true
            AND encrypted_tokens IS NOT NULL
            AND sync_status != 'syncing'
            AND (sync_locked_until IS NULL OR sync_locked_until <= now())
            AND (last_sync_at IS NULL OR last_sync_at + (sync_interval_minutes || ' minutes')::interval <= now())
          ORDER BY last_sync_at ASC NULLS FIRST
          LIMIT 20`
    );
    return rows;
}

async function acquireSyncLock(inboxId, ttlMinutes = 10) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE support_inboxes
            SET sync_locked_until = now() + ($2 || ' minutes')::interval, updated_at = now()
          WHERE id = $1 AND (sync_locked_until IS NULL OR sync_locked_until <= now())
          RETURNING sync_locked_until`,
        [inboxId, String(ttlMinutes)]
    );
    return { acquired: rows.length > 0 };
}

async function releaseSyncLock(inboxId) {
    await initDB();
    await pool.query(
        `UPDATE support_inboxes SET sync_locked_until = NULL, updated_at = now() WHERE id = $1`,
        [inboxId]
    );
}

async function updateIncrementalCursor(inboxId, { gmailHistoryId, graphDeltaLink } = {}) {
    await initDB();
    const sets = ['updated_at = now()'];
    const vals = [inboxId];
    let idx = 2;
    if (gmailHistoryId !== undefined) { sets.push(`gmail_history_id = $${idx}`); vals.push(gmailHistoryId); idx++; }
    if (graphDeltaLink !== undefined) { sets.push(`graph_delta_link = $${idx}`); vals.push(graphDeltaLink); idx++; }
    if (sets.length === 1) return;
    await pool.query(`UPDATE support_inboxes SET ${sets.join(', ')} WHERE id = $1`, vals);
}

async function updateSyncState(inboxId, { syncStatus, syncError, lastSyncAt } = {}) {
    await initDB();
    const sets = ['updated_at = now()'];
    const vals = [inboxId];
    let idx = 2;
    if (syncStatus !== undefined) { sets.push(`sync_status = $${idx}`); vals.push(syncStatus); idx++; }
    if (syncError !== undefined) { sets.push(`sync_error = $${idx}`); vals.push(syncError); idx++; }
    if (lastSyncAt !== undefined) { sets.push(`last_sync_at = $${idx}`); vals.push(lastSyncAt); idx++; }
    if (sets.length === 1) return;
    await pool.query(`UPDATE support_inboxes SET ${sets.join(', ')} WHERE id = $1`, vals);
}

module.exports = {
    initDB,
    createInbox,
    listInboxes,
    getInbox,
    getInboxWithTokens,
    updateInbox,
    setKbAutomation,
    updateTokens,
    deleteInbox,
    getDueInboxes,
    acquireSyncLock,
    releaseSyncLock,
    updateIncrementalCursor,
    updateSyncState,
    encryptTokens,
    decryptTokens,
};
