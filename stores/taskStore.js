/**
 * Task Store — PostgreSQL-backed CRUD for AI-proposed tasks
 *
 * Tasks are created by agents and MUST be approved by a human before execution.
 * The approval gate is enforced in updateTaskStatus().
 *
 * Uses `pg` Pool for async PostgreSQL access.
 */

const crypto = require('crypto');
const { Pool } = require('pg');
const { createHash } = crypto;

// ── Connection ─────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://beeflow:beeflow@localhost:5432/beeflow_tasks',
});

// ── Schema ──────────────────────────────────────────────
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    priority TEXT DEFAULT 'medium',
    type TEXT DEFAULT 'manual',
    source TEXT DEFAULT 'manual',
    trigger_config JSONB DEFAULT '{}',
    conditions JSONB DEFAULT '[]',
    actions JSONB DEFAULT '[]',
    requires_ai BOOLEAN DEFAULT FALSE,
    scan_id TEXT,
    script TEXT,
    pending_changes JSONB,
    created_by TEXT,
    created_for TEXT,
    organization_id TEXT,
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    rejected_by TEXT,
    rejected_at TIMESTAMPTZ,
    rejection_reason TEXT,
    result JSONB,
    metadata JSONB DEFAULT '{}',
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,
    run_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_ledger (
    id SERIAL PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    item_hash TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'processed',
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_task_item ON task_ledger(task_id, item_hash);
CREATE INDEX IF NOT EXISTS idx_ledger_task_id ON task_ledger(task_id);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_for ON tasks(created_for);
CREATE INDEX IF NOT EXISTS idx_tasks_scan_id ON tasks(scan_id);
CREATE INDEX IF NOT EXISTS idx_tasks_organization_id ON tasks(organization_id);
`;

let initialized = false;

async function initDB() {
    if (initialized) return;
    try {
        await pool.query(INIT_SQL);
        initialized = true;
        console.log('[TaskStore] PostgreSQL initialized');
    } catch (err) {
        console.error('[TaskStore] PostgreSQL init error:', err.message);
        throw err;
    }
}

// Auto-init on import
initDB().catch(err => console.error('[TaskStore] Failed to init:', err.message));

// ── Helpers ──────────────────────────────────────────────

function serialize(row) {
    if (!row) return null;
    return {
        ...row,
        // JSONB columns are already parsed by pg driver
        metadata: row.metadata || {},
        result: row.result || null,
        trigger_config: row.trigger_config || {},
        conditions: row.conditions || [],
        actions: row.actions || [],
        pending_changes: row.pending_changes || null,
        requires_ai: !!row.requires_ai,
        script: row.script || null,
        // Normalize timestamps to ISO strings
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        approved_at: row.approved_at ? new Date(row.approved_at).toISOString() : null,
        rejected_at: row.rejected_at ? new Date(row.rejected_at).toISOString() : null,
        last_run_at: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
        next_run_at: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
    };
}

// ── CRUD ──────────────────────────────────────────────

async function getAllTasks(filters = {}) {
    await initDB();
    let query = 'SELECT * FROM tasks';
    const params = [];
    const conditions = [];

    if (filters.status) {
        conditions.push(`status = $${params.length + 1}`);
        params.push(filters.status);
    }
    if (filters.userId) {
        conditions.push(`created_for = $${params.length + 1}`);
        params.push(filters.userId);
    }
    if (filters.organizationId) {
        conditions.push(`organization_id = $${params.length + 1}`);
        params.push(filters.organizationId);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY created_at DESC';

    const { rows } = await pool.query(query, params);
    return rows.map(serialize);
}

async function getTask(id) {
    await initDB();
    const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    return serialize(rows[0]);
}

async function createTask(data) {
    await initDB();
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    try {
        await pool.query(
            `INSERT INTO tasks (id, title, description, status, priority, type, source, trigger_config, conditions, actions, requires_ai, scan_id, script, created_by, created_for, organization_id, metadata, created_at, updated_at)
             VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
            [
                id,
                data.title,
                data.description || '',
                data.priority || 'medium',
                data.type || 'manual',
                data.source || 'manual',
                JSON.stringify(data.trigger_config || {}),
                JSON.stringify(data.conditions || []),
                JSON.stringify(data.actions || []),
                data.requires_ai ? true : false,
                data.scan_id || null,
                data.script || null,
                data.created_by || 'system',
                data.created_for || null,
                data.organization_id || null,
                JSON.stringify(data.metadata || {}),
                now,
                now,
            ]
        );
        return getTask(id);
    } catch (err) {
        console.error('[TaskStore] createTask error:', err.message);
        return null;
    }
}

