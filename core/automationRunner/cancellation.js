/**
 * Cancellation primitives for the automation runner.
 *
 * Two parallel mechanisms cooperate so a cancel signalled in one place
 * propagates everywhere it needs to:
 *
 * 1. In-process AbortController per active run, kept in ACTIVE_RUNS.
 *    Lets a Promise.race / fetch / streaming call short-circuit the
 *    instant cancel is requested on the SAME pod.
 *
 * 2. The cancel_requested DB flag (read by isCancelRequested below).
 *    Cross-pod safe: a cancel issued against a different runner pod is
 *    still honoured on the next between-steps check.
 *
 * Carved out of automationRunner.js as the first phase of §22 — keeps
 * the module surface unchanged via a re-export shim in the original
 * file. Any new consumer should import from here directly.
 */

const automationStore = require('../../stores/automationStore');

const ACTIVE_RUNS = new Map();

function registerRunCancellation(runId) {
    const controller = new AbortController();
    ACTIVE_RUNS.set(runId, controller);
    return controller;
}

function clearRunCancellation(runId) {
    ACTIVE_RUNS.delete(runId);
}

function getActiveController(runId) {
    return ACTIVE_RUNS.get(runId) || null;
}

/**
 * Request cancellation of an in-flight run. Returns the updated run
 * row, or null if no active row matched. The DB flag is the
 * cross-process signal; the AbortController short-circuits when the
 * run is local.
 */
async function requestCancel(runId) {
    const updated = await automationStore.requestCancelRun(runId).catch(() => null);
    const ctrl = ACTIVE_RUNS.get(runId);
    if (ctrl) {
        try { ctrl.abort(); } catch { /* abort is idempotent */ }
    }
    return updated;
}

/**
 * Cross-process cancellation check. Reads the cancel_requested flag
 * from the run row so a cancel issued against a different runner pod
 * is still honoured — at worst on the next "between steps" check.
 *
 * Best-effort: a DB hiccup falls through (returns false) so a flaky
 * connection doesn't kill in-progress work.
 */
async function isCancelRequested(runId) {
    try {
        const r = await automationStore.getRun(runId);
        return !!r?.cancelRequested;
    } catch {
        return false;
    }
}

module.exports = {
    ACTIVE_RUNS,
    registerRunCancellation,
    clearRunCancellation,
    getActiveController,
    requestCancel,
    isCancelRequested,
};
