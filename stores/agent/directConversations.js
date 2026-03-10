/**
 * Direct Conversations - Chat without an agent (direct LLM access)
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./initSchema');

async function createDirectConversation(userId, modelTier = 'fast') {
    await initDB();
    const id = uuidv4();
    await run("INSERT INTO direct_conversations (id, user_id, title, messages_json, model_tier, created_at, updated_at) VALUES ($1,$2,'New Chat','[]',$3,NOW(),NOW())", [id, userId, modelTier]);
    return { id, title: 'New Chat', messages: [], model_tier: modelTier };
}

async function getDirectConversation(id, userId) {
    await initDB();
    const row = await getOne('SELECT * FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!row) return null;
    const meta = JSON.parse(row.meta_json || '{}');
    return { ...row, messages: JSON.parse(row.messages_json || '[]'), ...meta };
}

async function listDirectConversations(userId) {
    await initDB();
    return getAll('SELECT id, title, model_tier, project_id, created_at, updated_at FROM direct_conversations WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
}

async function updateDirectConversation(id, messages, userId, meta = null) {
    await initDB();
    if (meta && Object.keys(meta).length > 0) {
        // Merge new metadata with existing
        const existing = await getOne('SELECT meta_json FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
        const existingMeta = JSON.parse(existing?.meta_json || '{}');
        const merged = { ...existingMeta, ...meta };
        const { rowCount } = await run('UPDATE direct_conversations SET messages_json = $1, meta_json = $2, updated_at = NOW() WHERE id = $3 AND user_id = $4',
            [JSON.stringify(messages), JSON.stringify(merged), id, userId]);
        return rowCount > 0;
    }
    const { rowCount } = await run('UPDATE direct_conversations SET messages_json = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', [JSON.stringify(messages), id, userId]);
    return rowCount > 0;
}

async function updateDirectConversationTitle(id, title, userId) {
    await initDB();
    const { rowCount } = await run('UPDATE direct_conversations SET title = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3', [title, id, userId]);
    return rowCount > 0;
}

async function deleteDirectConversation(id, userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM direct_conversations WHERE id = $1 AND user_id = $2', [id, userId]);
    return rowCount > 0;
}

async function updateDirectConversationWorkspace(id, content) {
    await initDB();
    await run('UPDATE direct_conversations SET workspace_content = $1, updated_at = NOW() WHERE id = $2', [content, id]);
}

async function getDirectConversationWorkspace(id) {
    await initDB();
    const row = await getOne('SELECT workspace_content FROM direct_conversations WHERE id = $1', [id]);
    return row ? { content: row.workspace_content || '' } : null;
}

module.exports = {
    createDirectConversation, getDirectConversation, listDirectConversations,
    updateDirectConversation, updateDirectConversationTitle, deleteDirectConversation,
    updateDirectConversationWorkspace, getDirectConversationWorkspace,
};