async function getTasksByScan(scanId) {
    await initDB();
    const { rows } = await pool.query('SELECT * FROM tasks WHERE scan_id = $1 ORDER BY created_at DESC', [scanId]);
    return rows.map(serialize);
}

async function getApprovedTasks() {
    await initDB();
    const { rows } = await pool.query(
        `SELECT * FROM tasks WHERE status IN ('approved', 'queued', 'awaiting_approval') AND approved_by IS NOT NULL ORDER BY created_at DESC`
    );
    return rows.map(serialize);
}

async function markTaskRun(id, nextRunAt = null) {
    await initDB();
    const now = new Date().toISOString();
    await pool.query(
        'UPDATE tasks SET last_run_at = $1, next_run_at = $2, run_count = COALESCE(run_count, 0) + 1, updated_at = $3 WHERE id = $4',
        [now, nextRunAt, now, id]
    );
    return getTask(id);
}

async function approveTask(id, userId) {
    await initDB();
    const task = await getTask(id);
    if (!task) return null;
    if (task.status !== 'pending') return null;

    const now = new Date().toISOString();
    await pool.query(
        'UPDATE tasks SET status = $1, approved_by = $2, approved_at = $3, updated_at = $4 WHERE id = $5',
        ['approved', userId, now, now, id]
    );
    return getTask(id);
}

async function rejectTask(id, userId, reason = '') {
    await initDB();
    const task = await getTask(id);
    if (!task) return null;
    if (task.status !== 'pending') return null;

    const now = new Date().toISOString();
    await pool.query(
        'UPDATE tasks SET status = $1, rejected_by = $2, rejected_at = $3, rejection_reason = $4, updated_at = $5 WHERE id = $6',
        ['rejected', userId, now, reason, now, id]
    );
    return getTask(id);
}

/**
 * Update task status for execution lifecycle.
 *
 * ⚠️  HARD GATE: Will throw if attempting to set 'running' on a task
 *     that has NOT been approved (approved_by is null).
 *     This is the core safety mechanism — no bypass allowed.
 */
async function updateTaskStatus(id, newStatus, result = null) {
    await initDB();
    const task = await getTask(id);
    if (!task) return null;

    // ═══════════════════════════════════════════════════════
    //  APPROVAL GATE — DO NOT REMOVE OR MODIFY
    //  Tasks MUST be approved before they can run.
    // ═══════════════════════════════════════════════════════
    if (newStatus === 'running' && !task.approved_by) {
        throw new Error('APPROVAL_REQUIRED: Cannot execute a task without explicit user approval');
    }

    const now = new Date().toISOString();
    const resultVal = result ? JSON.stringify(result) : (task.result ? JSON.stringify(task.result) : null);
    await pool.query(
        'UPDATE tasks SET status = $1, result = $2, updated_at = $3 WHERE id = $4',
        [newStatus, resultVal, now, id]
    );
    return getTask(id);
}

async function deleteTask(id) {
    await initDB();
    const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
    return rowCount > 0;
}

/**
 * Update task editable fields.
 */
async function updateTask(id, updates) {
    await initDB();
    const task = await getTask(id);
    if (!task) return null;

    const now = new Date().toISOString();
    await pool.query(
        'UPDATE tasks SET title = $1, description = $2, trigger_config = $3, conditions = $4, actions = $5, updated_at = $6 WHERE id = $7',
        [
            updates.title ?? task.title,
            updates.description ?? task.description,
            updates.trigger_config ? JSON.stringify(updates.trigger_config) : JSON.stringify(task.trigger_config),
            updates.conditions ? JSON.stringify(updates.conditions) : JSON.stringify(task.conditions),
            updates.actions ? JSON.stringify(updates.actions) : JSON.stringify(task.actions),
            now, id,
        ]
    );
    return getTask(id);
}

