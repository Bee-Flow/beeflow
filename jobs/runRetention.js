/**
 * Run-history retention job (§WS3.1).
 *
 * Every execution writes one automation_runs row + N automation_run_steps rows
 * (each with full input/output JSONB). Without a reaper these two highest-volume
 * tables grow without bound, degrading the executions list and inflating storage.
 *
 * This pass DELETES terminal runs (success/error/cancelled) older than the
 * retention window in bounded batches; automation_run_steps cascade-delete via
 * their FK. In-flight runs (queued/running/awaiting_approval) are never touched.
 *
 * Window: AUTOMATION_RUN_RETENTION_DAYS (default 90). Set to 0 to disable.
 * Per-org retention windows are a future enhancement; today it's a single
 * platform-wide window (delete-by-age, deliberately simple — like the nonce GC).
 */

const automationStore = require('../stores/automationStore');

const RETENTION_DAYS = (() => {
    const env = parseInt(process.env.AUTOMATION_RUN_RETENTION_DAYS, 10);
    return Number.isFinite(env) ? env : 90;
})();
const BATCH_SIZE = 5000;
// Bound the work per pass so a huge backlog drains over several passes rather
// than holding a long transaction. At 5k/batch this clears up to 100k per pass.
const MAX_BATCHES = 20;

async function runRetentionPass() {
    if (!RETENTION_DAYS || RETENTION_DAYS <= 0) {
        return { deleted: 0, disabled: true, ts: new Date().toISOString() };
    }
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60_000).toISOString();
    let deleted = 0;
    try {
        for (let i = 0; i < MAX_BATCHES; i++) {
            const n = await automationStore.deleteRunsOlderThan(cutoff, { limit: BATCH_SIZE });
            deleted += n;
            if (n < BATCH_SIZE) break;
        }
    } catch (e) {
        console.error('[runRetention] pass error:', e.message);
    }
    if (deleted) console.log(`[runRetention] deleted ${deleted} run(s) older than ${RETENTION_DAYS}d (cutoff ${cutoff})`);
    return { deleted, cutoff, ts: new Date().toISOString() };
}

module.exports = { runRetentionPass, RETENTION_DAYS };
