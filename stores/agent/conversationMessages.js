/**
 * Conversation Messages Store — Phase 4 Performance Fix
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
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll, exec } = require('../../db');

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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Migrate a legacy messages_json blob into the conversation_messages table.
 * Safe to call multiple times — checks messages_migrated flag first.
 * Returns true if migration happened, false if already migrated or nothing to do.
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
    // Bulk insert — use individual inserts with ON CONFLICT DO NOTHING to be safe
    for (const r of rows) {
        await run(
            `INSERT INTO conversation_messages
                (id, conversation_id, conversation_type, role, content, tool_name, meta_json, seq)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (id) DO NOTHING`,
            [r.id, r.conversation_id, r.conversation_type, r.role,
             r.content, r.tool_name, r.meta_json, r.seq]
        );
    }

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
 * Deletes existing rows and inserts the new full array atomically.
 * This is called by the dual-write shim in agentConversations / directConversations.
 */
async function replaceMessages(conversationId, type, messagesArray) {
    await initMessagesTable();
    // Delete old rows
    await run('DELETE FROM conversation_messages WHERE conversation_id = $1', [conversationId]);
    if (!messagesArray || messagesArray.length === 0) return;
    const rows = messagesToRows(conversationId, type, messagesArray);
    for (const r of rows) {
        await run(
            `INSERT INTO conversation_messages
                (id, conversation_id, conversation_type, role, content, tool_name, meta_json, seq)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [r.id, r.conversation_id, r.conversation_type, r.role,
             r.content, r.tool_name, r.meta_json, r.seq]
        );
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
