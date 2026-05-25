/**
 * Migration: Phase-2 scaffolding tables (§4b, §6b, §18, §26).
 *
 * Lands the data structures so per-feature scaffolds have somewhere to
 * read/write once their bodies arrive. Each table is created with
 * IF NOT EXISTS so re-running this migration is safe.
 *
 *   automation_trigger_samples — pinned trigger payloads for replay (§4b)
 *   automation_approval_audit  — who approved/rejected, when, why (§6b)
 *   automation_templates       — DB-backed template gallery (§26)
 *
 * Plus column additions on `automations` for the §18 context bundle
 * (kb_ids, skill_ids, persona_id).
 */

const { exec } = require('../db');

async function up() {
    // §4b — trigger sample vault
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_trigger_samples (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL,
            trigger_id TEXT NOT NULL,
            label TEXT,
            payload JSONB NOT NULL,
            pinned_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_trigger_samples_automation
                    ON automation_trigger_samples(automation_id, trigger_id, created_at DESC)`);

    // §6b — approval audit trail
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_approval_audit (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            step_id TEXT,
            decided_by TEXT,
            decision TEXT NOT NULL,
            comment TEXT,
            source TEXT,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_approval_audit_run
                    ON automation_approval_audit(run_id, ts DESC)`);

    // §18 — context bundle on automations
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS kb_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS skill_ids JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS persona_id INTEGER`);

    // §26 — DB-backed template gallery
    await exec(`
        CREATE TABLE IF NOT EXISTS automation_templates (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            description TEXT,
            category TEXT,
            tags JSONB NOT NULL DEFAULT '[]'::jsonb,
            definition JSONB NOT NULL,
            params_schema JSONB,
            version INTEGER NOT NULL DEFAULT 1,
            parent_id TEXT,
            org_id TEXT,
            created_by TEXT,
            fork_count INTEGER NOT NULL DEFAULT 0,
            published_at TIMESTAMPTZ,
            source TEXT NOT NULL DEFAULT 'official',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_templates_category
                    ON automation_templates(category) WHERE category IS NOT NULL`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_templates_source
                    ON automation_templates(source)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automation_templates_org
                    ON automation_templates(org_id) WHERE org_id IS NOT NULL`);

    console.log('[Migration] automation-extras-2026-06 applied');
}

module.exports = { up };
