/**
 * Email KB Store — Database layer for email connections and sync logs.
 *
 * Supports both organisation-scoped and consumer (no-org) accounts.
 * When a user has no organisation, data is scoped by user ID instead.
 *
 * Tables auto-created on first use:
 *   • email_kb_connections — OAuth connection config + sync state
 *   • email_kb_sync_logs  — Per-sync audit trail
 */

const { exec, getOne, getAll, run } = require('../db');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ── Encryption helpers (AES-256-GCM using SESSION_SECRET) ────────────────────
const CIPHER_ALGO = 'aes-256-gcm';

function getEncKey() {
    const secret = process.env.SESSION_SECRET || 'beeflow-dev-secret-key';
    return crypto.createHash('sha256').update(secret).digest();
}

function encryptTokens(tokens) {
    const key = getEncKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(CIPHER_ALGO, key, iv);
    const plaintext = JSON.stringify(tokens);
    let enc = cipher.update(plaintext, 'utf8', 'hex');
    enc += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${enc}`;
}

function decryptTokens(encrypted) {
    if (!encrypted) return null;
    try {
        const [ivHex, tagHex, data] = encrypted.split(':');
        const key = getEncKey();
        const decipher = crypto.createDecipheriv(CIPHER_ALGO, key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        let dec = decipher.update(data, 'hex', 'utf8');
        dec += decipher.final('utf8');
        return JSON.parse(dec);
    } catch (err) {
        console.error('[EmailKBStore] Decryption error:', err.message);
        return null;
    }
}

// ── Schema migration ─────────────────────────────────────────────────────────
let _migrated = false;
async function ensureTables() {
    if (_migrated) return;
    try {
        await exec(`
            CREATE TABLE IF NOT EXISTS email_kb_connections (
                id TEXT PRIMARY KEY,
                created_by TEXT NOT NULL,
                organization_id TEXT,
                provider TEXT NOT NULL CHECK(provider IN ('gmail', 'outlook')),
                email_address TEXT NOT NULL,
                encrypted_tokens TEXT NOT NULL,
                knowledge_base_id TEXT NOT NULL,
                enabled INTEGER DEFAULT 1,
                sync_interval_minutes INTEGER DEFAULT 30,
                group_threads INTEGER DEFAULT 1,
                process_attachments INTEGER DEFAULT 0,
                folder_filter TEXT DEFAULT '["INBOX"]',
                sender_blacklist TEXT DEFAULT '[]',
                ai_system_prompt TEXT,
                sync_status TEXT DEFAULT 'idle',
                sync_error TEXT,
                last_sync_at TEXT,
                total_emails_processed INTEGER DEFAULT 0,
                total_articles_created INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            )
        `);
        await exec(`
            CREATE TABLE IF NOT EXISTS email_kb_sync_logs (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                started_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT,
                emails_fetched INTEGER DEFAULT 0,
                articles_created INTEGER DEFAULT 0,
                articles_skipped INTEGER DEFAULT 0,
                errors INTEGER DEFAULT 0,
                error_details TEXT
            )
        `);
        console.log('[EmailKBStore] Tables ready');
    } catch (err) {
        console.error('[EmailKBStore] Init error:', err.message);
    }
    _migrated = true;
}

// ── Connection CRUD ──────────────────────────────────────────────────────────

async function createConnection({ userId, orgId, provider, email, tokens, kbId }) {
    await ensureTables();
    const id = uuidv4();
    const encrypted = encryptTokens(tokens);
    await run(
        `INSERT INTO email_kb_connections (id, created_by, organization_id, provider, email_address, encrypted_tokens, knowledge_base_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, userId, orgId || null, provider, email, encrypted, kbId]
    );
    return { id, provider, email_address: email, knowledge_base_id: kbId };
}

async function getConnections(userId, orgId = null) {
    await ensureTables();
    // Show connections owned by user OR belonging to the same org
    if (orgId) {
        return getAll(
            `SELECT id, provider, email_address, knowledge_base_id, enabled, sync_interval_minutes,
                    group_threads, process_attachments, folder_filter, sender_blacklist,
                    sync_status, sync_error, last_sync_at, total_emails_processed, total_articles_created,
                    created_at, updated_at
             FROM email_kb_connections
             WHERE created_by = $1 OR organization_id = $2
             ORDER BY created_at DESC`,
            [userId, orgId]
        );
    }
    // Consumer account — user-scoped only
    return getAll(
        `SELECT id, provider, email_address, knowledge_base_id, enabled, sync_interval_minutes,
                group_threads, process_attachments, folder_filter, sender_blacklist,
                sync_status, sync_error, last_sync_at, total_emails_processed, total_articles_created,
                created_at, updated_at
         FROM email_kb_connections
         WHERE created_by = $1
         ORDER BY created_at DESC`,
        [userId]
    );
}

