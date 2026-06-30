/**
 * Notebook Store — PostgreSQL-backed notebook management.
 *
 * Three tables:
 *   • notebooks          — top-level notebook (name, instructions, KB links, settings)
 *   • notebook_sources   — individual sources within a notebook (PDF, DOCX, URL, text, etc.)
 *   • notebook_versions  — immutable content snapshots for version history
 *
 * Backwards-compatible: existing `word_templates` rows are migrated into notebooks on first access.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const { htmlToMarkdown } = require('../core/markdown');

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

    // Migration: add type column for proposals support
    try {
        await exec(`ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'notebook'`);
    } catch (_) {}

    // Migration: canonical Markdown mirror + per-row source-of-truth format flag
    // (for the new editor's token-efficient AI path; document_content stays the
    // HTML mirror so export + the TipTap fallback keep working unchanged).
    try {
        await exec(`ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS document_md TEXT DEFAULT NULL`);
        await exec(`ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS document_format TEXT DEFAULT 'html'`);
    } catch (_) {}

    // Migration: optimistic-concurrency version counter. Bumped on every content
    // write; lets a caller pass `expectedVersion` to detect a lost-update race
    // (two tabs, or a tool-write vs a user autosave). Callers that don't pass it
    // keep today's last-writer-wins behaviour — the column is purely additive.
    try {
        await exec(`ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0`);
    } catch (_) {}

    // Migration: PII token map (the {token → real value} dictionary the Privacy
    // Shield builds while tokenizing this notebook's chat/document/sources for
    // the LLM). Persisting it here lets dlpRunner restore `[person_1]` → real
    // values on reload / after a restart. dlpRunner reads & write-throughs this
    // column directly (keyed by notebook id), the same way it does for
    // agent_conversations / direct_conversations.
    try {
        await exec(`ALTER TABLE notebooks ADD COLUMN IF NOT EXISTS pii_token_map JSONB`);
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
        -- V2 source improvements: manual ordering, ingestion stage, and stored
        -- original text so pasted-text / meeting sources become retryable.
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS stage TEXT;
        ALTER TABLE notebook_sources ADD COLUMN IF NOT EXISTS content_text TEXT;
    `);

    // ── Notebook Versions table (immutable content snapshots) ────────
    await exec(`
        CREATE TABLE IF NOT EXISTS notebook_versions (
            id TEXT PRIMARY KEY,
            notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
            content TEXT NOT NULL DEFAULT '',
            summary TEXT DEFAULT '',
            content_length INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_notebook_versions_notebook ON notebook_versions(notebook_id, created_at DESC);
    `);

    initialized = true;
    console.log('[NotebookStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[NotebookStore] Init error:', err.message));

// ── Notebook CRUD ──────────────────────────────────────────────────

async function createNotebook({ userId, name, description, instructions, knowledgeBaseIds, settings, type }) {
    await initDB();
    const id = crypto.randomUUID();
    const notebookType = type || 'notebook';
    await run(
        `INSERT INTO notebooks (id, user_id, name, description, instructions, knowledge_base_ids, settings, document_content, type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, userId, name || 'Untitled Notebook', description || '', instructions || '',
         JSON.stringify(knowledgeBaseIds || []), JSON.stringify(settings || {}), '', notebookType]
    );
    console.log(`[NotebookStore] Created ${notebookType} "${name}" for user ${userId}`);
    return {
        id, userId, name: name || 'Untitled Notebook', description: description || '',
        instructions: instructions || '', knowledgeBaseIds: knowledgeBaseIds || [],
        settings: settings || {}, documentContent: '', type: notebookType,
        createdAt: new Date().toISOString()
    };
}

async function getNotebooks(userId, { limit = 50, offset = 0, type } = {}) {
    await initDB();
    let query = `SELECT n.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM notebooks n
         LEFT JOIN (
             SELECT notebook_id, COUNT(*) AS source_count
             FROM notebook_sources GROUP BY notebook_id
         ) s ON s.notebook_id = n.id
         WHERE n.user_id = $1`;
    const params = [userId];
    if (type) {
        query += ` AND n.type = $${params.length + 1}`;
        params.push(type);
    }
    query += ` ORDER BY n.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const rows = await getAll(query, params);
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
    let contentChanged = false;
    if (updates.documentContent !== undefined) {
        contentChanged = true;
        setClauses.push(`document_content = $${idx++}`); params.push(updates.documentContent);
        // Keep the canonical Markdown mirror fresh (derive from HTML unless the
        // caller supplied it directly). If derivation throws, still persist the
        // document content — losing the user's edit would be far worse than a
        // stale mirror, and the AI tools already fall back to deriving Markdown
        // from HTML on the fly. Previously a throw here aborted the whole save.
        let md = updates.documentMd;
        if (md === undefined) {
            try { md = htmlToMarkdown(updates.documentContent); }
            catch (e) { md = undefined; console.warn(`[NotebookStore] document_md derivation failed for ${id} — content still saved: ${e.message}`); }
        }
        if (md !== undefined) { setClauses.push(`document_md = $${idx++}`); params.push(md); }
    }
    if (updates.documentFormat !== undefined) { setClauses.push(`document_format = $${idx++}`); params.push(updates.documentFormat); }

    if (setClauses.length === 0) return false;
    // Bump the version on any content-bearing write so a CAS caller can detect a
    // concurrent change.
    if (contentChanged) setClauses.push(`version = version + 1`);
    setClauses.push(`updated_at = NOW()`);
    params.push(id, userId);
    let where = `id = $${idx++} AND user_id = $${idx++}`;
    // Optimistic concurrency: when the caller passes the version it last read,
    // refuse the write if the row moved underneath it (lost-update guard).
    if (typeof updates.expectedVersion === 'number') {
        where += ` AND version = $${idx++}`;
        params.push(updates.expectedVersion);
    }
    const { rowCount } = await run(
        `UPDATE notebooks SET ${setClauses.join(', ')} WHERE ${where}`,
        params
    );
    if (rowCount === 0 && typeof updates.expectedVersion === 'number') {
        // Distinguish a CAS conflict so the caller can surface it instead of
        // silently overwriting (it reaches workspaceTools' _nbWriteFailed path).
        return { ok: false, conflict: true };
    }
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

async function addSource({ notebookId, type, name, storageKey, fileName, metadata, wordCount, contentText, stage }) {
    await initDB();
    const id = crypto.randomUUID();
    // Append to the end of the manual order.
    const ord = await getOne('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM notebook_sources WHERE notebook_id = $1', [notebookId]);
    const sortOrder = ord?.next ?? 0;
    await run(
        `INSERT INTO notebook_sources (id, notebook_id, type, name, storage_key, file_name, metadata, status, word_count, content_text, stage, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8, $9, $10, $11)`,
        [id, notebookId, type, name || 'Untitled', storageKey || null, fileName || null,
         JSON.stringify(metadata || {}), wordCount || 0, contentText || null, stage || 'queued', sortOrder]
    );
    // Touch the notebook's updated_at
    await run('UPDATE notebooks SET updated_at = NOW() WHERE id = $1', [notebookId]);
    return { id, notebookId, type, name, storageKey, fileName, metadata: metadata || {}, status: 'processing', stage: stage || 'queued', wordCount: wordCount || 0, sortOrder };
}

async function getSources(notebookId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM notebook_sources WHERE notebook_id = $1 ORDER BY sort_order ASC, created_at ASC`,
        [notebookId]
    );
    return rows.map(mapSourceRow);
}

/** Full extracted text of a source (for the preview panel + text/meeting retry). */
async function getSourceContent(id) {
    await initDB();
    const r = await getOne('SELECT content_text FROM notebook_sources WHERE id = $1', [id]);
    return r ? (r.content_text || '') : null;
}

