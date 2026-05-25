/**
 * Migration: alert rules + alert event log (§11 scaffolding).
 *
 * Two tables:
 *   automation_alert_rules  — user-declared rules per automation
 *   automation_alert_events — fired events (for dedupe + audit + UI feed)
 *
 * Idempotent — uses CREATE TABLE IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_alert_rules (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL,
            user_id TEXT,
            "when" TEXT NOT NULL,
            threshold JSONB,
            window_ms BIGINT,
            channels JSONB NOT NULL DEFAULT '[]'::jsonb,
            dedupe_key TEXT,
            quiet_hours JSONB,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_alert_rules_automation ON automation_alert_rules(automation_id)`);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_alert_events (
            id TEXT PRIMARY KEY,
            rule_id TEXT NOT NULL,
            automation_id TEXT NOT NULL,
            run_id TEXT,
            kind TEXT NOT NULL,
            payload JSONB,
            dedupe_key TEXT,
            fired_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_alert_events_rule_dedupe
                    ON automation_alert_events(rule_id, dedupe_key, fired_at DESC)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_alert_events_automation_time
                    ON automation_alert_events(automation_id, fired_at DESC)`);

    console.log('[Migration] automation-alerts-2026-06 applied');
}

module.exports = { up };
