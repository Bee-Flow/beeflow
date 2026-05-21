/**
 * Test Suite Store — PostgreSQL-backed Playwright test suites.
 *
 * Tables:
 *   • test_suites          — top-level suite (name, generated code, source manifest, config)
 *   • test_suite_versions  — immutable snapshots, taken on (re)generation or restore
 *
 * Ownership: every read filters by (user_id) so org isolation is preserved
 * the same way notebookStore does it.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;
const MAX_VERSIONS_PER_SUITE = 50;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS test_suites (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            name TEXT NOT NULL DEFAULT 'Untitled Test Suite',
            description TEXT DEFAULT '',
            source_manifest JSONB DEFAULT '[]'::jsonb,
            playwright_code TEXT DEFAULT '',
            playwright_config JSONB DEFAULT '{}'::jsonb,
            latest_run_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_test_suites_user ON test_suites(user_id);
        CREATE INDEX IF NOT EXISTS idx_test_suites_org ON test_suites(organization_id, created_at DESC);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS test_suite_versions (
            id TEXT PRIMARY KEY,
            suite_id TEXT NOT NULL REFERENCES test_suites(id) ON DELETE CASCADE,
            playwright_code TEXT NOT NULL DEFAULT '',
            source_manifest JSONB DEFAULT '[]'::jsonb,
            summary TEXT DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_test_suite_versions_suite ON test_suite_versions(suite_id, created_at DESC);
    `);

    initialized = true;
    console.log('[TestSuiteStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[TestSuiteStore] Init error:', err.message));

function parseJSON(v, fallback) {
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return v ?? fallback;
}

function mapSuiteRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id || null,
        name: r.name,
        description: r.description || '',
        sourceManifest: parseJSON(r.source_manifest, []),
        playwrightCode: r.playwright_code || '',
        playwrightConfig: parseJSON(r.playwright_config, {}),
        latestRunId: r.latest_run_id || null,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

function mapVersionRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        suiteId: r.suite_id,
        playwrightCode: r.playwright_code || '',
        sourceManifest: parseJSON(r.source_manifest, []),
        summary: r.summary || '',
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

async function createSuite({ userId, organizationId = null, name, description = '' }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO test_suites (id, user_id, organization_id, name, description, source_manifest, playwright_code, playwright_config)
         VALUES ($1, $2, $3, $4, $5, '[]'::jsonb, '', '{}'::jsonb)`,
        [id, userId, organizationId, name || 'Untitled Test Suite', description]
    );
    return getSuite(id, userId);
}

async function listSuites(userId, { limit = 100, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM test_suites WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
    );
    return rows.map(mapSuiteRow);
}

async function getSuite(id, userId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM test_suites WHERE id = $1 AND user_id = $2`,
        [id, userId]
    );
    return mapSuiteRow(r);
}

async function updateSuite(id, userId, updates) {
    await initDB();
    const setClauses = [];
    const params = [];
    let idx = 1;

    if (updates.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push(`description = $${idx++}`); params.push(updates.description); }
    if (updates.sourceManifest !== undefined) { setClauses.push(`source_manifest = $${idx++}`); params.push(JSON.stringify(updates.sourceManifest)); }
    if (updates.playwrightCode !== undefined) { setClauses.push(`playwright_code = $${idx++}`); params.push(updates.playwrightCode); }
    if (updates.playwrightConfig !== undefined) { setClauses.push(`playwright_config = $${idx++}`); params.push(JSON.stringify(updates.playwrightConfig)); }
    if (updates.latestRunId !== undefined) { setClauses.push(`latest_run_id = $${idx++}`); params.push(updates.latestRunId); }

    if (setClauses.length === 0) return false;
    setClauses.push(`updated_at = NOW()`);
    params.push(id, userId);
    const { rowCount } = await run(
        `UPDATE test_suites SET ${setClauses.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
        params
    );
    return rowCount > 0;
}

async function deleteSuite(id, userId) {
    await initDB();
    const r = await getOne(`SELECT * FROM test_suites WHERE id = $1 AND user_id = $2`, [id, userId]);
    if (!r) return null;
    await run(`DELETE FROM test_suites WHERE id = $1 AND user_id = $2`, [id, userId]);
    return mapSuiteRow(r);
}

async function snapshotVersion(suiteId, summary = 'Generated') {
    await initDB();
    const suite = await getOne(`SELECT playwright_code, source_manifest FROM test_suites WHERE id = $1`, [suiteId]);
    if (!suite) return null;
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO test_suite_versions (id, suite_id, playwright_code, source_manifest, summary)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, suiteId, suite.playwright_code || '', JSON.stringify(parseJSON(suite.source_manifest, [])), summary]
    );
    // Prune oldest beyond MAX
    await run(
        `DELETE FROM test_suite_versions
          WHERE id IN (
              SELECT id FROM test_suite_versions
               WHERE suite_id = $1
               ORDER BY created_at DESC
               OFFSET $2
          )`,
        [suiteId, MAX_VERSIONS_PER_SUITE]
    );
    return { id, suiteId, summary, createdAt: new Date().toISOString() };
}

async function listVersions(suiteId, userId) {
    await initDB();
    // Ownership: only list versions when the suite belongs to the caller.
    const owner = await getOne(`SELECT 1 FROM test_suites WHERE id = $1 AND user_id = $2`, [suiteId, userId]);
    if (!owner) return [];
    const rows = await getAll(
        `SELECT id, suite_id, summary, created_at FROM test_suite_versions
          WHERE suite_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [suiteId]
    );
    return rows.map(r => ({
        id: r.id,
        suiteId: r.suite_id,
        summary: r.summary || '',
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
}

async function getVersion(versionId, userId) {
    await initDB();
    const r = await getOne(
        `SELECT v.* FROM test_suite_versions v
           JOIN test_suites s ON s.id = v.suite_id
          WHERE v.id = $1 AND s.user_id = $2`,
        [versionId, userId]
    );
    return mapVersionRow(r);
}

async function restoreVersion(versionId, userId) {
    await initDB();
    const v = await getVersion(versionId, userId);
    if (!v) return null;
    await run(
        `UPDATE test_suites
            SET playwright_code = $1,
                source_manifest = $2,
                updated_at = NOW()
          WHERE id = $3 AND user_id = $4`,
        [v.playwrightCode, JSON.stringify(v.sourceManifest), v.suiteId, userId]
    );
    return getSuite(v.suiteId, userId);
}

async function countActiveSuites(userId) {
    await initDB();
    const r = await getOne(`SELECT COUNT(*)::int AS n FROM test_suites WHERE user_id = $1`, [userId]);
    return r?.n || 0;
}

module.exports = {
    initDB,
    createSuite,
    listSuites,
    getSuite,
    updateSuite,
    deleteSuite,
    snapshotVersion,
    listVersions,
    getVersion,
    restoreVersion,
    countActiveSuites,
};
