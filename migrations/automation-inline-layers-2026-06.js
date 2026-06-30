#!/usr/bin/env node
/**
 * Migration: inline layers (n8n-style sub-flows) + run-step nesting columns.
 *
 * Layers used to be standalone `automations` rows (kind='layer') that a
 * call_layer step fetched BY ID at run time. They are now inline: the full
 * mini-definition lives at `definition.layers[<key>]` of each automation
 * that uses it, and call_layer steps reference it via `layerKey`.
 *
 * Phases (all idempotent — safe to run on every boot):
 *
 *   1. DDL (always):
 *        - automation_run_steps.parent_step_id TEXT — nests recorded layer
 *          sub-steps ('cl1/out') under their calling step ('cl1').
 *        - automation_runs.handled_error_count INT — WS4 (on-error branches)
 *          plumbing, added here so both columns ship in one migration.
 *
 *   2. Data: for every kind='automation' row whose definition contains
 *      call_layer steps still referencing a layerId (walk steps + loop
 *      bodies + parallel branches recursively):
 *        - embed each referenced layer row's definition VERBATIM as
 *          definition.layers[key] (key = slug(title)_<id8>, deterministic so
 *          a shared layer gets the SAME key in every parent it's copied to);
 *        - recursively embed layers referenced by embedded layers
 *          (visited-set terminates legacy cycles);
 *        - rewrite each call step: layerKey + migratedFromLayerId, drop
 *          layerId/version/inputContract/outputContract;
 *        - stamp schemaVersion 2; persist with version+1 + an
 *          automation_versions snapshot (mirrors updateAutomation's SQL);
 *        - per-automation transaction with SELECT ... FOR UPDATE.
 *      Dangling layerId (row missing): leave the step untouched + warn —
 *      validation surfaces it as call_layer.legacy_layerId.
 *
 *   3. Retire: DELETE the layer rows that were embedded somewhere; convert
 *      orphan (never-referenced) layers into inactive draft automations
 *      (kind='automation', is_active=false, is_draft=true, title suffixed,
 *      trigger.kind layer_input → manual). The `kind` column stays (legacy
 *      data may still carry it) but nothing writes 'layer' anymore.
 *
 * Runs from automationStore.initDB() before any runner tick, so there is no
 * dual-read window (single-instance deploys; the reaper resets in-flight
 * runs). Manual usage: node server/migrations/automation-inline-layers-2026-06.js
 */

const crypto = require('crypto');
const { run, getAll, exec, getClient } = require('../db');

// ── Helpers ──────────────────────────────────────────────────────────────

function safeParse(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
}

/**
 * Deterministic inline-layer key for a legacy layer row:
 *   slug(title).slice(0,40) + '_' + id.slice(0,8)
 * slug: lowercase, runs of [^a-z0-9] → '_', trimmed; prefixed with 'layer'
 * when empty or starting with a digit so the result always matches
 * ^[a-z][a-z0-9_]*$. UUID first-8 chars are hex, so the suffix is safe.
 */
function layerKeyFor(row) {
    let slug = String(row.title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40)
        .replace(/^_+|_+$/g, '');
    if (!slug) slug = 'layer';
    else if (/^[0-9]/.test(slug)) slug = `layer_${slug}`;
    return `${slug}_${String(row.id).slice(0, 8)}`;
}

/**
 * Walk a graph's steps (incl. loop bodies + parallel branches, recursively)
 * collecting every call_layer step object (by reference, so callers can
 * mutate them in place).
 */
function collectCallSteps(graph) {
    const out = [];
    const walk = (steps) => {
        if (!Array.isArray(steps)) return;
        for (const s of steps) {
            if (!s || typeof s !== 'object') continue;
            if (s.type === 'call_layer') out.push(s);
            if (s.type === 'loop' && Array.isArray(s.body)) walk(s.body);
            if (s.type === 'parallel' && Array.isArray(s.branches)) {
                for (const branch of s.branches) walk(branch);
            }
        }
    };
    walk(graph?.steps);
    return out;
}

/** Rewrite one call step in place: layerId → layerKey (+ traceability). */
function rewriteCallStep(step, key) {
    step.layerKey = key;
    step.migratedFromLayerId = step.layerId;
    delete step.layerId;
    delete step.version;
    delete step.inputContract;
    delete step.outputContract;
}

/**
 * Embed a layer row (and, recursively, the layers IT references) into
 * `def.layers`. Returns the key, or null when the row is missing (dangling).
 * The visited set terminates legacy cycles (A → B → A embeds both once).
 */
