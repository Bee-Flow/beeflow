/**
 * GitHub Sync Store — PostgreSQL-backed sync state tracking
 *
 * Tracks which agents/skills have been synced to GitHub and their content hashes.
 * Org-level sync configuration (repo, branch, auto-sync) is stored via configStore.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const configStore = require('./configStore');

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS github_sync_state (
            id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            last_synced_at TIMESTAMPTZ,
            last_synced_sha TEXT,
            github_commit_sha TEXT,
            sync_status TEXT DEFAULT 'pending',
            error_message TEXT,
            UNIQUE(organization_id, resource_type, resource_id)
        );
        CREATE INDEX IF NOT EXISTS idx_github_sync_org ON github_sync_state(organization_id);
        CREATE INDEX IF NOT EXISTS idx_github_sync_status ON github_sync_state(organization_id, sync_status);
    `);

    initialized = true;
    console.log('[GitHubSyncStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[GitHubSyncStore] Init error:', err.message));

// ── Config key helpers ───────────────────────────────────────────

function _configKey(orgId) { return `github_sync_config_${orgId}`; }

// ── Org Sync Configuration ───────────────────────────────────────

/**
 * Get the GitHub sync configuration for an organization.
 * Returns null if not configured.
 */
async function getOrgSyncConfig(orgId) {
    const raw = await configStore.getConfig(_configKey(orgId));
    if (!raw) return null;
    const config = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
        repoOwner: config.repoOwner || '',
        repoName: config.repoName || '',
        branch: config.branch || 'main',
        autoSync: config.autoSync === true,
        lastFullSync: config.lastFullSync || null,
        configuredBy: config.configuredBy || null,
        configuredAt: config.configuredAt || null,
    };
}

/**
 * Save GitHub sync configuration for an organization.
 */
async function setOrgSyncConfig(orgId, config) {
    await configStore.setConfig(_configKey(orgId), {
        repoOwner: config.repoOwner,
        repoName: config.repoName,
        branch: config.branch || 'main',
        autoSync: config.autoSync === true,
        lastFullSync: config.lastFullSync || null,
        configuredBy: config.configuredBy || null,
        configuredAt: config.configuredAt || new Date().toISOString(),
    });
}

/**
 * Remove GitHub sync configuration for an organization.
 */
async function deleteOrgSyncConfig(orgId) {
    await configStore.deleteConfig(_configKey(orgId));
    // Clear all sync states for this org
    await run('DELETE FROM github_sync_state WHERE organization_id = $1', [orgId]);
}

// ── Sync State CRUD ──────────────────────────────────────────────

/**
 * Mark a resource as needing sync (called after create/update/delete).
 */
async function markPending(orgId, resourceType, resourceId) {
    await initDB();
    const id = crypto.randomUUID();
    await run(`
        INSERT INTO github_sync_state (id, organization_id, resource_type, resource_id, sync_status)
        VALUES ($1, $2, $3, $4, 'pending')
        ON CONFLICT (organization_id, resource_type, resource_id)
        DO UPDATE SET sync_status = 'pending', error_message = NULL
    `, [id, orgId, resourceType, resourceId]);
}

/**
 * Mark a resource as 'deleted' — pending removal from GitHub.
 */
async function markDeleted(orgId, resourceType, resourceId) {
    await initDB();
    const id = crypto.randomUUID();
    await run(`
        INSERT INTO github_sync_state (id, organization_id, resource_type, resource_id, sync_status)
        VALUES ($1, $2, $3, $4, 'deleted')
        ON CONFLICT (organization_id, resource_type, resource_id)
        DO UPDATE SET sync_status = 'deleted', error_message = NULL
    `, [id, orgId, resourceType, resourceId]);
}

/**
 * Update sync state after a successful push.
 */
async function markSynced(orgId, resourceType, resourceId, contentSha, commitSha) {
    await initDB();
    await run(`
        UPDATE github_sync_state
        SET sync_status = 'synced',
            last_synced_at = NOW(),
            last_synced_sha = $1,
            github_commit_sha = $2,
            error_message = NULL
        WHERE organization_id = $3 AND resource_type = $4 AND resource_id = $5
    `, [contentSha, commitSha, orgId, resourceType, resourceId]);
}

/**
 * Mark a resource sync as errored.
 */
async function markError(orgId, resourceType, resourceId, errorMessage) {
    await initDB();
    await run(`
        UPDATE github_sync_state
        SET sync_status = 'error', error_message = $1
        WHERE organization_id = $2 AND resource_type = $3 AND resource_id = $4
    `, [errorMessage, orgId, resourceType, resourceId]);
}

/**
 * Get sync state for a single resource.
 */
async function getSyncState(orgId, resourceType, resourceId) {
    await initDB();
    return getOne(
        'SELECT * FROM github_sync_state WHERE organization_id = $1 AND resource_type = $2 AND resource_id = $3',
        [orgId, resourceType, resourceId]
    );
}

/**
 * Get all resources that need a (re)push for an org — pending, errored, or
 * deleted. Errored items are included so an incremental "Push Pending" retries
 * previously-failed pushes instead of leaving them stuck.
 */
async function getPendingChanges(orgId) {
    await initDB();
    return getAll(
        "SELECT * FROM github_sync_state WHERE organization_id = $1 AND sync_status IN ('pending', 'error', 'deleted')",
        [orgId]
    );
}

/**
 * Get full sync overview for an org (counts by status).
 */
async function getSyncOverview(orgId) {
    await initDB();
    const rows = await getAll(
        'SELECT sync_status, COUNT(*) as count FROM github_sync_state WHERE organization_id = $1 GROUP BY sync_status',
        [orgId]
    );
    const result = { synced: 0, pending: 0, error: 0, deleted: 0, total: 0 };
    for (const row of rows) {
        result[row.sync_status] = parseInt(row.count);
    }
    // Total reflects live resources only — pending-deletions are on their way
    // out and shouldn't inflate the count.
    result.total = result.synced + result.pending + result.error;
    return result;
}

/**
 * Get all sync states for an org (for detailed UI display).
 */
async function getAllSyncStates(orgId) {
    await initDB();
    return getAll(
        'SELECT * FROM github_sync_state WHERE organization_id = $1 ORDER BY last_synced_at DESC NULLS LAST',
        [orgId]
    );
}

/**
 * Remove sync state record (after file deleted from GitHub).
 */
async function removeSyncState(orgId, resourceType, resourceId) {
    await initDB();
    await run(
        'DELETE FROM github_sync_state WHERE organization_id = $1 AND resource_type = $2 AND resource_id = $3',
        [orgId, resourceType, resourceId]
    );
}

/**
 * Update the last full sync timestamp on the org config.
 */
async function updateLastFullSync(orgId) {
    const config = await getOrgSyncConfig(orgId);
    if (config) {
        config.lastFullSync = new Date().toISOString();
        await setOrgSyncConfig(orgId, config);
    }
}

module.exports = {
    // Org config
    getOrgSyncConfig,
    setOrgSyncConfig,
    deleteOrgSyncConfig,
    // Sync state
    markPending,
    markDeleted,
    markSynced,
    markError,
    getSyncState,
    getPendingChanges,
    getSyncOverview,
    getAllSyncStates,
    removeSyncState,
    updateLastFullSync,
};
