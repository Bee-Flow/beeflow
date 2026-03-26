/**
 * Agent Conversations - CRUD, search, multi-conversation support for agent chat
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');
const { encryptMessages, decryptMessages } = require('./messageEncryption');

// ============ Basic Conversation CRUD ============

async function getConversation(agentId, userId, encryptionKey = null) {
    await initDB();
    const row = await getOne('SELECT * FROM agent_conversations WHERE agent_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT 1', [agentId, userId]);
    if (!row) return null;
    const messagesJson = decryptMessages(row.messages_json || '[]', encryptionKey, row.id, userId);
    return { ...row, messages: JSON.parse(messagesJson) };
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

async function updateConversation(conversationId, messages, encryptionKey = null, userId = null) {
    await initDB();
    const messagesJson = JSON.stringify(messages);
    const storedData = encryptMessages(messagesJson, encryptionKey, conversationId, userId);
    await run('UPDATE agent_conversations SET messages_json = $1, updated_at = NOW() WHERE id = $2', [storedData, conversationId]);
}

async function clearConversation(agentId, userId) {
    await initDB();
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
    let sql = `SELECT c.id, c.agent_id, c.user_id, c.title, c.updated_at, c.messages_json,
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
            const messagesJson = decryptMessages(conv.messages_json || '[]', encryptionKey, conv.id, userId);
            const titleMatch = conv.title && conv.title.toLowerCase().includes(lowerQuery);
            const messageMatch = messagesJson.toLowerCase().includes(lowerQuery);
            if (titleMatch || messageMatch) {
                results.push({ ...conv, messages_json: messagesJson });
            }
            if (results.length >= 50) break;
        } catch (e) {
            console.error('[AgentConversations] Search decryption error:', e);
        }
    }
    return results;
}

async function getConversationById(conversationId, encryptionKey = null) {
    await initDB();
    const row = await getOne('SELECT * FROM agent_conversations WHERE id = $1', [conversationId]);
    if (!row) return null;
    const messagesJson = decryptMessages(row.messages_json || '[]', encryptionKey, conversationId, row.user_id);
    return { ...row, messages: JSON.parse(messagesJson), threadTitles: JSON.parse(row.thread_titles_json || '{}') };
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
    await run('DELETE FROM agent_conversations WHERE id = $1', [conversationId]);
}

module.exports = {
    getConversation, getOrCreateConversation, createNewConversation,
    updateConversation, clearConversation, updateConversationWorkspace, getConversationWorkspace,
    listConversations, listAllConversations, searchConversations,
    getConversationById, createConversation,
    updateConversationTitle, pinConversation, setConversationLabels, updateThreadTitles, deleteConversationById,
};
