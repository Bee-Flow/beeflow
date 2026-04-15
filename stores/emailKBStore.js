/**
 * Email KB Store — Database layer for email-to-knowledge-base connections
 *
 * Tables:
 *   email_kb_connections  — connected mailboxes + sync state
 *   email_kb_sync_log     — audit trail for each sync run
 */

const { run, getOne, getAll, exec } = require('../db');
const crypto = require('crypto');

const ENCRYPTION_KEY_SOURCE = process.env.SESSION_SECRET || 'beeflow-default-key';

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS email_kb_connections (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL,
            knowledge_base_id UUID NOT NULL,
            created_by TEXT NOT NULL,
            provider TEXT NOT NULL CHECK (provider IN ('gmail', 'outlook')),
            email_address TEXT NOT NULL,
            display_name TEXT DEFAULT '',
            folder_filter JSONB DEFAULT '["INBOX"]'::jsonb,
            sender_blacklist JSONB DEFAULT '[]'::jsonb,
            sync_interval_minutes INT DEFAULT 30,
            last_sync_at TIMESTAMPTZ,
            last_sync_cursor TEXT,
            sync_status TEXT DEFAULT 'idle' CHECK (sync_status IN ('idle', 'syncing', 'error')),
            sync_error TEXT,
            total_emails_processed INT DEFAULT 0,
            total_articles_created INT DEFAULT 0,
            ai_system_prompt TEXT,
            enabled BOOLEAN DEFAULT false,
            encrypted_tokens TEXT,
            process_attachments BOOLEAN DEFAULT true,
            group_threads BOOLEAN DEFAULT true,
            redact_pii BOOLEAN DEFAULT true,
            max_emails_per_sync INT DEFAULT 50,
            sync_after_date TEXT,
            pipeline_config JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_email_kb_conn_org ON email_kb_connections(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_email_kb_conn_kb ON email_kb_connections(knowledge_base_id)`);

    // Migrate: add columns for existing tables
    await exec(`ALTER TABLE email_kb_connections ADD COLUMN IF NOT EXISTS redact_pii BOOLEAN DEFAULT true`);
    await exec(`ALTER TABLE email_kb_connections ADD COLUMN IF NOT EXISTS max_emails_per_sync INT DEFAULT 50`);
    await exec(`ALTER TABLE email_kb_connections ADD COLUMN IF NOT EXISTS sync_after_date TEXT`);
    await exec(`ALTER TABLE email_kb_connections ADD COLUMN IF NOT EXISTS pipeline_config JSONB DEFAULT '{}'::jsonb`);

    await exec(`
        CREATE TABLE IF NOT EXISTS email_kb_sync_log (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            connection_id UUID NOT NULL REFERENCES email_kb_connections(id) ON DELETE CASCADE,
            started_at TIMESTAMPTZ DEFAULT now(),
            finished_at TIMESTAMPTZ,
            emails_fetched INT DEFAULT 0,
            articles_created INT DEFAULT 0,
            articles_skipped INT DEFAULT 0,
            errors INT DEFAULT 0,
            error_details TEXT
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_email_kb_log_conn ON email_kb_sync_log(connection_id)`);

    initialized = true;
    console.log('[EmailKBStore] Tables initialized');
}

// Auto-init
initDB().catch(err => console.error('[EmailKBStore] Init error:', err.message));

// ──────────────────────────────────────────────
// Token Encryption
// ──────────────────────────────────────────────

function deriveKey() {
    return crypto.scryptSync(ENCRYPTION_KEY_SOURCE, 'email-kb-salt', 32);
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
        const key = deriveKey();
        const [ivHex, tagHex, data] = encryptedStr.split(':');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        let decrypted = decipher.update(data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return JSON.parse(decrypted);
    } catch (err) {
        console.error('[EmailKBStore] Token decryption failed:', err.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// Connection CRUD
// ──────────────────────────────────────────────

const EmailKBStore = {

    /**
     * Create a new email KB connection.
     */
    createConnection: async ({ organizationId, knowledgeBaseId, createdBy, provider, emailAddress, displayName, tokens }) => {
        await initDB();
        const encTokens = encryptTokens(tokens);
        return getOne(
            `INSERT INTO email_kb_connections
             (organization_id, knowledge_base_id, created_by, provider, email_address, display_name, encrypted_tokens)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, organization_id, knowledge_base_id, provider, email_address, display_name,
                       folder_filter, sender_blacklist, sync_interval_minutes, sync_status,
                       total_emails_processed, total_articles_created, enabled, process_attachments,
                       group_threads, created_at`,
            [organizationId, knowledgeBaseId, createdBy, provider, emailAddress, displayName || emailAddress, encTokens]
        );
    },

    /**
     * List connections for an organization (never exposes tokens).
     */
    listConnections: async (organizationId) => {
        await initDB();
        return getAll(
            `SELECT id, organization_id, knowledge_base_id, provider, email_address, display_name,
                    folder_filter, sender_blacklist, sync_interval_minutes,
                    last_sync_at, sync_status, sync_error,
                    total_emails_processed, total_articles_created,
                    enabled, process_attachments, group_threads,
                    redact_pii, max_emails_per_sync, sync_after_date, ai_system_prompt,
                    pipeline_config, created_at, updated_at
             FROM email_kb_connections
             WHERE organization_id = $1
             ORDER BY created_at DESC`,
            [organizationId]
        );
    },

    /**
     * Get a single connection by ID (without tokens).
     */
    getConnection: async (id) => {
        await initDB();
        return getOne(
            `SELECT id, organization_id, knowledge_base_id, created_by, provider, email_address, display_name,
                    folder_filter, sender_blacklist, sync_interval_minutes,
                    last_sync_at, last_sync_cursor, sync_status, sync_error,
                    total_emails_processed, total_articles_created,
                    ai_system_prompt, enabled, process_attachments, group_threads,
                    redact_pii, max_emails_per_sync, sync_after_date, pipeline_config,
                    created_at, updated_at
             FROM email_kb_connections
             WHERE id = $1`,
            [id]
        );
    },

    /**
     * Get connection with decrypted tokens (for sync engine only).
     */
    getConnectionWithTokens: async (id) => {
        await initDB();
        const row = await getOne(
            `SELECT * FROM email_kb_connections WHERE id = $1`,
            [id]
        );
        if (!row) return null;
        row.tokens = decryptTokens(row.encrypted_tokens);
        delete row.encrypted_tokens;
        return row;
    },

    /**
     * Get all connections that are due for syncing.
     */
    getDueConnections: async () => {
        await initDB();
        return getAll(
            `SELECT * FROM email_kb_connections
             WHERE enabled = true
               AND sync_status != 'syncing'
               AND (last_sync_at IS NULL OR last_sync_at + (sync_interval_minutes || ' minutes')::interval <= now())
             ORDER BY last_sync_at ASC NULLS FIRST
             LIMIT 10`
        );
    },

    /**
     * Update connection settings.
     */
    updateConnection: async (id, updates) => {
        await initDB();
        const allowed = ['display_name', 'folder_filter', 'sender_blacklist', 'sync_interval_minutes',
                          'ai_system_prompt', 'enabled', 'process_attachments', 'group_threads', 'knowledge_base_id',
                          'redact_pii', 'max_emails_per_sync', 'sync_after_date', 'pipeline_config'];
        const sets = [];
        const vals = [id];
        let idx = 2;

        for (const key of allowed) {
            if (updates[key] !== undefined) {
                const isJsonb = key === 'folder_filter' || key === 'sender_blacklist' || key === 'pipeline_config';
                const dbKey = isJsonb ? `${key} = $${idx}::jsonb` : `${key} = $${idx}`;
                sets.push(dbKey);
                vals.push(isJsonb ? JSON.stringify(updates[key]) : updates[key]);
                idx++;
            }
        }

        if (sets.length === 0) return null;
        sets.push('updated_at = now()');

        return getOne(
            `UPDATE email_kb_connections SET ${sets.join(', ')} WHERE id = $1
             RETURNING id, organization_id, knowledge_base_id, provider, email_address, display_name,
                       folder_filter, sender_blacklist, sync_interval_minutes, sync_status,
                       total_emails_processed, total_articles_created, enabled,
                       process_attachments, group_threads, redact_pii, max_emails_per_sync,
                       sync_after_date, ai_system_prompt, pipeline_config, updated_at`,
            vals
        );
    },

    /**
     * Update OAuth tokens (after refresh).
     */
    updateTokens: async (id, tokens) => {
        await initDB();
        const encTokens = encryptTokens(tokens);
        return run(
            `UPDATE email_kb_connections SET encrypted_tokens = $2, updated_at = now() WHERE id = $1`,
            [id, encTokens]
        );
    },

    /**
     * Update sync state atomically (used by sync engine).
     */
    updateSyncState: async (id, { syncStatus, syncError, lastSyncAt, lastSyncCursor, emailsProcessed, articlesCreated }) => {
        await initDB();
        const sets = ['updated_at = now()'];
        const vals = [id];
        let idx = 2;

        if (syncStatus !== undefined) { sets.push(`sync_status = $${idx}`); vals.push(syncStatus); idx++; }
        if (syncError !== undefined) { sets.push(`sync_error = $${idx}`); vals.push(syncError); idx++; }
        if (lastSyncAt !== undefined) { sets.push(`last_sync_at = $${idx}`); vals.push(lastSyncAt); idx++; }
        if (lastSyncCursor !== undefined) { sets.push(`last_sync_cursor = $${idx}`); vals.push(lastSyncCursor); idx++; }
        if (emailsProcessed !== undefined) {
            sets.push(`total_emails_processed = total_emails_processed + $${idx}`);
            vals.push(emailsProcessed); idx++;
        }
        if (articlesCreated !== undefined) {
            sets.push(`total_articles_created = total_articles_created + $${idx}`);
            vals.push(articlesCreated); idx++;
        }

        return run(`UPDATE email_kb_connections SET ${sets.join(', ')} WHERE id = $1`, vals);
    },

    /**
     * Delete a connection.
     */
    deleteConnection: async (id) => {
        await initDB();
        await run('DELETE FROM email_kb_connections WHERE id = $1', [id]);
        return true;
    },

    // ──────────────────────────────────────────────
    // Sync Logs
    // ──────────────────────────────────────────────

    createSyncLog: async (connectionId) => {
        await initDB();
        return getOne(
            `INSERT INTO email_kb_sync_log (connection_id) VALUES ($1) RETURNING *`,
            [connectionId]
        );
    },

    completeSyncLog: async (logId, { emailsFetched, articlesCreated, articlesSkipped, errors, errorDetails }) => {
        await initDB();
        return run(
            `UPDATE email_kb_sync_log
             SET finished_at = now(),
                 emails_fetched = $2,
                 articles_created = $3,
                 articles_skipped = $4,
                 errors = $5,
                 error_details = $6
             WHERE id = $1`,
            [logId, emailsFetched || 0, articlesCreated || 0, articlesSkipped || 0, errors || 0, errorDetails || null]
        );
    },

    getRecentSyncLogs: async (connectionId, limit = 20) => {
        await initDB();
        return getAll(
            `SELECT * FROM email_kb_sync_log
             WHERE connection_id = $1
             ORDER BY started_at DESC
             LIMIT $2`,
            [connectionId, limit]
        );
    },

    // ── Helpers ──
    encryptTokens,
    decryptTokens,
};

module.exports = EmailKBStore;
