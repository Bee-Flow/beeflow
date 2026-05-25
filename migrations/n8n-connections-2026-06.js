/**
 * Migration: org_n8n_connections (§21 scaffolding).
 *
 * Today n8n is configured per-org via a single secret slot
 * (`n8n_url_org_<orgId>`). Some orgs run more than one n8n instance —
 * staging vs prod, EU vs US, etc. This table lets each connection
 * carry its own URL + api-key secret reference so routine steps can
 * pick which one to dispatch against via `connectionId`.
 *
 * Phase 2: n8nWorkflowTools.js consumes connectionId; routine UI
 * surfaces the picker. Phase 1 lands the schema so the migration is
 * stable when Phase 2 ships.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS org_n8n_connections (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL,
            label TEXT NOT NULL,
            url TEXT NOT NULL,
            api_key_secret_ref TEXT,
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_org_n8n_connections_org ON org_n8n_connections(org_id)`);
    console.log('[Migration] n8n-connections-2026-06 applied');
}

module.exports = { up };