function embedLayer(def, layerId, layersById, referenced, visited, warn) {
    const row = layersById.get(layerId);
    if (!row) return null;
    const key = layerKeyFor(row);
    referenced.add(layerId);
    if (def.layers[key] || visited.has(layerId)) return key; // already embedded
    visited.add(layerId);
    // VERBATIM embed of the layer row's definition, plus the row title so
    // the drill-in breadcrumb has a label.
    def.layers[key] = { title: row.title, ...safeParse(row.definition_json, {}) };
    // The embedded copy may itself contain legacy call_layer steps —
    // embed + rewrite those too.
    for (const step of collectCallSteps(def.layers[key])) {
        if (step.layerKey || !step.layerId) continue;
        const nestedKey = embedLayer(def, step.layerId, layersById, referenced, visited, warn);
        if (!nestedKey) {
            warn(`dangling layerId ${step.layerId} referenced from embedded layer "${key}" — step left untouched`);
            continue;
        }
        rewriteCallStep(step, nestedKey);
    }
    return key;
}

// ── Migration ────────────────────────────────────────────────────────────

async function up() {
    // 1) DDL — always, IF NOT EXISTS keeps re-runs safe.
    await exec(`ALTER TABLE automation_run_steps ADD COLUMN IF NOT EXISTS parent_step_id TEXT`);
    await exec(`ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS handled_error_count INTEGER NOT NULL DEFAULT 0`);

    // 2) Data phase — only when legacy layer rows exist (fast no-op after
    //    the first run: phase 3 removes every kind='layer' row).
    const layerRows = await getAll(`SELECT * FROM automations WHERE kind = 'layer'`);
    if (!layerRows || layerRows.length === 0) return { migrated: 0, deleted: 0, converted: 0 };

    const layersById = new Map(layerRows.map(r => [r.id, r]));
    const referenced = new Set(); // layer ids embedded into at least one automation
    let migrated = 0;

    const autoRows = await getAll(`SELECT id FROM automations WHERE kind = 'automation'`);
    for (const { id } of (autoRows || [])) {
        const client = await getClient();
        try {
            await client.query('BEGIN');
            const sel = await client.query('SELECT * FROM automations WHERE id = $1 FOR UPDATE', [id]);
            const row = sel.rows[0];
            if (!row) { await client.query('ROLLBACK'); continue; }
            const def = safeParse(row.definition_json, {});
            const callSteps = collectCallSteps(def);
            // Idempotency: nothing to do when there are no call steps, or
            // every call step already carries a layerKey.
            if (callSteps.length === 0 || callSteps.every(s => s.layerKey)) {
                await client.query('ROLLBACK');
                continue;
            }

            def.layers = (def.layers && typeof def.layers === 'object' && !Array.isArray(def.layers)) ? def.layers : {};
            let changed = false;
            const visited = new Set();
            const warn = (msg) => console.warn(`[inline-layers] automation ${id}: ${msg}`);
            for (const step of callSteps) {
                if (step.layerKey || !step.layerId) continue;
                const key = embedLayer(def, step.layerId, layersById, referenced, visited, warn);
                if (!key) {
                    warn(`dangling layerId ${step.layerId} on step ${step.id} — step left untouched`);
                    continue;
                }
                rewriteCallStep(step, key);
                changed = true;
            }

            if (!changed) { await client.query('ROLLBACK'); continue; }
            def.schemaVersion = 2;
            // Mirror updateAutomation: bump version + snapshot the new
            // definition into automation_versions.
            const upd = await client.query(
                `UPDATE automations SET definition_json = $1, version = version + 1, updated_at = NOW() WHERE id = $2 RETURNING *`,
                [JSON.stringify(def), id],
            );
            const updatedRow = upd.rows[0];
            await client.query(
                `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (automation_id, version) DO NOTHING`,
                [crypto.randomUUID(), id, updatedRow.version, JSON.stringify(def), updatedRow.user_id],
            );
            await client.query('COMMIT');
            migrated++;
        } catch (e) {
            await client.query('ROLLBACK').catch(() => {});
            console.error(`[inline-layers] failed to migrate automation ${id}: ${e.message}`);
        } finally {
            client.release();
        }
    }

    // 3) Retire the legacy rows.
    //    Referenced layers now live inline in every parent → delete the rows.
    let deleted = 0;
    const toDelete = [...referenced].filter(lid => layersById.has(lid));
    if (toDelete.length > 0) {
        const res = await run(`DELETE FROM automations WHERE id = ANY($1::text[])`, [toDelete]);
        deleted = res?.rowCount ?? toDelete.length;
    }
    //    Orphans (never referenced by any automation) become inactive draft
    //    automations so the user's work stays visible and editable.
    let converted = 0;
    for (const rowItem of layerRows) {
        if (referenced.has(rowItem.id)) continue;
        const def = safeParse(rowItem.definition_json, {});
        if (def.trigger && def.trigger.kind === 'layer_input') def.trigger.kind = 'manual';
        const newTitle = `${rowItem.title || 'Untitled'} (converted layer)`;
        await run(
            `UPDATE automations
                SET kind = 'automation', is_active = FALSE, is_draft = TRUE,
                    title = $1, definition_json = $2, updated_at = NOW()
              WHERE id = $3`,
            [newTitle, JSON.stringify(def), rowItem.id],
        );
        converted++;
    }

    console.log(`[Migration] automation-inline-layers-2026-06 applied (migrated=${migrated}, deletedLayers=${deleted}, convertedOrphans=${converted})`);
    return { migrated, deleted, converted };
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