async function getConnection(id) {
    await ensureTables();
    return getOne('SELECT * FROM email_kb_connections WHERE id = $1', [id]);
}

async function getConnectionWithTokens(id) {
    await ensureTables();
    const conn = await getOne('SELECT * FROM email_kb_connections WHERE id = $1', [id]);
    if (!conn) return null;
    conn.tokens = decryptTokens(conn.encrypted_tokens);
    return conn;
}

async function updateConnection(id, updates) {
    await ensureTables();
    const allowed = ['enabled', 'sync_interval_minutes', 'group_threads', 'process_attachments',
                     'folder_filter', 'sender_blacklist', 'knowledge_base_id', 'ai_system_prompt'];
    const sets = [];
    const params = [];
    let idx = 1;

    for (const key of allowed) {
        if (updates[key] !== undefined) {
            const col = key;
            let val = updates[key];
            if (typeof val === 'object') val = JSON.stringify(val);
            if (typeof val === 'boolean') val = val ? 1 : 0;
            sets.push(`${col} = $${idx}`);
            params.push(val);
            idx++;
        }
    }

    if (sets.length === 0) return;
    sets.push(`updated_at = datetime('now')`);
    params.push(id);
    await run(`UPDATE email_kb_connections SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

async function updateTokens(id, tokens) {
    await ensureTables();
    const encrypted = encryptTokens(tokens);
    await run('UPDATE email_kb_connections SET encrypted_tokens = $1, updated_at = datetime(\'now\') WHERE id = $2', [encrypted, id]);
}

async function updateSyncState(id, { syncStatus, syncError, lastSyncAt, emailsProcessed, articlesCreated }) {
    await ensureTables();
    const sets = [];
    const params = [];
    let idx = 1;

    if (syncStatus !== undefined) { sets.push(`sync_status = $${idx++}`); params.push(syncStatus); }
    if (syncError !== undefined) { sets.push(`sync_error = $${idx++}`); params.push(syncError); }
    if (lastSyncAt !== undefined) { sets.push(`last_sync_at = $${idx++}`); params.push(lastSyncAt); }
    if (emailsProcessed !== undefined) {
        sets.push(`total_emails_processed = total_emails_processed + $${idx++}`);
        params.push(emailsProcessed);
    }
    if (articlesCreated !== undefined) {
        sets.push(`total_articles_created = total_articles_created + $${idx++}`);
        params.push(articlesCreated);
    }
    sets.push(`updated_at = datetime('now')`);
    params.push(id);
    await run(`UPDATE email_kb_connections SET ${sets.join(', ')} WHERE id = $${idx}`, params);
}

async function deleteConnection(id) {
    await ensureTables();
    await run('DELETE FROM email_kb_sync_logs WHERE connection_id = $1', [id]);
    await run('DELETE FROM email_kb_connections WHERE id = $1', [id]);
}

// ── Sync scheduling ──────────────────────────────────────────────────────────

async function getDueConnections() {
    await ensureTables();
    return getAll(`
        SELECT * FROM email_kb_connections
        WHERE enabled = 1
          AND sync_status != 'syncing'
          AND (
            last_sync_at IS NULL
            OR (julianday('now') - julianday(last_sync_at)) * 24 * 60 >= sync_interval_minutes
          )
    `);
}

// ── Sync logs ────────────────────────────────────────────────────────────────

async function createSyncLog(connectionId) {
    await ensureTables();
    const id = uuidv4();
    await run('INSERT INTO email_kb_sync_logs (id, connection_id) VALUES ($1, $2)', [id, connectionId]);
    return { id };
}

async function completeSyncLog(logId, { emailsFetched, articlesCreated, articlesSkipped, errors, errorDetails }) {
    await ensureTables();
    await run(
        `UPDATE email_kb_sync_logs
         SET completed_at = datetime('now'), emails_fetched = $1, articles_created = $2,
             articles_skipped = $3, errors = $4, error_details = $5
         WHERE id = $6`,
        [emailsFetched, articlesCreated, articlesSkipped, errors, errorDetails, logId]
    );
}

async function getSyncLogs(connectionId, limit = 20) {
    await ensureTables();
    return getAll(
        'SELECT * FROM email_kb_sync_logs WHERE connection_id = $1 ORDER BY started_at DESC LIMIT $2',
        [connectionId, limit]
    );
}

module.exports = {
    ensureTables,
    encryptTokens,
    decryptTokens,
    createConnection,
    getConnections,
    getConnection,
    getConnectionWithTokens,
    updateConnection,
    updateTokens,
    updateSyncState,
    deleteConnection,
    getDueConnections,
    createSyncLog,
    completeSyncLog,
    getSyncLogs,
};