/** Persist a manual ordering (array of source ids in the desired order). */
async function reorderSources(notebookId, orderedIds) {
    await initDB();
    let i = 0;
    for (const sid of orderedIds) {
        await run('UPDATE notebook_sources SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND notebook_id = $3', [i++, sid, notebookId]);
    }
    return true;
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
    if (updates.stage !== undefined) { setClauses.push(`stage = $${idx++}`); params.push(updates.stage); }
    if (updates.contentText !== undefined) { setClauses.push(`content_text = $${idx++}`); params.push(updates.contentText); }
    if (updates.sortOrder !== undefined) { setClauses.push(`sort_order = $${idx++}`); params.push(updates.sortOrder); }

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

/**
 * Watchdog: flip any `processing` source older than the given timeout to `error`
 * with a generic "timed out" message. Called opportunistically on list-sources so
 * users never see a yellow row stuck forever after an ingestion worker dies.
 *
 * Returns the number of rows transitioned so callers can decide whether to log.
 */
async function timeoutStuckSources(notebookId, { stuckMinutes = 10 } = {}) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE notebook_sources
            SET status = 'error',
                error = 'Ingestion timed out — retry or re-upload.',
                updated_at = NOW()
          WHERE notebook_id = $1
            AND status = 'processing'
            AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')`,
        [notebookId, stuckMinutes]
    );
    return rowCount || 0;
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
        documentMd: r.document_md != null ? r.document_md : null,
        documentFormat: r.document_format || 'html',
        type: r.type || 'notebook',
        version: typeof r.version === 'number' ? r.version : (parseInt(r.version) || 0),
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
        stage: r.stage || null,
        error: r.error || null,
        wordCount: parseInt(r.word_count) || 0,
        sortOrder: parseInt(r.sort_order) || 0,
        // Flag (not the content) so the list payload stays small but the UI knows
        // a preview is available and whether a text/meeting source can be retried.
        hasContent: !!(r.content_text && r.content_text.length),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

