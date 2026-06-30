/**
 * Migration: indexes for the n8n-style executions-history list.
 *
 * The executions table lists a user's runs newest-first with keyset (cursor)
 * pagination and server-side status/trigger/date/automation filters. These
 * indexes keep the list query O(limit) and the facet counts cheap, without
 * scanning the whole automation_runs table.
 *
 *  - idx_automation_runs_user_started — the primary keyset index: scopes to the
 *    user and orders by (started_at DESC, id DESC), which is exactly the
 *    pagination cursor. Serves both the global list and per-automation filters.
 *  - idx_automation_runs_user_trigger — supports the "Trigger" facet/filter.
 *
 * Index-only (no new columns); IF NOT EXISTS keeps re-runs safe.
 */

const { exec } = require('../db');

async function up() {
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_user_started
                  ON automation_runs(user_id, started_at DESC, id DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_runs_user_trigger
                  ON automation_runs(user_id, trigger_kind)`);
    console.log('[Migration] automation-runs-history-2026-06 applied');
}

module.exports = { up };
