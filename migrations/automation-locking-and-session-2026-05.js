#!/usr/bin/env node
/**
 * Migration: Automations — atomic claim + builder session snapshot (2026-05).
 *
 * Adds:
 *   - automations.running_instance_id   TEXT       — worker/process token
 *   - automations.running_started_at    TIMESTAMPTZ — set when the row is claimed
 *   - automations.attempts              INTEGER     — retry count, drives backoff
 *   - automations.builder_session       JSONB       — SSE resume snapshot
 *                                                     ({sessionId, version,
 *                                                      messages, draft,
 *                                                      lastValidation})
 *
 * Plus indexes used by the runner's `FOR UPDATE SKIP LOCKED` claim and
 * the stuck-run reaper.
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
 *
 * Auto-runs from `stores/automationStore.js initDB()` after the init migration.
 * Manual usage:
 *   node server/migrations/automation-locking-and-session-2026-05.js
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        ALTER TABLE automations
            ADD COLUMN IF NOT EXISTS running_instance_id TEXT
    `);
    await exec(`
        ALTER TABLE automations
            ADD COLUMN IF NOT EXISTS running_started_at TIMESTAMPTZ
    `);
    await exec(`
        ALTER TABLE automations
            ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0
    `);
    await exec(`
        ALTER TABLE automations
            ADD COLUMN IF NOT EXISTS builder_session JSONB
    `);

    // Partial index targets the reaper's lookup pattern (only rows that are
    // currently running). Keeps the index small even at fleet scale.
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_automations_stuck
            ON automations(running_started_at)
            WHERE last_status = 'running'
    `);

    // Tightened "due" index used by claimDueAutomations(). Covers the
    // common filter (active, non-draft, schedule trigger, due now).
    await exec(`
        CREATE INDEX IF NOT EXISTS idx_automations_claimable
            ON automations(next_run_at)
            WHERE is_active = TRUE
              AND is_draft = FALSE
              AND trigger_type = 'schedule'
    `);

    console.log('[Migration] automation-locking-and-session-2026-05 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
