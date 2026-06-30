/**
 * Migration: integration_connections + connection_grants.
 *
 * First-class "named connections" for integration credentials. Today a user
 * has at most one credential per integration (stored ad-hoc in `config` under
 * `<provider>_*_user_<id>` keys, or in `routine_credentials` for OAuth). This
 * migration introduces:
 *
 *   integration_connections — multiple NAMED credentials per (owner, provider),
 *       each encrypted with the per-org routine-vault key (see orgVault.js).
 *   connection_grants       — an owner explicitly LENDS a connection to a
 *       user / group / org, optionally bound to a specific resource. The
 *       absence of a grant means "bring your own" (the safe default).
 *
 * Phase 1 lands only the schema + store; runtime resolution and UI ship in
 * later phases. Additive — no existing table changes, full back-compat.
 */

const { exec } = require('../db');

async function up() {
    // ── integration_connections ─────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS integration_connections (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            owner_user_id TEXT NOT NULL,
            org_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT 'Default',
            kind TEXT NOT NULL DEFAULT 'api_key'
                CHECK (kind IN ('oauth','api_key','basic','mcp')),
            secret TEXT,
            secret_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','needs_reauth','revoked','error')),
            is_default BOOLEAN NOT NULL DEFAULT FALSE,
            last_used_at TIMESTAMPTZ,
            last_error TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_intconn_owner_provider ON integration_connections(owner_user_id, provider)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_intconn_org ON integration_connections(org_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_intconn_status ON integration_connections(status)`);
    // Exactly one default per (owner, provider) — but unlimited non-default rows.
    await exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_intconn_default
        ON integration_connections(owner_user_id, provider)
        WHERE is_default = TRUE
    `);

    // ── connection_grants ────────────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS connection_grants (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
            org_id TEXT NOT NULL,
            grantor_user_id TEXT NOT NULL,
            grantee_type TEXT NOT NULL CHECK (grantee_type IN ('user','group','org')),
            grantee_id TEXT,
            resource_type TEXT CHECK (resource_type IS NULL OR resource_type IN ('agent','webpage','skill','routine')),
            resource_id TEXT,
            policy TEXT NOT NULL DEFAULT 'lend' CHECK (policy IN ('lend')),
            fixed_args JSONB,
            expires_at TIMESTAMPTZ,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_congrant_grantee ON connection_grants(grantee_type, grantee_id) WHERE revoked_at IS NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_congrant_resource ON connection_grants(resource_type, resource_id) WHERE revoked_at IS NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_congrant_connection ON connection_grants(connection_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_congrant_org ON connection_grants(org_id)`);

    console.log('[Migration] integration-connections-2026-06 applied');
}

module.exports = { up };
