/**
 * Skill Store — PostgreSQL-backed reusable instruction pack management.
 *
 * Skills are scoped to an organization. A skill can be:
 *   - personal (visible only to the creator)
 *   - shared with the whole org (is_shared=true, shared_groups=[])
 *   - shared with specific groups (is_shared=true, shared_groups=["g1","g2"])
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const userStore = require('./userStore');

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
            dynamic_activation BOOLEAN DEFAULT false,
            shared_groups TEXT DEFAULT '[]',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE skills ADD COLUMN IF NOT EXISTS dynamic_activation BOOLEAN DEFAULT false;
        ALTER TABLE skills ADD COLUMN IF NOT EXISTS shared_groups TEXT DEFAULT '[]';

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
async function createSkill({ orgId, userId, name, description, instructions, workflow, rules, examples, icon, isShared, dynamicActivation, sharedGroups }) {
    await initDB();
    const id = crypto.randomUUID();
    const groupsJson = JSON.stringify(Array.isArray(sharedGroups) ? sharedGroups : []);
    await run(
        `INSERT INTO skills (id, org_id, user_id, name, description, instructions, workflow, rules, examples, icon, is_shared, dynamic_activation, shared_groups)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, orgId, userId, name, description || '', instructions || '', workflow || '', rules || '', examples || '', icon || '⚡', isShared === true, dynamicActivation === true, groupsJson]
    );
    console.log(`[SkillStore] Created skill "${name}" for org ${orgId}`);
    _notifySkillSync(orgId, id);
    return {
        id, orgId, userId, name, description: description || '', instructions: instructions || '',
        workflow: workflow || '', rules: rules || '', examples: examples || '',
        icon: icon || '⚡', isShared: isShared === true, dynamicActivation: dynamicActivation === true,
        sharedGroups: Array.isArray(sharedGroups) ? sharedGroups : [],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
}

// Resolve the user's group IDs (used for sharedGroups visibility checks).
async function _getUserGroupIds(userId) {
    if (!userId) return [];
    try {
        const user = await userStore.getUser(userId);
        if (!user) return [];
        if (Array.isArray(user.groups)) return user.groups;
        try { return JSON.parse(user.groups || '[]'); } catch (_) { return []; }
    } catch (_) {
        return [];
    }
}

// Build the shared visibility WHERE fragment + params for a single user.
//   "skill is owned by user, OR (is_shared AND (no group restriction OR user is in one of the groups))"
// Returns { sql, params } where the params slot in starting at `nextParamIdx`.
function _buildVisibilityClause(userId, userGroups, nextParamIdx) {
    const params = [userId];
    let userIdx = nextParamIdx;
    let sql = `(user_id = $${userIdx}`;
    sql += ` OR (is_shared = true AND (shared_groups IS NULL OR shared_groups = '' OR shared_groups = '[]'`;
    if (userGroups && userGroups.length > 0) {
        const groupParams = userGroups.map((_, i) => `$${userIdx + 1 + i}`);
        sql += ` OR shared_groups::jsonb ?| array[${groupParams.join(', ')}]`;
        params.push(...userGroups);
    }
    sql += `)))`;
    return { sql, params };
}

/**
 * Get all skills available to a user (own + shared within org, scoped by group).
 */
async function getAvailableSkills(orgId, userId) {
    await initDB();
    const userGroups = await _getUserGroupIds(userId);
    // $1 = orgId, then visibility clause starts at $2
    const { sql: visSql, params: visParams } = _buildVisibilityClause(userId, userGroups, 2);
    const rows = await getAll(
        `SELECT * FROM skills
         WHERE org_id = $1 AND ${visSql}
         ORDER BY created_at DESC`,
        [orgId, ...visParams]
    );
    return rows.map(mapRow);
}

/**
 * Get a single skill by ID (with access check).
 */
async function getSkill(id, orgId, userId) {
    await initDB();
    const userGroups = await _getUserGroupIds(userId);
    // $1 = id, $2 = orgId, then visibility clause starts at $3
    const { sql: visSql, params: visParams } = _buildVisibilityClause(userId, userGroups, 3);
    const r = await getOne(
        `SELECT * FROM skills WHERE id = $1 AND org_id = $2 AND ${visSql}`,
        [id, orgId, ...visParams]
    );
    return r ? mapRow(r) : null;
}

/**
 * Get multiple skills by IDs (for chat injection).
 */
async function getSkillsByIds(ids, orgId, userId) {
    await initDB();
    if (!ids || ids.length === 0) return [];
    const userGroups = await _getUserGroupIds(userId);
    // $1 = orgId, then visibility clause, then IN-list
    const { sql: visSql, params: visParams } = _buildVisibilityClause(userId, userGroups, 2);
    const baseParamCount = 1 + visParams.length; // orgId + visibility params
    const placeholders = ids.map((_, i) => `$${baseParamCount + 1 + i}`).join(', ');
    const rows = await getAll(
        `SELECT * FROM skills
         WHERE org_id = $1 AND ${visSql} AND id IN (${placeholders})`,
        [orgId, ...visParams, ...ids]
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
    if (updates.dynamicActivation !== undefined) {
        setClauses.push(`dynamic_activation = $${idx++}`);
        params.push(updates.dynamicActivation === true);
    }
    if (updates.sharedGroups !== undefined) {
        setClauses.push(`shared_groups = $${idx++}`);
        params.push(JSON.stringify(Array.isArray(updates.sharedGroups) ? updates.sharedGroups : []));
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
        dynamicActivation: r.dynamic_activation === true,
        sharedGroups: (() => { try { return JSON.parse(r.shared_groups || '[]'); } catch (_) { return []; } })(),
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
