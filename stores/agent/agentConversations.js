/**
 * Agent Conversations - CRUD, search, multi-conversation support for agent chat
 *
 * Phase 4: Dual-write architecture.
 *   - Reads: try conversation_messages table first (new); fall back to messages_json blob (legacy).
 *   - Writes: write to both conversation_messages (new) AND messages_json (legacy backup).
 *   - Old conversations are lazily migrated on first read.
 *
 * Rolling back is safe: old code still reads messages_json which stays in sync.
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const { encryptMessages, decryptMessages } = require('./messageEncryption');
const convMessages = require('./conversationMessages');

// ============ Basic Conversation CRUD ============

async function getConversation(agentId, userId, encryptionKey = null) {
    await initDB();
    const row = await getOne('SELECT * FROM agent_conversations WHERE agent_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 1', [agentId, userId]);
    if (!row) return null;
    const messages = await _readMessages(row, encryptionKey);
    const meta = _parseMeta(row.meta_json);
    return { ...row, messages, meta };
}

function _parseMeta(metaJson) {
    try { return JSON.parse(metaJson || '{}'); } catch (_) { return {}; }
}

/**
 * Merge partial fields into the conversation's meta_json. Used to persist
 * conversation-scoped state (e.g. compactionSummary). Safe against
 * concurrent writers because the merge uses a single UPDATE ... jsonb
 * read-modify-write round-trip; collisions overwrite last-writer-wins,
 * which is acceptable for this data.
 */
async function updateConversationMeta(conversationId, partial) {
    if (!partial || typeof partial !== 'object' || Object.keys(partial).length === 0) return;
    await initDB();
    const existing = await getOne('SELECT meta_json FROM agent_conversations WHERE id = $1', [conversationId]);
    if (!existing) return;
    const merged = { ..._parseMeta(existing.meta_json), ...partial };
    await run('UPDATE agent_conversations SET meta_json = $1 WHERE id = $2', [JSON.stringify(merged), conversationId]);
}

async function getOrCreateConversation(agentId, userId, encryptionKey = null) {
    let conv = await getConversation(agentId, userId, encryptionKey);
    if (!conv) {
        const id = uuidv4();
        await run("INSERT INTO agent_conversations (id, agent_id, user_id, messages_json, created_at, updated_at) VALUES ($1,$2,$3,'[]',NOW(),NOW())", [id, agentId, userId]);
        conv = { id, agent_id: agentId, user_id: userId, messages: [] };
    }
    return conv;
}

async function createNewConversation(agentId, userId) {
    await initDB();
    const id = uuidv4();
    await run("INSERT INTO agent_conversations (id, agent_id, user_id, messages_json, created_at, updated_at) VALUES ($1,$2,$3,'[]',NOW(),NOW())", [id, agentId, userId]);
    return { id, agent_id: agentId, user_id: userId, messages: [] };
}

/**
 * Phase 4 dual-write: persist messages to conversation_messages table (new, fast) AND
 * keep messages_json updated as a backup for rollback safety.
 */
async function updateConversation(conversationId, messages, encryptionKey = null, userId = null) {
    await initDB();

    // ── New table write (Phase 4) — fire and forget, blob is the safety net ──
    convMessages.replaceMessages(conversationId, 'agent', messages).catch(err =>
        console.error('[AgentConversations] conversation_messages write error:', err.message)
    );

    // ── Legacy blob write (kept for rollback safety) ──────────────────────────
    const messagesJson = JSON.stringify(messages);
    const storedData = encryptMessages(messagesJson, encryptionKey, conversationId, userId);
    await run('UPDATE agent_conversations SET messages_json = $1, updated_at = NOW() WHERE id = $2', [storedData, conversationId]);
}

async function clearConversation(agentId, userId) {
    await initDB();
    const rows = await getAll('SELECT id FROM agent_conversations WHERE agent_id = $1 AND user_id = $2', [agentId, userId]);
    for (const row of rows) {
        await run('DELETE FROM conversation_messages WHERE conversation_id = $1', [row.id]).catch(() => {});
    }
    await run('DELETE FROM agent_conversations WHERE agent_id = $1 AND user_id = $2', [agentId, userId]);
}

async function updateConversationWorkspace(conversationId, content, notebookId = null) {
    await initDB();
    if (notebookId !== null) {
        await run('UPDATE agent_conversations SET workspace_content = $1, workspace_notebook_id = $2, updated_at = NOW() WHERE id = $3', [content, notebookId, conversationId]);
    } else {
        await run('UPDATE agent_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2', [content, conversationId]);
    }
}

