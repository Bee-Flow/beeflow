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
// Versioned slots include the SQLite database — `data.db` is snapshotted
// alongside the text files but isn't part of the text-write code paths.
const VERSIONED_SLOTS = [...SLOTS, 'db'];
const CONTENT_TYPES = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    db: 'application/vnd.sqlite3',
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

    // SQLite database slot — sha + size of the at-rest `data.db` blob in RustFS.
    // The DB itself is run server-side by webpageDbStore.
    try {
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS db_sha256 TEXT DEFAULT ''`);
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS db_size INTEGER DEFAULT 0`);
    } catch (_) { /* column already exists — fine */ }

    // Card metadata — emoji icon, accent colour and tagline the AI sets after
    // building/editing a page so the Webpages list shows a visual identity
    // instead of a generic file-code icon. Thumbnail is a small rendered
    // screenshot stored under users/{userId}/webpages/{id}/thumbnail.png; we
    // keep its sha + size in DB for cache-busting and cheap list rendering.
    try {
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS icon TEXT DEFAULT ''`);
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS accent_color TEXT DEFAULT ''`);
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS tagline TEXT DEFAULT ''`);
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS thumbnail_sha256 TEXT DEFAULT ''`);
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS thumbnail_size INTEGER DEFAULT 0`);
    } catch (_) { /* columns already exist — fine */ }

    // Publishing — same 3-mode model as agents/KBs: Personal (is_published=false),
    // Entire Org (is_published=true, shared_groups=[]), Specific Groups
    // (is_published=true, shared_groups=[...]). organization_id is set on first
    // publish from the owner's primary org so cross-org leakage is impossible.
    try {
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS is_published BOOLEAN DEFAULT FALSE`);
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS shared_groups TEXT DEFAULT '[]'`);
        await exec(`ALTER TABLE webpages ADD COLUMN IF NOT EXISTS organization_id TEXT`);
        await exec(`CREATE INDEX IF NOT EXISTS idx_webpages_org_published ON webpages(organization_id, is_published)`);
    } catch (_) { /* columns already exist — fine */ }

    // Multi-file support — arbitrary additional files under a webpage.
    // The three primary slots (index.html / style.css / script.js) keep their
    // dedicated columns and RustFS keys; this table stores everything else.
    await exec(`
        CREATE TABLE IF NOT EXISTS webpage_extra_files (
            id TEXT PRIMARY KEY,
            webpage_id TEXT NOT NULL REFERENCES webpages(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            mime_type TEXT NOT NULL DEFAULT 'text/plain',
            is_text BOOLEAN NOT NULL DEFAULT TRUE,
            sha256 TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_webpage_extra_path ON webpage_extra_files(webpage_id, path);
    `);

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
 * Restore a versioned slot back over `current/` via a server-side copy.
 * Used by the version restore route for the `db` slot (text slots use
 * `writeSlot` because they need the content for the response payload).
 * Returns `true` if the source object existed and was copied; `false` if
 * the version had no object for this slot (e.g. a pre-DB snapshot).
 */
async function restoreSlotFromVersion(userId, webpageId, versionId, slot) {
    if (!storageStore.isAvailable()) return false;
    const src = keyFor(userId, webpageId, slot, versionId);
    const dst = keyFor(userId, webpageId, slot);
    try {
        await storageStore.copyObject(src, dst);
        return true;
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
            // No DB in this snapshot — drop the current one too so the restore
            // is a true reset to the snapshot's state.
            try { await storageStore.deleteFile(dst); } catch (_) {}
            return false;
        }
        throw err;
    }
}

// ── Thumbnail helpers ──────────────────────────────────────────────
//
// A small rendered screenshot stored alongside the slot files in RustFS so
// the Webpages list can render a real preview tile instead of a generic
// icon. Owner-prefixed because every webpage lives under its owner's path.

function thumbnailKey(userId, webpageId) {
    return `users/${userId}/webpages/${webpageId}/thumbnail.png`;
}

async function writeThumbnail(userId, webpageId, buffer) {
    if (!storageStore.isAvailable()) {
        throw new Error('RustFS not configured — cannot persist thumbnail');
    }
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const key = thumbnailKey(userId, webpageId);
    await storageStore.uploadFile(key, buf, 'image/png');
    return { sha: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

async function readThumbnail(userId, webpageId) {
    if (!storageStore.isAvailable()) return null;
    try {
        const { stream } = await storageStore.streamFile(thumbnailKey(userId, webpageId));
        const chunks = [];
        for await (const c of stream) chunks.push(c);
        return Buffer.concat(chunks);
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

// ── Extra-files (multi-file) RustFS helpers ────────────────────────
//
// Extra files live at `users/{userId}/webpages/{webpageId}/extras/{path}`.
// The path is the user-facing relative path (e.g. "components/header.html",
// "assets/logo.svg"). RustFS S3 supports slashes in keys natively.

const TEXT_MIME_PREFIXES = ['text/', 'application/javascript', 'application/json', 'application/xml', 'image/svg+xml'];
const TEXT_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md', 'svg', 'xml', 'csv', 'tsv', 'yaml', 'yml']);

function isTextFile(mime, ext) {
    if (mime && TEXT_MIME_PREFIXES.some(p => mime.startsWith(p))) return true;
    if (ext && TEXT_EXTENSIONS.has(ext.toLowerCase())) return true;
    return false;
}

function guessMime(path) {
    const ext = (path.split('.').pop() || '').toLowerCase();
    const map = {
        html: 'text/html; charset=utf-8',
        htm: 'text/html; charset=utf-8',
        css: 'text/css; charset=utf-8',
        js: 'application/javascript; charset=utf-8',
        mjs: 'application/javascript; charset=utf-8',
        json: 'application/json; charset=utf-8',
        txt: 'text/plain; charset=utf-8',
        md: 'text/markdown; charset=utf-8',
        svg: 'image/svg+xml; charset=utf-8',
        xml: 'application/xml; charset=utf-8',
        csv: 'text/csv; charset=utf-8',
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        ico: 'image/x-icon',
        woff: 'font/woff',
        woff2: 'font/woff2',
        ttf: 'font/ttf',
        otf: 'font/otf',
        mp3: 'audio/mpeg',
        mp4: 'video/mp4',
        webm: 'video/webm',
        pdf: 'application/pdf',
    };
    return { mime: map[ext] || 'application/octet-stream', ext };
}

/**
 * Path validation: allow nested folders, reject path traversal, leading /,
 * empty segments, or anything weird. Reserved names are blocked because
 * they collide with the primary slots' filenames.
 */
const RESERVED_PATHS = new Set(['index.html', 'style.css', 'script.js']);
function validateExtraPath(path) {
    if (typeof path !== 'string' || !path.trim()) return 'path is required';
    if (path.length > 240) return 'path is too long';
    if (path.startsWith('/') || path.startsWith('\\')) return 'path must be relative (no leading slash)';
    if (path.includes('..')) return 'path may not contain ".."';
    if (/^\s|\s$/.test(path)) return 'path may not start or end with whitespace';
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 0) return 'path is empty';
    for (const s of segs) {
        if (!s || s === '.' || s === '..') return `invalid path segment "${s}"`;
        if (!/^[A-Za-z0-9_.\- @]+$/.test(s)) return `path segment "${s}" contains unsupported characters`;
    }
    if (RESERVED_PATHS.has(path)) return `"${path}" is a primary slot — use webpage_file_write({file:"${path === 'index.html' ? 'html' : path === 'style.css' ? 'css' : 'js'}", ...}) instead`;
    return null;
}

function extraKey(userId, webpageId, path) {
    return `users/${userId}/webpages/${webpageId}/extras/${path}`;
}

async function readExtra(userId, webpageId, path) {
    if (!storageStore.isAvailable()) return null;
    try {
        const { stream } = await storageStore.streamFile(extraKey(userId, webpageId, path));
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

async function writeExtra(userId, webpageId, path, content, mimeType) {
    if (!storageStore.isAvailable()) {
        throw new Error('RustFS not configured — cannot persist extra files');
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    await storageStore.uploadFile(extraKey(userId, webpageId, path), buf, mimeType);
    return { sha: sha256(buf.toString('utf8')), size: buf.length };
}

async function deleteExtra(userId, webpageId, path) {
    if (!storageStore.isAvailable()) return;
    try { await storageStore.deleteFile(extraKey(userId, webpageId, path)); } catch (_) { /* ignore */ }
}

// ── Extra-files DB CRUD ───────────────────────────────────────────

async function listExtraFiles(webpageId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM webpage_extra_files WHERE webpage_id = $1 ORDER BY path ASC`,
        [webpageId]
    );
    return rows.map(mapExtraFileRow);
}

