/**
 * Version Store - PostgreSQL-backed unified version control for all agent types
 * Tracks version history for agents, browser agents, terminal agents, and swarms.
 */

const { run, getOne, getAll, exec } = require('../db');
const { v4: uuidv4 } = require('uuid');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS agent_versions (
            id TEXT PRIMARY KEY,
            agent_id TEXT NOT NULL,
            agent_type TEXT NOT NULL,
            version_number INTEGER NOT NULL,
            snapshot TEXT NOT NULL,
            change_summary TEXT,
            created_by TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(agent_id, version_number)
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_agent_versions_lookup ON agent_versions(agent_id, version_number DESC)`);
    initialized = true;
}

initDB().catch(err => console.error('[VersionStore] Init error:', err.message));
console.log('[VersionStore] Initialized (PostgreSQL)');

async function createVersion(agentId, agentType, snapshot, userId = null, changeSummary = null) {
    await initDB();
    const id = uuidv4();
    const last = await getOne('SELECT MAX(version_number) as max_ver FROM agent_versions WHERE agent_id = $1', [agentId]);
    const versionNumber = (last?.max_ver || 0) + 1;
    if (!changeSummary && snapshot) changeSummary = `Version ${versionNumber}`;

    await run(`
        INSERT INTO agent_versions (id, agent_id, agent_type, version_number, snapshot, change_summary, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [id, agentId, agentType, versionNumber, JSON.stringify(snapshot), changeSummary, userId]);

    await pruneVersions(agentId, 50);
    return { id, agent_id: agentId, agent_type: agentType, version_number: versionNumber, change_summary: changeSummary, created_at: new Date().toISOString() };
}

async function getVersions(agentId) {
    await initDB();
    return getAll(`
        SELECT id, agent_id, agent_type, version_number, change_summary, created_by, created_at
        FROM agent_versions WHERE agent_id = $1 ORDER BY version_number DESC
    `, [agentId]);
}

async function getVersion(versionId) {
    await initDB();
    const row = await getOne('SELECT * FROM agent_versions WHERE id = $1', [versionId]);
    if (!row) return null;
    return { ...row, snapshot: safeParseJSON(row.snapshot, {}) };
}

async function deleteVersion(versionId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM agent_versions WHERE id = $1', [versionId]);
    return rowCount > 0;
}

async function deleteAllVersions(agentId) {
    await initDB();
    await run('DELETE FROM agent_versions WHERE agent_id = $1', [agentId]);
}

async function pruneVersions(agentId, keepCount = 50) {
    await initDB();
    const count = await getOne('SELECT COUNT(*) as cnt FROM agent_versions WHERE agent_id = $1', [agentId]);
    if (parseInt(count.cnt) <= keepCount) return;
    await run(`
        DELETE FROM agent_versions
        WHERE agent_id = $1 AND id NOT IN (
            SELECT id FROM agent_versions WHERE agent_id = $2
            ORDER BY version_number DESC LIMIT $3
        )
    `, [agentId, agentId, keepCount]);
}

function safeParseJSON(str, fallback) {
    try { return typeof str === 'string' ? JSON.parse(str) : (str || fallback); } catch { return fallback; }
}

module.exports = {
    createVersion,
    getVersions,
    getVersion,
    deleteVersion,
    deleteAllVersions,
    pruneVersions
};