// ── Version Control ─────────────────────────────────────────────────

// Auto-versioning snapshots notebook content on save with the 5-minute debounce
// below. At 200 versions that's ~16 hours of continuous editing before the oldest
// snapshot is pruned — plenty of recovery runway for accidental overwrites.
const MAX_VERSIONS_PER_NOTEBOOK = 200;
const AUTO_VERSION_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Create a version snapshot. Auto-prunes oldest versions beyond MAX.
 */
async function createVersion(notebookId, content, summary = 'Auto-save') {
    await initDB();
    const id = crypto.randomUUID();
    const contentLength = (content || '').length;
    await run(
        `INSERT INTO notebook_versions (id, notebook_id, content, summary, content_length)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, notebookId, content || '', summary, contentLength]
    );

    // Prune: keep only the newest MAX_VERSIONS_PER_NOTEBOOK versions
    await run(
        `DELETE FROM notebook_versions
         WHERE id IN (
             SELECT id FROM notebook_versions
             WHERE notebook_id = $1
             ORDER BY created_at DESC
             OFFSET $2
         )`,
        [notebookId, MAX_VERSIONS_PER_NOTEBOOK]
    );

    return { id, notebookId, summary, contentLength, createdAt: new Date().toISOString() };
}

/**
 * Get version list (metadata only — no content). Newest first.
 */
async function getVersions(notebookId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT id, notebook_id, summary, content_length, created_at
         FROM notebook_versions
         WHERE notebook_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [notebookId, limit, offset]
    );
    return rows.map(r => ({
        id: r.id,
        notebookId: r.notebook_id,
        summary: r.summary || '',
        contentLength: parseInt(r.content_length) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
}

/**
 * Get a single version with full content.
 */
async function getVersion(versionId) {
    await initDB();
    const r = await getOne('SELECT * FROM notebook_versions WHERE id = $1', [versionId]);
    if (!r) return null;
    return {
        id: r.id,
        notebookId: r.notebook_id,
        content: r.content || '',
        summary: r.summary || '',
        contentLength: parseInt(r.content_length) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

/**
 * Delete a specific version.
 */
async function deleteVersion(versionId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM notebook_versions WHERE id = $1', [versionId]);
    return rowCount > 0;
}

/**
 * Check whether an auto-version should be created.
 * Returns true if no version exists or the last one is > 5 minutes old.
 */
async function shouldAutoVersion(notebookId) {
    await initDB();
    const latest = await getOne(
        `SELECT created_at FROM notebook_versions
         WHERE notebook_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [notebookId]
    );
    if (!latest) return true;
    const elapsed = Date.now() - new Date(latest.created_at).getTime();
    return elapsed >= AUTO_VERSION_DEBOUNCE_MS;
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
    getSourceContent,
    reorderSources,
    updateSource,
    deleteSource,
    timeoutStuckSources,
    // Versions
    createVersion,
    getVersions,
    getVersion,
    deleteVersion,
    shouldAutoVersion,
};
