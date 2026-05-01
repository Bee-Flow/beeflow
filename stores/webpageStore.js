/**
 * Webpage Store — PostgreSQL metadata + RustFS object storage for static webpages.
 *
 * Three tables:
 *   • webpages          — top-level webpage (name, instructions, KB links, settings, file hashes/sizes)
 *   • webpage_sources   — individual sources within a webpage (PDF, DOCX, URL, text, etc.)
 *   • webpage_versions  — immutable file-trio snapshots for version history
 *
 * File storage layout (RustFS):
 *   users/{userId}/webpages/{webpageId}/current/index.html       (slot='html')
 *   users/{userId}/webpages/{webpageId}/current/style.css        (slot='css')
 *   users/{userId}/webpages/{webpageId}/current/script.js        (slot='js')
 *   users/{userId}/webpages/{webpageId}/versions/{versionId}/<filename>
 *
 * The DB carries hashes + sizes for change detection and cheap list rendering;
 * file bytes never live in Postgres rows.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const storageStore = require('./storageStore');

let initialized = false;

const SLOTS = ['html', 'css', 'js'];
const CONTENT_TYPES = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
};

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS webpages (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled Webpage',
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            settings JSONB DEFAULT '{}'::jsonb,
            html_sha256 TEXT DEFAULT '',
            css_sha256 TEXT DEFAULT '',
            js_sha256 TEXT DEFAULT '',
            html_size INTEGER DEFAULT 0,
            css_size INTEGER DEFAULT 0,
            js_size INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_webpages_user ON webpages(user_id);
        CREATE INDEX IF NOT EXISTS idx_webpages_created ON webpages(created_at DESC);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS webpage_sources (
            id TEXT PRIMARY KEY,
            webpage_id TEXT NOT NULL REFERENCES webpages(id) ON DELETE CASCADE,
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
        CREATE INDEX IF NOT EXISTS idx_webpage_sources_webpage ON webpage_sources(webpage_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS webpage_versions (
            id TEXT PRIMARY KEY,
            webpage_id TEXT NOT NULL REFERENCES webpages(id) ON DELETE CASCADE,
            summary TEXT DEFAULT '',
            html_sha256 TEXT DEFAULT '',
            css_sha256 TEXT DEFAULT '',
            js_sha256 TEXT DEFAULT '',
            content_length INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_webpage_versions_webpage ON webpage_versions(webpage_id, created_at DESC);
    `);

    // Lazy migration — `chat_messages` was added after the original schema for
    // per-webpage chat history persistence. Stored as JSONB so we can read/
    // write the full array atomically without RustFS round-trips.
    try {
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS chat_messages JSONB DEFAULT '[]'::jsonb`);
    } catch (_) { /* column already exists or table doesn't yet — fine */ }

    initialized = true;
    console.log('[WebpageStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[WebpageStore] Init error:', err.message));

// ── RustFS helpers ─────────────────────────────────────────────────

function sha256(s) {
    return crypto.createHash('sha256').update(s || '', 'utf8').digest('hex');
}

function keyFor(userId, webpageId, slot, versionId = null) {
    return storageStore.buildWebpageKey(userId, webpageId, slot, versionId);
}

/**
 * Read one slot's contents from RustFS. Returns '' if the object doesn't
 * exist (treated as empty).
 */
async function readSlot(userId, webpageId, slot, versionId = null) {
    if (!storageStore.isAvailable()) return '';
    const key = keyFor(userId, webpageId, slot, versionId);
    try {
        const { stream } = await storageStore.streamFile(key);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
    } catch (err) {
        // NoSuchKey is expected for empty/optional slots.
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return '';
        throw err;
    }
}

/**
 * Read all three slots in parallel.
 */
async function readAllSlots(userId, webpageId, versionId = null) {
    const [html, css, js] = await Promise.all(
        SLOTS.map(s => readSlot(userId, webpageId, s, versionId))
    );
    return { html, css, js };
}

/**
 * Write one slot's contents to RustFS. Empty content deletes the object
 * so an empty `script.js` doesn't sit around as a 0-byte file.
 */
async function writeSlot(userId, webpageId, slot, content) {
    if (!storageStore.isAvailable()) {
        throw new Error('RustFS not configured — cannot persist webpage files');
    }
    const key = keyFor(userId, webpageId, slot);
    if (!content) {
        try { await storageStore.deleteFile(key); } catch (_) {}
        return { sha: '', size: 0 };
    }
    const buf = Buffer.from(content, 'utf8');
    await storageStore.uploadFile(key, buf, CONTENT_TYPES[slot]);
    return { sha: sha256(content), size: buf.length };
}