/**
 * Pause/unpause a task.
 */
async function pauseTask(id) {
    await initDB();
    const task = await getTask(id);
    if (!task) return null;
    const now = new Date().toISOString();
    const newStatus = task.status === 'paused' ? 'approved' : 'paused';
    const resultVal = task.result ? JSON.stringify(task.result) : null;
    await pool.query(
        'UPDATE tasks SET status = $1, result = $2, updated_at = $3 WHERE id = $4',
        [newStatus, resultVal, now, id]
    );
    return getTask(id);
}

/**
 * Retry a failed task — reset to approved.
 */
async function retryTask(id) {
    await initDB();
    const task = await getTask(id);
    if (!task) return null;
    if (task.status !== 'failed' && task.status !== 'paused') return null;
    const now = new Date().toISOString();
    const resultVal = task.result ? JSON.stringify(task.result) : null;
    await pool.query(
        'UPDATE tasks SET status = $1, result = $2, updated_at = $3 WHERE id = $4',
        ['approved', resultVal, now, id]
    );
    return getTask(id);
}

/**
 * Duplicate a task — creates a new pending copy.
 */
async function duplicateTask(id) {
    const source = await getTask(id);
    if (!source) return null;
    return createTask({
        title: `${source.title} (copy)`,
        description: source.description,
        priority: source.priority,
        type: source.type,
        source: source.source,
        trigger_config: source.trigger_config,
        conditions: source.conditions,
        actions: source.actions,
        requires_ai: source.requires_ai,
        created_by: source.created_by,
        created_for: source.created_for,
        organization_id: source.organization_id,
    });
}

/**
 * Direct query helper for raw SQL (used by taskExecutor for status updates).
 */
async function query(sql, params = []) {
    await initDB();
    return pool.query(sql, params);
}

// ── Execution Ledger — deduplication via hashed item IDs ──

/**
 * Hash a value with SHA-256 — no sensitive data stored.
 */
function hashItem(value) {
    return createHash('sha256').update(String(value)).digest('hex');
}

/**
 * Record an item as processed for a given task.
 * Uses ON CONFLICT to silently skip duplicates.
 */
async function recordProcessed(taskId, itemId, action = 'processed') {
    await initDB();
    const h = hashItem(itemId);
    await pool.query(
        `INSERT INTO task_ledger (task_id, item_hash, action) VALUES ($1, $2, $3)
         ON CONFLICT (task_id, item_hash) DO NOTHING`,
        [taskId, h, action]
    );
}

/**
 * Check if an item was already processed for a given task.
 */
async function isProcessed(taskId, itemId) {
    await initDB();
    const h = hashItem(itemId);
    const { rows } = await pool.query(
        'SELECT 1 FROM task_ledger WHERE task_id = $1 AND item_hash = $2 LIMIT 1',
        [taskId, h]
    );
    return rows.length > 0;
}

/**
 * Get all processed hashes for a task (for bulk filtering).
 * Returns a Set of hash strings.
 */
async function getProcessedHashes(taskId) {
    await initDB();
    const { rows } = await pool.query(
        'SELECT item_hash FROM task_ledger WHERE task_id = $1',
        [taskId]
    );
    return new Set(rows.map(r => r.item_hash));
}

module.exports = {
    getAllTasks,
    getTask,
    createTask,
    getTasksByScan,
    getApprovedTasks,
    markTaskRun,
    approveTask,
    rejectTask,
    updateTaskStatus,
    deleteTask,
    updateTask,
    pauseTask,
    retryTask,
    duplicateTask,
    query,
    pool,
    // Ledger
    hashItem,
    recordProcessed,
    isProcessed,
    getProcessedHashes,
};
