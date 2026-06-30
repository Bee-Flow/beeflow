/**
 * Migration: Automation Builder — initial schema (2026-05).
 *
 * Creates all tables that back the conversational automation builder:
 *   - automations                       (definition rows)
 *   - automation_versions               (immutable history)
 *   - automation_runs                   (one row per execution)
 *   - automation_run_steps              (per-step log)
 *   - automation_webhooks               (signed inbound URLs)
 *   - automation_webhook_seen_nonces    (replay protection, 24h)
 *   - automation_event_subscriptions    (app-event triggers, webhook + polling)
 *
 * Idempotent — safe to run multiple times. Re-creating the same schema
 * inside automationStore.initDB() is also safe.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS automations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            title TEXT NOT NULL,
            description TEXT,
            definition_json JSONB NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            is_draft BOOLEAN NOT NULL DEFAULT TRUE,
            needs_first_run_confirm BOOLEAN NOT NULL DEFAULT TRUE,
            trigger_type TEXT NOT NULL DEFAULT 'manual',
            schedule_cron TEXT,
            schedule_tz TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
            next_run_at TIMESTAMPTZ,
            last_run_at TIMESTAMPTZ,
            last_status TEXT,
            created_from_chat_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(user_id);
        CREATE INDEX IF NOT EXISTS idx_automations_org ON automations(organization_id);
        CREATE INDEX IF NOT EXISTS idx_automations_due ON automations(next_run_at, is_active);
        CREATE INDEX IF NOT EXISTS idx_automations_trigger_type ON automations(trigger_type);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_versions (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            definition_json JSONB NOT NULL,
            saved_by_user_id TEXT NOT NULL,
            saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            change_summary TEXT,
            UNIQUE (automation_id, version)
        );
        CREATE INDEX IF NOT EXISTS idx_automation_versions_aid ON automation_versions(automation_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_runs (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            trigger_kind TEXT NOT NULL,
            trigger_payload JSONB,
            mode TEXT NOT NULL DEFAULT 'live',
            status TEXT NOT NULL DEFAULT 'queued',
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            duration_ms INTEGER,
            error TEXT,
            summary TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_automation_runs_aid_started ON automation_runs(automation_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_run_steps (
            run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL,
            step_type TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'pending',
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            input_json JSONB,
            output_json JSONB,
            error TEXT,
            PRIMARY KEY (run_id, step_id, attempts)
        );
        CREATE INDEX IF NOT EXISTS idx_automation_run_steps_run ON automation_run_steps(run_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_webhooks (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            secret TEXT NOT NULL,
            allow_methods TEXT NOT NULL DEFAULT 'POST',
            last_seen_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_automation_webhooks_aid ON automation_webhooks(automation_id);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_webhook_seen_nonces (
            nonce TEXT PRIMARY KEY,
            seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_automation_webhook_nonces_seen ON automation_webhook_seen_nonces(seen_at);
    `);

    await exec(`
        CREATE TABLE IF NOT EXISTS automation_event_subscriptions (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            event_type TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'webhook',
            external_ref TEXT,
            expires_at TIMESTAMPTZ,
            last_cursor TEXT,
            last_polled_at TIMESTAMPTZ,
            filter_json JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_aes_aid ON automation_event_subscriptions(automation_id);
        CREATE INDEX IF NOT EXISTS idx_aes_provider_event ON automation_event_subscriptions(provider, event_type);
        CREATE INDEX IF NOT EXISTS idx_aes_polling ON automation_event_subscriptions(mode, last_polled_at);
    `);

    console.log('[Migration] automation-builder-2026-05-init applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
