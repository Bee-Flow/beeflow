/**
 * Icon Store
 * Manages user-defined icon packs for customizing the app UI.
 */

const { run, getOne, getAll, exec } = require('../db');
const crypto = require('crypto');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS icon_packs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            icons TEXT DEFAULT '{}',
            created_at TEXT
        );
    `);
    initialized = true;
}

initDB().catch(err => console.error('[IconStore] Init error:', err.message));

function parseJSON(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch (e) { return fallback; }
}

async function getIconPacks(userId) {
    await initDB();
    const rows = await getAll('SELECT * FROM icon_packs WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return rows.map(r => ({ ...r, icons: parseJSON(r.icons, {}) }));
}

async function getIconPack(id) {
    await initDB();
    const row = await getOne('SELECT * FROM icon_packs WHERE id = $1', [id]);
    if (!row) return null;
    return { ...row, icons: parseJSON(row.icons, {}) };
}

async function createIconPack(userId, name, icons = {}) {
    await initDB();
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    try {
        await run(
            'INSERT INTO icon_packs (id, user_id, name, icons, created_at) VALUES ($1, $2, $3, $4, $5)',
            [id, userId, name, JSON.stringify(icons), createdAt]
        );
        return { id, user_id: userId, name, icons, created_at: createdAt };
    } catch (e) {
        console.error('[IconStore] Error creating icon pack:', e);
        return null;
    }
}

async function updateIconPack(id, userId, updates) {
    await initDB();
    const pack = await getIconPack(id);
    if (!pack || pack.user_id !== userId) return false;

    const name = updates.name !== undefined ? updates.name : pack.name;
    const icons = updates.icons !== undefined ? JSON.stringify(updates.icons) : JSON.stringify(pack.icons);

    try {
        await run('UPDATE icon_packs SET name = $1, icons = $2 WHERE id = $3 AND user_id = $4', [name, icons, id, userId]);
        return true;
    } catch (e) {
        console.error('[IconStore] Error updating icon pack:', e);
        return false;
    }
}

async function deleteIconPack(id, userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM icon_packs WHERE id = $1 AND user_id = $2', [id, userId]);
    return rowCount > 0;
}

module.exports = {
    getIconPacks,
    getIconPack,
    createIconPack,
    updateIconPack,
    deleteIconPack,
};
