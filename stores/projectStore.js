/**
 * Project Store — PostgreSQL-backed projects for organizing chats.
 *
 * Tables:
 *   - projects:          core project data (name, instructions, owner)
 *   - project_shares:    sharing records (user / group), permission ∈ {viewer, editor}
 *   - project_activity:  audit feed (member changes, edits, kb/conversation moves)
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            custom_instructions TEXT DEFAULT '',
            knowledge_base_ids JSONB DEFAULT '[]'::jsonb,
            color TEXT DEFAULT '#6366f1',
            icon TEXT DEFAULT '📁',
            owner_id TEXT NOT NULL,
            organization_id TEXT DEFAULT '',
            extract_memories BOOLEAN DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        -- Migrations
        DO $$ BEGIN
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS knowledge_base_ids JSONB DEFAULT '[]'::jsonb;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;
        
        DO $$ BEGIN
            ALTER TABLE projects ADD COLUMN IF NOT EXISTS extract_memories BOOLEAN DEFAULT false;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        CREATE TABLE IF NOT EXISTS project_shares (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            shared_with_type TEXT NOT NULL,
            shared_with_id TEXT NOT NULL,
            permission TEXT DEFAULT 'view',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
        CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(organization_id);
        CREATE INDEX IF NOT EXISTS idx_project_shares_project ON project_shares(project_id);
        CREATE INDEX IF NOT EXISTS idx_project_shares_shared ON project_shares(shared_with_type, shared_with_id);

        -- Migrate legacy permission vocabulary: 'view' → 'viewer', 'edit' → 'editor'
        DO $$ BEGIN
            UPDATE project_shares SET permission = 'viewer' WHERE permission = 'view';
            UPDATE project_shares SET permission = 'editor' WHERE permission = 'edit';
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        DO $$ BEGIN
            ALTER TABLE project_shares ADD COLUMN IF NOT EXISTS invited_by TEXT;
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        DO $$ BEGIN
            ALTER TABLE project_shares
                ADD CONSTRAINT project_shares_permission_chk
                CHECK (permission IN ('viewer', 'editor'));
        EXCEPTION WHEN OTHERS THEN NULL;
        END $$;

        CREATE TABLE IF NOT EXISTS project_activity (
            id          TEXT PRIMARY KEY,
            project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            actor_id    TEXT NOT NULL,
            action      TEXT NOT NULL,
            target_type TEXT,
            target_id   TEXT,
            details     JSONB DEFAULT '{}'::jsonb,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_project_activity_project_created
            ON project_activity(project_id, created_at DESC);
    `);

    initialized = true;
    console.log('[ProjectStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[ProjectStore] Init error:', err.message));

// ── Helpers ──────────────────────────────────────────────

function parseJSON(str, fallback) {
    if (!str) return fallback;
    try { return JSON.parse(str); } catch { return fallback; }
}

// ── CRUD ─────────────────────────────────────────────────

async function createProject({ name, description, customInstructions, color, icon, ownerId, organizationId, knowledgeBaseIds, extractMemories }) {
    await initDB();
    const id = crypto.randomUUID();
    const kbIds = JSON.stringify(knowledgeBaseIds || []);
    await run(
        `INSERT INTO projects (id, name, description, custom_instructions, knowledge_base_ids, color, icon, owner_id, organization_id, extract_memories)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, name, description || '', customInstructions || '', kbIds, color || '#6366f1', icon || '📁', ownerId, organizationId || '', extractMemories || false]
    );
    return { id, name, description, customInstructions, knowledgeBaseIds: knowledgeBaseIds || [], color, icon, ownerId, organizationId, extractMemories: extractMemories || false };
}

async function getProject(id) {
    await initDB();
    const row = await getOne('SELECT * FROM projects WHERE id = $1', [id]);
    if (!row) return null;
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        customInstructions: row.custom_instructions,
        knowledgeBaseIds: parseJSON(row.knowledge_base_ids, []),
        color: row.color,
        icon: row.icon,
        ownerId: row.owner_id,
        organizationId: row.organization_id,
        extractMemories: row.extract_memories,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

/**
 * List projects the user can access (owned + shared via user or group).
 * @param {string} userId
 * @param {string[]} groupIds - groups the user belongs to
 */
