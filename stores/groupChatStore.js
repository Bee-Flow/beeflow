/**
 * Group Chat Store - PostgreSQL management for multi-agent group chats
 * Stores group chat configurations with participant agent references
 */

const { run, getOne, getAll, exec } = require('../db');
const { v4: uuidv4 } = require('uuid');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS group_chats (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            avatar TEXT,
            owner_id TEXT NOT NULL,
            participant_ids TEXT NOT NULL DEFAULT '[]',
            turn_mode TEXT DEFAULT 'round_robin',
            config TEXT DEFAULT '{}',
            is_published BOOLEAN DEFAULT FALSE,
            organization_id TEXT DEFAULT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_group_chats_owner ON group_chats(owner_id)`);
    initialized = true;
}

initDB().catch(err => console.error('[GroupChatStore] Init error:', err.message));

async function createGroupChat(name, description, avatar, ownerId, participantIds = [], turnMode = 'round_robin', config = {}, updates = {}) {
    await initDB();
    const id = uuidv4();
    await run(`
        INSERT INTO group_chats (id, name, description, avatar, owner_id, participant_ids, turn_mode, config, is_published, organization_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
        id, name, description || '', avatar || '👥', ownerId,
        JSON.stringify(participantIds), turnMode, JSON.stringify(config),
        false, updates?.organization_id || null
    ]);
    return getGroupChat(id);
}

async function getGroupChat(id) {
    await initDB();
    const row = await getOne('SELECT * FROM group_chats WHERE id = $1', [id]);
    if (!row) return null;
    return parseGroupChat(row);
}

async function getGroupChats(ownerId) {
    await initDB();
    const rows = await getAll('SELECT * FROM group_chats WHERE owner_id = $1 ORDER BY updated_at DESC', [ownerId]);
    return rows.map(parseGroupChat);
}

async function updateGroupChat(id, ownerId, updates) {
    await initDB();
    const existing = await getGroupChat(id);
    if (!existing) return null;

    await run(`
        UPDATE group_chats SET
            name = $1, description = $2, avatar = $3,
            participant_ids = $4, turn_mode = $5, config = $6,
            is_published = $7, organization_id = $8, updated_at = NOW()
        WHERE id = $9 AND owner_id = $10
    `, [
        updates.name ?? existing.name,
        updates.description ?? existing.description,
        updates.avatar ?? existing.avatar,
        JSON.stringify(updates.participantIds ?? existing.participantIds),
        updates.turnMode ?? existing.turnMode,
        JSON.stringify(updates.config ?? existing.config),
        updates.isPublished !== undefined ? !!updates.isPublished : !!existing.is_published,
        updates.organization_id !== undefined ? (updates.organization_id || null) : (existing.organization_id || null),
        id, ownerId
    ]);
    return getGroupChat(id);
}

async function deleteGroupChat(id, ownerId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM group_chats WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    return rowCount > 0;
}

function parseGroupChat(row) {
    return {
        ...row,
        participantIds: typeof row.participant_ids === 'string' ? JSON.parse(row.participant_ids || '[]') : (row.participant_ids || []),
        config: typeof row.config === 'string' ? JSON.parse(row.config || '{}') : (row.config || {}),
        _type: 'roundtable'
    };
}

module.exports = {
    createGroupChat,
    getGroupChat,
    getGroupChats,
    updateGroupChat,
    deleteGroupChat
};
