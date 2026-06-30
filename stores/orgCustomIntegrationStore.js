/**
 * Org Custom Integration Store — AI Integration Builder persistence.
 *
 * Org-scoped custom integrations built by an admin with an AI agent. Two
 * kinds: 'rest' (declarative toolset run by the hardened generic runner) and
 * 'mcp_remote' (vendor-hosted HTTP MCP server). Lifecycle draft → review/test
 * → active.
 *
 * `definition` is the mutable working copy; saveDefinition bumps
 * definition_version and appends to org_custom_integration_versions.
 * activate() FREEZES the current definition into activated_definition /
 * activated_version — later edits never change what runs until re-activation.
 *
 * The slug (^[a-z0-9]{4,16}$, no underscores) namespaces tool names as
 * cint_<slug>_<toolName>; it is random, globally unique, and immutable.
 * Credentials are NOT stored here — they live in integration_connections
 * under provider 'custom:<integrationId>', encrypted via orgVault.
 */

const crypto = require('crypto');
const { run, getOne, getAll, getClient } = require('../db');
// Same '__default_org__' sentinel funnel as named connections — custom
// integrations and their credentials must agree on the org id.
const { resolveOrgId, DEFAULT_ORG_SENTINEL } = require('./integrationConnectionStore');

const KINDS = new Set(['rest', 'mcp_remote']);
const STATUSES = new Set(['draft', 'active', 'disabled']);
const LEND_MODES = new Set(['org', 'byo']);

// ── Schema ──────────────────────────────────────────────────────────
let initialized = false;
async function initDB() {
    if (initialized) return;
    try {
        await require('../migrations/org-custom-integrations-2026-06').up();
    } catch (err) {
        console.error('[OrgCustomIntegrationStore] migration error:', err.message);
    }
    initialized = true;
}
initDB().catch(err => console.error('[OrgCustomIntegrationStore] init error:', err.message));

// ── Pure helpers ────────────────────────────────────────────────────
const SLUG_RE = /^[a-z0-9]{4,16}$/;
const SLUG_LENGTH = 11;

/**
 * Random lowercase base36 slug, default 11 chars (clamped to the 4..16 the
 * spec allows). Pure given crypto.randomBytes — unit-testable.
 */
function generateSlug(length = SLUG_LENGTH) {
    const len = Math.min(16, Math.max(4, Math.floor(length) || SLUG_LENGTH));
    let s = '';
    while (s.length < len) {
        // 64 random bits → up to 13 base36 chars; loop covers short outputs
        s += crypto.randomBytes(8).readBigUInt64BE(0).toString(36);
    }
    return s.slice(0, len);
}

// pg usually hands JSONB back as objects, but normalize strings too (mirrors
// mcpStore.parseRow) so callers never see double-encoded values.
function parseJson(value, fallback) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch (_) { return fallback; }
    }
    return value;
}

function shapeIntegration(row) {
    if (!row) return null;
    return {
        id: row.id,
        orgId: row.org_id,
        slug: row.slug,
        kind: row.kind,
        name: row.name,
        description: row.description || null,
        status: row.status,
        definition: parseJson(row.definition, {}),
        definitionVersion: row.definition_version,
        activatedDefinition: parseJson(row.activated_definition, null),
        activatedVersion: row.activated_version ?? null,
        toolsCache: parseJson(row.tools_cache, []),
        allowWrites: row.allow_writes === true,
        lendMode: row.lend_mode || null,
        lastValidation: parseJson(row.last_validation, null),
        createdBy: row.created_by,
        activatedBy: row.activated_by || null,
        activatedAt: row.activated_at || null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        // builder_session is deliberately NOT shaped in — it can be large and
        // is only needed by the builder itself (getBuilderSession).
    };
}

// ── CRUD ────────────────────────────────────────────────────────────

const MAX_SLUG_ATTEMPTS = 5;

/**
 * Create a draft integration with a fresh random slug. Retries on the
 * (astronomically unlikely) slug unique-collision.
 */
async function createIntegration({ orgId, name, kind = 'rest', createdBy, description = null }) {
    if (!name || !createdBy) throw new Error('createIntegration requires name, createdBy');
    if (!KINDS.has(kind)) throw new Error(`createIntegration: invalid kind '${kind}'`);
    await initDB();
    const resolvedOrg = resolveOrgId(orgId);
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
        const slug = generateSlug();
        try {
            const { rows } = await run(`
                INSERT INTO org_custom_integrations (org_id, slug, kind, name, description, created_by)
                VALUES ($1,$2,$3,$4,$5,$6)
                RETURNING *
            `, [resolvedOrg, slug, kind, name, description, createdBy]);
            return shapeIntegration(rows[0]);
        } catch (e) {
            // 23505 = unique_violation; slug is the only unique constraint here
            if (e && e.code === '23505') { lastErr = e; continue; }
            throw e;
        }
    }
    throw lastErr || new Error('createIntegration: slug generation exhausted retries');
}

async function getById(id) {
    await initDB();
    return shapeIntegration(await getOne('SELECT * FROM org_custom_integrations WHERE id = $1', [id]));
}

async function getBySlug(slug) {
    await initDB();
    return shapeIntegration(await getOne('SELECT * FROM org_custom_integrations WHERE slug = $1', [slug]));
}