/**
 * Server-side copy a slot from `current/` into `versions/{vid}/`.
 */
async function copySlotToVersion(userId, webpageId, versionId, slot) {
    if (!storageStore.isAvailable()) return;
    const src = keyFor(userId, webpageId, slot);
    const dst = keyFor(userId, webpageId, slot, versionId);
    try {
        await storageStore.copyObject(src, dst);
    } catch (err) {
        // If the source slot is empty (no object), there's nothing to snapshot.
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return;
        throw err;
    }
}

/**
 * Purge every RustFS object under a webpage's prefix. Called on DELETE.
 */
async function purgeWebpageObjects(userId, webpageId) {
    if (!storageStore.isAvailable()) return 0;
    const prefix = `users/${userId}/webpages/${webpageId}/`;
    try {
        const keys = await storageStore.listKeys(prefix);
        for (const k of keys) {
            try { await storageStore.deleteFile(k); } catch (_) {}
        }
        return keys.length;
    } catch (err) {
        console.warn('[WebpageStore] Purge failed:', err.message);
        return 0;
    }
}

// ── Webpage CRUD ─────────────────────────────────────────────────────

async function createWebpage({ userId, name, description, instructions, knowledgeBaseIds, settings }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO webpages (id, user_id, name, description, instructions, knowledge_base_ids, settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, userId, name || 'Untitled Webpage', description || '', instructions || '',
         JSON.stringify(knowledgeBaseIds || []), JSON.stringify(settings || {})]
    );
    console.log(`[WebpageStore] Created webpage "${name}" for user ${userId}`);
    return {
        id, userId, name: name || 'Untitled Webpage', description: description || '',
        instructions: instructions || '', knowledgeBaseIds: knowledgeBaseIds || [],
        settings: settings || {},
        htmlSize: 0, cssSize: 0, jsSize: 0,
        createdAt: new Date().toISOString(),
    };
}

async function getWebpages(userId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT w.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM webpages w
         LEFT JOIN (
             SELECT webpage_id, COUNT(*) AS source_count
             FROM webpage_sources GROUP BY webpage_id
         ) s ON s.webpage_id = w.id
         WHERE w.user_id = $1
         ORDER BY w.updated_at DESC
         LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
    );
    return rows.map(mapWebpageRow);
}

async function getWebpage(id, userId) {
    await initDB();
    const r = await getOne(
        `SELECT w.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM webpages w
         LEFT JOIN (
             SELECT webpage_id, COUNT(*) AS source_count
             FROM webpage_sources GROUP BY webpage_id
         ) s ON s.webpage_id = w.id
         WHERE w.id = $1 AND w.user_id = $2`,
        [id, userId]
    );
    if (!r) return null;
    return mapWebpageRow(r);
}

