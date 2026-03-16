/**
 * Conversation Labels - User-defined labels for organizing conversations
 */

const { v4: uuidv4 } = require('uuid');
const { run, getAll } = require('../../db');
const { initDB } = require('./initSchema');

async function listLabels(userId) {
    await initDB();
    return getAll('SELECT id, name, color, created_at FROM conversation_labels WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
}

async function createLabel(userId, name, color) {
    await initDB();
    const id = uuidv4();
    await run('INSERT INTO conversation_labels (id, user_id, name, color) VALUES ($1, $2, $3, $4)', [id, userId, name, color]);
    return { id, name, color };
}

async function updateLabel(id, userId, updates) {
    await initDB();
    const sets = [];
    const params = [];
    let idx = 1;
    if (updates.name !== undefined) { sets.push(`name = $${idx++}`); params.push(updates.name); }
    if (updates.color !== undefined) { sets.push(`color = $${idx++}`); params.push(updates.color); }
    if (sets.length === 0) return false;
    params.push(id, userId);
    const { rowCount } = await run(`UPDATE conversation_labels SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`, params);
    return rowCount > 0;
}

async function deleteLabel(id, userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM conversation_labels WHERE id = $1 AND user_id = $2', [id, userId]);
    return rowCount > 0;
}

module.exports = { listLabels, createLabel, updateLabel, deleteLabel };
