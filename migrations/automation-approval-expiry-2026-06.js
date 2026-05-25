/**
 * Migration: add awaiting_step_expires_at column to automation_runs
 * (2026-06).
 *
 * Lets approval steps declare a deadline. Once the deadline passes,
 * the approve route returns 410 Gone and the reaper transitions the
 * row to status='error' with error_class='ApprovalExpired' (see
 * server/core/automationErrors.js).
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS awaiting_step_expires_at TIMESTAMPTZ`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_awaiting_expires
                    ON automation_runs(awaiting_step_expires_at)
                    WHERE awaiting_step_expires_at IS NOT NULL`);
    console.log('[Migration] automation-approval-expiry-2026-06 applied');
}

module.exports = { up };
