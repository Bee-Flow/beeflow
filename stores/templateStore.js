/**
 * Template Store — PostgreSQL-backed Word template management.
 *
 * Stores template metadata (per-user) so they can be listed,
 * viewed, renamed, and deleted from the Templates page.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS word_templates (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT 'Untitled Template',
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            file_name TEXT,
            storage_key TEXT NOT NULL,
            parameters JSONB DEFAULT '[]'::jsonb,
            knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_word_templates_user ON word_templates(user_id);
        CREATE INDEX IF NOT EXISTS idx_word_templates_created ON word_templates(created_at DESC);
    `);

    // Migrations for existing tables
    await exec(`ALTER TABLE word_templates ADD COLUMN IF NOT EXISTS instructions TEXT DEFAULT ''`);
    await exec(`ALTER TABLE word_templates ADD COLUMN IF NOT EXISTS knowledge_base_ids JSONB DEFAULT '[]'::jsonb`);

    initialized = true;
    console.log('[TemplateStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[TemplateStore] Init error:', err.message));

// ── CRUD ─────────────────────────────────────────────────

async function createTemplate({ userId, name, description, instructions, fileName, storageKey, parameters, knowledgeBaseIds }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO word_templates (id, user_id, name, description, instructions, file_name, storage_key, parameters, knowledge_base_ids)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, userId, name || fileName || 'Untitled Template', description || '', instructions || '', fileName, storageKey, JSON.stringify(parameters || []), JSON.stringify(knowledgeBaseIds || [])]
    );
    console.log(`[TemplateStore] Created template "${name}" for user ${userId}`);
    return { id, userId, name, description, instructions, fileName, storageKey, parameters, knowledgeBaseIds: knowledgeBaseIds || [], createdAt: new Date().toISOString() };
}

async function getTemplates(userId, { limit = 50, offset = 0 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT id, user_id, name, description, file_name, storage_key, parameters, created_at, updated_at
         FROM word_templates
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [userId, limit, offset]
    );
    return rows.map(mapRow);
}

async function getTemplate(id, userId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM word_templates WHERE id = $1 AND user_id = $2`,
        [id, userId]
    );
    if (!r) return null;
    return mapRow(r);
}

async function updateTemplate(id, userId, updates) {
    await initDB();
    const setClauses = [];
    const params = [];
    let idx = 1;

    if (updates.name !== undefined) { setClauses.push(`name = $${idx++}`); params.push(updates.name); }
    if (updates.description !== undefined) { setClauses.push(`description = $${idx++}`); params.push(updates.description); }
    if (updates.instructions !== undefined) { setClauses.push(`instructions = $${idx++}`); params.push(updates.instructions); }
    if (updates.parameters !== undefined) { setClauses.push(`parameters = $${idx++}`); params.push(JSON.stringify(updates.parameters)); }
    if (updates.knowledgeBaseIds !== undefined) { setClauses.push(`knowledge_base_ids = $${idx++}`); params.push(JSON.stringify(updates.knowledgeBaseIds)); }

    if (setClauses.length === 0) return false;
    setClauses.push(`updated_at = NOW()`);
    params.push(id, userId);
    const { rowCount } = await run(
        `UPDATE word_templates SET ${setClauses.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
        params
    );
    return rowCount > 0;
}

async function deleteTemplate(id, userId) {
    await initDB();
    // Return the storage key so the caller can delete the file from RustFS
    const r = await getOne('SELECT storage_key FROM word_templates WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!r) return null;
    await run('DELETE FROM word_templates WHERE id = $1 AND user_id = $2', [id, userId]);
    return { storageKey: r.storage_key };
}

function mapRow(r) {
    const parseJSON = (v, fallback) => {
        if (Array.isArray(v)) return v;
        if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
        return v || fallback;
    };
    return {
        id: r.id,
        userId: r.user_id,
        name: r.name,
        description: r.description || '',
        instructions: r.instructions || '',
        fileName: r.file_name,
        storageKey: r.storage_key,
        parameters: parseJSON(r.parameters, []),
        knowledgeBaseIds: parseJSON(r.knowledge_base_ids, []),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = {
    createTemplate,
    getTemplates,
    getTemplate,
    updateTemplate,
    deleteTemplate,
};