async function getExtraFile(webpageId, path) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM webpage_extra_files WHERE webpage_id = $1 AND path = $2`,
        [webpageId, path]
    );
    return r ? mapExtraFileRow(r) : null;
}

/**
 * Upsert a single extra file. Writes bytes to RustFS and metadata to DB.
 */
async function upsertExtraFile({ webpageId, userId, path, content }) {
    await initDB();
    const validation = validateExtraPath(path);
    if (validation) throw new Error(validation);

    const { mime, ext } = guessMime(path);
    const isText = isTextFile(mime, ext);
    const { sha, size } = await writeExtra(userId, webpageId, path, content, mime);

    const existing = await getExtraFile(webpageId, path);
    if (existing) {
        await run(
            `UPDATE webpage_extra_files SET mime_type = $1, is_text = $2, sha256 = $3, size = $4, updated_at = NOW()
             WHERE webpage_id = $5 AND path = $6`,
            [mime, isText, sha, size, webpageId, path]
        );
        return { ...existing, mimeType: mime, isText, sha256: sha, size, updatedAt: new Date().toISOString() };
    }

    const id = crypto.randomUUID();
    await run(
        `INSERT INTO webpage_extra_files (id, webpage_id, path, mime_type, is_text, sha256, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, webpageId, path, mime, isText, sha, size]
    );
    await run('UPDATE webpages SET updated_at = NOW() WHERE id = $1', [webpageId]);
    return { id, webpageId, path, mimeType: mime, isText, sha256: sha, size };
}

