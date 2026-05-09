/**
 * Migration: Automation event subscriptions — push/poll mode preference (2026-05).
 *
 * Power-Automate-style triggers want sub-second latency. Phase 1 introduces
 * a Nextcloud event-bridge in the connector that pushes events to the
 * SaaS, but we keep polling as crash-recovery fallback. Each subscription
 * gets a `mode_preference` (the user's stated intent: hybrid/webhook/polling)
 * and a `last_push_at` timestamp so a "we haven't seen a push in N minutes"
 * fallback detector can promote the row back into polling without losing
 * events.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automation_event_subscriptions ADD COLUMN IF NOT EXISTS mode_preference TEXT NOT NULL DEFAULT 'hybrid'`);
    await exec(`ALTER TABLE automation_event_subscriptions ADD COLUMN IF NOT EXISTS last_push_at TIMESTAMPTZ`);
    console.log('[Migration] automation-event-mode-2026-05 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
