/**
 * Conversation Messages Store — Phase 5 Performance Fix
 *
 * Replaces the messages_json TEXT blob anti-pattern.
 * Each message is stored as an individual row, so appending a message
 * is O(1) instead of O(n) (read full blob → deserialise → append → serialise → write).
 *
 * Schema:
 *   conversation_messages
 *     id               TEXT PRIMARY KEY
 *     conversation_id  TEXT NOT NULL
 *     conversation_type TEXT NOT NULL  ('agent' | 'direct')
 *     role             TEXT NOT NULL   ('user' | 'assistant' | 'tool' | 'system')
 *     content          TEXT
 *     tool_name        TEXT
 *     meta_json        TEXT DEFAULT '{}'   -- arbitrary per-message metadata
 *     seq              INTEGER NOT NULL    -- ordinal, for deterministic ordering
 *     created_at       TIMESTAMPTZ DEFAULT NOW()
 *
 * Migration strategy (lazy, zero-downtime):
 *   - New messages are written to this table.
 *   - On first read of an old conversation, messages_json is migrated
 *     into this table and a flag (messages_migrated) is set on the parent row.
 *   - Once migrated, the blob column is no longer read.
 *   - The blob column is kept for emergency rollback — it stays in sync for
 *     a release cycle, then can be dropped.
 *
 * Phase 5 change:
 *   replaceMessages() and migrateConversationIfNeeded() previously looped and
 *   ran one INSERT per message (N round-trips). They now use a single
 *   parameterized multi-row INSERT, shrinking N round-trips to 1
 *   (or ceil(N/500) for very long conversations — PG parameter limit safety).
 *   replaceMessages() also wraps the DELETE + INSERT in a transaction so
 *   a crashed write never leaves a conversation message-less.
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll, exec, getClient } = require('../../db');

let initialized = false;

async function initMessagesTable() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS conversation_messages (
            id               TEXT PRIMARY KEY,
            conversation_id  TEXT NOT NULL,
            conversation_type TEXT NOT NULL DEFAULT 'agent',
            role             TEXT NOT NULL,
            content          TEXT,
            tool_name        TEXT,
            meta_json        TEXT DEFAULT '{}',
            seq              INTEGER NOT NULL DEFAULT 0,
            created_at       TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_seq
        ON conversation_messages(conversation_id, seq ASC)
    `);
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_conv_messages_conv_type
        ON conversation_messages(conversation_id, conversation_type)
    `);
    // Migration flag columns on the parent tables —
    // added lazily so this is safe on existing databases.
    try {
        await exec(`ALTER TABLE agent_conversations
            ADD COLUMN IF NOT EXISTS messages_migrated BOOLEAN DEFAULT FALSE`);
    } catch (e) { /* already exists */ }
    try {
        await exec(`ALTER TABLE direct_conversations
            ADD COLUMN IF NOT EXISTS messages_migrated BOOLEAN DEFAULT FALSE`);
    } catch (e) { /* already exists */ }
    initialized = true;
}

initMessagesTable().catch(err =>
    console.error('[ConversationMessages] Init error:', err.message)
);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert a full messages array (from the legacy blob) into rows for bulk insert.
 */
function messagesToRows(conversationId, type, messages) {
    return messages.map((m, idx) => ({
        id: m.id || uuidv4(),
        conversation_id: conversationId,
        conversation_type: type,
        role: m.role || 'user',
        content: typeof m.content === 'string'
            ? m.content
            : JSON.stringify(m.content ?? null),
        tool_name: m.tool_name || m.toolName || null,
        meta_json: JSON.stringify(
            Object.fromEntries(
                Object.entries(m).filter(([k]) =>
                    !['id', 'role', 'content', 'tool_name', 'toolName'].includes(k)
                )
            )
        ),
        seq: idx,
    }));
}

/**
 * Reconstruct a message object from a DB row.
 */
function rowToMessage(row) {
    let meta = {};
    try { meta = JSON.parse(row.meta_json || '{}'); } catch (e) { /* ignore */ }
    let content = row.content;
    try {
        const parsed = JSON.parse(content);
        if (typeof parsed !== 'string') content = parsed;
    } catch (e) { /* keep as string */ }
    return {
        id: row.id,
        role: row.role,
        content,
        ...(row.tool_name ? { tool_name: row.tool_name } : {}),
        ...meta,
    };
}

// ── Phase 5: Bulk INSERT helper ───────────────────────────────────────────────