async function getConversationWorkspace(conversationId) {
    await initDB();
    const row = await getOne('SELECT workspace_content, workspace_notebook_id FROM agent_conversations WHERE id = $1', [conversationId]);
    return row ? { content: row.workspace_content || '', notebookId: row.workspace_notebook_id || null } : null;
}

// ============ Multi-Conversation ============

async function listConversations(agentId, userId) {
    await initDB();
    return getAll('SELECT id, agent_id, user_id, title, project_id, pinned, labels_json, created_at, updated_at FROM agent_conversations WHERE agent_id = $1 AND user_id = $2 ORDER BY updated_at DESC', [agentId, userId]);
}

async function listAllConversations(userId) {
    await initDB();
    return getAll(`SELECT c.id, c.agent_id, c.user_id, c.title, c.project_id, c.pinned, c.labels_json, c.created_at, c.updated_at,
        a.name as agent_name, a.avatar as agent_avatar
        FROM agent_conversations c
        LEFT JOIN agents a ON c.agent_id = a.id
        WHERE c.user_id = $1
        ORDER BY c.updated_at DESC
        LIMIT 50`, [userId]);
}

async function searchConversations(userId, query, filters = {}, encryptionKey) {
    await initDB();

    // ── Phase 6: SQL-side search ──────────────────────────────────────────────
    // Old approach: load every conversation + messages into Node.js, then do
    //   JS string matching (O(n) queries + O(n) memory).
    //
    // New approach — three strategies, applied in priority order:
    //
    //  Strategy A (SQL JOIN — zero extra queries):
    //    For title matches AND migrated-conversation content matches.
    //    One query with LEFT JOIN on conversation_messages finds both in one shot.
    //
    //  Strategy B (SQL ILIKE on blob — no encryption):
    //    If no encryption key, the messages_json blob is plain text, so we can
    //    search it directly in SQL for non-migrated conversations.
    //
    //  Strategy C (JS fallback — encrypted blobs only):
    //    Only reached when encryptionKey is set AND conversations aren't migrated
    //    yet. Bounded to 200 rows max (vs. the old unbounded loop).
    // ─────────────────────────────────────────────────────────────────────────

    const likeQuery = `%${query}%`;
    const lowerQuery = query.toLowerCase();

    // Base filter params (userId is always $1)
    const filterParams = [userId];
    let filterClauses = '';
    let filterIdx = 2;
    if (filters.agentId) { filterClauses += ` AND c.agent_id = $${filterIdx++}`; filterParams.push(filters.agentId); }
    if (filters.startDate) { filterClauses += ` AND c.updated_at >= $${filterIdx++}`; filterParams.push(filters.startDate); }

    // likeQuery is the next param after the filter params
    const likeIdx = filterIdx; // e.g. $2 if no filters, $3 if agentId, etc.

    // ── Strategy A: title OR migrated message content (single JOIN query) ────
    const stratA = await getAll(`
        SELECT DISTINCT
            c.id, c.agent_id, c.user_id, c.title, c.updated_at,
            c.messages_migrated,
            a.name AS agent_name, a.avatar AS agent_avatar
        FROM agent_conversations c
        LEFT JOIN agents a ON c.agent_id = a.id
        LEFT JOIN conversation_messages cm
            ON cm.conversation_id = c.id AND c.messages_migrated = TRUE
        WHERE c.user_id = $1
          AND (c.title ILIKE $${likeIdx} OR cm.content ILIKE $${likeIdx})
          ${filterClauses}
        ORDER BY c.updated_at DESC
        LIMIT 50
    `, [...filterParams, likeQuery]);

    const results = [...stratA];
    const matchedIds = new Set(results.map(r => r.id));

    if (results.length < 50) {
        if (!encryptionKey) {
            // ── Strategy B: non-migrated blobs, no encryption — search in SQL ──
            const remaining = 50 - results.length;
            const stratB = await getAll(`
                SELECT
                    c.id, c.agent_id, c.user_id, c.title, c.updated_at,
                    c.messages_migrated,
                    a.name AS agent_name, a.avatar AS agent_avatar
                FROM agent_conversations c
                LEFT JOIN agents a ON c.agent_id = a.id
                WHERE c.user_id = $1
                  AND c.messages_migrated = FALSE
                  AND c.messages_json ILIKE $${likeIdx}
                  ${filterClauses}
                ORDER BY c.updated_at DESC
                LIMIT ${remaining}
            `, [...filterParams, likeQuery]);

            for (const r of stratB) {
                if (!matchedIds.has(r.id)) { results.push(r); matchedIds.add(r.id); }
            }
        } else {
            // ── Strategy C: non-migrated encrypted blobs — bounded JS fallback ──
            const remaining = 50 - results.length;
            const encCandidates = await getAll(`
                SELECT
                    c.id, c.agent_id, c.user_id, c.title, c.updated_at,
                    c.messages_json, c.messages_migrated,
                    a.name AS agent_name, a.avatar AS agent_avatar
                FROM agent_conversations c
                LEFT JOIN agents a ON c.agent_id = a.id
                WHERE c.user_id = $1
                  AND c.messages_migrated = FALSE
                  ${filterClauses}
                ORDER BY c.updated_at DESC
                LIMIT 200
            `, filterParams);

            for (const conv of encCandidates) {
                if (matchedIds.has(conv.id) || results.length >= 50) break;
                try {
                    const decrypted = decryptMessages(conv.messages_json || '[]', encryptionKey, conv.id, userId);
                    if (decrypted.toLowerCase().includes(lowerQuery)) {
                        results.push({ ...conv, messages_json: decrypted });
                        matchedIds.add(conv.id);
                    }
                } catch (e) {
                    console.error('[AgentConversations] Search decrypt error:', e);
                }
            }
        }
    }

    // Return unified results sorted by recency, capped at 50
    return results
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .slice(0, 50);
}

