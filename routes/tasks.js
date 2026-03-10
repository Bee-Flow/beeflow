/**
 * Tasks API Routes
 *
 * All endpoints require authentication + the 'tasks' beta feature.
 * Tasks are created by agents, approved/rejected by users.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/permissions');
const { requireBetaFeature } = require('../core/betaFeatures');
const taskStore = require('../stores/taskStore');
const { heartbeat, isUserActive, startScheduler } = require('../integrations/taskScheduler');

// All routes require auth + tasks beta feature
router.use(requireAuth);
router.use(requireBetaFeature('tasks'));

// Start the scheduler when routes are loaded
startScheduler();

// GET /api/tasks — list tasks (optionally filtered by status, org, user)
router.get('/', async (req, res) => {
    try {
        const { status, organization_id } = req.query;
        const userId = req.session.user?.id;

        const filters = {};
        if (status) filters.status = status;

        // If user is not super admin, scope to their tasks or their org's tasks
        const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
        if (!isSuperAdmin) {
            if (organization_id) {
                // Check user belongs to this org
                const userOrgs = req.session.user?.organizations || [];
                if (userOrgs.includes(organization_id)) {
                    filters.organizationId = organization_id;
                } else {
                    filters.userId = userId;
                }
            } else {
                filters.userId = userId;
            }
        } else if (organization_id) {
            filters.organizationId = organization_id;
        }

        const tasks = await taskStore.getAllTasks(filters);
        res.json(tasks);
    } catch (err) {
        console.error('[Tasks] GET / error:', err);
        res.status(500).json({ error: 'Failed to fetch tasks' });
    }
});

// POST /api/tasks/heartbeat — user presence signal (stores session for background execution)
router.post('/heartbeat', (req, res) => {
    const userId = req.session.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    heartbeat(userId, req.session);
    res.json({ active: true, userId });
});

// GET /api/tasks/activity — scheduler status
router.get('/activity', (req, res) => {
    const userId = req.session.user?.id;
    res.json({
        userActive: isUserActive(userId),
        userId,
    });
});

// GET /api/tasks/:id — get single task
router.get('/:id', async (req, res) => {
    const task = await taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
});

// POST /api/tasks — create a new task (manual or from a scan proposal)
router.post('/', async (req, res) => {
    const {
        title, description, priority, metadata,
        created_for, organization_id,
        type, source, trigger_config, conditions, actions, script, requires_ai, scan_id,
    } = req.body;

    if (!title) {
        return res.status(400).json({ error: 'Task title is required' });
    }

    const task = await taskStore.createTask({
        title,
        description,
        priority,
        metadata,
        type: type || 'manual',
        source: source || 'manual',
        trigger_config: trigger_config || {},
        conditions: conditions || [],
        actions: actions || [],
        script: script || null,
        requires_ai: !!requires_ai,
        scan_id: scan_id || null,
        created_by: req.session.user?.id || 'system',
        created_for: created_for || req.session.user?.id,
        organization_id,
    });

    if (task) {
        res.status(201).json(task);
    } else {
        res.status(500).json({ error: 'Failed to create task' });
    }
});

// POST /api/tasks/scan/gmail — scan Gmail for automation opportunities (SSE)
router.post('/scan/gmail', async (req, res) => {
    // Verify Gmail is connected
    if (!req.session?.accessToken) {
        return res.status(400).json({ error: 'Gmail not connected. Please log in with Google.' });
    }

    // Set SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const { scanGmail } = require('../integrations/gmailTaskScanner');

        const result = await scanGmail(req.session, (event, data) => {
            send(event, data);
        });

        send('done', { scanId: result.scanId, proposalCount: result.proposals.length });
    } catch (err) {
        console.error('[Tasks] Gmail scan error:', err);
        send('error', { error: err.message });
    }

    res.end();
});

// ── Tier → Model resolution ──────────────────────────
function resolveModelFromTier(tier) {
    if (!tier || tier === 'auto') return null; // let scanner pick
    const configStore = require('../stores/configStore');
    const tiers = configStore.getConfig('chat_model_tiers') || {};
    const tierConfig = tiers[tier];
    return tierConfig?.modelId || null;
}

// ── Build existing-task context for scanners ─────────
async function buildExistingTaskContext() {
    try {
        const allTasks = await taskStore.getAllTasks();
        if (!allTasks || allTasks.length === 0) return '';

        const active = allTasks.filter(t => ['approved', 'pending', 'completed', 'paused', 'queued'].includes(t.status));
        const rejected = allTasks.filter(t => t.status === 'rejected');

        const lines = [];
        if (active.length > 0) {
            lines.push('EXISTING AUTOMATIONS (do NOT suggest these again):');
            active.forEach(t => lines.push(`- [${t.status.toUpperCase()}] "${t.title}"`));
        }
        if (rejected.length > 0) {
            lines.push('');
            lines.push('REJECTED/IGNORED IDEAS (user did NOT want these):');
            rejected.forEach(t => lines.push(`- "${t.title}"`));
        }
        return lines.join('\n');
    } catch (e) {
        console.error('[Tasks] Failed to build task context:', e.message);
        return '';
    }
}

// ── Generic scan helper (SSE) ─────────────────────────
function sseHandler(scanFn, scanArgs, req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    scanFn(...scanArgs, (event, data) => send(event, data))
        .then(result => send('done', { scanId: result.scanId, proposalCount: result.proposals.length }))
        .catch(err => { console.error('[Tasks] Scan error:', err); send('error', { error: err.message }); })
        .finally(() => res.end());
}

// POST /api/tasks/scan/calendar
router.post('/scan/calendar', async (req, res) => {
    if (!req.session?.accessToken) return res.status(400).json({ error: 'Google Calendar not connected.' });
    const { scanCalendar } = require('../integrations/calendarTaskScanner');
    const modelId = resolveModelFromTier(req.body?.tier);
    const existingContext = await buildExistingTaskContext();
    const focus = req.body?.focus || '';
    sseHandler(scanCalendar, [req.session, { modelId, existingContext, focus }], req, res);
});

// POST /api/tasks/scan/drive
router.post('/scan/drive', async (req, res) => {
    if (!req.session?.accessToken) return res.status(400).json({ error: 'Google Drive not connected.' });
    const { scanDrive } = require('../integrations/driveTaskScanner');
    const modelId = resolveModelFromTier(req.body?.tier);
    const existingContext = await buildExistingTaskContext();
    const focus = req.body?.focus || '';
    sseHandler(scanDrive, [req.session, { modelId, existingContext, focus }], req, res);
});

// POST /api/tasks/scan/slides
router.post('/scan/slides', async (req, res) => {
    if (!req.session?.accessToken) return res.status(400).json({ error: 'Google Slides not connected.' });
    const { scanSlides } = require('../integrations/slidesTaskScanner');
    const modelId = resolveModelFromTier(req.body?.tier);
    const existingContext = await buildExistingTaskContext();
    const focus = req.body?.focus || '';
    sseHandler(scanSlides, [req.session, { modelId, existingContext, focus }], req, res);
});

// POST /api/tasks/scan/sheets — reuse cross-app scanner focused on spreadsheet tasks
router.post('/scan/sheets', async (req, res) => {
    if (!req.session?.accessToken) return res.status(400).json({ error: 'Google Sheets not connected.' });
    const { scanCrossApp } = require('../integrations/crossAppTaskScanner');
    const modelId = resolveModelFromTier(req.body?.tier);
    const existingContext = await buildExistingTaskContext();
    const focus = (req.body?.focus || '') + ' Focus on Google Sheets tasks: reading, creating, and populating spreadsheets from other data sources like emails, Drive files, or calendar events.';
    sseHandler(scanCrossApp, [req.session, { modelId, existingContext, focus }], req, res);
});

// POST /api/tasks/scan/docs — reuse cross-app scanner focused on document tasks
router.post('/scan/docs', async (req, res) => {
    if (!req.session?.accessToken) return res.status(400).json({ error: 'Google Docs not connected.' });
    const { scanCrossApp } = require('../integrations/crossAppTaskScanner');
    const modelId = resolveModelFromTier(req.body?.tier);
    const existingContext = await buildExistingTaskContext();
    const focus = (req.body?.focus || '') + ' Focus on Google Docs tasks: creating, reading, updating documents from other data sources like emails, Drive files, or calendar events.';
    sseHandler(scanCrossApp, [req.session, { modelId, existingContext, focus }], req, res);
});

// POST /api/tasks/scan/fireflies
router.post('/scan/fireflies', async (req, res) => {
    const userId = req.session.user?.id;
    const configStore = require('../stores/configStore');
    if (!(await configStore.getSecret(`fireflies_api_key_user_${userId}`))) {
        return res.status(400).json({ error: 'Fireflies.ai not configured.' });
    }
    const { scanFireflies } = require('../integrations/firefliesTaskScanner');
    const modelId = resolveModelFromTier(req.body?.tier);
    const existingContext = await buildExistingTaskContext();
    const focus = req.body?.focus || '';
    sseHandler(scanFireflies, [req.session, userId, { modelId, existingContext, focus }], req, res);
});

// POST /api/tasks/scan/youtrack
router.post('/scan/youtrack', async (req, res) => {
    const userId = req.session.user?.id;
    const configStore = require('../stores/configStore');
    if (!(await configStore.getSecret(`youtrack_url_user_${userId}`))) {
        return res.status(400).json({ error: 'YouTrack not configured.' });
    }
    const { scanYouTrack } = require('../integrations/youtrackTaskScanner');
    const modelId = resolveModelFromTier(req.body?.tier);
    const existingContext = await buildExistingTaskContext();
    const focus = req.body?.focus || '';
    sseHandler(scanYouTrack, [req.session, userId, { modelId, existingContext, focus }], req, res);
});

// POST /api/tasks/scan/cross_app — cross-app scan (merges tools from all connected apps)
router.post('/scan/cross_app', async (req, res) => {
    const { scanCrossApp } = require('../integrations/crossAppTaskScanner');
    const modelId = resolveModelFromTier(req.body?.tier);
    const existingContext = await buildExistingTaskContext();
    const focus = req.body?.focus || '';
    const enabledApps = req.body?.enabledApps || null;
    sseHandler(scanCrossApp, [req.session, { modelId, existingContext, focus, enabledApps }], req, res);
});

// GET /api/tasks/scan/:scanId — get tasks from a specific scan
router.get('/scan/:scanId', async (req, res) => {
    try {
        const tasks = await taskStore.getTasksByScan(req.params.scanId);
        res.json(tasks);
    } catch (err) {
        console.error('[Tasks] GET /scan/:scanId error:', err);
        res.status(500).json({ error: 'Failed to fetch scan results' });
    }
});

// POST /api/tasks/:id/approve — approve a pending task
router.post('/:id/approve', async (req, res) => {
    const userId = req.session.user?.id;
    const task = await taskStore.approveTask(req.params.id, userId);

    if (!task) {
        return res.status(400).json({ error: 'Task not found or not in pending status' });
    }

    res.json(task);
});

// POST /api/tasks/:id/reject — reject a pending task
router.post('/:id/reject', async (req, res) => {
    const userId = req.session.user?.id;
    const { reason } = req.body;
    const task = await taskStore.rejectTask(req.params.id, userId, reason || '');

    if (!task) {
        return res.status(400).json({ error: 'Task not found or not in pending status' });
    }

    res.json(task);
});

// DELETE /api/tasks/:id — delete a task
router.delete('/:id', async (req, res) => {
    if (await taskStore.deleteTask(req.params.id)) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Task not found' });
    }
});

// POST /api/tasks/:id/run — manually trigger a task
router.post('/:id/run', async (req, res) => {
    const task = await taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!task.approved_by) return res.status(400).json({ error: 'Task must be approved first' });

    // Reset completed/failed tasks to approved so the executor gate allows re-run
    if (['completed', 'failed', 'paused'].includes(task.status)) {
        const now = new Date().toISOString();
        await taskStore.query(
            'UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3',
            ['approved', now, task.id]
        );
    }

    const { executeTask } = require('../integrations/taskExecutor');

    try {
        const result = await executeTask({ ...task, status: 'approved' }, req.session);
        res.json(result);
    } catch (err) {
        console.error('[Tasks] Manual run error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/tasks/:id/approve-execution — user approves pending changes, runs Phase 2
router.post('/:id/approve-execution', async (req, res) => {
    const task = await taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'awaiting_approval') return res.status(400).json({ error: 'Task is not awaiting approval' });

    const { executeTask } = require('../integrations/taskExecutor');

    try {
        // Run with _executeApproved flag so the executor runs Phase 2
        const result = await executeTask({ ...task, _executeApproved: true }, req.session);
        res.json(result);
    } catch (err) {
        console.error('[Tasks] Approve execution error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/tasks/:id/skip-execution — user skips pending changes
router.post('/:id/skip-execution', async (req, res) => {
    const task = await taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const now = new Date().toISOString();
    await taskStore.query(
        'UPDATE tasks SET status = $1, pending_changes = NULL, updated_at = $2 WHERE id = $3',
        ['approved', now, task.id]
    );

    res.json({ success: true, message: 'Execution skipped, task reset to approved' });
});

// GET /api/tasks/:id/pending-changes — get preview data for frontend
router.get('/:id/pending-changes', async (req, res) => {
    const task = await taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json({ changes: task.pending_changes || [], status: task.status });
});

// PUT /api/tasks/:id — edit task fields
router.put('/:id', async (req, res) => {
    const { title, description, trigger_config, conditions, actions } = req.body;
    const task = await taskStore.updateTask(req.params.id, { title, description, trigger_config, conditions, actions });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
});

// POST /api/tasks/:id/retry — retry a failed task
router.post('/:id/retry', async (req, res) => {
    const task = await taskStore.retryTask(req.params.id);
    if (!task) return res.status(400).json({ error: 'Task not found or not in failed/paused status' });

    // Optionally run immediately if requested
    if (req.body.runNow && task.approved_by) {
        const { executeTask } = require('../integrations/taskExecutor');
        try {
            const result = await executeTask(task, req.session);
            return res.json({ task: await taskStore.getTask(task.id), execution: result });
        } catch (err) {
            return res.json({ task: await taskStore.getTask(task.id), error: err.message });
        }
    }

    res.json(task);
});

// POST /api/tasks/:id/pause — toggle paused state
router.post('/:id/pause', async (req, res) => {
    const task = await taskStore.pauseTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
});

// POST /api/tasks/:id/duplicate — clone a task
router.post('/:id/duplicate', async (req, res) => {
    const task = await taskStore.duplicateTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Source task not found' });
    res.status(201).json(task);
});

module.exports = router;
