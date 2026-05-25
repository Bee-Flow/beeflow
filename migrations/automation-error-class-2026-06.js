/**
 * Migration: Add error_class column to automation_runs +
 * automation_run_steps (2026-06).
 *
 * Phase 1 lands the column so future error-classification work can
 * write into it; the runner itself doesn't populate it yet. The column
 * is nullable so existing rows stay valid without backfill — only new
 * errors carry a code (see server/core/automationErrors.js for the
 * vocabulary).
 *
 * The accompanying index lets the activity dashboard filter "errors
 * with class X in the last hour" cheaply.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS error_class VARCHAR(40)`);
    await exec(`ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS error_class VARCHAR(40)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_error_class
                    ON automation_runs(error_class)
                    WHERE error_class IS NOT NULL`);
    console.log('[Migration] automation-error-class-2026-06 applied');
}

module.exports = { up };
