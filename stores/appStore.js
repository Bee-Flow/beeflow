/**
 * App Store - PostgreSQL management for Published Apps
 * Stores app metadata and HTML code for the App Marketplace
 */

const { run, getOne, getAll, exec } = require('../db');
const { v4: uuidv4 } = require('uuid');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS apps (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            code TEXT NOT NULL,
            thumbnail TEXT,
            created_by TEXT NOT NULL,
            created_by_username TEXT,
            is_published BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_apps_published ON apps(is_published)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_apps_created_by ON apps(created_by)`);
    initialized = true;
}

initDB().catch(err => console.error('[AppStore] Init error:', err.message));

async function createApp(name, description, code, createdBy, createdByUsername = null, thumbnail = null, isPublished = true) {
    await initDB();
    const id = uuidv4();
    await run(`
        INSERT INTO apps (id, name, description, code, thumbnail, created_by, created_by_username, is_published)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, name, description || '', code, thumbnail, createdBy, createdByUsername, isPublished]);
    return { id, name, description, code, thumbnail, created_by: createdBy, created_by_username: createdByUsername, is_published: isPublished };
}

async function getPublishedApps() {
    await initDB();
    return getAll('SELECT * FROM apps WHERE is_published = TRUE ORDER BY created_at DESC');
}

async function getAllApps() {
    await initDB();
    return getAll('SELECT * FROM apps ORDER BY created_at DESC');
}

async function getApp(id) {
    await initDB();
    return getOne('SELECT * FROM apps WHERE id = $1', [id]);
}

async function updateApp(id, name, description, code, thumbnail = null, isPublished = true) {
    await initDB();
    const { rowCount } = await run(`
        UPDATE apps SET name = $1, description = $2, code = $3, thumbnail = $4, is_published = $5, updated_at = NOW()
        WHERE id = $6
    `, [name, description || '', code, thumbnail, isPublished, id]);
    return rowCount > 0;
}

async function deleteApp(id) {
    await initDB();
    const { rowCount } = await run('DELETE FROM apps WHERE id = $1', [id]);
    return rowCount > 0;
}

async function getAppsByUser(userId) {
    await initDB();
    return getAll('SELECT * FROM apps WHERE created_by = $1 ORDER BY created_at DESC', [userId]);
}

module.exports = {
    createApp,
    getPublishedApps,
    getAllApps,
    getApp,
    updateApp,
    deleteApp,
    getAppsByUser
};
