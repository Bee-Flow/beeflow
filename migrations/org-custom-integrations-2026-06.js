/**
 * Migration: org_custom_integrations + org_custom_integration_versions.
 *
 * AI Integration Builder — org admins build org-scoped custom integrations
 * via an AI agent. Two kinds:
 *
 *   'rest'       — a declarative toolset definition executed by a hardened
 *                  generic REST runner.
 *   'mcp_remote' — a vendor-hosted HTTP MCP server.
 *
 * Lifecycle: draft → review/test → active. `definition` is the mutable working
 * copy (bumped via definition_version); activation FREEZES a snapshot into
 * activated_definition/activated_version so edits never change what runs.
 * Every saved definition is also appended to org_custom_integration_versions
 * for history/rollback. Tool names are cint_<slug>_<toolName> where slug
 * matches ^[a-z0-9]{4,16}$ (globally unique, no underscores so parsing stays
 * unambiguous). Credentials live in integration_connections under provider
 * 'custom:<integrationId>' — not here.
 *
 * Additive — no existing table changes, full back-compat.
 */

const { exec } = require('../db');

async function up() {
    // ── org_custom_integrations ─────────────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS org_custom_integrations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL DEFAULT 'rest'
                CHECK (kind IN ('rest','mcp_remote')),
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','active','disabled')),
            definition JSONB NOT NULL DEFAULT '{}'::jsonb,
            definition_version INTEGER NOT NULL DEFAULT 1,
            activated_definition JSONB,
            activated_version INTEGER,
            tools_cache JSONB NOT NULL DEFAULT '[]'::jsonb,
            allow_writes BOOLEAN NOT NULL DEFAULT FALSE,
            lend_mode TEXT CHECK (lend_mode IN ('org','byo')),
            builder_session JSONB,
            last_validation JSONB,
            created_by TEXT NOT NULL,
            activated_by TEXT,
            activated_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_orgcint_org ON org_custom_integrations(org_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_orgcint_org_status ON org_custom_integrations(org_id, status)`);

    // ── org_custom_integration_versions ─────────────────────────────
    await exec(`
        CREATE TABLE IF NOT EXISTS org_custom_integration_versions (
            integration_id UUID NOT NULL REFERENCES org_custom_integrations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            definition JSONB NOT NULL,
            created_by TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (integration_id, version)
        )
    `);

    console.log('[Migration] org-custom-integrations-2026-06 applied');
}

module.exports = { up };
