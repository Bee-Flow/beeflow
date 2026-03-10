/**
 * Task Scheduler — evaluates triggers and manages activity-gated execution
 *
 * Core loop runs every 60s:
 * 1. Checks all approved tasks for due triggers
 * 2. If user is active (heartbeat < 2min) → execute immediately
 * 3. If user is away → mark as queued → execute on next heartbeat
 *
 * User presence is tracked via heartbeat from the Tasks page.
 */

const taskStore = require('../stores/taskStore');
const { executeTask } = require('./taskExecutor');

// ── Execution lock — prevent the same task from running concurrently ──
const runningTasks = new Set();

// ── User presence tracking ──────────────────────────────

const activeUsers = new Map(); // userId → { lastHeartbeat, session }

function heartbeat(userId, session) {
    // Always store the LATEST session — never a stale snapshot.
    // This ensures updated OAuth tokens (e.g. new scopes) are used.
    activeUsers.set(userId, {
        lastHeartbeat: Date.now(),
        session,  // live reference, not a snapshot
    });

    // On heartbeat, check and run any queued tasks
    processQueuedTasks(userId);
}

function isUserActive(userId) {
    const entry = activeUsers.get(userId);
    if (!entry) return false;
    return (Date.now() - entry.lastHeartbeat) < 2 * 60 * 1000; // 2 min
}

function getUserSession(userId) {
    const entry = activeUsers.get(userId);
    return entry?.session || null;
}

// ── Task queue (for execution when user returns) ────────

async function processQueuedTasks(userId) {
    const session = getUserSession(userId);
    if (!session) return;

    const tasks = await taskStore.getApprovedTasks();
    const queued = tasks.filter(t => t.status === 'queued' && t.created_for === userId);

    for (const task of queued) {
        console.log(`[TaskScheduler] Running queued task: "${task.title}"`);
        try {
            // Reset to approved first so the gate allows running
            const now = new Date().toISOString();
            await taskStore.query(
                'UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3',
                ['approved', now, task.id]
            );

            runningTasks.add(task.id);
            try {
                const result = await executeTask(task, session);
                if (result?.success === false) {
                    trackFailure(task.id);
                } else {
                    resetFailures(task.id);
                }
            } finally {
                runningTasks.delete(task.id);
            }
        } catch (err) {
            console.error(`[TaskScheduler] Queued task error:`, err.message);
            await taskStore.updateTaskStatus(task.id, 'failed', { error: err.message });
            trackFailure(task.id);
        }
    }
}

// ── Failure tracking ────────────────────────────────────

const failureCounts = new Map(); // taskId → count
const MAX_CONSECUTIVE_FAILURES = 3;

async function trackFailure(taskId) {
    const count = (failureCounts.get(taskId) || 0) + 1;
    failureCounts.set(taskId, count);

    if (count >= MAX_CONSECUTIVE_FAILURES) {
        console.warn(`[TaskScheduler] Task ${taskId} failed ${count}x in a row — auto-pausing`);
        const now = new Date().toISOString();
        await taskStore.query(
            'UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3',
            ['paused', now, taskId]
        );
        failureCounts.delete(taskId);
    }
}

function resetFailures(taskId) {
    failureCounts.delete(taskId);
}

// ── Trigger evaluation ──────────────────────────────────

function shouldTrigger(task) {
    const trigger = task.trigger_config || {};
    const triggerType = trigger.type || task.type;

    switch (triggerType) {
        case 'schedule':
        case 'scheduled': {
            // Check if next_run_at is due
            if (task.next_run_at) {
                return new Date(task.next_run_at) <= new Date();
            }
            // First run: check if task was never run
            if (!task.last_run_at) return true;
            // Fallback: use simple interval
            return false;
        }

        case 'email_received':
        case 'email_triggered': {
            // Check every 5 minutes
            if (task.next_run_at) {
                return new Date(task.next_run_at) <= new Date();
            }
            if (!task.last_run_at) return true;
            // Default: 5 min since last run
            const lastRun = new Date(task.last_run_at).getTime();
            return (Date.now() - lastRun) > 5 * 60 * 1000;
        }

        case 'email_pattern':
        case 'pattern_triggered': {
            // Same as email_received
            if (task.next_run_at) {
                return new Date(task.next_run_at) <= new Date();
            }
            if (!task.last_run_at) return true;
            const lastRun2 = new Date(task.last_run_at).getTime();
            return (Date.now() - lastRun2) > 5 * 60 * 1000;
        }

        case 'manual':
            // Manual tasks are only triggered by user clicking "Run Now"
            return false;

        default:
            return false;
    }
}

// ── Main check loop ─────────────────────────────────────

let checkInterval = null;
let running = false;

async function checkTasks() {
    if (running) return; // Prevent overlap
    running = true;

    try {
        const tasks = await taskStore.getApprovedTasks();
        if (tasks.length === 0) {
            running = false;
            return;
        }

        for (const task of tasks) {
            if (task.status === 'queued') continue; // handled by heartbeat
            if (task.status === 'awaiting_approval') continue; // waiting for user approval
            if (runningTasks.has(task.id)) continue; // already executing
            if (!shouldTrigger(task)) continue;

            const userId = task.created_for || task.created_by;

            if (isUserActive(userId)) {
                // User is on the page — execute now
                const session = getUserSession(userId);
                if (session) {
                    console.log(`[TaskScheduler] Trigger fired for "${task.title}" — user active, executing`);
                    runningTasks.add(task.id);
                    try {
                        const result = await executeTask(task, session);
                        if (result?.success === false) {
                            await trackFailure(task.id);
                        } else {
                            resetFailures(task.id);
                        }
                    } catch (err) {
                        console.error(`[TaskScheduler] Execution error:`, err.message);
                        await taskStore.updateTaskStatus(task.id, 'failed', { error: err.message });
                        await trackFailure(task.id);
                    } finally {
                        runningTasks.delete(task.id);
                    }
                }
            } else {
                // User is away — queue for later
                console.log(`[TaskScheduler] Trigger fired for "${task.title}" — user away, queuing`);
                const now = new Date().toISOString();
                await taskStore.query(
                    'UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3',
                    ['queued', now, task.id]
                );
            }
        }
    } catch (err) {
        console.error('[TaskScheduler] Check error:', err.message);
    } finally {
        running = false;
    }
}

// ── Start / Stop ────────────────────────────────────────

function startScheduler() {
    if (checkInterval) return;
    console.log('[TaskScheduler] Started (60s interval) — waiting for user heartbeat before executing');
    checkInterval = setInterval(checkTasks, 60 * 1000);
    // DO NOT run checkTasks() immediately — wait for heartbeat first.
    // This prevents tasks from auto-firing before the user consents.
}

function stopScheduler() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
        console.log('[TaskScheduler] Stopped');
    }
}

module.exports = {
    heartbeat,
    isUserActive,
    getUserSession,
    startScheduler,
    stopScheduler,
    checkTasks,
};
