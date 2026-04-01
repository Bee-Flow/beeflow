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
    return { ...row, messages };
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
    let sql = `SELECT c.id, c.agent_id, c.user_id, c.title, c.updated_at, c.messages_json, c.messages_migrated,
        a.name as agent_name, a.avatar as agent_avatar
        FROM agent_conversations c
        LEFT JOIN agents a ON c.agent_id = a.id
        WHERE c.user_id = $1`;
    const params = [userId];
    let idx = 2;

    if (filters.agentId) { sql += ` AND c.agent_id = $${idx++}`; params.push(filters.agentId); }
    if (filters.startDate) { sql += ` AND c.updated_at >= $${idx++}`; params.push(filters.startDate); }
    sql += ' ORDER BY c.updated_at DESC';

    const candidates = await getAll(sql, params);
    const results = [];
    const lowerQuery = query.toLowerCase();

    for (const conv of candidates) {
        try {
            let messagesJson;
            if (conv.messages_migrated) {
                const msgs = await convMessages.getMessages(conv.id);
                messagesJson = JSON.stringify(msgs);
            } else {
                messagesJson = decryptMessages(conv.messages_json || '[]', encryptionKey, conv.id, userId);
            }
            const titleMatch = conv.title && conv.title.toLowerCase().includes(lowerQuery);
            const messageMatch = messagesJson.toLowerCase().includes(lowerQuery);
            if (titleMatch || messageMatch) {
                results.push({ ...conv, messages_json: messagesJson });
            }
            if (results.length >= 50) break;
        } catch (e) {
            console.error('[AgentConversations] Search error:', e);
        }
    }
    return results;
}

async function getConversationById(conversationId, encryptionKey = null) {
    await initDB();
    const row = await getOne('SELECT * FROM agent_conversations WHERE id = $1', [conversationId]);
    if (!row) return null;
    const messages = await _readMessages(row, encryptionKey);
    return { ...row, messages, threadTitles: JSON.parse(row.thread_titles_json || '{}') };
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
}

// ── Internal: read messages, preferring new table, lazy-migrating from blob ──

async function _readMessages(row, encryptionKey) {
    try {
        const hasMigrated = await convMessages.isMigrated(row.id);
        if (hasMigrated) {
            return await convMessages.getMessages(row.id);
        }
    } catch (e) {
        console.warn('[AgentConversations] New table read failed, using blob fallback:', e.message);
    }

    // Legacy blob fallback
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
};
