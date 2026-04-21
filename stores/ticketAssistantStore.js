/**
 * Ticket Assistant Store — Database layer for ITIL ticket-source connections
 *
 * Tables:
 *   ticket_assistant_connections — connected sources (gmail, outlook, jira,
 *                                  servicenow, zendesk, freshservice, topdesk)
 *                                  + sync state
 *   ticket_assistant_sync_log    — audit trail for each sync run
 *
 * Historical names: email_kb_connections / email_kb_sync_log — auto-migrated on boot.
 */

const { run, getOne, getAll, exec } = require('../db');
const crypto = require('crypto');

const ENCRYPTION_KEY_SOURCE = process.env.SESSION_SECRET || 'beeflow-default-key';

let initialized = false;

async function initDB() {
    if (initialized) return;

    // ── Legacy rename (one-shot, idempotent) ────────────────────────────────
    // Earlier versions of this feature used email_kb_* table names. On boot
    // with a pre-existing DB, rename them in place. The ALTER ... IF EXISTS
    // form makes this safe to run on fresh DBs too (no-op when tables don't
    // exist yet).
    try {
        await exec(`ALTER TABLE IF EXISTS email_kb_connections RENAME TO ticket_assistant_connections`);
        await exec(`ALTER TABLE IF EXISTS email_kb_sync_log   RENAME TO ticket_assistant_sync_log`);
        await exec(`ALTER INDEX IF EXISTS idx_email_kb_conn_org RENAME TO idx_ta_conn_org`);
        await exec(`ALTER INDEX IF EXISTS idx_email_kb_conn_kb  RENAME TO idx_ta_conn_kb`);
        await exec(`ALTER INDEX IF EXISTS idx_email_kb_log_conn RENAME TO idx_ta_log_conn`);
    } catch (err) {
        console.warn('[TicketAssistantStore] Legacy rename error (safe to ignore on fresh DB):', err.message);
    }

    await exec(`
        CREATE TABLE IF NOT EXISTS ticket_assistant_connections (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id TEXT NOT NULL,
            knowledge_base_id UUID NOT NULL,
            created_by TEXT NOT NULL,
            provider TEXT NOT NULL CHECK (provider IN ('gmail','outlook','jira','servicenow','zendesk','freshservice','topdesk')),
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
            provider_config JSONB DEFAULT '{}'::jsonb,
            auth_method TEXT DEFAULT 'oauth',
            provider_cursor JSONB DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ DEFAULT now(),
            updated_at TIMESTAMPTZ DEFAULT now()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_ta_conn_org ON ticket_assistant_connections(organization_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_ta_conn_kb ON ticket_assistant_connections(knowledge_base_id)`);

    // Migrate: add columns for existing tables (historical + new)
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS redact_pii BOOLEAN DEFAULT true`);
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS max_emails_per_sync INT DEFAULT 50`);
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS sync_after_date TEXT`);
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS pipeline_config JSONB DEFAULT '{}'::jsonb`);
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS sync_locked_until TIMESTAMPTZ`);
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS gmail_history_id TEXT`);
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS graph_delta_link TEXT`);
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS provider_config JSONB DEFAULT '{}'::jsonb`);
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS auth_method TEXT DEFAULT 'oauth'`);
    await exec(`ALTER TABLE ticket_assistant_connections ADD COLUMN IF NOT EXISTS provider_cursor JSONB DEFAULT '{}'::jsonb`);

    // Widen provider enum (existing rows preserved; new providers now valid)
    try {
        await exec(`ALTER TABLE ticket_assistant_connections DROP CONSTRAINT IF EXISTS email_kb_connections_provider_check`);
        await exec(`ALTER TABLE ticket_assistant_connections DROP CONSTRAINT IF EXISTS ticket_assistant_connections_provider_check`);
        await exec(`ALTER TABLE ticket_assistant_connections ADD CONSTRAINT ticket_assistant_connections_provider_check
                    CHECK (provider IN ('gmail','outlook','jira','servicenow','zendesk','freshservice','topdesk'))`);
    } catch (err) {
        console.warn('[TicketAssistantStore] Provider enum widening error (safe on fresh DB):', err.message);
    }

    await exec(`
        CREATE TABLE IF NOT EXISTS ticket_assistant_sync_log (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            connection_id UUID NOT NULL REFERENCES ticket_assistant_connections(id) ON DELETE CASCADE,
            started_at TIMESTAMPTZ DEFAULT now(),
            finished_at TIMESTAMPTZ,
            emails_fetched INT DEFAULT 0,
            articles_created INT DEFAULT 0,
            articles_skipped INT DEFAULT 0,
            errors INT DEFAULT 0,
            error_details TEXT,
            outcomes JSONB DEFAULT '{}'::jsonb
        )
    `);
    await exec(`ALTER TABLE ticket_assistant_sync_log ADD COLUMN IF NOT EXISTS outcomes JSONB DEFAULT '{}'::jsonb`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_ta_log_conn ON ticket_assistant_sync_log(connection_id)`);

    // Migrate beta-feature ID on organizations (TEXT column, JSON-serialized)
    try {
        await run(
            `UPDATE organizations
             SET beta_features = REPLACE(beta_features, '"email_knowledge_base"', '"itil_ticket_assistant"')
             WHERE beta_features LIKE '%"email_knowledge_base"%'`
        );
    } catch (err) {
        // Organizations table may not exist during first-boot — not fatal.
    }

    initialized = true;
    console.log('[TicketAssistantStore] Tables initialized');
}

