/**
 * Slides Store — PostgreSQL-backed CRUD for AI Slide Decks.
 *
 * Mirrors notebookStore.js architecture exactly — uses the same
 * { run, getOne, getAll, exec } helpers from ../db (NOT getPool()).
 *
 *   slide_decks          – top-level deck metadata + slides JSON
 *   slide_deck_sources   – uploaded/pasted/URL source references
 *   slide_deck_versions  – immutable content snapshots for undo history
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;

    // ── Slide Decks table ─────────────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS slide_decks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled Slides',
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            settings JSONB DEFAULT '{}'::jsonb,
            slides_content JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_slide_decks_user ON slide_decks(user_id);
        CREATE INDEX IF NOT EXISTS idx_slide_decks_updated ON slide_decks(updated_at DESC);
    `);

    // ── Slide Deck Sources table ──────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS slide_deck_sources (
            id TEXT PRIMARY KEY,
            deck_id TEXT NOT NULL REFERENCES slide_decks(id) ON DELETE CASCADE,
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
        CREATE INDEX IF NOT EXISTS idx_slide_deck_sources_deck ON slide_deck_sources(deck_id);
    `);

    // ── Slide Deck Versions table (immutable snapshots) ───────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS slide_deck_versions (
            id TEXT PRIMARY KEY,
            deck_id TEXT NOT NULL REFERENCES slide_decks(id) ON DELETE CASCADE,
            content JSONB NOT NULL DEFAULT '[]'::jsonb,
            summary TEXT DEFAULT '',
            slide_count INTEGER DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_slide_deck_versions_deck ON slide_deck_versions(deck_id, created_at DESC);
    `);

    initialized = true;
    console.log('[SlidesStore] PostgreSQL initialized');
}

// Eager init on module load (same pattern as notebookStore)
initDB().catch(err => console.error('[SlidesStore] Init error:', err.message));

// ─── Slide Deck CRUD ─────────────────────────────────────────────

async function createDeck(userId, name, description = '') {
    await initDB();
    const id = crypto.randomUUID();
    const defaultSettings = { theme: 'corporate', aspectRatio: '16:9' };
    const defaultSlides = [
        {
            id: crypto.randomUUID(),
            layout: 'title',
            elements: [
                {
                    id: crypto.randomUUID(),
                    type: 'heading',
                    content: name || 'Untitled Slides',
                    position: { x: 10, y: 25, width: 80, height: 30 },
                    style: { fontSize: '44px', fontWeight: 'bold', textAlign: 'center' }
                },
                {
                    id: crypto.randomUUID(),
                    type: 'text',
                    content: 'Click to add subtitle',
                    position: { x: 20, y: 58, width: 60, height: 10 },
                    style: { fontSize: '22px', textAlign: 'center', opacity: 0.7 }
                }
            ],
            notes: '',
            background: null,
            transition: 'fade'
        }
    ];

    const row = await getOne(
        `INSERT INTO slide_decks (id, user_id, name, description, settings, slides_content)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [id, userId, name || 'Untitled Slides', description,
         JSON.stringify(defaultSettings), JSON.stringify(defaultSlides)]
    );
    return parseDeckRow(row);
}

async function getDecks(userId) {
    await initDB();
    const rows = await getAll(
        `SELECT d.*,
                (SELECT COUNT(*)::int FROM slide_deck_sources WHERE deck_id = d.id) AS source_count,
                COALESCE(jsonb_array_length(d.slides_content), 0) AS slide_count
         FROM slide_decks d
         WHERE d.user_id = $1
         ORDER BY d.updated_at DESC`,
        [userId]
    );
    return rows.map(parseDeckRow);
}

async function getDeck(deckId, userId) {
    await initDB();
    const row = await getOne(
        `SELECT * FROM slide_decks WHERE id = $1 AND user_id = $2`,
        [deckId, userId]
    );
    return parseDeckRow(row);
}

async function updateDeck(deckId, userId, updates) {
    await initDB();

    const allowedFields = ['name', 'description', 'instructions', 'knowledge_base_ids', 'settings', 'slides_content'];
    const sets = [];
    const values = [];
    let paramIdx = 1;

    for (const field of allowedFields) {
        if (updates[field] !== undefined) {
            const isJsonb = ['knowledge_base_ids', 'settings', 'slides_content'].includes(field);
            sets.push(`${field} = $${paramIdx}${isJsonb ? '::jsonb' : ''}`);
            values.push(isJsonb ? JSON.stringify(updates[field]) : updates[field]);
            paramIdx++;
        }
    }

    if (sets.length === 0) return null;
    sets.push(`updated_at = NOW()`);
    values.push(deckId, userId);

    const row = await getOne(
        `UPDATE slide_decks SET ${sets.join(', ')} WHERE id = $${paramIdx} AND user_id = $${paramIdx + 1} RETURNING *`,
        values
    );
    return parseDeckRow(row);
}

async function deleteDeck(deckId, userId) {
    await initDB();
    const result = await run(
        `DELETE FROM slide_decks WHERE id = $1 AND user_id = $2`,
        [deckId, userId]
    );
    return result.rowCount > 0;
}

// ─── Sources CRUD ────────────────────────────────────────────────

async function addSource({ deckId, type, name, storageKey, fileName, metadata, wordCount }) {
    await initDB();
    const id = crypto.randomUUID();
    const row = await getOne(
        `INSERT INTO slide_deck_sources (id, deck_id, type, name, storage_key, file_name, metadata, word_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [id, deckId, type || 'text', name || 'Untitled', storageKey || null, fileName || null,
         JSON.stringify(metadata || {}), wordCount || 0]
    );
    return parseSourceRow(row);
}

async function getSources(deckId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM slide_deck_sources WHERE deck_id = $1 ORDER BY created_at ASC`,
        [deckId]
    );
    return rows.map(parseSourceRow);
}

async function getSource(sourceId) {
    await initDB();
    const row = await getOne(`SELECT * FROM slide_deck_sources WHERE id = $1`, [sourceId]);
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
        `UPDATE slide_deck_sources SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
        values
    );
    return parseSourceRow(row);
}

async function deleteSource(sourceId) {
    await initDB();
    const result = await run(`DELETE FROM slide_deck_sources WHERE id = $1`, [sourceId]);
    return result.rowCount > 0;
}

// ─── Version History ─────────────────────────────────────────────

async function createVersion(deckId, content, summary = '') {
    await initDB();
    const id = crypto.randomUUID();
    const slideCount = Array.isArray(content) ? content.length : 0;
    const row = await getOne(
        `INSERT INTO slide_deck_versions (id, deck_id, content, summary, slide_count)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         RETURNING *`,
        [id, deckId, JSON.stringify(content), summary, slideCount]
    );

    // Keep only last 20 versions per deck
    await run(
        `DELETE FROM slide_deck_versions WHERE deck_id = $1
         AND id NOT IN (SELECT id FROM slide_deck_versions WHERE deck_id = $1 ORDER BY created_at DESC LIMIT 20)`,
        [deckId]
    );

    return parseVersionRow(row);
}

async function getVersions(deckId) {
    await initDB();
    const rows = await getAll(
        `SELECT id, deck_id, summary, slide_count, created_at FROM slide_deck_versions
         WHERE deck_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [deckId]
    );
    return rows.map(parseVersionRow);
}

async function getVersion(versionId) {
    await initDB();
    const row = await getOne(`SELECT * FROM slide_deck_versions WHERE id = $1`, [versionId]);
    return parseVersionRow(row);
}

async function deleteVersion(versionId) {
    await initDB();
    const result = await run(`DELETE FROM slide_deck_versions WHERE id = $1`, [versionId]);
    return result.rowCount > 0;
}

async function shouldAutoVersion(deckId) {
    await initDB();
    const row = await getOne(
        `SELECT created_at FROM slide_deck_versions WHERE deck_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [deckId]
    );
    if (!row) return true;
    const lastVersion = new Date(row.created_at);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    return lastVersion < fiveMinutesAgo;
}

// ─── Row Parsers ─────────────────────────────────────────────────

function parseDeckRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        userId: row.user_id,
        name: row.name,
        description: row.description || '',
        instructions: row.instructions || '',
        knowledgeBaseIds: safeJsonParse(row.knowledge_base_ids, []),
        settings: safeJsonParse(row.settings, {}),
        slidesContent: safeJsonParse(row.slides_content, []),
        sourceCount: row.source_count ?? 0,
        slideCount: row.slide_count ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function parseSourceRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        deckId: row.deck_id,
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
        deckId: row.deck_id,
        content: safeJsonParse(row.content, []),
        summary: row.summary || '',
        slideCount: row.slide_count || 0,
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
    createDeck,
    getDecks,
    getDeck,
    updateDeck,
    deleteDeck,
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
