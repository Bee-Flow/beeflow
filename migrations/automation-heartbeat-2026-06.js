/**
 * Migration: add last_heartbeat_at column to automation_runs (2026-06).
 *
 * Phase 2 reaper switch: replace the per-row reaper SQL (max of floor
 * and run_timeout_ms+buffer) with a simple `last_heartbeat_at < NOW()
 * - timeout` predicate. The runner writes a heartbeat between steps;
 * a missed heartbeat means the runner pod died and the row should be
 * re-claimed. The DB cancel_requested flag piggybacks on the same
 * heartbeat read so cross-pod cancel latency drops to ~one heartbeat.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_heartbeat
                    ON automation_runs(last_heartbeat_at)
                    WHERE status = 'running'`);
    console.log('[Migration] automation-heartbeat-2026-06 applied');
}

module.exports = { up };
