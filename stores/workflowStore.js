/**
 * Workflow Store - PostgreSQL management for workflows, folders, shares, and execution history
 */

const { run, getOne, getAll, exec, getClient } = require('../db');
const { v4: uuidv4 } = require('uuid');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id TEXT REFERENCES folders(id),
            owner_id TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS workflows (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            folder_id TEXT REFERENCES folders(id),
            owner_id TEXT NOT NULL,
            nodes_json TEXT NOT NULL,
            edges_json TEXT NOT NULL,
            viewport_json TEXT,
            is_public BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS shares (
            id TEXT PRIMARY KEY,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            shared_by TEXT NOT NULL,
            shared_with TEXT NOT NULL,
            permission TEXT NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS execution_history (
            id TEXT PRIMARY KEY,
            workflow_id TEXT NOT NULL,
            workflow_name TEXT,
            user_id TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TIMESTAMPTZ NOT NULL,
            completed_at TIMESTAMPTZ,
            duration_ms INTEGER,
            trigger_type TEXT,
            nodes_executed INTEGER,
            workflow_json TEXT,
            result_json TEXT,
            error TEXT,
            FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_workflows_owner ON workflows(owner_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_workflows_folder ON workflows(folder_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(owner_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_shares_resource ON shares(resource_type, resource_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(shared_with)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_execution_history_workflow ON execution_history(workflow_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_execution_history_user ON execution_history(user_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_execution_history_started ON execution_history(started_at DESC)`);
    initialized = true;
}

initDB().catch(err => console.error('[WorkflowStore] Init error:', err.message));

// ============ Folder Functions ============

async function createFolder(name, parentId, ownerId) {
    await initDB();
    const id = uuidv4();
    await run('INSERT INTO folders (id, name, parent_id, owner_id) VALUES ($1, $2, $3, $4)', [id, name, parentId || null, ownerId]);
    return { id, name, parentId, ownerId };
}

async function getFolders(userId) {
    await initDB();
    return getAll(`
        SELECT f.*,
            CASE WHEN f.owner_id = $1 THEN 'owner' ELSE s.permission END as access_type,
            CASE WHEN f.owner_id != $2 THEN s.shared_by END as shared_by
        FROM folders f
        LEFT JOIN shares s ON s.resource_type = 'folder' AND s.resource_id = f.id AND s.shared_with = $3
        WHERE f.owner_id = $4 OR s.shared_with = $5
        ORDER BY f.name
    `, [userId, userId, userId, userId, userId]);
}

async function getFolder(id) {
    await initDB();
    return getOne('SELECT * FROM folders WHERE id = $1', [id]);
}

async function updateFolder(id, name, parentId, userId) {
    await initDB();
    const folder = await getOne('SELECT * FROM folders WHERE id = $1', [id]);
    if (!folder) return { error: 'Folder not found' };
    if (folder.owner_id !== userId) {
        const share = await getOne("SELECT * FROM shares WHERE resource_type = 'folder' AND resource_id = $1 AND shared_with = $2", [id, userId]);
        if (!share || share.permission !== 'edit') return { error: 'Permission denied' };
    }
    await run('UPDATE folders SET name = $1, parent_id = $2, updated_at = NOW() WHERE id = $3', [name, parentId || null, id]);
    return { success: true };
}

async function deleteFolder(id, userId) {
    await initDB();
    const folder = await getOne('SELECT * FROM folders WHERE id = $1', [id]);
    if (!folder) return { error: 'Folder not found' };
    if (folder.owner_id !== userId) return { error: 'Permission denied' };

    await run('DELETE FROM workflows WHERE folder_id = $1', [id]);
    await run("DELETE FROM shares WHERE resource_type = 'folder' AND resource_id = $1", [id]);
    await run('DELETE FROM folders WHERE id = $1', [id]);
    return { success: true };
}

// ============ Workflow Functions ============

async function createWorkflow(data, ownerId) {
    await initDB();
    const id = data.id || uuidv4();
    await run(`
        INSERT INTO workflows (id, name, description, folder_id, owner_id, nodes_json, edges_json, viewport_json, is_public)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [id, data.name || 'Untitled Workflow', data.description || '', data.folderId || null, ownerId,
        JSON.stringify(data.nodes || []), JSON.stringify(data.edges || []), JSON.stringify(data.viewport || {}), !!data.isPublic]);
    return { id, ...data, ownerId };
}

async function getWorkflows(userId, folderId = null) {
    await initDB();
    if (folderId) {
        return getAll(`
            SELECT w.id, w.name, w.description, w.folder_id, w.owner_id, w.is_public, w.created_at, w.updated_at,
                CASE WHEN w.owner_id = $1 THEN 'owner' WHEN w.is_public THEN 'view' ELSE s.permission END as access_type
            FROM workflows w
            LEFT JOIN shares s ON s.resource_type = 'workflow' AND s.resource_id = w.id AND s.shared_with = $2
            WHERE w.folder_id = $3 AND (w.owner_id = $4 OR s.shared_with = $5 OR w.is_public = TRUE)
            ORDER BY w.updated_at DESC
        `, [userId, userId, folderId, userId, userId]);
    }
    return getAll(`
        SELECT w.id, w.name, w.description, w.folder_id, w.owner_id, w.is_public, w.created_at, w.updated_at,
            CASE WHEN w.owner_id = $1 THEN 'owner' WHEN w.is_public THEN 'view' ELSE s.permission END as access_type,
            CASE WHEN w.owner_id != $2 THEN COALESCE(s.shared_by, 'public') END as shared_by
        FROM workflows w
        LEFT JOIN shares s ON s.resource_type = 'workflow' AND s.resource_id = w.id AND s.shared_with = $3
        WHERE w.owner_id = $4 OR s.shared_with = $5 OR w.is_public = TRUE
        ORDER BY w.updated_at DESC
    `, [userId, userId, userId, userId, userId]);
}

async function getAllWorkflows() {
    await initDB();
    const rows = await getAll('SELECT * FROM workflows');
    return rows.map(row => ({
        id: row.id, name: row.name, description: row.description,
        folder_id: row.folder_id, owner_id: row.owner_id,
        nodes: JSON.parse(row.nodes_json || '[]'),
        edges: JSON.parse(row.edges_json || '[]'),
        is_public: row.is_public
    }));
}

async function getWorkflowById(id) {
    await initDB();
    const workflow = await getOne('SELECT * FROM workflows WHERE id = $1', [id]);
    if (!workflow) return null;
    workflow.nodes = JSON.parse(workflow.nodes_json || '[]');
    workflow.edges = JSON.parse(workflow.edges_json || '[]');
    workflow.viewport = JSON.parse(workflow.viewport_json || '{}');
    workflow.access_type = 'system';
    return workflow;
}

async function getWorkflow(id, userId) {
    await initDB();
    const workflow = await getOne('SELECT * FROM workflows WHERE id = $1', [id]);
    if (!workflow) return null;

    if (workflow.owner_id !== userId && !workflow.is_public) {
        const share = await getOne("SELECT * FROM shares WHERE resource_type = 'workflow' AND resource_id = $1 AND shared_with = $2", [id, userId]);
        if (!share) return null;
        workflow.access_type = share.permission;
    } else if (workflow.owner_id === userId) {
        workflow.access_type = 'owner';
    } else {
        workflow.access_type = 'view';
    }
    workflow.nodes = JSON.parse(workflow.nodes_json);
    workflow.edges = JSON.parse(workflow.edges_json);
    workflow.viewport = JSON.parse(workflow.viewport_json || '{}');
    return workflow;
}

async function updateWorkflow(id, data, userId) {
    await initDB();
    const workflow = await getOne('SELECT * FROM workflows WHERE id = $1', [id]);
    if (!workflow) return { error: 'Workflow not found' };

    if (workflow.owner_id !== userId) {
        const share = await getOne("SELECT * FROM shares WHERE resource_type = 'workflow' AND resource_id = $1 AND shared_with = $2", [id, userId]);
        if (!share || share.permission !== 'edit') return { error: 'Permission denied' };
    }

    await run(`
        UPDATE workflows SET name = $1, description = $2, folder_id = $3, nodes_json = $4, edges_json = $5, viewport_json = $6, is_public = $7, updated_at = NOW()
        WHERE id = $8
    `, [
        data.name ?? workflow.name,
        data.description ?? workflow.description,
        data.folderId !== undefined ? data.folderId : workflow.folder_id,
        data.nodes ? JSON.stringify(data.nodes) : workflow.nodes_json,
        data.edges ? JSON.stringify(data.edges) : workflow.edges_json,
        data.viewport ? JSON.stringify(data.viewport) : workflow.viewport_json,
        data.isPublic !== undefined ? !!data.isPublic : workflow.is_public,
        id
    ]);
    return { id, success: true };
}

async function deleteWorkflow(id, userId) {
    await initDB();
    const workflow = await getOne('SELECT * FROM workflows WHERE id = $1', [id]);
    if (!workflow) return { error: 'Workflow not found' };
    if (workflow.owner_id !== userId) return { error: 'Permission denied' };
    await run("DELETE FROM shares WHERE resource_type = 'workflow' AND resource_id = $1", [id]);
    await run('DELETE FROM workflows WHERE id = $1', [id]);
    return { success: true };
}

// ============ Sharing Functions ============

async function shareResource(resourceType, resourceId, sharedBy, sharedWith, permission) {
    await initDB();
    const existing = await getOne('SELECT * FROM shares WHERE resource_type = $1 AND resource_id = $2 AND shared_with = $3', [resourceType, resourceId, sharedWith]);
    if (existing) {
        await run('UPDATE shares SET permission = $1 WHERE id = $2', [permission, existing.id]);
        return { id: existing.id, updated: true };
    }
    const id = uuidv4();
    await run('INSERT INTO shares (id, resource_type, resource_id, shared_by, shared_with, permission) VALUES ($1, $2, $3, $4, $5, $6)', [id, resourceType, resourceId, sharedBy, sharedWith, permission]);
    return { id, created: true };
}

async function unshareResource(shareId) {
    await initDB();
    await run('DELETE FROM shares WHERE id = $1', [shareId]);
    return { success: true };
}

async function getShares(resourceType, resourceId) {
    await initDB();
    return getAll('SELECT * FROM shares WHERE resource_type = $1 AND resource_id = $2', [resourceType, resourceId]);
}

async function getShare(shareId) {
    await initDB();
    return getOne('SELECT * FROM shares WHERE id = $1', [shareId]);
}

// ============ Migration Helper ============

async function migrateFromJson(workflows, defaultOwnerId) {
    await initDB();
    for (const wf of workflows) {
        try {
            await run(`
                INSERT INTO workflows (id, name, description, folder_id, owner_id, nodes_json, edges_json, viewport_json, is_public)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, FALSE)
                ON CONFLICT(id) DO NOTHING
            `, [wf.id || uuidv4(), wf.name || 'Migrated Workflow', wf.description || '', null, defaultOwnerId,
            JSON.stringify(wf.nodes || []), JSON.stringify(wf.edges || []), JSON.stringify(wf.viewport || {})]);
        } catch (e) {
            console.error('Migration error for workflow:', wf.id, e.message);
        }
    }
    return { migrated: workflows.length };
}

// ============ Execution History Functions ============

async function createExecution(workflowId, workflowName, userId, triggerType = 'manual', workflow = null) {
    await initDB();
    const id = uuidv4();
    const startedAt = new Date().toISOString();
    await run(`
        INSERT INTO execution_history (id, workflow_id, workflow_name, user_id, status, started_at, trigger_type, workflow_json)
        VALUES ($1, $2, $3, $4, 'running', $5, $6, $7)
    `, [id, workflowId, workflowName, userId, startedAt, triggerType, workflow ? JSON.stringify(workflow) : null]);
    return { id, startedAt };
}

async function completeExecution(id, status, nodesExecuted, result, error = null) {
    await initDB();
    const completedAt = new Date().toISOString();
    const execution = await getOne('SELECT * FROM execution_history WHERE id = $1', [id]);
    if (!execution) return { error: 'Execution not found' };

    const durationMs = new Date(completedAt) - new Date(execution.started_at);
    await run(`
        UPDATE execution_history SET status = $1, completed_at = $2, duration_ms = $3, nodes_executed = $4, result_json = $5, error = $6
        WHERE id = $7
    `, [status, completedAt, durationMs, nodesExecuted, result ? JSON.stringify(result) : null, error, id]);
    return { success: true, durationMs };
}

async function getExecutionHistory(userId, limit = 50) {
    await initDB();
    const rows = await getAll('SELECT * FROM execution_history WHERE user_id = $1 ORDER BY started_at DESC LIMIT $2', [userId, limit]);
    return rows.map(row => ({
        ...row,
        result: row.result_json ? JSON.parse(row.result_json) : null,
        workflow: row.workflow_json ? JSON.parse(row.workflow_json) : null
    }));
}

async function getWorkflowExecutionHistory(workflowId, userId, limit = 50) {
    await initDB();
    const rows = await getAll('SELECT * FROM execution_history WHERE workflow_id = $1 AND user_id = $2 ORDER BY started_at DESC LIMIT $3', [workflowId, userId, limit]);
    return rows.map(row => ({
        ...row,
        result: row.result_json ? JSON.parse(row.result_json) : null,
        workflow: row.workflow_json ? JSON.parse(row.workflow_json) : null
    }));
}

async function getExecution(id) {
    await initDB();
    const row = await getOne('SELECT * FROM execution_history WHERE id = $1', [id]);
    if (!row) return null;
    return {
        ...row,
        result: row.result_json ? JSON.parse(row.result_json) : null,
        workflow: row.workflow_json ? JSON.parse(row.workflow_json) : null
    };
}

async function cleanupOldExecutions(userId, daysToKeep = 30) {
    await initDB();
    await run(`DELETE FROM execution_history WHERE user_id = $1 AND started_at < NOW() - ($2 || ' days')::interval`, [userId, daysToKeep]);
    return { success: true };
}

module.exports = {
    createFolder, getFolders, getFolder, updateFolder, deleteFolder,
    createWorkflow, getWorkflows, getAllWorkflows, getWorkflow, getWorkflowById, updateWorkflow, deleteWorkflow,
    shareResource, unshareResource, getShares, getShare,
    migrateFromJson,
    createExecution, completeExecution, getExecutionHistory, getWorkflowExecutionHistory, getExecution, cleanupOldExecutions
};
