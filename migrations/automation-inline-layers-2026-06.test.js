/**
 * Unit tests for the inline-layers migration — embeds legacy kind='layer'
 * rows into each referencing automation's definition.layers, rewrites
 * call_layer steps (layerId → layerKey + migratedFromLayerId), bumps the
 * version + snapshots, deletes referenced layer rows and converts orphans.
 * The pg layer is mocked via require.cache (mirrors
 * default-org-plan-2026-06.test.js) with an in-memory automations table.
 *
 * Run: node --test server/migrations/automation-inline-layers-2026-06.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── In-memory fake of server/db.js ───────────────────────────────────────
const state = { automations: [], versions: [], ddl: [] };
const reset = () => { state.automations = []; state.versions = []; state.ddl = []; };
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const findAuto = (id) => state.automations.find(a => a.id === id);

const fakeDb = {
    async exec(sql) {
        state.ddl.push(norm(sql));
    },
    async getAll(sql) {
        const q = norm(sql);
        if (q.includes("WHERE kind = 'layer'")) {
            // Return copies of the row objects so mutation accidents surface.
            return state.automations.filter(a => a.kind === 'layer').map(a => ({ ...a }));
        }
        if (q.includes("WHERE kind = 'automation'")) {
            return state.automations.filter(a => a.kind === 'automation').map(a => ({ id: a.id }));
        }
        throw new Error('unexpected getAll: ' + q);
    },
    async run(sql, params = []) {
        const q = norm(sql);
        if (q.startsWith('DELETE FROM automations WHERE id = ANY')) {
            const ids = new Set(params[0]);
            const before = state.automations.length;
            state.automations = state.automations.filter(a => !ids.has(a.id));
            return { rowCount: before - state.automations.length };
        }
        if (q.startsWith("UPDATE automations SET kind = 'automation'")) {
            const a = findAuto(params[2]);
            if (!a) return { rowCount: 0 };
            a.kind = 'automation';
            a.is_active = false;
            a.is_draft = true;
            a.title = params[0];
            a.definition_json = JSON.parse(params[1]);
            return { rowCount: 1 };
        }
        throw new Error('unexpected run: ' + q);
    },
    async getClient() {
        return {
            async query(sql, params = []) {
                const q = norm(sql);
                if (q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK') return { rows: [] };
                if (q.startsWith('SELECT * FROM automations WHERE id = $1 FOR UPDATE')) {
                    const a = findAuto(params[0]);
                    return { rows: a ? [{ ...a }] : [] };
                }
                if (q.startsWith('UPDATE automations SET definition_json = $1, version = version + 1')) {
                    const a = findAuto(params[1]);
                    if (!a) return { rows: [] };
                    a.definition_json = JSON.parse(params[0]);
                    a.version = (a.version || 1) + 1;
                    return { rows: [{ ...a }] };
                }
                if (q.startsWith('INSERT INTO automation_versions')) {
                    const [vid, automationId, version, definitionJson, savedBy] = params;
                    const dup = state.versions.some(v => v.automation_id === automationId && v.version === version);
                    if (!dup) state.versions.push({ id: vid, automation_id: automationId, version, definition_json: definitionJson, saved_by_user_id: savedBy });
                    return { rows: [] };
                }
                throw new Error('unexpected client.query: ' + q);
            },
            release() {},
        };
    },
};

const dbPath = path.join(__dirname, '..', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { up } = require('./automation-inline-layers-2026-06');

// ── Fixtures ─────────────────────────────────────────────────────────────

function layerRow(id, title, def = null) {
    return {
        id, user_id: 'u1', kind: 'layer', title, version: 1,
        is_active: false, is_draft: false,
        definition_json: def || {
            trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'x', type: 'string' }] },
            steps: [{ id: 'out', type: 'layer_output', fields: { r: { kind: 'literal', value: 1 } } }],
            edges: [{ from: 'trg', to: 'out' }],
        },
    };
}

function autoRow(id, steps) {
    return {
        id, user_id: 'u1', kind: 'automation', title: `Auto ${id}`, version: 1,
        is_active: true, is_draft: false,
        definition_json: {
            schemaVersion: 1,
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps,
            edges: [{ from: 'trg', to: steps[0]?.id }].filter(e => e.to),
        },
    };
}

const legacyCall = (id, layerId) => ({
    id, type: 'call_layer', layerId, inputs: {},
    version: 2, inputContract: [{ name: 'x' }], outputContract: [{ name: 'r' }],
});

test.beforeEach(reset);

test('DDL always runs (parent_step_id + handled_error_count)', async () => {
    await up();
    assert.ok(state.ddl.some(d => d.includes('automation_run_steps ADD COLUMN IF NOT EXISTS parent_step_id TEXT')));
    assert.ok(state.ddl.some(d => d.includes('automation_runs ADD COLUMN IF NOT EXISTS handled_error_count INTEGER NOT NULL DEFAULT 0')));
});

test('simple embed + rewrite + version snapshot; referenced layer row deleted', async () => {
    state.automations.push(
        layerRow('l1aaaaaa-0000', 'Enrich Contact'),
        autoRow('auto1', [legacyCall('cl1', 'l1aaaaaa-0000')]),
    );
    const res = await up();
    assert.equal(res.migrated, 1);
    assert.equal(res.deleted, 1);
    assert.equal(res.converted, 0);

    const a = findAuto('auto1');
    const def = a.definition_json;
    const expectedKey = 'enrich_contact_l1aaaaaa';
    assert.ok(def.layers[expectedKey], `layer embedded under deterministic key (got ${Object.keys(def.layers || {})})`);
    assert.equal(def.layers[expectedKey].title, 'Enrich Contact');
    assert.equal(def.layers[expectedKey].trigger.kind, 'layer_input', 'embedded VERBATIM');
    assert.equal(def.schemaVersion, 2);

    const step = def.steps.find(s => s.id === 'cl1');
    assert.equal(step.layerKey, expectedKey);
    assert.equal(step.migratedFromLayerId, 'l1aaaaaa-0000');
    for (const gone of ['layerId', 'version', 'inputContract', 'outputContract']) {
        assert.ok(!(gone in step), `${gone} must be deleted from the call step`);
    }

    assert.equal(a.version, 2, 'version bumped');
    const snap = state.versions.find(v => v.automation_id === 'auto1' && v.version === 2);
    assert.ok(snap, 'automation_versions snapshot written');
    assert.ok(JSON.parse(snap.definition_json).layers[expectedKey], 'snapshot carries the migrated definition');

    assert.ok(!findAuto('l1aaaaaa-0000'), 'referenced layer row deleted');
});

test('nested layer (layer referencing a layer) embeds the whole closure', async () => {
    const innerId = 'l2bbbbbb-0000';
    const outerDef = {
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [
            legacyCall('cl_in', innerId),
            { id: 'out', type: 'layer_output', fields: {} },
        ],
        edges: [{ from: 'trg', to: 'cl_in' }, { from: 'cl_in', to: 'out' }],
    };
    state.automations.push(
        layerRow('l1aaaaaa-0000', 'Outer', outerDef),
        layerRow(innerId, 'Inner'),
        autoRow('auto1', [legacyCall('cl1', 'l1aaaaaa-0000')]),
    );
    const res = await up();
    assert.equal(res.migrated, 1);
    assert.equal(res.deleted, 2, 'both layer rows deleted');

    const def = findAuto('auto1').definition_json;
    assert.ok(def.layers['outer_l1aaaaaa'], 'outer embedded');
    assert.ok(def.layers['inner_l2bbbbbb'], 'inner embedded too');
    const innerCall = def.layers['outer_l1aaaaaa'].steps.find(s => s.id === 'cl_in');
    assert.equal(innerCall.layerKey, 'inner_l2bbbbbb', 'embedded copy rewritten as well');
    assert.equal(innerCall.migratedFromLayerId, innerId);
    assert.ok(!('layerId' in innerCall));
});

test('shared layer is copied into BOTH parents under the identical key', async () => {
    state.automations.push(
        layerRow('l1aaaaaa-0000', 'Shared Layer'),
        autoRow('auto1', [legacyCall('cl1', 'l1aaaaaa-0000')]),
        autoRow('auto2', [legacyCall('cl9', 'l1aaaaaa-0000')]),
    );
    const res = await up();
    assert.equal(res.migrated, 2);
    const key = 'shared_layer_l1aaaaaa';
    const d1 = findAuto('auto1').definition_json;
    const d2 = findAuto('auto2').definition_json;
    assert.ok(d1.layers[key] && d2.layers[key], 'same deterministic key in both parents');
    assert.equal(d1.steps[0].layerKey, key);
    assert.equal(d2.steps[0].layerKey, key);
    assert.ok(!findAuto('l1aaaaaa-0000'), 'shared layer row deleted after copying');
});

test('orphan layer converts to an inactive draft automation (manual trigger, suffixed title)', async () => {
    state.automations.push(layerRow('l3cccccc-0000', 'Lonely Layer'));
    const res = await up();
    assert.equal(res.migrated, 0);
    assert.equal(res.deleted, 0);
    assert.equal(res.converted, 1);

    const a = findAuto('l3cccccc-0000');
    assert.ok(a, 'orphan row kept');
    assert.equal(a.kind, 'automation');
    assert.equal(a.is_active, false);
    assert.equal(a.is_draft, true);
    assert.equal(a.title, 'Lonely Layer (converted layer)');
    assert.equal(a.definition_json.trigger.kind, 'manual', 'layer_input → manual');
});

test('dangling layerId leaves the step untouched (no version bump)', async () => {
    state.automations.push(
        layerRow('l3cccccc-0000', 'Unrelated'), // ensures the data phase runs
        autoRow('auto1', [legacyCall('cl1', 'missing-layer-id')]),
    );
    const res = await up();
    assert.equal(res.migrated, 0, 'nothing migrated');
    const a = findAuto('auto1');
    assert.equal(a.version, 1, 'no version bump');
    const step = a.definition_json.steps.find(s => s.id === 'cl1');
    assert.equal(step.layerId, 'missing-layer-id', 'step untouched');
    assert.ok(!step.layerKey);
    assert.equal(state.versions.length, 0, 'no snapshot written');
});

test('second run is a no-op (idempotent)', async () => {
    state.automations.push(
        layerRow('l1aaaaaa-0000', 'Enrich Contact'),
        autoRow('auto1', [legacyCall('cl1', 'l1aaaaaa-0000')]),
    );
    await up();
    const afterFirst = JSON.stringify(state.automations) + JSON.stringify(state.versions);
    const res2 = await up();
    assert.equal(res2.migrated, 0);
    assert.equal(res2.deleted, 0);
    assert.equal(res2.converted, 0);
    const afterSecond = JSON.stringify(state.automations) + JSON.stringify(state.versions);
    assert.equal(afterSecond, afterFirst, 'second run changes nothing');
});

test('automation whose call steps ALL carry layerKey already is skipped', async () => {
    state.automations.push(
        layerRow('l3cccccc-0000', 'Unrelated'),
        {
            ...autoRow('auto1', [{ id: 'cl1', type: 'call_layer', layerKey: 'already_inline', inputs: {} }]),
        },
    );
    const res = await up();
    assert.equal(res.migrated, 0);
    assert.equal(findAuto('auto1').version, 1, 'no bump for already-migrated rows');
});
