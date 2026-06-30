/**
 * Notebook Conversation Store — persistent, encrypted chat history for the
 * in-notebook AI chat (regular notebooks AND legal_matter dossiers).
 *
 * Why a dedicated table instead of reusing agent_/direct_conversations:
 *   - `agent_conversations.agent_id` is NOT NULL with an FK to `agents`, so a
 *     notebook (which has no agent) can't own a row without a fake agent.
 *   - `direct_conversations` and the `conversation_messages` table both store
 *     message content in PLAINTEXT. The user asked for audit-grade, encrypted
 *     persistence (Dutch-law legal drafting record), so we persist an
 *     AES-256-GCM envelope here via the shared messageEncryption module.
 *
 * One row per (notebook_id, user_id). Messages are stored as a single
 * encrypted JSON blob, re-encrypted on each turn. This mirrors how
 * agent_conversations keeps its encrypted legacy blob, and keeps the schema
 * trivial. Encryption is best-effort: when the caller has no session DEK
 * (zero-knowledge / OPAQUE clients hold the key client-side) the blob is
 * stored as plaintext JSON, exactly like the existing direct-chat path.
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, exec } = require('../db');
const { encryptMessages, decryptMessages } = require('./agent/messageEncryption');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS notebook_conversations (
            id            TEXT PRIMARY KEY,
            notebook_id   TEXT NOT NULL,
            user_id       TEXT NOT NULL,
            messages_json TEXT NOT NULL DEFAULT '[]',
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (notebook_id, user_id)
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_notebook_conv_nb_user ON notebook_conversations(notebook_id, user_id)`);
    initialized = true;
}

initDB().catch(err => console.error('[NotebookConversationStore] Init error:', err.message));

async function _getRow(notebookId, userId) {
    await initDB();
    return getOne('SELECT * FROM notebook_conversations WHERE notebook_id = $1 AND user_id = $2', [notebookId, userId]);
}

/**
 * Return the conversation row for (notebook, user), creating it on first use.
 * The INSERT is ON CONFLICT DO NOTHING so two concurrent tabs racing the first
 * message can't create duplicate rows.
 */
async function getOrCreate(notebookId, userId) {
    await initDB();
    let row = await _getRow(notebookId, userId);
    if (!row) {
        const id = uuidv4();
        await run(
            `INSERT INTO notebook_conversations (id, notebook_id, user_id, messages_json)
             VALUES ($1, $2, $3, '[]')
             ON CONFLICT (notebook_id, user_id) DO NOTHING`,
            [id, notebookId, userId],
        );
        row = await _getRow(notebookId, userId);
    }
    return row;
}

function _decode(row, encryptionKey, userId) {
    if (!row) return [];
    // The blob is encrypted under the row id (stable HKDF context) + userId AAD.
    const json = decryptMessages(row.messages_json || '[]', encryptionKey || null, row.id, userId);
    try {
        const arr = JSON.parse(json);
        return Array.isArray(arr) ? arr : [];
    } catch (_) {
        return [];
    }
}

/**
 * Decrypted message history for (notebook, user). [] when none yet.
 */
async function getMessages(notebookId, userId, encryptionKey = null) {
    const row = await _getRow(notebookId, userId);
    return _decode(row, encryptionKey, userId);
}

/**
 * Append a completed turn (one or more messages) to the conversation and
 * persist the re-encrypted blob. Returns the full merged array.
 */
async function appendMessages(notebookId, userId, encryptionKey, newMessages) {
    if (!Array.isArray(newMessages) || newMessages.length === 0) return null;
    const row = await getOrCreate(notebookId, userId);
    if (!row) return null;
    const existing = _decode(row, encryptionKey, userId);
    const merged = [...existing, ...newMessages];
    const stored = encryptMessages(JSON.stringify(merged), encryptionKey || null, row.id, userId);
    const { rowCount } = await run(
        'UPDATE notebook_conversations SET messages_json = $1, updated_at = NOW() WHERE id = $2',
        [stored, row.id],
    );
    if (!rowCount) {
        // Row vanished between read and write (deleted notebook) — surface it so
        // a silent persist failure can't masquerade as success.
        console.warn(`[NotebookConversationStore] append found no row for notebook ${notebookId} / user ${userId}`);
        return null;
    }
    return merged;
}

/**
 * Overwrite the full history (used when the client reconciles a truncated/edited
 * conversation). Returns the stored array.
 */
async function replaceMessages(notebookId, userId, encryptionKey, messages) {
    const safe = Array.isArray(messages) ? messages : [];
    const row = await getOrCreate(notebookId, userId);
    if (!row) return null;
    const stored = encryptMessages(JSON.stringify(safe), encryptionKey || null, row.id, userId);
    await run('UPDATE notebook_conversations SET messages_json = $1, updated_at = NOW() WHERE id = $2', [stored, row.id]);
    return safe;
}

/**
 * Clear/delete the conversation for a notebook. Called when a notebook (or a
 * legal matter) is deleted, and from the "clear chat" affordance.
 */
async function deleteForNotebook(notebookId, userId = null) {
    await initDB();
    if (userId) {
        await run('DELETE FROM notebook_conversations WHERE notebook_id = $1 AND user_id = $2', [notebookId, userId]);
    } else {
        await run('DELETE FROM notebook_conversations WHERE notebook_id = $1', [notebookId]);
    }
}

module.exports = {
    initDB,
    getOrCreate,
    getMessages,
    appendMessages,
    replaceMessages,
    deleteForNotebook,
};