/**
 * Insert an array of message rows in one (or a few) SQL statements.
 *
 * PostgreSQL supports at most 65535 bound parameters per query.
 * With 8 columns per row that is ~8191 rows. We chunk at 500 rows
 * (4000 params) to stay well within the limit and keep individual
 * statements fast.
 *
 * @param {object[]} rows       - Output of messagesToRows()
 * @param {object}   client     - PG client (from getClient()) for transaction, or null to use pool
 * @param {string}   onConflict - Optional "ON CONFLICT ..." clause
 */
const COLS = 8;           // id, conversation_id, conversation_type, role, content, tool_name, meta_json, seq
const CHUNK_SIZE = 500;   // max rows per INSERT — keeps pg params < 4000

async function _bulkInsert(rows, client, onConflict = '') {
    if (!rows || rows.length === 0) return;

    const query = client
        ? (sql, params) => client.query(sql, params)
        : (sql, params) => run(sql, params);

    // Process in chunks to respect PG parameter limit
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        const valueClauses = [];
        const params = [];
        let idx = 1;

        for (const r of chunk) {
            valueClauses.push(
                `($${idx},$${idx+1},$${idx+2},$${idx+3},$${idx+4},$${idx+5},$${idx+6},$${idx+7})`
            );
            params.push(
                r.id,
                r.conversation_id,
                r.conversation_type,
                r.role,
                r.content,
                r.tool_name,
                r.meta_json,
                r.seq
            );
            idx += COLS;
        }

        await query(
            `INSERT INTO conversation_messages
                (id, conversation_id, conversation_type, role, content, tool_name, meta_json, seq)
             VALUES ${valueClauses.join(',')}
             ${onConflict}`,
            params
        );
    }
}


// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Migrate a legacy messages_json blob into the conversation_messages table.
 * Safe to call multiple times — checks messages_migrated flag first.
 * Returns true if migration happened, false if already migrated or nothing to do.
 *
 * Phase 5: Uses bulk INSERT instead of N individual INSERTs.
 */
async function migrateConversationIfNeeded(conversationId, type, messagesArray) {
    await initMessagesTable();
    if (!messagesArray || messagesArray.length === 0) return false;

    // Check if already migrated
    const existing = await getOne(
        'SELECT id FROM conversation_messages WHERE conversation_id = $1 LIMIT 1',
        [conversationId]
    );
    if (existing) return false; // already has rows

    const rows = messagesToRows(conversationId, type, messagesArray);

    // Phase 5: single bulk INSERT instead of N round-trips
    await _bulkInsert(rows, null, 'ON CONFLICT (id) DO NOTHING');

    // Mark as migrated on the parent table
    const parentTable = type === 'direct' ? 'direct_conversations' : 'agent_conversations';
    await run(
        `UPDATE ${parentTable} SET messages_migrated = TRUE WHERE id = $1`,
        [conversationId]
    );

    return true;
}

/**
 * Get all messages for a conversation, ordered by seq ASC.
 * Returns raw message objects ready for use by the AI runtime.
 */
async function getMessages(conversationId) {
    await initMessagesTable();
    const rows = await getAll(
        'SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY seq ASC',
        [conversationId]
    );
    return rows.map(rowToMessage);
}

/**
 * Replace all messages for a conversation (mirrors the old updateConversation behaviour).
 * Deletes existing rows and inserts the new full array atomically inside a transaction.
 * This is called by the dual-write shim in agentConversations / directConversations.
 *
 * Phase 5: Wraps DELETE + bulk INSERT in a single transaction.
 *   - A failed write now leaves the old messages intact (ROLLBACK) rather than
 *     leaving an empty conversation after a partial failure.
 *   - N round-trips → 1 round-trip (or ceil(N/500) for very long conversations).
 */
async function replaceMessages(conversationId, type, messagesArray) {
    await initMessagesTable();

    const client = await getClient();
    try {
        await client.query('BEGIN');

        // 1. Wipe existing rows for this conversation
        await client.query(
            'DELETE FROM conversation_messages WHERE conversation_id = $1',
            [conversationId]
        );

        // 2. Bulk insert new rows (no-op if empty)
        if (messagesArray && messagesArray.length > 0) {
            const rows = messagesToRows(conversationId, type, messagesArray);
            await _bulkInsert(rows, client);
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Check if a conversation has been migrated to the new table.
 */
async function isMigrated(conversationId) {
    await initMessagesTable();
    const row = await getOne(
        'SELECT id FROM conversation_messages WHERE conversation_id = $1 LIMIT 1',
        [conversationId]
    );
    return !!row;
}

module.exports = {
    initMessagesTable,
    migrateConversationIfNeeded,
    getMessages,
    replaceMessages,
    isMigrated,
};
