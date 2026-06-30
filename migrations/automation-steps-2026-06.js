/**
 * Migration: Steps (reusable, standalone building blocks).
 *
 * A "Step" (UI name) is a standalone version of an inline Flowlet: a row with
 * `kind='block'` whose definition has a single `layer_input` trigger + a
 * `layer_output` step, built in the same visual builder, and added to any
 * automation via a `call_block` step — or exposed as a chat/agent tool.
 *
 * Columns added here are only meaningful for `kind='block'` rows; existing
 * automations (`kind='automation'`) keep the defaults, so their behaviour is
 * unchanged (the routine list query stays owner-only + kind-filtered).
 *
 *  - is_published / shared_groups → the standard Agent/KB sharing model
 *    (Personal / Entire Org / Specific Groups). Mirrors those tables exactly.
 *  - published_version → publish-to-apply: consumers run the snapshot in
 *    automation_versions at this version; editing only touches the draft
 *    (definition_json). NULL = never published (not yet addable/callable).
 *  - expose_as_tool → when true the Step is offered as a tool in direct/agent
 *    chat (gated additionally by the `automations` capability + integration
 *    availability).
 *
 * IF NOT EXISTS keeps re-runs safe.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT FALSE`);
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS shared_groups TEXT NOT NULL DEFAULT '[]'`);
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS published_version INTEGER`);
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS expose_as_tool BOOLEAN NOT NULL DEFAULT FALSE`);
    // A Step's own symbol — a Lucide icon name (e.g. 'Mail'). NULL = default.
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS icon TEXT`);
    // A user-set category for grouping Steps in the builder's add-step menu.
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS category TEXT`);
    // Partial index for the "blocks visible/callable in this org" queries
    // (the catalog + tab listing) without scanning the whole automations table.
    await exec(`CREATE INDEX IF NOT EXISTS idx_automations_kind_org ON automations(kind, organization_id) WHERE kind = 'block'`);
    console.log('[Migration] automation-steps-2026-06 applied');
}

module.exports = { up };
