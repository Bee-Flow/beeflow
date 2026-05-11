/**
 * House Style Store — per-organization Word/DOCX templates that drive the
 * styling of Notebook exports (font, headings, margins, header/footer logo).
 *
 * One org has zero or more house styles; at most one is marked as default.
 * The original .docx is kept as a blob so we can re-extract or regenerate
 * style metadata later without asking the user to re-upload.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS org_house_styles (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            docx_blob BYTEA NOT NULL,
            style_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_house_styles_org ON org_house_styles(org_id);
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_house_styles_default
            ON org_house_styles(org_id) WHERE is_default = TRUE;
    `);

    initialized = true;
}

initDB().catch(err => console.error('[houseStyleStore] initDB failed:', err));

function mapRow(r, { includeBlob = false } = {}) {
    if (!r) return null;
    const out = {
        id: r.id,
        orgId: r.org_id,
        name: r.name,
        description: r.description || '',
        styleMeta: typeof r.style_meta === 'string' ? safeJSON(r.style_meta) : (r.style_meta || {}),
        isDefault: !!r.is_default,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
    if (includeBlob) out.docxBlob = r.docx_blob;
    return out;
}

function safeJSON(v) { try { return JSON.parse(v); } catch (_) { return {}; } }

async function listForOrg(orgId) {
    await initDB();
    const rows = await getAll(
        `SELECT id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at
         FROM org_house_styles WHERE org_id = $1 ORDER BY is_default DESC, created_at DESC`,
        [orgId]
    );
    return rows.map(r => mapRow(r));
}

async function getById(id, orgId, { includeBlob = false } = {}) {
    await initDB();
    const cols = includeBlob
        ? 'id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at, docx_blob'
        : 'id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at';
    const row = await getOne(
        `SELECT ${cols} FROM org_house_styles WHERE id = $1 AND org_id = $2`,
        [id, orgId]
    );
    return mapRow(row, { includeBlob });
}

async function getDefaultForOrg(orgId, { includeBlob = false } = {}) {
    await initDB();
    const cols = includeBlob
        ? 'id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at, docx_blob'
        : 'id, org_id, name, description, style_meta, is_default, created_by, created_at, updated_at';
    const row = await getOne(
        `SELECT ${cols} FROM org_house_styles WHERE org_id = $1 AND is_default = TRUE LIMIT 1`,
        [orgId]
    );
    return mapRow(row, { includeBlob });
}

async function create({ orgId, name, description, docxBuffer, styleMeta, createdBy, makeDefault }) {
    await initDB();
    const id = crypto.randomUUID();
    if (makeDefault) await clearDefault(orgId);
    await run(
        `INSERT INTO org_house_styles (id, org_id, name, description, docx_blob, style_meta, is_default, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, orgId, name, description || '', docxBuffer, JSON.stringify(styleMeta || {}), !!makeDefault, createdBy || null]
    );
    return getById(id, orgId);
}

async function update(id, orgId, updates) {
    await initDB();
    const fields = [];
    const values = [];
    let i = 1;
    if (updates.name !== undefined)        { fields.push(`name = $${i++}`);        values.push(updates.name); }
    if (updates.description !== undefined) { fields.push(`description = $${i++}`); values.push(updates.description); }
    if (updates.styleMeta !== undefined)   { fields.push(`style_meta = $${i++}`);  values.push(JSON.stringify(updates.styleMeta)); }
    if (!fields.length && updates.isDefault === undefined) return getById(id, orgId);
    if (updates.isDefault === true) {
        await clearDefault(orgId);
        fields.push(`is_default = TRUE`);
    } else if (updates.isDefault === false) {
        fields.push(`is_default = FALSE`);
    }
    fields.push(`updated_at = NOW()`);
    values.push(id, orgId);
    await run(
        `UPDATE org_house_styles SET ${fields.join(', ')} WHERE id = $${i++} AND org_id = $${i++}`,
        values
    );
    return getById(id, orgId);
}

async function clearDefault(orgId) {
    await initDB();
    await run(`UPDATE org_house_styles SET is_default = FALSE WHERE org_id = $1 AND is_default = TRUE`, [orgId]);
}

async function remove(id, orgId) {
    await initDB();
    await run(`DELETE FROM org_house_styles WHERE id = $1 AND org_id = $2`, [id, orgId]);
}

module.exports = {
    initDB,
    listForOrg,
    getById,
    getDefaultForOrg,
    create,
    update,
    remove,
};
