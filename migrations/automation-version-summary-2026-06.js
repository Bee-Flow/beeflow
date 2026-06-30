/**
 * Migration: per-version change summary.
 *
 * Adds `change_summary` to automation_versions — a short, human-readable
 * description of what changed vs the immediately-prior version (e.g.
 * "2 steps added · 1 connection removed"), computed at save time in
 * automationStore.updateAutomation via automation/diffSummary.js. Surfaced
 * as the auto-label in the Version History panel. IF NOT EXISTS so
 * re-running is safe; existing rows keep NULL (rendered as "—").
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_versions ADD COLUMN IF NOT EXISTS change_summary TEXT`);
    console.log('[Migration] automation-version-summary-2026-06 applied');
}

module.exports = { up };
