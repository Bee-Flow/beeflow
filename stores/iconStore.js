/**
 * Icon Store
 * Manages user-defined icon packs for customizing the app UI.
 *
 * An icon pack is a collection of overrides:
 *   { [iconKey]: { type: 'emoji', value: '🌟' } | { type: 'image', value: '/api/icons/data/...' } }
 *
 * Packs are scoped per user. A user has one active pack at a time
 * (stored on the user record as activeIconPackId).
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
            created_at TEXT,
            updated_at TEXT
        );
    `);
    // Add updated_at if missing (older deployments).
    try {
        await exec(`ALTER TABLE icon_packs ADD COLUMN IF NOT EXISTS updated_at TEXT`);
    } catch (_) { /* ignore — may not be supported on all engines */ }
    initialized = true;
}

initDB().catch(err => console.error('[IconStore] Init error:', err.message));

function parseJSON(str, fallback) {
    if (!str) return fallback;
    if (typeof str !== 'string') return str; // Already parsed
    try { return JSON.parse(str); } catch (e) { return fallback; }
}

function hydrate(row) {
    if (!row) return null;
    return { ...row, icons: parseJSON(row.icons, {}) };
}

async function getIconPacks(userId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM icon_packs WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
    );
    return rows.map(hydrate);
}

async function getIconPack(id) {
    await initDB();
    const row = await getOne('SELECT * FROM icon_packs WHERE id = $1', [id]);
    return hydrate(row);
}

async function createIconPack(userId, name, icons = {}) {
    await initDB();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await run(
        'INSERT INTO icon_packs (id, user_id, name, icons, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, userId, name, JSON.stringify(icons), now, now]
    );
    return { id, user_id: userId, name, icons, created_at: now, updated_at: now };
}

async function updateIconPack(id, userId, updates) {
    await initDB();
    const pack = await getIconPack(id);
    if (!pack || pack.user_id !== userId) return false;

    const name = updates.name !== undefined ? updates.name : pack.name;
    const icons = updates.icons !== undefined ? JSON.stringify(updates.icons) : JSON.stringify(pack.icons);
    const updatedAt = new Date().toISOString();

    await run(
        'UPDATE icon_packs SET name = $1, icons = $2, updated_at = $3 WHERE id = $4 AND user_id = $5',
        [name, icons, updatedAt, id, userId]
    );
    return true;
}

/**
 * Patch a single icon entry inside a pack. Pass `iconData = null` to clear the override.
 */
async function setIcon(packId, userId, iconKey, iconData) {
    const pack = await getIconPack(packId);
    if (!pack || pack.user_id !== userId) return null;

    const next = { ...(pack.icons || {}) };
    if (iconData === null || iconData === undefined) {
        delete next[iconKey];
    } else {
        next[iconKey] = iconData;
    }
    await updateIconPack(packId, userId, { icons: next });
    return next;
}

async function deleteIconPack(id, userId) {
    await initDB();
    const { rowCount } = await run(
        'DELETE FROM icon_packs WHERE id = $1 AND user_id = $2',
        [id, userId]
    );
    return rowCount > 0;
}

module.exports = {
    getIconPacks,
    getIconPack,
    createIconPack,
    updateIconPack,
    setIcon,
    deleteIconPack,
};