async function listUserProjects(userId, groupIds = []) {
    await initDB();

    // Build a query that gets owned projects + projects shared with user or user's groups
    const params = [userId];
    let groupPlaceholders = '';
    if (groupIds.length > 0) {
        const placeholders = groupIds.map((_, i) => `$${i + 2}`).join(', ');
        groupPlaceholders = `OR (ps.shared_with_type = 'group' AND ps.shared_with_id IN (${placeholders}))`;
        params.push(...groupIds);
    }

    const rows = await getAll(`
        SELECT DISTINCT p.*,
            CASE WHEN p.owner_id = $1 THEN 'owner' ELSE COALESCE(
                (SELECT ps2.permission FROM project_shares ps2
                 WHERE ps2.project_id = p.id AND (
                     (ps2.shared_with_type = 'user' AND ps2.shared_with_id = $1)
                     ${groupPlaceholders.replace(/ps\./g, 'ps2.')}
                 )
                 ORDER BY CASE ps2.permission WHEN 'editor' THEN 0 ELSE 1 END
                 LIMIT 1),
                'viewer'
            ) END as user_permission
        FROM projects p
        LEFT JOIN project_shares ps ON ps.project_id = p.id
        WHERE p.owner_id = $1
           OR (ps.shared_with_type = 'user' AND ps.shared_with_id = $1)
           ${groupPlaceholders}
        ORDER BY p.updated_at DESC
    `, params);

    return rows.map(row => ({
        id: row.id,
        name: row.name,
        description: row.description,
        customInstructions: row.custom_instructions,
        knowledgeBaseIds: parseJSON(row.knowledge_base_ids, []),
        color: row.color,
        icon: row.icon,
        ownerId: row.owner_id,
        organizationId: row.organization_id,
        extractMemories: row.extract_memories,
        permission: row.user_permission || 'view',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    }));
}

async function updateProject(id, updates) {
    await initDB();
    const existing = await getOne('SELECT id, owner_id FROM projects WHERE id = $1', [id]);
    if (!existing) return null;

    const setClauses = [];
    const params = [];
    let idx = 1;

    const fieldMap = {
        name: 'name',
        description: 'description',
        customInstructions: 'custom_instructions',
        color: 'color',
        icon: 'icon',
        extractMemories: 'extract_memories'
    };

    // Handle knowledgeBaseIds separately (needs JSON serialization)
    if (updates.knowledgeBaseIds !== undefined) {
        setClauses.push(`knowledge_base_ids = $${idx++}`);
        params.push(JSON.stringify(updates.knowledgeBaseIds));
    }

    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
        if (updates[jsKey] !== undefined) {
            setClauses.push(`"${dbCol}" = $${idx++}`);
            params.push(updates[jsKey]);
        }
    }

    if (setClauses.length === 0) return await getProject(id);

    setClauses.push(`updated_at = NOW()`);
    params.push(id);

    await run(`UPDATE projects SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
    return await getProject(id);
}

async function deleteProject(id) {
    await initDB();
    // project_shares cascade-deleted via FK
    const { rowCount } = await run('DELETE FROM projects WHERE id = $1', [id]);
    return rowCount > 0;
}

// ── Sharing ──────────────────────────────────────────────

// Translate legacy permission vocabulary so external callers don't break.
function normalizePermission(permission) {
    if (permission === 'view') return 'viewer';
    if (permission === 'edit') return 'editor';
    if (permission === 'viewer' || permission === 'editor') return permission;
    return 'viewer';
}

async function shareProject(projectId, sharedWithType, sharedWithId, permission = 'viewer', invitedBy = null) {
    await initDB();
    const perm = normalizePermission(permission);
    // Check for existing share
    const existing = await getOne(
        'SELECT id FROM project_shares WHERE project_id = $1 AND shared_with_type = $2 AND shared_with_id = $3',
        [projectId, sharedWithType, sharedWithId]
    );
    if (existing) {
        await run('UPDATE project_shares SET permission = $1 WHERE id = $2', [perm, existing.id]);
        return existing.id;
    }

    const id = crypto.randomUUID();
    await run(
        `INSERT INTO project_shares (id, project_id, shared_with_type, shared_with_id, permission, invited_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, projectId, sharedWithType, sharedWithId, perm, invitedBy]
    );
    return id;
}

async function getShareById(shareId) {
    await initDB();
    const r = await getOne('SELECT * FROM project_shares WHERE id = $1', [shareId]);
    if (!r) return null;
    return {
        id: r.id,
        projectId: r.project_id,
        sharedWithType: r.shared_with_type,
        sharedWithId: r.shared_with_id,
        permission: r.permission,
        invitedBy: r.invited_by,
        createdAt: r.created_at,
    };
}

