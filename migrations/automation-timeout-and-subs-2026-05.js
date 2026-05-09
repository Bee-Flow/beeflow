/**
 * Migration: Automations — configurable run timeout, subscription failure
 * tracking, MS Graph clientState, and run cancel/parent linkage (2026-05).
 *
 * Adds:
 *   - automations.run_timeout_ms                       INT       — per-automation override (NULL = use server default)
 *   - automation_event_subscriptions.consecutive_failures INT    — count of back-to-back polling/renewal failures
 *   - automation_event_subscriptions.error_notified_at  TIMESTAMPTZ — debounces user-facing failure notifications (24h)
 *   - automation_event_subscriptions.client_state       TEXT     — HMAC the provider must echo back (MS Graph)
 *   - automation_runs.parent_run_id                     TEXT     — set on retried runs, points to the run they replay
 *   - automation_runs.cancel_requested                  BOOLEAN  — flipped by the cancel endpoint
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS run_timeout_ms INTEGER`);

    await exec(`ALTER TABLE automation_event_subscriptions ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0`);
    await exec(`ALTER TABLE automation_event_subscriptions ADD COLUMN IF NOT EXISTS error_notified_at TIMESTAMPTZ`);
    await exec(`ALTER TABLE automation_event_subscriptions ADD COLUMN IF NOT EXISTS client_state TEXT`);

    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT`);
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE`);

    console.log('[Migration] automation-timeout-and-subs-2026-05 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