async function getConversationById(conversationId, encryptionKey = null) {
    await initDB();
    const row = await getOne('SELECT * FROM agent_conversations WHERE id = $1', [conversationId]);
    if (!row) return null;
    const messages = await _readMessages(row, encryptionKey);
    return { ...row, messages, meta: _parseMeta(row.meta_json), threadTitles: JSON.parse(row.thread_titles_json || '{}') };
}

async function createConversation(agentId, userId, title = 'New Chat') {
    await initDB();
    const id = uuidv4();
    await run("INSERT INTO agent_conversations (id, agent_id, user_id, title, messages_json, created_at, updated_at) VALUES ($1,$2,$3,$4,'[]',NOW(),NOW())", [id, agentId, userId, title]);
    return { id, agent_id: agentId, user_id: userId, title, messages: [], threadTitles: {} };
}

async function updateConversationTitle(conversationId, title) {
    await initDB();
    await run('UPDATE agent_conversations SET title = $1 WHERE id = $2', [title, conversationId]);
}

async function pinConversation(conversationId, pinned) {
    await initDB();
    await run('UPDATE agent_conversations SET pinned = $1 WHERE id = $2', [!!pinned, conversationId]);
}

async function setConversationLabels(conversationId, labels) {
    await initDB();
    await run('UPDATE agent_conversations SET labels_json = $1 WHERE id = $2', [JSON.stringify(labels), conversationId]);
}

async function updateThreadTitles(conversationId, threadTitles) {
    await initDB();
    await run('UPDATE agent_conversations SET thread_titles_json = $1 WHERE id = $2', [JSON.stringify(threadTitles), conversationId]);
}

async function deleteConversationById(conversationId) {
    await initDB();
    await run('DELETE FROM conversation_messages WHERE conversation_id = $1', [conversationId]).catch(() => {});
    await run('DELETE FROM agent_conversations WHERE id = $1', [conversationId]);
    // Drop any DLP token map / remembered choice for this conversation so a new
    // conversation reusing the same ID (unlikely but possible) starts clean.
    try { require('../../core/dlp/dlpRunner').clearConversationState(conversationId); } catch (_) { /* module not loaded yet */ }
}

// ── Internal: read messages, preferring new table, lazy-migrating from blob ──

async function _readMessages(row, encryptionKey) {
    // Phase 7a: Use the messages_migrated flag already present on the fetched row
    // instead of calling isMigrated() which fires an extra SELECT LIMIT 1 per read.
    if (row.messages_migrated) {
        try {
            return await convMessages.getMessages(row.id);
        } catch (e) {
            console.warn('[AgentConversations] New table read failed, using blob fallback:', e.message);
        }
    }

    // Legacy blob fallback (row not yet migrated, or new-table read failed)
    const messagesJson = decryptMessages(row.messages_json || '[]', encryptionKey, row.id, row.user_id);
    const messages = JSON.parse(messagesJson);

    // Kick off lazy migration in background — does not block the response
    convMessages.migrateConversationIfNeeded(row.id, 'agent', messages).catch(err =>
        console.error('[AgentConversations] Lazy migration error:', err.message)
    );

    return messages;
}

module.exports = {
    getConversation, getOrCreateConversation, createNewConversation,
    updateConversation, clearConversation, updateConversationWorkspace, getConversationWorkspace,
    listConversations, listAllConversations, searchConversations,
    getConversationById, createConversation,
    updateConversationTitle, pinConversation, setConversationLabels, updateThreadTitles, deleteConversationById,
    updateConversationMeta,
};
