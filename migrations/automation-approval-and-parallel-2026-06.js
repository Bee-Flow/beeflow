/**
 * Migration: Automation runs — approval + parallel + resume support (2026-06).
 *
 * Phase 2 introduces three Power-Automate-style flow primitives:
 *   1. approval step  — pauses the run until a human approves/rejects
 *   2. parallel step  — fans out into N concurrent branches
 *   3. resume-from-step — replay a flow from any saved step
 *
 * Schema additions:
 *   - automation_runs.awaiting_step_id   TEXT       which step is paused on approval
 *   - automation_runs.approval_token     TEXT       single-use HMAC token for email/Talk-link approve
 *   - automation_run_steps.branch_index  INTEGER    which parallel branch produced this row
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS awaiting_step_id TEXT`);
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS approval_token TEXT`);
    // Unique only when present — multiple finished runs all have NULL.
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_runs_approval_token
                    ON automation_runs(approval_token)
                    WHERE approval_token IS NOT NULL`);
    await exec(`ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS branch_index INTEGER`);
    console.log('[Migration] automation-approval-and-parallel-2026-06 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
