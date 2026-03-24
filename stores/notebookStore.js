/**
 * Notebook Store — PostgreSQL-backed notebook management.
 *
 * Two tables:
 *   • notebooks        — top-level notebook (name, instructions, KB links, settings)
 *   • notebook_sources  — individual sources within a notebook (PDF, DOCX, URL, text, etc.)
 *
 * Backwards-compatible: existing `word_templates` rows are migrated into notebooks on first access.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;

    // ── Notebooks table ──────────────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS notebooks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled Notebook',
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            settings JSONB DEFAULT '{}'::jsonb,
            document_content TEXT DEFAULT '',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks(user_id);
        CREATE INDEX IF NOT EXISTS idx_notebooks_created ON notebooks(created_at DESC);
    `);

    // Migration: add document_content column if table already exists
    try {
        await exec(`ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS document_content TEXT DEFAULT ''`);
    } catch (_) {}

    // ── Notebook Sources table ───────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS notebook_sources (
            id TEXT PRIMARY KEY,
            notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
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
        CREATE INDEX IF NOT EXISTS idx_notebook_sources_notebook ON notebook_sources(notebook_id);
    `);

    initialized = true;
    console.log('[NotebookStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[NotebookStore] Init error:', err.message));

// ── Notebook CRUD ──────────────────────────────────────────────────

async function createNotebook({ userId, name, description, instructions, knowledgeBaseIds, settings }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO notebooks (id, user_id, name, description, instructions, knowledge_base_ids, settings, document_content)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, userId, name || 'Untitled Notebook', description || '', instructions || '',
         JSON.stringify(knowledgeBaseIds || []), JSON.stringify(settings || {}), '']
    );
    console.log(`[NotebookStore] Created notebook "${name}" for user ${userId}`);
    return {
        id, userId, name: name || 'Untitled Notebook', description: description || '',
        instructions: instructions || '', knowledgeBaseIds: knowledgeBaseIds || [],
        settings: settings || {}, documentContent: '', createdAt: new Date().toISOString()
    };
}

async function getNotebooks(userId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT n.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM notebooks n
         LEFT JOIN (
             SELECT notebook_id, COUNT(*) AS source_count
             FROM notebook_sources GROUP BY notebook_id
         ) s ON s.notebook_id = n.id
         WHERE n.user_id = $1
         ORDER BY n.updated_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
    );
    return rows.map(mapNotebookRow);
}

async function getNotebook(id, userId) {
    await initDB();
    const r = await getOne(
        `SELECT n.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM notebooks n
         LEFT JOIN (
             SELECT notebook_id, COUNT(*) AS source_count
             FROM notebook_sources GROUP BY notebook_id
         ) s ON s.notebook_id = n.id
         WHERE n.id = $1 AND n.user_id = $2`,
        [id, userId]
    );
    if (!r) return null;
    return mapNotebookRow(r);
}

async function updateNotebook(id, userId, updates) {
    await initDB();
    const setClauses = [];
    const params = [];
    let idx = 1;

    if (updates.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push(`description = $${idx++}`); params.push(updates.description); }
    if (updates.instructions !== undefined) { setClauses.push(`instructions = $${idx++}`); params.push(updates.instructions); }
    if (updates.knowledgeBaseIds !== undefined) { setClauses.push(`knowledge_base_ids = $${idx++}`); params.push(JSON.stringify(updates.knowledgeBaseIds)); }
    if (updates.settings !== undefined) { setClauses.push(`settings = $${idx++}`); params.push(JSON.stringify(updates.settings)); }
    if (updates.documentContent !== undefined) { setClauses.push(`document_content = $${idx++}`); params.push(updates.documentContent); }

    if (setClauses.length === 0) return false;
    setClauses.push(`updated_at = NOW()`);
    params.push(id, userId);
    const { rowCount } = await run(
        `UPDATE notebooks SET ${setClauses.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
        params
    );
    return rowCount > 0;
}

async function deleteNotebook(id, userId) {
    await initDB();
    // Sources cascade-delete via FK.  Return notebook for caller to clean up KBs/storage.
    const r = await getOne('SELECT * FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!r) return null;
    await run('DELETE FROM notebooks WHERE id = $1 AND user_id = $2', [id, userId]);
    return mapNotebookRow(r);
}

// ── Source CRUD ─────────────────────────────────────────────────────

async function addSource({ notebookId, type, name, storageKey, fileName, metadata, wordCount }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO notebook_sources (id, notebook_id, type, name, storage_key, file_name, metadata, status, word_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8)`,
        [id, notebookId, type, name || 'Untitled', storageKey || null, fileName || null,
         JSON.stringify(metadata || {}), wordCount || 0]
    );
    // Touch the notebook's updated_at
    await run('UPDATE notebooks SET updated_at = NOW() WHERE id = $1', [notebookId]);
    return { id, notebookId, type, name, storageKey, fileName, metadata: metadata || {}, status: 'processing', wordCount: wordCount || 0 };
}

async function getSources(notebookId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM notebook_sources WHERE notebook_id = $1 ORDER BY created_at ASC`,
        [notebookId]
    );
    return rows.map(mapSourceRow);
}

async function getSource(id) {
    await initDB();
    const r = await getOne('SELECT * FROM notebook_sources WHERE id = $1', [id]);
    return r ? mapSourceRow(r) : null;
}

async function updateSource(id, updates) {
    await initDB();
    const setClauses = [];
    const params = [];
    let idx = 1;

    if (updates.status !== undefined) { setClauses.push(`status = $${idx++}`); params.push(updates.status); }
    if (updates.error !== undefined) { setClauses.push(`error = $${idx++}`); params.push(updates.error); }
    if (updates.wordCount !== undefined) { setClauses.push(`word_count = $${idx++}`); params.push(updates.wordCount); }
    if (updates.metadata !== undefined) { setClauses.push(`metadata = $${idx++}`); params.push(JSON.stringify(updates.metadata)); }
    if (updates.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(updates.name); }

    if (setClauses.length === 0) return false;
    setClauses.push(`updated_at = NOW()`);
    params.push(id);
    const { rowCount } = await run(
        `UPDATE notebook_sources SET ${setClauses.join(', ')} WHERE id = $${idx}`,
        params
    );
    return rowCount > 0;
}

async function deleteSource(id) {
    await initDB();
    const r = await getOne('SELECT * FROM notebook_sources WHERE id = $1', [id]);
    if (!r) return null;
    await run('DELETE FROM notebook_sources WHERE id = $1', [id]);
    return mapSourceRow(r);
}

// ── Row Mappers ─────────────────────────────────────────────────────

function parseJSON(v, fallback) {
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return v || fallback;
}

function mapNotebookRow(r) {
    return {
        id: r.id,
        userId: r.user_id,
        name: r.name,
        description: r.description || '',
        instructions: r.instructions || '',
        knowledgeBaseIds: parseJSON(r.knowledge_base_ids, []),
        settings: parseJSON(r.settings, {}),
        documentContent: r.document_content || '',
        sourceCount: parseInt(r.source_count) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

function mapSourceRow(r) {
    return {
        id: r.id,
        notebookId: r.notebook_id,
        type: r.type,
        name: r.name,
        storageKey: r.storage_key,
        fileName: r.file_name,
        metadata: parseJSON(r.metadata, {}),
        status: r.status,
        error: r.error || null,
        wordCount: parseInt(r.word_count) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = {
    // Notebooks
    createNotebook,
    getNotebooks,
    getNotebook,
    updateNotebook,
    deleteNotebook,
    // Sources
    addSource,
    getSources,
    getSource,
    updateSource,
    deleteSource,
};
