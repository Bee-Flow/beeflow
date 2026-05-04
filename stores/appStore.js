/**
 * App Store - PostgreSQL management for Published Apps
 * Stores app metadata and HTML code for the App Marketplace.
 *
 * Apps now follow the same publish/audience model as agents and KBs:
 *   - `organization_id` scopes the app to an org (NULL = legacy global app)
 *   - `is_published` controls whether non-owners in the org can see it
 *   - `shared_groups` optionally restricts visibility to specific groups
 *     within that org (empty array = entire org)
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

    // Audience columns — added after the original schema. Idempotent.
    try { await exec(`ALTER TABLE apps ADD COLUMN IF NOT EXISTS organization_id TEXT`); } catch (_) { /* exists */ }
    try { await exec(`ALTER TABLE apps ADD COLUMN IF NOT EXISTS shared_groups TEXT DEFAULT '[]'`); } catch (_) { /* exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_apps_org ON apps(organization_id) WHERE organization_id IS NOT NULL`); } catch (_) { /* exists */ }

    // Backfill: pre-existing apps had no org. Inherit it from the creator's
    // direct organization so they don't disappear from the marketplace
    // immediately after this migration. Apps whose creator has no org stay
    // global (organization_id IS NULL) — only super admins see them.
    try {
        await run(`
            UPDATE apps a
            SET organization_id = u."organizationId"
            FROM users u
            WHERE a.organization_id IS NULL
              AND a.created_by = u.id
              AND u."organizationId" IS NOT NULL
        `);
    } catch (e) { /* users table shape may differ in test fixtures — tolerate */ }

    initialized = true;
}

initDB().catch(err => console.error('[AppStore] Init error:', err.message));

async function createApp(name, description, code, createdBy, createdByUsername = null, thumbnail = null, isPublished = true, organizationId = null, sharedGroups = []) {
    await initDB();
    const id = uuidv4();
    const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
    await run(`
        INSERT INTO apps (id, name, description, code, thumbnail, created_by, created_by_username, is_published, organization_id, shared_groups)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [id, name, description || '', code, thumbnail, createdBy, createdByUsername, isPublished, organizationId || null, groupsJson]);
    return {
        id, name, description, code, thumbnail,
        created_by: createdBy, created_by_username: createdByUsername,
        is_published: isPublished,
        organization_id: organizationId || null,
        shared_groups: Array.isArray(sharedGroups) ? sharedGroups : [],
    };
}

async function getPublishedApps() {
    await initDB();
    return getAll('SELECT * FROM apps WHERE is_published = TRUE ORDER BY created_at DESC');
}

/**
 * List published apps visible to a specific user, applying the same
 * org + shared_groups rules used by agents and KBs.
 *
 * @param {Set|null} userOrgIds - From resolveUserOrgIds(req). null = super admin.
 * @param {string[]} userGroups - User's group IDs.
 * @param {string} userId - For owner-pass-through on personal drafts.
 */
async function getPublishedAppsForUser(userOrgIds, userGroups = [], userId = null) {
    await initDB();
    const all = await getAll('SELECT * FROM apps WHERE is_published = TRUE ORDER BY created_at DESC');
    if (userOrgIds === null) return all; // super admin

    return all.filter(app => {
        if (userId && app.created_by === userId) return true;
        // Org isolation
        if (!app.organization_id) return false;
        if (!(userOrgIds instanceof Set) || !userOrgIds.has(app.organization_id)) return false;
        // Group restriction
        let groups = [];
        try { groups = JSON.parse(app.shared_groups || '[]'); } catch (_) { /* */ }
        if (!Array.isArray(groups) || groups.length === 0) return true;
        return groups.some(g => userGroups.includes(g));
    });
}

async function getAllApps() {
    await initDB();
    return getAll('SELECT * FROM apps ORDER BY created_at DESC');
}

async function getApp(id) {
    await initDB();
    return getOne('SELECT * FROM apps WHERE id = $1', [id]);
}

async function updateApp(id, name, description, code, thumbnail = null, isPublished = true, sharedGroups) {
    await initDB();
    // Preserve existing shared_groups when caller didn't pass them — same
    // contract as agentCrud.setAgentPublished and kbStore.setPublished, so
    // a metadata-only update can't silently widen the audience.
    if (sharedGroups === undefined) {
        const { rowCount } = await run(`
            UPDATE apps SET name = $1, description = $2, code = $3, thumbnail = $4, is_published = $5, updated_at = NOW()
            WHERE id = $6
        `, [name, description || '', code, thumbnail, isPublished, id]);
        return rowCount > 0;
    }
    const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
    const { rowCount } = await run(`
        UPDATE apps SET name = $1, description = $2, code = $3, thumbnail = $4, is_published = $5, shared_groups = $6, updated_at = NOW()
        WHERE id = $7
    `, [name, description || '', code, thumbnail, isPublished, groupsJson, id]);
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
    getPublishedAppsForUser,
    getAllApps,
    getApp,
    updateApp,
    deleteApp,
    getAppsByUser,
};
