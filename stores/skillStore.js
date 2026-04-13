/**
 * Skill Store — PostgreSQL-backed reusable instruction pack management.
 *
 * Skills are scoped to an organization. A skill can be personal
 * (visible only to the creator) or shared (visible to all org members).
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

// ── GitHub Sync hook (fire-and-forget) ───────────────────────────
async function _notifySkillSync(orgId, skillId, action = 'pending') {
    if (!orgId) return;
    try {
        const syncStore = require('./githubSyncStore');
        const config = await syncStore.getOrgSyncConfig(orgId);
        if (!config) return;
        if (action === 'deleted') {
            await syncStore.markDeleted(orgId, 'skill', skillId);
        } else {
            await syncStore.markPending(orgId, 'skill', skillId);
        }
    } catch (e) { /* non-fatal */ }
}

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS skills (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            workflow TEXT DEFAULT '',
            rules TEXT DEFAULT '',
            examples TEXT DEFAULT '',
            icon TEXT DEFAULT '⚡',
            is_shared BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_skills_org ON skills(org_id);
        CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id);
        CREATE INDEX IF NOT EXISTS idx_skills_created ON skills(created_at DESC);
    `);

    initialized = true;
    console.log('[SkillStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[SkillStore] Init error:', err.message));

// ── CRUD ─────────────────────────────────────────

/**
 * Create a new skill.
 */
async function createSkill({ orgId, userId, name, description, instructions, workflow, rules, examples, icon, isShared }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO skills (id, org_id, user_id, name, description, instructions, workflow, rules, examples, icon, is_shared)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, orgId, userId, name, description || '', instructions || '', workflow || '', rules || '', examples || '', icon || '⚡', isShared === true]
    );
    console.log(`[SkillStore] Created skill "${name}" for org ${orgId}`);
    _notifySkillSync(orgId, id);
    return {
        id, orgId, userId, name, description: description || '', instructions: instructions || '',
        workflow: workflow || '', rules: rules || '', examples: examples || '',
        icon: icon || '⚡', isShared: isShared === true,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
}

/**
 * Get all skills available to a user (own + shared within org).
 */
async function getAvailableSkills(orgId, userId) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM skills
         WHERE org_id = $1 AND (user_id = $2 OR is_shared = true)
         ORDER BY created_at DESC`,
        [orgId, userId]
    );
    return rows.map(mapRow);
}

/**
 * Get a single skill by ID (with access check).
 */
async function getSkill(id, orgId, userId) {
    await initDB();
    const r = await getOne(
        `SELECT * FROM skills WHERE id = $1 AND org_id = $2 AND (user_id = $3 OR is_shared = true)`,
        [id, orgId, userId]
    );
    return r ? mapRow(r) : null;
}

/**
 * Get multiple skills by IDs (for chat injection).
 */
async function getSkillsByIds(ids, orgId, userId) {
    await initDB();
    if (!ids || ids.length === 0) return [];
    // Build parameterized IN clause
    const placeholders = ids.map((_, i) => `$${i + 3}`).join(', ');
    const rows = await getAll(
        `SELECT * FROM skills
         WHERE id IN (${placeholders}) AND org_id = $1 AND (user_id = $2 OR is_shared = true)`,
        [orgId, userId, ...ids]
    );
    return rows.map(mapRow);
}

/**
 * Update a skill (owner only).
 */
async function updateSkill(id, userId, updates) {
    await initDB();
    const setClauses = [];
    const params = [];
    let idx = 1;

    const fields = ['name', 'description', 'instructions', 'workflow', 'rules', 'examples', 'icon'];
    for (const field of fields) {
        if (updates[field] !== undefined) {
            setClauses.push(`${field} = $${idx++}`);
            params.push(updates[field]);
        }
    }
    if (updates.isShared !== undefined) {
        setClauses.push(`is_shared = $${idx++}`);
        params.push(updates.isShared === true);
    }

    if (setClauses.length === 0) return false;
    setClauses.push('updated_at = NOW()');
    params.push(id, userId);
    const { rowCount } = await run(
        `UPDATE skills SET ${setClauses.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
        params
    );
    if (rowCount > 0) {
        // Resolve org_id for sync notification
        const skill = await getOne('SELECT org_id FROM skills WHERE id = $1', [id]);
        if (skill?.org_id) _notifySkillSync(skill.org_id, id);
    }
    return rowCount > 0;
}

/**
 * Delete a skill (owner only, or admin via isAdmin flag).
 */
async function deleteSkill(id, userId, isAdmin = false) {
    await initDB();
    // Grab org_id before deleting for sync notification
    const skill = await getOne('SELECT org_id FROM skills WHERE id = $1', [id]);
    let result;
    if (isAdmin) {
        result = await run('DELETE FROM skills WHERE id = $1', [id]);
    } else {
        result = await run('DELETE FROM skills WHERE id = $1 AND user_id = $2', [id, userId]);
    }
    if (result.rowCount > 0 && skill?.org_id) _notifySkillSync(skill.org_id, id, 'deleted');
    return result.rowCount > 0;
}

// ── Helper ───────────────────────────────────────

function mapRow(r) {
    return {
        id: r.id,
        orgId: r.org_id,
        userId: r.user_id,
        name: r.name,
        description: r.description || '',
        instructions: r.instructions || '',
        workflow: r.workflow || '',
        rules: r.rules || '',
        examples: r.examples || '',
        icon: r.icon || '⚡',
        isShared: r.is_shared === true,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

module.exports = {
    createSkill,
    getAvailableSkills,
    getSkill,
    getSkillsByIds,
    updateSkill,
    deleteSkill,
};
