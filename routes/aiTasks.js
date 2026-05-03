/**
 * AI Tasks Routes — REST API for user-bound scheduled AI tasks.
 *
 * GET    /              → list user's AI tasks
 * POST   /              → create AI task
 * PUT    /:id           → update AI task
 * DELETE /:id           → delete AI task
 * POST   /:id/toggle    → toggle active/inactive
 * POST   /:id/run-now   → force immediate execution
 */

const express = require('express');
const router = express.Router();
const aiTaskStore = require('../stores/aiTaskStore');
const agentStore = require('../stores/agentStore');
const configStore = require('../stores/configStore');
const { executeTask } = require('../core/aiTaskRunner');
const { userHasBetaFeature } = require('../core/betaFeatures');

// Default max tasks per user (admin-configurable via configStore)
const DEFAULT_MAX_TASKS = 10;

const VALID_REPEAT_INTERVALS = new Set([
    'hourly', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'quarterly', 'yearly',
]);
const VALID_DOW_TOKENS = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

function normalizeRepeatInterval(value) {
    if (value === undefined) return undefined; // no change (PUT)
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !VALID_REPEAT_INTERVALS.has(value)) {
        const err = new Error(`Invalid repeatInterval: ${value}`);
        err.statusCode = 400;
        throw err;
    }
    return value;
}

function normalizeDaysOfWeek(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (!Array.isArray(value)) {
        const err = new Error('daysOfWeek must be an array of weekday tokens (sun, mon, …)');
        err.statusCode = 400;
        throw err;
    }
    const normalised = value.map(v => String(v).toLowerCase().slice(0, 3)).filter(v => VALID_DOW_TOKENS.has(v));
    return normalised.length === 0 ? null : Array.from(new Set(normalised));
}

function normalizeTimeOfDay(value) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
        const err = new Error('timeOfDay must be in "HH:MM" format');
        err.statusCode = 400;
        throw err;
    }
    return value;
}

async function getMaxTasks() {
    const limit = await configStore.getConfig('ai_tasks_max_per_user');
    return (typeof limit === 'number' && limit > 0) ? limit : DEFAULT_MAX_TASKS;
}

// Auth middleware
function requireAuth(req, res, next) {
    if (req.session?.user?.id) return next();
    res.status(401).json({ error: 'Not authenticated' });
}

router.use(requireAuth);

// GET / — list tasks. Optional `?agentId=<id>` filter for routines.
router.get('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : null;
        const tasks = agentId
            ? await aiTaskStore.getTasksByAgent(userId, agentId)
            : await aiTaskStore.getTasks(userId);
        const maxTasks = await getMaxTasks();
        res.json({ tasks, maxTasks });
    } catch (err) {
        console.error('[AITasks] List error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST / — create task. Pass `agentId` (beta-gated) to make it an agent routine.
router.post('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { title, prompt, repeatInterval, nextRunAt, modelTier, timezone, agentId, daysOfWeek, timeOfDay } = req.body;

        if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
        if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required' });
        if (!nextRunAt) return res.status(400).json({ error: 'nextRunAt is required' });

        let normalizedRepeat;
        let normalizedDays;
        let normalizedTime;
        try {
            normalizedRepeat = normalizeRepeatInterval(repeatInterval);
            normalizedDays = normalizeDaysOfWeek(daysOfWeek);
            normalizedTime = normalizeTimeOfDay(timeOfDay);
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }

        // Beta gate + agent ownership check for agent-scoped routines.
        let resolvedAgentId = null;
        if (agentId) {
            const allowed = await userHasBetaFeature(userId, 'agent_routines', req.session).catch(() => false);
            if (!allowed) return res.status(403).json({ error: 'Agent routines beta is not enabled for this account' });
            const agent = await agentStore.getAgent(agentId);
            if (!agent || agent.userId !== userId) {
                return res.status(403).json({ error: 'Agent not found or not owned by you' });
            }
            resolvedAgentId = agent.id;
        }

        // Check task limit
        const maxTasks = await getMaxTasks();
        const currentCount = await aiTaskStore.getTaskCount(userId);
        if (currentCount >= maxTasks) {
            return res.status(400).json({
                error: `Maximum number of routines reached (${maxTasks}). Delete or deactivate existing routines to create new ones.`
            });
        }

        const task = await aiTaskStore.createTask({
            userId,
            title: title.trim(),
            prompt: prompt.trim(),
            repeatInterval: normalizedRepeat ?? null,
            nextRunAt,
            modelTier: modelTier || 'fast',
            timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
            agentId: resolvedAgentId,
            daysOfWeek: normalizedDays ?? null,
            timeOfDay: normalizedTime ?? null,
        });
        res.json(task);
    } catch (err) {
        console.error('[AITasks] Create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /:id — update task
router.put('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await aiTaskStore.getTask(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        const { title, prompt, repeatInterval, nextRunAt, modelTier, timezone, isActive, daysOfWeek, timeOfDay } = req.body;

        let normalizedRepeat;
        let normalizedDays;
        let normalizedTime;
        try {
            normalizedRepeat = normalizeRepeatInterval(repeatInterval);
            normalizedDays = normalizeDaysOfWeek(daysOfWeek);
            normalizedTime = normalizeTimeOfDay(timeOfDay);
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }

        const ok = await aiTaskStore.updateTask(req.params.id, {
            title, prompt,
            repeatInterval: normalizedRepeat,
            nextRunAt, modelTier, timezone, isActive,
            daysOfWeek: normalizedDays,
            timeOfDay: normalizedTime,
        });
        res.json({ success: ok });
    } catch (err) {
        console.error('[AITasks] Update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /:id — delete task
router.delete('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await aiTaskStore.getTask(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        const ok = await aiTaskStore.deleteTask(req.params.id);
        res.json({ success: ok });
    } catch (err) {
        console.error('[AITasks] Delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /:id/toggle — toggle active/inactive
router.post('/:id/toggle', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await aiTaskStore.getTask(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        const ok = await aiTaskStore.updateTask(req.params.id, { isActive: !existing.isActive });
        res.json({ success: ok, isActive: !existing.isActive });
    } catch (err) {
        console.error('[AITasks] Toggle error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /:id/run-now — force immediate execution
router.post('/:id/run-now', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await aiTaskStore.getTask(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        if (existing.lastStatus === 'running') return res.status(400).json({ error: 'Task is already running' });

        // Execute asynchronously — don't block the response
        setImmediate(async () => {
            try {
                await executeTask(existing, { manual: true });
            } catch (err) {
                console.error(`[AITasks] Run-now failed for ${req.params.id}:`, err.message);
            }
        });

        res.json({ success: true, message: 'Task execution started. Results will appear in notifications.' });
    } catch (err) {
        console.error('[AITasks] Run-now error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
