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
            max_result_length INTEGER DEFAULT 50000,
            run_count INTEGER DEFAULT 0,
            timezone TEXT DEFAULT 'Europe/Amsterdam',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_ai_tasks_user ON ai_tasks(user_id);
        CREATE INDEX IF NOT EXISTS idx_ai_tasks_due ON ai_tasks(next_run_at, is_active);

        ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS agent_id TEXT DEFAULT NULL;
        ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS conversation_id TEXT DEFAULT NULL;
        ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS days_of_week TEXT DEFAULT NULL;
        ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS time_of_day TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_ai_tasks_agent ON ai_tasks(agent_id);
    `);

    // Migrate existing tasks with old default (2000) to new default (50000)
    await exec(`
        ALTER TABLE ai_tasks ALTER COLUMN max_result_length SET DEFAULT 50000;
        UPDATE ai_tasks SET max_result_length = 50000 WHERE max_result_length <= 2000;
    `).catch(() => { /* already migrated or column doesn't exist yet */ });

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
        // Routine extensions — agent-scoped scheduled tasks (beta).
        agentId: r.agent_id || null,
        conversationId: r.conversation_id || null,
        daysOfWeek: r.days_of_week ? safeParseJSON(r.days_of_week, null) : null,
        timeOfDay: r.time_of_day || null,
    };
}

function safeParseJSON(str, fallback = []) {
    if (Array.isArray(str)) return str;
    try { return JSON.parse(str); } catch (_) { return fallback; }
}

// ── CRUD ─────────────────────────────────────────────────

async function createTask({ userId, title, prompt, repeatInterval, nextRunAt, modelTier, timezone, toolsEnabled, agentId, daysOfWeek, timeOfDay }) {
    await initDB();
    const id = crypto.randomUUID();
    const daysJson = Array.isArray(daysOfWeek) && daysOfWeek.length > 0 ? JSON.stringify(daysOfWeek) : null;
    await run(
        `INSERT INTO ai_tasks (id, user_id, title, prompt, repeat_interval, next_run_at, model_tier, timezone, tools_enabled, agent_id, days_of_week, time_of_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
            id, userId, title, prompt,
            repeatInterval || null,
            nextRunAt,
            modelTier || 'fast',
            timezone || 'Europe/Amsterdam',
            JSON.stringify(toolsEnabled || ['agent_search']),
            agentId || null,
            daysJson,
            timeOfDay || null,
        ]
    );
    console.log(`[AITaskStore] Created ${agentId ? 'routine' : 'task'} "${title}" for user ${userId}${agentId ? ` (agent ${agentId})` : ''}, next run: ${nextRunAt}`);
    return rowToTask({
        id, user_id: userId, title, prompt,
        repeat_interval: repeatInterval,
        next_run_at: nextRunAt,
        last_run_at: null, last_result: null, last_status: 'pending',
        is_active: true, model_tier: modelTier || 'fast',
        tools_enabled: JSON.stringify(toolsEnabled || ['agent_search']),
        max_result_length: 50000, run_count: 0,
        timezone: timezone || 'Europe/Amsterdam',
        created_at: new Date().toISOString(),
        agent_id: agentId || null,
        conversation_id: null,
        days_of_week: daysJson,
        time_of_day: timeOfDay || null,
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

async function getTasksByAgent(userId, agentId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM ai_tasks WHERE user_id = $1 AND agent_id = $2 ORDER BY created_at DESC',
        [userId, agentId]
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
        agentId: 'agent_id',
        conversationId: 'conversation_id',
        daysOfWeek: 'days_of_week',
        timeOfDay: 'time_of_day',
    };

    for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
        if (updates[jsKey] !== undefined) {
            setClauses.push(`"${dbCol}" = $${idx++}`);
            let val = updates[jsKey];
            if (jsKey === 'toolsEnabled' && Array.isArray(val)) val = JSON.stringify(val);
            if (jsKey === 'daysOfWeek') val = (Array.isArray(val) && val.length > 0) ? JSON.stringify(val) : null;
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
    const msg = typeof error === 'string' ? error : error?.message || 'Unknown error';
    // Tag credential-expired runs distinctly so the UI can render a
    // "Reconnect <provider>" affordance instead of a generic error chip,
    // and so resume-on-reauth can find the right rows.
    const isReauth = msg.startsWith('needs_reauth');
    await run(
        `UPDATE ai_tasks
         SET last_status = $1,
             last_result = $2,
             last_run_at = NOW(),
             run_count = run_count + 1
         WHERE id = $3`,
        [isReauth ? 'needs_reauth' : 'error', msg, id]
    );
}

/**
 * Re-activate every routine of `userId` that was paused with
 * last_status='needs_reauth'. Called from the OAuth callback once the user
 * has reconnected. The runner picks them up on the next minute tick.
 * Returns the number of resumed routines.
 */
async function resumeNeedsReauthForUser(userId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE ai_tasks
         SET is_active = TRUE, last_status = 'pending'
         WHERE user_id = $1 AND is_active = FALSE AND last_status = 'needs_reauth'`,
        [userId]
    );
    return rowCount || 0;
}

// Map a JS getDay() (0 = Sun … 6 = Sat) to the routine day-of-week tokens used
// in the days_of_week JSON array. Keep in sync with the frontend day picker.
const DOW_TOKENS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function advanceNextRun(currentNextRun, interval, daysOfWeek = null) {
    const d = new Date(currentNextRun);
    // Routine day-of-week mode: advance one day at a time until we hit a
    // permitted weekday. Falls through to standard intervals below if the
    // array is empty.
    if (Array.isArray(daysOfWeek) && daysOfWeek.length > 0) {
        const allowed = new Set(daysOfWeek.map(s => String(s).toLowerCase().slice(0, 3)));
        for (let i = 0; i < 7; i += 1) {
            d.setDate(d.getDate() + 1);
            if (allowed.has(DOW_TOKENS[d.getDay()])) return d.toISOString();
        }
        return null; // no valid day in a week — defensive
    }
    switch (interval) {
        case 'hourly':    d.setHours(d.getHours() + 1); break;
        case 'daily':     d.setDate(d.getDate() + 1); break;
        case 'weekdays': {
            do { d.setDate(d.getDate() + 1); }
            while (d.getDay() === 0 || d.getDay() === 6);
            break;
        }
        case 'weekly':    d.setDate(d.getDate() + 7); break;
        case 'biweekly':  d.setDate(d.getDate() + 14); break;
        case 'monthly':   d.setMonth(d.getMonth() + 1); break;
        case 'quarterly': d.setMonth(d.getMonth() + 3); break;
        case 'yearly':    d.setFullYear(d.getFullYear() + 1); break;
        default: return null;
    }
    return d.toISOString();
}

async function advanceSchedule(id, currentNextRun, interval, daysOfWeek = null) {
    const next = advanceNextRun(currentNextRun, interval, daysOfWeek);
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
    getTasksByAgent,
    updateTask,
    resumeNeedsReauthForUser,
    deleteTask,
    getDueTasks,
    markRunning,
    markCompleted,
    markError,
    advanceSchedule,
    advanceNextRun,
    getTaskCount,
    deleteUserTasks,
};