async function listForOrg(orgId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM org_custom_integrations WHERE org_id = $1 ORDER BY created_at ASC',
        [resolveOrgId(orgId)]
    );
    return rows.map(shapeIntegration);
}

/** Active integrations only — what the tool loader exposes to agents. */
async function listActiveForOrg(orgId) {
    await initDB();
    const rows = await getAll(
        "SELECT * FROM org_custom_integrations WHERE org_id = $1 AND status = 'active' ORDER BY created_at ASC",
        [resolveOrgId(orgId)]
    );
    return rows.map(shapeIntegration);
}

// ── Definition lifecycle ────────────────────────────────────────────

/**
 * Save a new working definition: bumps definition_version and appends the
 * snapshot to org_custom_integration_versions, in one transaction. Pass
 * { lastValidation } to record the validator verdict alongside (explicit
 * null clears it; omitting it leaves the stored verdict untouched).
 * Returns the shaped row, or null when the integration doesn't exist.
 */
async function saveDefinition(id, definition, userId, { lastValidation } = {}) {
    if (!userId) throw new Error('saveDefinition requires userId');
    await initDB();
    const defJson = JSON.stringify(definition || {});
    const hasValidation = lastValidation !== undefined;
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query(`
            UPDATE org_custom_integrations
               SET definition = $2::jsonb,
                   definition_version = definition_version + 1,
                   last_validation = CASE WHEN $4 THEN $3::jsonb ELSE last_validation END,
                   updated_at = NOW()
             WHERE id = $1
             RETURNING *
        `, [id, defJson, hasValidation ? JSON.stringify(lastValidation) : null, hasValidation]);
        if (!rows[0]) {
            await client.query('ROLLBACK');
            return null;
        }
        await client.query(`
            INSERT INTO org_custom_integration_versions (integration_id, version, definition, created_by)
            VALUES ($1,$2,$3::jsonb,$4)
            ON CONFLICT (integration_id, version)
            DO UPDATE SET definition = EXCLUDED.definition, created_by = EXCLUDED.created_by
        `, [id, rows[0].definition_version, defJson, userId]);
        await client.query('COMMIT');
        return shapeIntegration(rows[0]);
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Activate: freeze the CURRENT definition_version as what runs. The caller
 * passes the validated `definition` (must be what validation/test ran
 * against) plus the discovered/derived `toolsCache`; omitting `definition`
 * freezes the stored working copy.
 */
async function activate(id, { definition = null, toolsCache = [], allowWrites = false, lendMode = null, userId = null } = {}) {
    if (lendMode !== null && !LEND_MODES.has(lendMode)) {
        throw new Error(`activate: invalid lendMode '${lendMode}'`);
    }
    await initDB();
    const row = await getOne('SELECT definition FROM org_custom_integrations WHERE id = $1', [id]);
    if (!row) return null;
    const frozen = definition !== null ? definition : parseJson(row.definition, {});
    const { rows } = await run(`
        UPDATE org_custom_integrations
           SET status = 'active',
               activated_definition = $2::jsonb,
               activated_version = definition_version,
               tools_cache = $3::jsonb,
               allow_writes = $4,
               lend_mode = $5,
               activated_by = $6,
               activated_at = NOW(),
               updated_at = NOW()
         WHERE id = $1
         RETURNING *
    `, [id, JSON.stringify(frozen || {}), JSON.stringify(toolsCache || []), allowWrites === true, lendMode, userId]);
    return shapeIntegration(rows[0]);
}

async function setStatus(id, status) {
    if (!STATUSES.has(status)) throw new Error(`setStatus: invalid status '${status}'`);
    await initDB();
    const { rowCount } = await run(
        'UPDATE org_custom_integrations SET status = $2, updated_at = NOW() WHERE id = $1',
        [id, status]
    );
    return rowCount > 0;
}

async function deactivate(id) {
    return setStatus(id, 'disabled');
}

/** Refuses to delete an active integration — deactivate first. */
async function deleteIntegration(id) {
    await initDB();
    const { rowCount } = await run(
        "DELETE FROM org_custom_integrations WHERE id = $1 AND status <> 'active'",
        [id]
    );
    return rowCount > 0;
}

// ── Builder session (AI agent scratchpad) ───────────────────────────

async function setBuilderSession(id, sessionObj) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE org_custom_integrations SET builder_session = $2::jsonb, updated_at = NOW() WHERE id = $1',
        [id, sessionObj == null ? null : JSON.stringify(sessionObj)]
    );
    return rowCount > 0;
}

async function getBuilderSession(id) {
    await initDB();
    const row = await getOne('SELECT builder_session FROM org_custom_integrations WHERE id = $1', [id]);
    return row ? parseJson(row.builder_session, null) : null;
}

module.exports = {
    DEFAULT_ORG_SENTINEL,
    resolveOrgId,
    // CRUD
    createIntegration,
    getById,
    getBySlug,
    listForOrg,
    listActiveForOrg,
    // Definition lifecycle
    saveDefinition,
    activate,
    deactivate,
    setStatus,
    deleteIntegration,
    // Builder session
    setBuilderSession,
    getBuilderSession,
    // Pure helpers (unit-tested)
    generateSlug,
    shapeIntegration,
    // Tests / debugging only
    _internals: { SLUG_RE, SLUG_LENGTH, KINDS, STATUSES, LEND_MODES, parseJson },
};