// Auto-init
initDB().catch(err => console.error('[TicketAssistantStore] Init error:', err.message));

// ──────────────────────────────────────────────
// Token Encryption
// ──────────────────────────────────────────────

function deriveKey() {
    // Salt intentionally preserved as 'email-kb-salt' so that tokens stored
    // under the legacy feature name remain decryptable after the rename.
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
        console.error('[TicketAssistantStore] Token decryption failed:', err.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// Connection CRUD
// ──────────────────────────────────────────────

const TicketAssistantStore = {

    /**
     * Create a new ticket-source connection.
     *
     * @param {object} params
     * @param {string} params.organizationId
     * @param {string} params.knowledgeBaseId
     * @param {string} params.createdBy
     * @param {string} params.provider       — gmail|outlook|jira|servicenow|zendesk|freshservice|topdesk
     * @param {string} params.emailAddress   — account identifier (email for email providers, login/subdomain/instance for ticket providers)
     * @param {string} [params.displayName]
     * @param {object} params.tokens         — provider-specific credential blob (encrypted before storage)
     * @param {object} [params.providerConfig] — provider-specific config: { siteUrl, projectKeys, jql, instance, tables, subdomain, domain, ... }
     * @param {string} [params.authMethod]  — 'oauth' (default, used by gmail/outlook) | 'api_token' | 'basic'
     */
    createConnection: async ({ organizationId, knowledgeBaseId, createdBy, provider, emailAddress, displayName, tokens, providerConfig, authMethod }) => {
        await initDB();
        const encTokens = encryptTokens(tokens);
        // New connections default to the per-email archive mode (one KB doc per
        // message/ticket with rich metadata header). This preserves retrieval
        // signal far better than the AI-summarised category_merge pipeline;
        // existing connections keep their behaviour because they already have
        // a pipeline_config without `ingestion_mode` set (→ treated as
        // 'category_merge' by getIngestionMode in ticketAssistantSyncEngine.js).
        const defaultPipelineConfig = { ingestion_mode: 'per_email' };
        return getOne(
            `INSERT INTO ticket_assistant_connections
             (organization_id, knowledge_base_id, created_by, provider, email_address, display_name,
              encrypted_tokens, pipeline_config, provider_config, auth_method)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id, organization_id, knowledge_base_id, provider, email_address, display_name,
                       folder_filter, sender_blacklist, sync_interval_minutes, sync_status,
                       total_emails_processed, total_articles_created, enabled, process_attachments,
                       group_threads, pipeline_config, provider_config, auth_method, created_at`,
            [
                organizationId, knowledgeBaseId, createdBy, provider, emailAddress,
                displayName || emailAddress, encTokens,
                JSON.stringify(defaultPipelineConfig),
                JSON.stringify(providerConfig || {}),
                authMethod || 'oauth',
            ]
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
                    pipeline_config, provider_config, auth_method, created_at, updated_at
             FROM ticket_assistant_connections
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
                    provider_config, auth_method, provider_cursor, created_at, updated_at
             FROM ticket_assistant_connections
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
            `SELECT * FROM ticket_assistant_connections WHERE id = $1`,
            [id]
        );
        if (!row) return null;
        row.tokens = decryptTokens(row.encrypted_tokens);
        delete row.encrypted_tokens;
        return row;
    },

    /**
     * Get all connections that are due for syncing.
     * Skips connections with a live sync lock (another worker is in-flight).
     */
    getDueConnections: async () => {
        await initDB();
        return getAll(
            `SELECT * FROM ticket_assistant_connections
             WHERE enabled = true
               AND sync_status != 'syncing'
               AND (sync_locked_until IS NULL OR sync_locked_until <= now())
               AND (last_sync_at IS NULL OR last_sync_at + (sync_interval_minutes || ' minutes')::interval <= now())
             ORDER BY last_sync_at ASC NULLS FIRST
             LIMIT 10`
        );
    },

    /**
     * Atomically acquire a sync lock on a connection.
     * Returns { acquired:true, lockedUntil } on success, { acquired:false, retryAfterSeconds }
     * when another worker holds the lock.
     */
    acquireSyncLock: async (connectionId, ttlMinutes = 30) => {
        await initDB();
        const row = await getOne(
            `UPDATE ticket_assistant_connections
             SET sync_locked_until = now() + ($2 || ' minutes')::interval,
                 updated_at = now()
             WHERE id = $1
               AND (sync_locked_until IS NULL OR sync_locked_until <= now())
             RETURNING sync_locked_until`,
            [connectionId, String(ttlMinutes)]
        );
        if (row) {
            return { acquired: true, lockedUntil: row.sync_locked_until };
        }
        // Lock is held — read current expiry to return retry hint
        const held = await getOne(
            `SELECT sync_locked_until FROM ticket_assistant_connections WHERE id = $1`,
            [connectionId]
        );
        const secs = held?.sync_locked_until
            ? Math.max(1, Math.ceil((new Date(held.sync_locked_until).getTime() - Date.now()) / 1000))
            : 60;
        return { acquired: false, retryAfterSeconds: secs };
    },

    /**
     * Persist incremental-sync cursors (Gmail historyId, Graph @odata.deltaLink).
     * Either field may be set to `null` to force a fallback on next sync.
     */
    updateIncrementalCursor: async (connectionId, { gmailHistoryId, graphDeltaLink, providerCursor } = {}) => {
        await initDB();
        const sets = ['updated_at = now()'];
        const vals = [connectionId];
        let idx = 2;
        if (gmailHistoryId !== undefined) {
            sets.push(`gmail_history_id = $${idx}`); vals.push(gmailHistoryId); idx++;
        }
        if (graphDeltaLink !== undefined) {
            sets.push(`graph_delta_link = $${idx}`); vals.push(graphDeltaLink); idx++;
        }
        if (providerCursor !== undefined) {
            sets.push(`provider_cursor = $${idx}::jsonb`); vals.push(JSON.stringify(providerCursor)); idx++;
        }
        if (sets.length === 1) return null;
        return run(`UPDATE ticket_assistant_connections SET ${sets.join(', ')} WHERE id = $1`, vals);
    },

    /**
     * Release a sync lock. Safe to call even if no lock is held.
     */
    releaseSyncLock: async (connectionId) => {
        await initDB();
        return run(
            `UPDATE ticket_assistant_connections SET sync_locked_until = NULL, updated_at = now() WHERE id = $1`,
            [connectionId]
        );
    },

    /**
     * Update connection settings.
     */
    updateConnection: async (id, updates) => {
        await initDB();
        const allowed = ['display_name', 'folder_filter', 'sender_blacklist', 'sync_interval_minutes',
                          'ai_system_prompt', 'enabled', 'process_attachments', 'group_threads', 'knowledge_base_id',
                          'redact_pii', 'max_emails_per_sync', 'sync_after_date', 'pipeline_config',
                          'provider_config', 'auth_method'];
        const sets = [];
        const vals = [id];
        let idx = 2;

        for (const key of allowed) {
            if (updates[key] !== undefined) {
                const isJsonb = key === 'folder_filter' || key === 'sender_blacklist' || key === 'pipeline_config' || key === 'provider_config';
                const dbKey = isJsonb ? `${key} = $${idx}::jsonb` : `${key} = $${idx}`;
                sets.push(dbKey);
                vals.push(isJsonb ? JSON.stringify(updates[key]) : updates[key]);
                idx++;
            }
        }

        if (sets.length === 0) return null;
        sets.push('updated_at = now()');

        return getOne(
            `UPDATE ticket_assistant_connections SET ${sets.join(', ')} WHERE id = $1
             RETURNING id, organization_id, knowledge_base_id, provider, email_address, display_name,
                       folder_filter, sender_blacklist, sync_interval_minutes, sync_status,
                       total_emails_processed, total_articles_created, enabled,
                       process_attachments, group_threads, redact_pii, max_emails_per_sync,
                       sync_after_date, ai_system_prompt, pipeline_config,
                       provider_config, auth_method, updated_at`,
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
            `UPDATE ticket_assistant_connections SET encrypted_tokens = $2, updated_at = now() WHERE id = $1`,
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

        return run(`UPDATE ticket_assistant_connections SET ${sets.join(', ')} WHERE id = $1`, vals);
    },

    /**
     * Delete a connection.
     */
    deleteConnection: async (id) => {
        await initDB();
        await run('DELETE FROM ticket_assistant_connections WHERE id = $1', [id]);
        return true;
    },

    // ──────────────────────────────────────────────
    // Sync Logs
    // ──────────────────────────────────────────────

    createSyncLog: async (connectionId) => {
        await initDB();
        return getOne(
            `INSERT INTO ticket_assistant_sync_log (connection_id) VALUES ($1) RETURNING *`,
            [connectionId]
        );
    },

    completeSyncLog: async (logId, { emailsFetched, articlesCreated, articlesSkipped, errors, errorDetails, outcomes }) => {
        await initDB();
        if (outcomes !== undefined) {
            return run(
                `UPDATE ticket_assistant_sync_log
                 SET finished_at = now(),
                     emails_fetched = $2,
                     articles_created = $3,
                     articles_skipped = $4,
                     errors = $5,
                     error_details = $6,
                     outcomes = $7::jsonb
                 WHERE id = $1`,
                [logId, emailsFetched || 0, articlesCreated || 0, articlesSkipped || 0, errors || 0, errorDetails || null, JSON.stringify(outcomes)]
            );
        }
        return run(
            `UPDATE ticket_assistant_sync_log
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

    /**
     * Append a per-email outcome to the sync log's outcomes JSONB.
     *
     * @param {string} logId
     * @param {'ingested'|'skipped'|'failed'} bucket
     * @param {object} detail
     *   - for 'ingested': { messageId?, subject?, category? }
     *   - for 'skipped' : { reason: 'already_ingested'|'blacklisted'|'content_hash_dup'|'empty_after_redaction'|'rate_limited'|string, messageId?, subject? }
     *   - for 'failed'  : { messageId?, stage, error, subject? }
     *
     * Stored shape:
     *   {
     *     ingested: { count: number, samples: [{...}] },            // samples capped at 20
     *     skipped:  { count: number, byReason: { reason: count }, samples: [] },
     *     failed:   { count: number, samples: [] }
     *   }
     */
    addOutcome: async (logId, bucket, detail = {}) => {
        await initDB();
        if (!logId || !['ingested', 'skipped', 'failed'].includes(bucket)) return null;
        const SAMPLE_CAP = 20;
        const row = await getOne(`SELECT outcomes FROM ticket_assistant_sync_log WHERE id = $1`, [logId]);
        if (!row) return null;
        const outcomes = row.outcomes || {};
        const slot = outcomes[bucket] || { count: 0, samples: [] };
        slot.count = (slot.count || 0) + 1;
        if (bucket === 'skipped') {
            const reason = detail.reason || 'unknown';
            slot.byReason = slot.byReason || {};
            slot.byReason[reason] = (slot.byReason[reason] || 0) + 1;
        }
        if (Array.isArray(slot.samples) && slot.samples.length < SAMPLE_CAP) {
            slot.samples.push({ at: new Date().toISOString(), ...detail });
        }
        outcomes[bucket] = slot;
        return run(
            `UPDATE ticket_assistant_sync_log SET outcomes = $2::jsonb WHERE id = $1`,
            [logId, JSON.stringify(outcomes)]
        );
    },

    getRecentSyncLogs: async (connectionId, limit = 20) => {
        await initDB();
        return getAll(
            `SELECT * FROM ticket_assistant_sync_log
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

module.exports = TicketAssistantStore;