async function updateMemberRole(shareId, role) {
    await initDB();
    const perm = normalizePermission(role);
    const { rowCount } = await run(
        'UPDATE project_shares SET permission = $1 WHERE id = $2',
        [perm, shareId]
    );
    return rowCount > 0;
}

async function unshareProject(shareId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM project_shares WHERE id = $1', [shareId]);
    return rowCount > 0;
}

async function getProjectShares(projectId) {
    await initDB();
    const rows = await getAll('SELECT * FROM project_shares WHERE project_id = $1 ORDER BY created_at', [projectId]);
    return rows.map(r => ({
        id: r.id,
        projectId: r.project_id,
        sharedWithType: r.shared_with_type,
        sharedWithId: r.shared_with_id,
        permission: r.permission,
        createdAt: r.created_at,
    }));
}

// ── Conversation assignment ──────────────────────────────

async function assignConversation(conversationId, projectId, tableName = 'direct_conversations') {
    await initDB();
    const safeTable = tableName === 'agent_conversations' ? 'agent_conversations' : 'direct_conversations';
    const { rowCount } = await run(
        `UPDATE ${safeTable} SET project_id = $1 WHERE id = $2`,
        [projectId, conversationId]
    );
    return rowCount > 0;
}

async function unassignConversation(conversationId, tableName = 'direct_conversations') {
    await initDB();
    const safeTable = tableName === 'agent_conversations' ? 'agent_conversations' : 'direct_conversations';
    const { rowCount } = await run(
        `UPDATE ${safeTable} SET project_id = NULL WHERE id = $1`,
        [conversationId]
    );
    return rowCount > 0;
}

// ── Access check ─────────────────────────────────────────

/**
 * Returns the user's effective role on a project: 'owner' | 'editor' | 'viewer' | null.
 * Owner trumps any share. For non-owners, returns the highest matching share permission
 * across direct user shares and group shares.
 *
 * @param {string} userId
 * @param {string} projectId
 * @param {string[]} groupIds - groups the user belongs to
 */
async function getProjectRole(userId, projectId, groupIds = []) {
    await initDB();
    if (!userId || !projectId) return null;
    const project = await getOne('SELECT owner_id FROM projects WHERE id = $1', [projectId]);
    if (!project) return null;
    if (project.owner_id === userId) return 'owner';

    const groupArr = (groupIds && groupIds.length > 0) ? groupIds : [''];
    const row = await getOne(`
        SELECT permission FROM project_shares
        WHERE project_id = $1
          AND ((shared_with_type = 'user'  AND shared_with_id = $2)
            OR (shared_with_type = 'group' AND shared_with_id = ANY($3::text[])))
        ORDER BY CASE permission WHEN 'editor' THEN 0 ELSE 1 END
        LIMIT 1
    `, [projectId, userId, groupArr]);
    return row?.permission || null;
}

/**
 * Backwards-compatible boolean wrapper. New code should call getProjectRole.
 */
async function userHasAccess(userId, projectId, groupIds = []) {
    const role = await getProjectRole(userId, projectId, groupIds);
    return role !== null;
}

// ── Activity feed ────────────────────────────────────────

async function logActivity(projectId, actorId, action, details = {}) {
    await initDB();
    if (!projectId || !actorId || !action) return null;
    const id = crypto.randomUUID();
    const targetType = details.targetType || null;
    const targetId = details.targetId || null;
    try {
        await run(
            `INSERT INTO project_activity (id, project_id, actor_id, action, target_type, target_id, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [id, projectId, actorId, action, targetType, targetId, JSON.stringify(details)]
        );
    } catch (err) {
        console.warn('[ProjectStore] logActivity failed:', err.message);
        return null;
    }
    return id;
}

async function listActivity(projectId, limit = 50, offset = 0) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM project_activity
         WHERE project_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [projectId, limit, offset]
    );
    return rows.map(r => ({
        id: r.id,
        projectId: r.project_id,
        actorId: r.actor_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        details: r.details || {},
        createdAt: r.created_at,
    }));
}

module.exports = {
    createProject,
    getProject,
    listUserProjects,
    updateProject,
    deleteProject,
    shareProject,
    unshareProject,
    getProjectShares,
    getShareById,
    updateMemberRole,
    assignConversation,
    unassignConversation,
    getProjectRole,
    userHasAccess,
    logActivity,
    listActivity,
    normalizePermission,
};
