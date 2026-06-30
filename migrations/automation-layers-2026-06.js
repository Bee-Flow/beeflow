/**
 * Migration: Layers (reusable sub-automations).
 *
 * Adds a `kind` discriminator to `automations`. A row is either a normal
 * automation (`kind='automation'`, the default — every existing row stays
 * one) or a reusable Layer (`kind='layer'`) that is invoked from a parent
 * automation via a `call_layer` step rather than fired by its own trigger.
 *
 * A real column (not just a definition_json flag) so the routine list and
 * the layer picker can filter cheaply (`WHERE kind = 'layer'`) without
 * parsing JSONB per row, and so the scheduler can exclude layers.
 *
 * IF NOT EXISTS keeps re-runs safe.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE automations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'automation'`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_automations_kind ON automations(user_id, kind)`);
    console.log('[Migration] automation-layers-2026-06 applied');
}

module.exports = { up };