async function updateWebpageMetadata(id, userId, updates) {
    await initDB();
    const setClauses = [];
    const params = [];
    let idx = 1;

    if (updates.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push(`description = $${idx++}`); params.push(updates.description); }
    if (updates.instructions !== undefined) { setClauses.push(`instructions = $${idx++}`); params.push(updates.instructions); }
    if (updates.knowledgeBaseIds !== undefined) { setClauses.push(`knowledge_base_ids = $${idx++}`); params.push(JSON.stringify(updates.knowledgeBaseIds)); }
    if (updates.settings !== undefined) { setClauses.push(`settings = $${idx++}`); params.push(JSON.stringify(updates.settings)); }

    if (updates.htmlSha !== undefined) { setClauses.push(`html_sha256 = $${idx++}`); params.push(updates.htmlSha); }
    if (updates.cssSha !== undefined) { setClauses.push(`css_sha256 = $${idx++}`); params.push(updates.cssSha); }
    if (updates.jsSha !== undefined) { setClauses.push(`js_sha256 = $${idx++}`); params.push(updates.jsSha); }
    if (updates.htmlSize !== undefined) { setClauses.push(`html_size = $${idx++}`); params.push(updates.htmlSize); }
    if (updates.cssSize !== undefined) { setClauses.push(`css_size = $${idx++}`); params.push(updates.cssSize); }
    if (updates.jsSize !== undefined) { setClauses.push(`js_size = $${idx++}`); params.push(updates.jsSize); }

    if (setClauses.length === 0) return false;
    setClauses.push(`updated_at = NOW()`);
    params.push(id, userId);
    const { rowCount } = await run(
        `UPDATE webpages SET ${setClauses.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
        params
    );
    return rowCount > 0;
}

/**
 * Read the persisted chat history for a webpage. Returns [] when the column
 * is empty, missing, or unparseable. Stored as JSONB so the array is the
 * canonical type — no JSON.parse failures from invalid strings.
 */
async function getChatMessages(id, userId) {
    await initDB();
    const r = await getOne('SELECT chat_messages FROM webpages WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!r) return [];
    const raw = r.chat_messages;
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
    return [];
}

/**
 * Replace the chat history for a webpage. The frontend is the source of
 * truth — it sends the full array on every save, so this is an idempotent
 * overwrite (no merge logic needed). Validates the shape and trims to a
 * reasonable size to keep the row lean.
 */
async function setChatMessages(id, userId, messages) {
    await initDB();
    const safe = Array.isArray(messages) ? messages : [];
    // Cap at the most recent 200 messages to prevent unbounded row growth.
    const trimmed = safe.slice(-200);
    const { rowCount } = await run(
        'UPDATE webpages SET chat_messages = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
        [JSON.stringify(trimmed), id, userId]
    );
    return rowCount > 0;
}

async function deleteWebpage(id, userId) {
    await initDB();
    const r = await getOne('SELECT * FROM webpages WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!r) return null;
    // Sources cascade-delete via FK.  Versions too.
    await run('DELETE FROM webpages WHERE id = $1 AND user_id = $2', [id, userId]);
    // Purge RustFS objects (best-effort, non-blocking on failure)
    purgeWebpageObjects(userId, id).catch(err =>
        console.warn(`[WebpageStore] Purge failed for ${id}:`, err.message));
    return mapWebpageRow(r);
}

// ── Source CRUD (mirrors notebookStore) ────────────────────────────

async function addSource({ webpageId, type, name, storageKey, fileName, metadata, wordCount }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO webpage_sources (id, webpage_id, type, name, storage_key, file_name, metadata, status, word_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', $8)`,
        [id, webpageId, type, name || 'Untitled', storageKey || null, fileName || null,
         JSON.stringify(metadata || {}), wordCount || 0]
    );
    await run('UPDATE webpages SET updated_at = NOW() WHERE id = $1', [webpageId]);
    return { id, webpageId, type, name, storageKey, fileName, metadata: metadata || {}, status: 'processing', wordCount: wordCount || 0 };
}

async function getSources(webpageId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM webpage_sources WHERE webpage_id = $1 ORDER BY created_at ASC`,
        [webpageId]
    );
    return rows.map(mapSourceRow);
}

async function getSource(id) {
    await initDB();
    const r = await getOne('SELECT * FROM webpage_sources WHERE id = $1', [id]);
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
        `UPDATE webpage_sources SET ${setClauses.join(', ')} WHERE id = $${idx}`,
        params
    );
    return rowCount > 0;
}

async function deleteSource(id) {
    await initDB();
    const r = await getOne('SELECT * FROM webpage_sources WHERE id = $1', [id]);
    if (!r) return null;
    await run('DELETE FROM webpage_sources WHERE id = $1', [id]);
    return mapSourceRow(r);
}

async function timeoutStuckSources(webpageId, { stuckMinutes = 10 } = {}) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE webpage_sources
            SET status = 'error',
                error = 'Ingestion timed out — retry or re-upload.',
                updated_at = NOW()
          WHERE webpage_id = $1
            AND status = 'processing'
            AND updated_at < NOW() - ($2::int * INTERVAL '1 minute')`,
        [webpageId, stuckMinutes]
    );
    return rowCount || 0;
}

// ── Row Mappers ─────────────────────────────────────────────────────

function parseJSON(v, fallback) {
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return v || fallback;
}