async function deleteExtraFile({ webpageId, userId, path }) {
    await initDB();
    const existing = await getExtraFile(webpageId, path);
    if (!existing) return false;
    await run('DELETE FROM webpage_extra_files WHERE webpage_id = $1 AND path = $2', [webpageId, path]);
    await deleteExtra(userId, webpageId, path);
    await run('UPDATE webpages SET updated_at = NOW() WHERE id = $1', [webpageId]);
    return true;
}

/**
 * Read a single extra file's content. Returns { meta, text? , bytes? } where
 * `text` is set for text files and `bytes` (Buffer) for binary. Returns null
 * when the file doesn't exist.
 */
async function readExtraFile({ webpageId, userId, path }) {
    const meta = await getExtraFile(webpageId, path);
    if (!meta) return null;
    const buf = await readExtra(userId, webpageId, path);
    if (!buf) return { meta, text: '', bytes: Buffer.alloc(0) };
    return meta.isText
        ? { meta, text: buf.toString('utf8'), bytes: buf }
        : { meta, bytes: buf };
}

function mapExtraFileRow(r) {
    return {
        id: r.id,
        webpageId: r.webpage_id,
        path: r.path,
        mimeType: r.mime_type,
        isText: r.is_text === true || r.is_text === 't',
        sha256: r.sha256 || '',
        size: parseInt(r.size) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
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

/**
 * Owner-agnostic lookup — used by the publish endpoint and visibility checks
 * where we need the row before we know if the caller is the owner. Callers
 * MUST gate access via canReadWebpage / owner check before returning to UI.
 */
async function getWebpageRaw(id) {
    await initDB();
    const r = await getOne(
        `SELECT w.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM webpages w
         LEFT JOIN (
             SELECT webpage_id, COUNT(*) AS source_count
             FROM webpage_sources GROUP BY webpage_id
         ) s ON s.webpage_id = w.id
         WHERE w.id = $1`,
        [id]
    );
    return r ? mapWebpageRow(r) : null;
}

/**
 * List webpages the user can see: ones they own + ones published into their
 * org/groups. Mirrors getPublishedAgentsForUser's predicate.
 */
async function getAccessibleWebpages(userId, userGroupIds = [], userOrgIds = [], { limit = 50, offset = 0 } = {}) {
    await initDB();
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    const groupIds = Array.isArray(userGroupIds) ? userGroupIds : [];
    const rows = await getAll(
        `SELECT w.*,
                COALESCE(s.source_count, 0) AS source_count
         FROM webpages w
         LEFT JOIN (
             SELECT webpage_id, COUNT(*) AS source_count
             FROM webpage_sources GROUP BY webpage_id
         ) s ON s.webpage_id = w.id
         WHERE w.user_id = $1
            OR (w.is_published = TRUE AND w.organization_id IS NOT NULL AND w.organization_id = ANY($2::text[]))
         ORDER BY w.updated_at DESC
         LIMIT $3 OFFSET $4`,
        [userId, orgIds, limit, offset]
    );
    // Filter shared_groups in JS — keeps the SQL portable and parsing consistent.
    return rows
        .map(mapWebpageRow)
        .filter(w => {
            if (w.userId === userId) return true;
            if (!w.isPublished) return false;
            const groups = Array.isArray(w.sharedGroups) ? w.sharedGroups : [];
            if (groups.length === 0) return true; // entire-org publish
            return groups.some(g => groupIds.includes(g));
        });
}

/**
 * Single-row visibility predicate. Returns true if the caller can read the
 * webpage; mirrors the agent canSeePublished rules.
 */
function canReadWebpage(webpage, userId, userGroupIds = [], userOrgIds = []) {
    if (!webpage) return false;
    if (webpage.userId === userId) return true;
    if (!webpage.isPublished) return false;
    if (!webpage.organizationId) return false;
    const orgIds = Array.isArray(userOrgIds) ? userOrgIds : [...(userOrgIds || [])];
    if (!orgIds.includes(webpage.organizationId)) return false;
    const groups = Array.isArray(webpage.sharedGroups) ? webpage.sharedGroups : [];
    if (groups.length === 0) return true;
    return groups.some(g => userGroupIds.includes(g));
}

// Same surface as canReadWebpage. Automations were opted in to write to
// shared/published webpages by product decision; if we later need to gate
// writes more tightly (e.g. only writers in an explicit acl), narrow here.
function canWriteWebpage(webpage, userId, userGroupIds = [], userOrgIds = []) {
    return canReadWebpage(webpage, userId, userGroupIds, userOrgIds);
}

/**
 * Toggle published state + sharing scope. When sharedGroups is undefined,
 * preserve the existing DB value (same trap as agents had — see
 * setAgentPublished). organizationId is set on first publish so visibility
 * filters can match against the owner's org without a join.
 */
async function setWebpagePublished(id, isPublished, ownerId, sharedGroups = undefined, organizationId = undefined) {
    await initDB();
    const sets = ['is_published = $1', 'updated_at = NOW()'];
    const params = [!!isPublished];
    let idx = 2;
    if (sharedGroups !== undefined) {
        sets.push(`shared_groups = $${idx++}`);
        params.push(JSON.stringify(sharedGroups || []));
    }
    if (organizationId !== undefined) {
        sets.push(`organization_id = $${idx++}`);
        params.push(organizationId || null);
    }
    params.push(id, ownerId);
    const { rowCount } = await run(
        `UPDATE webpages SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
        params
    );
    return rowCount > 0;
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
    if (updates.dbSha !== undefined) { setClauses.push(`db_sha256 = $${idx++}`); params.push(updates.dbSha); }
    if (updates.dbSize !== undefined) { setClauses.push(`db_size = $${idx++}`); params.push(updates.dbSize); }
    if (updates.icon !== undefined) { setClauses.push(`icon = $${idx++}`); params.push(updates.icon); }
    if (updates.accentColor !== undefined) { setClauses.push(`accent_color = $${idx++}`); params.push(updates.accentColor); }
    if (updates.tagline !== undefined) { setClauses.push(`tagline = $${idx++}`); params.push(updates.tagline); }
    if (updates.thumbnailSha !== undefined) { setClauses.push(`thumbnail_sha256 = $${idx++}`); params.push(updates.thumbnailSha); }
    if (updates.thumbnailSize !== undefined) { setClauses.push(`thumbnail_size = $${idx++}`); params.push(updates.thumbnailSize); }

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
        dbSha: r.db_sha256 || '',
        htmlSize: parseInt(r.html_size) || 0,
        cssSize: parseInt(r.css_size) || 0,
        jsSize: parseInt(r.js_size) || 0,
        dbSize: parseInt(r.db_size) || 0,
        isPublished: r.is_published === true || r.is_published === 't',
        sharedGroups: parseJSON(r.shared_groups, []),
        organizationId: r.organization_id || null,
        icon: r.icon || '',
        accentColor: r.accent_color || '',
        tagline: r.tagline || '',
        thumbnailSha: r.thumbnail_sha256 || '',
        thumbnailSize: parseInt(r.thumbnail_size) || 0,
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

    // Copy each slot's current object into the version prefix — text slots
    // plus the SQLite database (if present). copySlotToVersion is a no-op
    // when the source key doesn't exist, so empty slots cost nothing.
    await Promise.all(VERSIONED_SLOTS.map(slot => copySlotToVersion(userId, webpageId, id, slot)));

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
            for (const slot of VERSIONED_SLOTS) {
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
    // Delete the version's RustFS objects (text slots + the snapshotted DB)
    for (const slot of VERSIONED_SLOTS) {
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
    VERSIONED_SLOTS,
    // Webpages
    createWebpage,
    getWebpages,
    getWebpage,
    getWebpageRaw,
    getAccessibleWebpages,
    canReadWebpage,
    canWriteWebpage,
    setWebpagePublished,
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
    restoreSlotFromVersion,
    purgeWebpageObjects,
    // Thumbnail
    writeThumbnail,
    readThumbnail,
    thumbnailKey,
    // Extra files (multi-file)
    listExtraFiles,
    getExtraFile,
    readExtraFile,
    upsertExtraFile,
    deleteExtraFile,
    validateExtraPath,
    isTextFile,
    guessMime,
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
