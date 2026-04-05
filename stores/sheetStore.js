/**
 * Sheet Store — PostgreSQL-backed CRUD for AI Spreadsheets.
 *
 * Mirrors slidesStore.js / notebookStore.js architecture exactly — uses the same
 * { run, getOne, getAll, exec } helpers from ../db (NOT getPool()).
 *
 *   spreadsheets            – top-level metadata + sheets JSON (multi-tab)
 *   spreadsheet_sources     – uploaded/pasted/URL source references
 *   spreadsheet_versions    – immutable content snapshots for undo history
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;

    // ── Spreadsheets table ───────────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS spreadsheets (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled Sheet',
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            settings JSONB DEFAULT '{}'::jsonb,
            sheets_content JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_spreadsheets_user ON spreadsheets(user_id);
        CREATE INDEX IF NOT EXISTS idx_spreadsheets_updated ON spreadsheets(updated_at DESC);
    `);

    // ── Spreadsheet Sources table ────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS spreadsheet_sources (
            id TEXT PRIMARY KEY,
            spreadsheet_id TEXT NOT NULL REFERENCES spreadsheets(id) ON DELETE CASCADE,
            type TEXT NOT NULL DEFAULT 'text',
            name TEXT NOT NULL DEFAULT 'Untitled',
            storage_key TEXT,
            file_name TEXT,
            metadata JSONB DEFAULT '{}'::jsonb,
            status TEXT NOT NULL DEFAULT 'processing',
            error TEXT,
            word_count INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_spreadsheet_sources_sheet ON spreadsheet_sources(spreadsheet_id);
    `);

    // ── Spreadsheet Versions table (immutable snapshots) ─────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS spreadsheet_versions (
            id TEXT PRIMARY KEY,
            spreadsheet_id TEXT NOT NULL REFERENCES spreadsheets(id) ON DELETE CASCADE,
            content JSONB NOT NULL DEFAULT '[]'::jsonb,
            summary TEXT DEFAULT '',
            sheet_count INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_spreadsheet_versions_sheet ON spreadsheet_versions(spreadsheet_id, created_at DESC);
    `);

    initialized = true;
    console.log('[SheetStore] PostgreSQL initialized');
}

// Eager init on module load (same pattern as slidesStore/notebookStore)
initDB().catch(err => console.error('[SheetStore] Init error:', err.message));

// ─── Spreadsheet CRUD ────────────────────────────────────────────

async function createSpreadsheet(userId, name, description = '') {
    await initDB();
    const id = crypto.randomUUID();
    const defaultSettings = { showGridLines: true, defaultColWidth: 120, defaultRowHeight: 28 };
    const defaultSheets = [
        {
            id: crypto.randomUUID(),
            name: 'Sheet 1',
            cells: {},
            colWidths: {},
            rowHeights: {},
            frozenRows: 0,
            frozenCols: 0,
        }
    ];

    const row = await getOne(
        `INSERT INTO spreadsheets (id, user_id, name, description, settings, sheets_content)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, userId, name || 'Untitled Sheet', description,
         JSON.stringify(defaultSettings), JSON.stringify(defaultSheets)]
    );
    return parseSpreadsheetRow(row);
}

async function getSpreadsheets(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT s.*,
                (SELECT COUNT(*)::int FROM spreadsheet_sources WHERE spreadsheet_id = s.id) AS source_count,
                COALESCE(jsonb_array_length(s.sheets_content), 0) AS sheet_count
         FROM spreadsheets s
         WHERE s.user_id = $1
         ORDER BY s.updated_at DESC`,
        [userId]
    );
    return rows.map(parseSpreadsheetRow);
}

async function getSpreadsheet(spreadsheetId, userId) {
    await initDB();
    const row = await getOne(
        `SELECT * FROM spreadsheets WHERE id = $1 AND user_id = $2`,
        [spreadsheetId, userId]
    );
    return parseSpreadsheetRow(row);
}

async function updateSpreadsheet(spreadsheetId, userId, updates) {
    await initDB();

    const allowedFields = ['name', 'description', 'instructions', 'knowledge_base_ids', 'settings', 'sheets_content'];
    const sets = [];
    const values = [];
    let paramIdx = 1;

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            const isJsonb = ['knowledge_base_ids', 'settings', 'sheets_content'].includes(field);
            sets.push(`${field} = $${paramIdx}${isJsonb ? '::jsonb' : ''}`);
            values.push(isJsonb ? JSON.stringify(updates[field]) : updates[field]);
            paramIdx++;
        }
    }

    if (sets.length === 0) return null;
    sets.push(`updated_at = NOW()`);
    values.push(spreadsheetId, userId);

    const row = await getOne(
        `UPDATE spreadsheets SET ${sets.join(', ')} WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1} RETURNING *`,
        values
    );
    return parseSpreadsheetRow(row);
}

async function deleteSpreadsheet(spreadsheetId, userId) {
    await initDB();
    const result = await run(
        `DELETE FROM spreadsheets WHERE id = $1 AND user_id = $2`,
        [spreadsheetId, userId]
    );
    return result.rowCount > 0;
}

// ─── Sources CRUD ────────────────────────────────────────────────

async function addSource({ spreadsheetId, type, name, storageKey, fileName, metadata, wordCount }) {
    await initDB();
    const id = crypto.randomUUID();
    const row = await getOne(
        `INSERT INTO spreadsheet_sources (id, spreadsheet_id, type, name, storage_key, file_name, metadata, word_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [id, spreadsheetId, type || 'text', name || 'Untitled', storageKey || null, fileName || null,
         JSON.stringify(metadata || {}), wordCount || 0]
    );
    return parseSourceRow(row);
}

async function getSources(spreadsheetId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM spreadsheet_sources WHERE spreadsheet_id = $1 ORDER BY created_at ASC`,
        [spreadsheetId]
    );
    return rows.map(parseSourceRow);
}

async function getSource(sourceId) {
    await initDB();
    const row = await getOne(`SELECT * FROM spreadsheet_sources WHERE id = $1`, [sourceId]);
    return parseSourceRow(row);
}

async function updateSource(sourceId, updates) {
    await initDB();
    const allowedFields = ['name', 'status', 'error', 'word_count', 'metadata', 'storage_key'];
    const sets = [];
    const values = [];
    let paramIdx = 1;

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            const isJsonb = field === 'metadata';
            sets.push(`${field} = $${paramIdx}${isJsonb ? '::jsonb' : ''}`);
            values.push(isJsonb ? JSON.stringify(updates[field]) : updates[field]);
            paramIdx++;
        }
    }

    if (sets.length === 0) return null;
    sets.push(`updated_at = NOW()`);
    values.push(sourceId);

    const row = await getOne(
        `UPDATE spreadsheet_sources SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
        values
    );
    return parseSourceRow(row);
}

async function deleteSource(sourceId) {
    await initDB();
    const result = await run(`DELETE FROM spreadsheet_sources WHERE id = $1`, [sourceId]);
    return result.rowCount > 0;
}

// ─── Version History ─────────────────────────────────────────────

async function createVersion(spreadsheetId, content, summary = '') {
    await initDB();
    const id = crypto.randomUUID();
    const sheetCount = Array.isArray(content) ? content.length : 0;
    const row = await getOne(
        `INSERT INTO spreadsheet_versions (id, spreadsheet_id, content, summary, sheet_count)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         RETURNING *`,
        [id, spreadsheetId, JSON.stringify(content), summary, sheetCount]
    );

    // Keep only last 20 versions per spreadsheet
    await run(
        `DELETE FROM spreadsheet_versions WHERE spreadsheet_id = $1
         AND id NOT IN (SELECT id FROM spreadsheet_versions WHERE spreadsheet_id = $1 ORDER BY created_at DESC LIMIT 20)`,
        [spreadsheetId]
    );

    return parseVersionRow(row);
}

async function getVersions(spreadsheetId) {
    await initDB();
    const rows = await getAll(
        `SELECT id, spreadsheet_id, summary, sheet_count, created_at FROM spreadsheet_versions
         WHERE spreadsheet_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [spreadsheetId]
    );
    return rows.map(parseVersionRow);
}

async function getVersion(versionId) {
    await initDB();
    const row = await getOne(`SELECT * FROM spreadsheet_versions WHERE id = $1`, [versionId]);
    return parseVersionRow(row);
}

async function deleteVersion(versionId) {
    await initDB();
    const result = await run(`DELETE FROM spreadsheet_versions WHERE id = $1`, [versionId]);
    return result.rowCount > 0;
}

async function shouldAutoVersion(spreadsheetId) {
    await initDB();
    const row = await getOne(
        `SELECT created_at FROM spreadsheet_versions WHERE spreadsheet_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [spreadsheetId]
    );
    if (!row) return true;
    const lastVersion = new Date(row.created_at);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return lastVersion < fiveMinutesAgo;
}

// ─── Row Parsers ─────────────────────────────────────────────────

function parseSpreadsheetRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        description: row.description || '',
        instructions: row.instructions || '',
        knowledgeBaseIds: safeJsonParse(row.knowledge_base_ids, []),
        settings: safeJsonParse(row.settings, {}),
        sheetsContent: safeJsonParse(row.sheets_content, []),
        sourceCount: row.source_count ?? 0,
        sheetCount: row.sheet_count ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function parseSourceRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        spreadsheetId: row.spreadsheet_id,
        type: row.type,
        name: row.name,
        storageKey: row.storage_key,
        fileName: row.file_name,
        metadata: safeJsonParse(row.metadata, {}),
        status: row.status,
        error: row.error,
        wordCount: row.word_count || 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function parseVersionRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        spreadsheetId: row.spreadsheet_id,
        content: safeJsonParse(row.content, []),
        summary: row.summary || '',
        sheetCount: row.sheet_count || 0,
        createdAt: row.created_at,
    };
}

function safeJsonParse(val, fallback) {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return fallback; }
}

module.exports = {
    ensureTables: initDB,
    createSpreadsheet,
    getSpreadsheets,
    getSpreadsheet,
    updateSpreadsheet,
    deleteSpreadsheet,
    addSource,
    getSources,
    getSource,
    updateSource,
    deleteSource,
    createVersion,
    getVersions,
    getVersion,
    deleteVersion,
    shouldAutoVersion,
};