function mapWebpageRow(r) {
    return {
        id: r.id,
        userId: r.user_id,
        name: r.name,
        description: r.description || '',
        instructions: r.instructions || '',
        knowledgeBaseIds: parseJSON(r.knowledge_base_ids, []),
        settings: parseJSON(r.settings, {}),
        htmlSha: r.html_sha256 || '',
        cssSha: r.css_sha256 || '',
        jsSha: r.js_sha256 || '',
        htmlSize: parseInt(r.html_size) || 0,
        cssSize: parseInt(r.css_size) || 0,
        jsSize: parseInt(r.js_size) || 0,
        sourceCount: parseInt(r.source_count) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

function mapSourceRow(r) {
    return {
        id: r.id,
        webpageId: r.webpage_id,
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

// ── Version Control ─────────────────────────────────────────────────

const MAX_VERSIONS_PER_WEBPAGE = 200;
const AUTO_VERSION_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Snapshot the current trio of files into a new version. Copies the
 * RustFS objects server-side and records a metadata row.
 *
 * @param {string} userId
 * @param {string} webpageId
 * @param {string} summary
 * @param {object} [hashes] — optional pre-computed { htmlSha, cssSha, jsSha, contentLength }
 *                          taken from the webpage row to avoid re-hashing
 */
async function createVersion(userId, webpageId, summary = 'Auto-save', hashes = null) {
    await initDB();
    const id = crypto.randomUUID();

    // Copy each slot's current object into the version prefix.
    await Promise.all(SLOTS.map(slot => copySlotToVersion(userId, webpageId, id, slot)));

    let htmlSha = hashes?.htmlSha;
    let cssSha = hashes?.cssSha;
    let jsSha = hashes?.jsSha;
    let contentLength = hashes?.contentLength;
    if (!hashes) {
        const wp = await getOne('SELECT * FROM webpages WHERE id = $1 AND user_id = $2', [webpageId, userId]);
        htmlSha = wp?.html_sha256 || '';
        cssSha = wp?.css_sha256 || '';
        jsSha = wp?.js_sha256 || '';
        contentLength = (parseInt(wp?.html_size) || 0) + (parseInt(wp?.css_size) || 0) + (parseInt(wp?.js_size) || 0);
    }

    await run(
        `INSERT INTO webpage_versions (id, webpage_id, summary, html_sha256, css_sha256, js_sha256, content_length)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, webpageId, summary, htmlSha || '', cssSha || '', jsSha || '', contentLength || 0]
    );

    // Prune oldest versions beyond MAX, deleting their RustFS objects too.
    const pruned = await getAll(
        `SELECT id FROM webpage_versions
         WHERE webpage_id = $1
         ORDER BY created_at DESC
         OFFSET $2`,
        [webpageId, MAX_VERSIONS_PER_WEBPAGE]
    );
    if (pruned.length > 0) {
        const ids = pruned.map(r => r.id);
        await run(`DELETE FROM webpage_versions WHERE id = ANY($1::text[])`, [ids]);
        for (const vid of ids) {
            for (const slot of SLOTS) {
                const k = keyFor(userId, webpageId, slot, vid);
                try { await storageStore.deleteFile(k); } catch (_) {}
            }
        }
    }

    return { id, webpageId, summary, contentLength: contentLength || 0, createdAt: new Date().toISOString() };
}

async function getVersions(webpageId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT id, webpage_id, summary, content_length, created_at
         FROM webpage_versions
         WHERE webpage_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [webpageId, limit, offset]
    );
    return rows.map(r => ({
        id: r.id,
        webpageId: r.webpage_id,
        summary: r.summary || '',
        contentLength: parseInt(r.content_length) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
}

/**
 * Get a single version with full file-trio contents (read from RustFS).
 */
async function getVersion(userId, versionId) {
    await initDB();
    const r = await getOne('SELECT * FROM webpage_versions WHERE id = $1', [versionId]);
    if (!r) return null;
    const trio = await readAllSlots(userId, r.webpage_id, versionId);
    return {
        id: r.id,
        webpageId: r.webpage_id,
        summary: r.summary || '',
        contentLength: parseInt(r.content_length) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        ...trio,
    };
}

async function deleteVersion(userId, versionId) {
    await initDB();
    const r = await getOne('SELECT * FROM webpage_versions WHERE id = $1', [versionId]);
    if (!r) return false;
    await run('DELETE FROM webpage_versions WHERE id = $1', [versionId]);
    // Delete the version's RustFS objects
    for (const slot of SLOTS) {
        const k = keyFor(userId, r.webpage_id, slot, versionId);
        try { await storageStore.deleteFile(k); } catch (_) {}
    }
    return true;
}

async function shouldAutoVersion(webpageId) {
    await initDB();
    const latest = await getOne(
        `SELECT created_at FROM webpage_versions
         WHERE webpage_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [webpageId]
    );
    if (!latest) return true;
    const elapsed = Date.now() - new Date(latest.created_at).getTime();
    return elapsed >= AUTO_VERSION_DEBOUNCE_MS;
}

module.exports = {
    SLOTS,
    // Webpages
    createWebpage,
    getWebpages,
    getWebpage,
    updateWebpageMetadata,
    deleteWebpage,
    // Chat history
    getChatMessages,
    setChatMessages,
    // RustFS slot I/O
    sha256,
    keyFor,
    readSlot,
    readAllSlots,
    writeSlot,
    purgeWebpageObjects,
    // Sources
    addSource,
    getSources,
    getSource,
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
