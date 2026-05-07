/**
 * Drops the first-run-confirm gate. The product no longer asks for a
 * one-time approval before live execution — activation runs immediately.
 *
 * - Clears the flag on every existing automation so the "Needs first-run
 *   confirm" badge disappears from the list.
 * - Flips the column default to FALSE so newly inserted rows don't
 *   re-acquire the flag (the runtime no longer reads it, but keeping the
 *   column lets us roll back without a destructive migration).
 *
 * Idempotent: re-running just no-ops both statements.
 */

const { exec } = require('../db');

async function up() {
    await exec(`UPDATE automations SET needs_first_run_confirm = FALSE WHERE needs_first_run_confirm = TRUE`);
    await exec(`ALTER TABLE automations ALTER COLUMN needs_first_run_confirm SET DEFAULT FALSE`);
    console.log('[Migration] automation-clear-first-run-confirm-2026-05 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
