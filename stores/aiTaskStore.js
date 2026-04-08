/**
 * AI Task Store — PostgreSQL-backed scheduled AI tasks.
 *
 * AI Tasks are user-scheduled, recurring prompts that the system
 * autonomously executes via the LLM and delivers results as
 * notifications (category: 'ai_task').
 *
 * A background runner (aiTaskRunner.js) picks up due tasks every 60s.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;

    await exec(`
        CREATE TABLE IF NOT EXISTS ai_tasks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            repeat_interval TEXT,
            next_run_at TIMESTAMPTZ NOT NULL,
            last_run_at TIMESTAMPTZ,
            last_result TEXT,
            last_status TEXT DEFAULT 'pending',
            is_active BOOLEAN DEFAULT TRUE,
            model_tier TEXT DEFAULT 'fast',
            tools_enabled TEXT DEFAULT '["agent_search"]',
            max_result_length INTEGER DEFAULT 2000,
            run_count INTEGER DEFAULT 0,
            timezone TEXT DEFAULT 'UTC',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_ai_tasks_user ON ai_tasks(user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_tasks_due ON ai_tasks(next_run_at, is_active);
    `);

    initialized = true;
    console.log('[AITaskStore] PostgreSQL initialized');
}

initDB().catch(err => console.error('[AITaskStore] Init error:', err.message));

// ── Helpers ─────────────────────────────────────────────

function rowToTask(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        title: r.title,
        prompt: r.prompt,
        repeatInterval: r.repeat_interval,
        nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
        lastResult: r.last_result,
        lastStatus: r.last_status,
        isActive: r.is_active,
        modelTier: r.model_tier,
        toolsEnabled: safeParseJSON(r.tools_enabled, ['agent_search']),
        maxResultLength: r.max_result_length,
        runCount: r.run_count,
        timezone: r.timezone,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

function safeParseJSON(str, fallback = []) {
    if (Array.isArray(str)) return str;
    try { return JSON.parse(str); } catch (_) { return fallback; }
}

// ── CRUD ─────────────────────────────────────────────────

async function createTask({ userId, title, prompt, repeatInterval, nextRunAt, modelTier, timezone, toolsEnabled }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO ai_tasks (id, user_id, title, prompt, repeat_interval, next_run_at, model_tier, timezone, tools_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            id, userId, title, prompt,
            repeatInterval || null,
            nextRunAt,
            modelTier || 'fast',
            timezone || 'UTC',
            JSON.stringify(toolsEnabled || ['agent_search']),
        ]
    );
    console.log(`[AITaskStore] Created task "${title}" for user ${userId}, next run: ${nextRunAt}`);
    return rowToTask({
        id, user_id: userId, title, prompt,
        repeat_interval: repeatInterval,
        next_run_at: nextRunAt,
        last_run_at: null, last_result: null, last_status: 'pending',
        is_active: true, model_tier: modelTier || 'fast',
        tools_enabled: JSON.stringify(toolsEnabled || ['agent_search']),
        max_result_length: 2000, run_count: 0,
        timezone: timezone || 'UTC',
        created_at: new Date().toISOString(),
    });
}

async function getTask(id) {
    await initDB();
    const r = await getOne('SELECT * FROM ai_tasks WHERE id = $1', [id]);
    return rowToTask(r);
}

async function getTasks(userId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM ai_tasks WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
    );
    return rows.map(rowToTask);
}

async function updateTask(id, updates) {
    await initDB();
    const setClauses = [];
    const params = [];
    let idx = 1;

    const fieldMap = {
        title: 'title',
        prompt: 'prompt',
        repeatInterval: 'repeat_interval',
        nextRunAt: 'next_run_at',
        isActive: 'is_active',
        modelTier: 'model_tier',
        timezone: 'timezone',
        toolsEnabled: 'tools_enabled',
        maxResultLength: 'max_result_length',
    };

    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
        if (updates[jsKey] !== undefined) {
            setClauses.push(`"${dbCol}" = $${idx++}`);
            let val = updates[jsKey];
            if (jsKey === 'toolsEnabled' && Array.isArray(val)) val = JSON.stringify(val);
            params.push(val);
        }
    }

    if (setClauses.length === 0) return false;
    params.push(id);
    const { rowCount } = await run(`UPDATE ai_tasks SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
    return rowCount > 0;
}

async function deleteTask(id) {
    await initDB();
    const { rowCount } = await run('DELETE FROM ai_tasks WHERE id = $1', [id]);
    return rowCount > 0;
}

// ── Execution helpers ───────────────────────────────────

async function getDueTasks() {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM ai_tasks
         WHERE next_run_at <= NOW()
           AND is_active = TRUE
           AND last_status != 'running'
         ORDER BY next_run_at ASC
         LIMIT 20`
    );
    return rows.map(rowToTask);
}

async function markRunning(id) {
    await initDB();
    await run(`UPDATE ai_tasks SET last_status = 'running' WHERE id = $1`, [id]);
}

async function markCompleted(id, result) {
    await initDB();
    await run(
        `UPDATE ai_tasks
         SET last_status = 'success',
             last_result = $1,
             last_run_at = NOW(),
             run_count = run_count + 1
         WHERE id = $2`,
        [result, id]
    );
}

async function markError(id, error) {
    await initDB();
    await run(
        `UPDATE ai_tasks
         SET last_status = 'error',
             last_result = $1,
             last_run_at = NOW(),
             run_count = run_count + 1
         WHERE id = $2`,
        [typeof error === 'string' ? error : error.message || 'Unknown error', id]
    );
}

function advanceNextRun(currentNextRun, interval) {
    const d = new Date(currentNextRun);
    switch (interval) {
        case 'daily': d.setDate(d.getDate() + 1); break;
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
        default: return null;
    }
    return d.toISOString();
}

async function advanceSchedule(id, currentNextRun, interval) {
    const next = advanceNextRun(currentNextRun, interval);
    if (next) {
        await run('UPDATE ai_tasks SET next_run_at = $1 WHERE id = $2', [next, id]);
        return next;
    }
    // No repeat → deactivate
    await run('UPDATE ai_tasks SET is_active = FALSE WHERE id = $1', [id]);
    return null;
}

async function getTaskCount(userId) {
    await initDB();
    const r = await getOne(
        'SELECT COUNT(*)::int AS count FROM ai_tasks WHERE user_id = $1',
        [userId]
    );
    return r?.count || 0;
}

async function deleteUserTasks(userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM ai_tasks WHERE user_id = $1', [userId]);
    if (rowCount > 0) console.log(`[AITaskStore] Deleted ${rowCount} task(s) for user ${userId}`);
    return rowCount;
}

module.exports = {
    createTask,
    getTask,
    getTasks,
    updateTask,
    deleteTask,
    getDueTasks,
    markRunning,
    markCompleted,
    markError,
    advanceSchedule,
    getTaskCount,
    deleteUserTasks,
};
