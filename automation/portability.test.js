'use strict';

/**
 * Unit tests for portability.js — the WS6 automation import/export layer.
 *
 * Run: node automation/portability.test.js   (from server/)
 *
 * Pure module, no DB/network; plain assert like the sibling tests.
 * validateDefinition is pulled in read-only to prove re-keyed fixtures
 * (including ones WITH inline layers) still validate.
 */

const assert = require('assert');
const { EXPORT_FORMAT, EXPORT_SCHEMA_VERSION, buildExport, sanitizeImport, rekeyDefinition } = require('./portability');
const { validateDefinition } = require('./validate');

// ── Fixtures ─────────────────────────────────────────────────────────────
//
// Root + one inline layer; the layer deliberately REUSES the ids `trg` and
// `s1` so per-graph rename scoping is actually exercised (a layer binding to
// steps.s1 must follow the LAYER's map, not the root's).

function makeDefinition() {
    return {
        schemaVersion: 2,
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            {
                id: 's1', type: 'integration_action', tool: 'gmail_search',
                inputs: { q: { kind: 'literal', value: 'invoices {{steps.s1}}' } }, // literal ships verbatim — must NOT be rewritten
                pinnedOutput: { count: 2, items: [{ subject: 'inv-1', from: 'a@b.c', date: '2026-06-01', amount: 12 }] },
            },
            { id: 'cond1', type: 'condition', expr: 'steps.s1.output.count > 0 && steps.s1.output.label != "steps.s1 failed"' },
            { id: 'n1', type: 'notification', title: 'Found {{steps.s1.output.count}}', body: 'First: {{ steps.s1.output.items[0].subject }}' },
            {
                id: 'loop1', type: 'loop', itemVar: 'item', overRef: 'steps.s1.output.items', maxIterations: 100,
                body: [
                    {
                        id: 'lb1', type: 'set',
                        fields: {
                            subj: { kind: 'ref', path: 'loop.item.subject' },
                            parent: { kind: 'ref', path: 'steps.s1.output.count' },
                        },
                        pinnedOutput: { subj: 'pinned-in-loop' },
                    },
                ],
            },
            {
                id: 'par1', type: 'parallel',
                branches: [[
                    { id: 'pb1', type: 'datetime', op: 'parse', input: 'steps.s1.output.items[0].date' },
                ]],
            },
            { id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: { email: { kind: 'ref', path: 'steps["s1"].output.items[0].from' } } },
            { id: 'f1', type: 'filter', arrayRef: 'steps.s1.output.items', expr: 'item.amount > 10' },
            { id: 'stop1', type: 'stop_error', message: 'Nothing matched {{steps.s1.output.count}}' },
        ],
        edges: [
            { from: 'trg', to: 's1' },
            { from: 's1', to: 'cond1' },
            { from: 'cond1', to: 'n1', label: 'then' },
            { from: 'cond1', to: 'f1', label: 'else' },
            { from: 'n1', to: 'loop1' },
            { from: 'loop1', to: 'par1' },
            { from: 'par1', to: 'cl1' },
            { from: 'f1', to: 'stop1' },
        ],
        vars: { fromVar: { kind: 'ref', path: 'steps.s1.output.count' } },
        layers: {
            enrich: {
                title: 'Enrich contact',
                trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'email', type: 'string', required: true }] },
                steps: [
                    {
                        id: 's1', type: 'ai_step', prompt: 'Enrich {{email}} please',
                        inputs: { email: { kind: 'ref', path: 'trigger.output.email' } },
                        pinnedOutput: { company: 'ACME' },
                    },
                    {
                        id: 'out', type: 'layer_output',
                        fields: {
                            company: { kind: 'ref', path: 'steps.s1.output.company' },
                            viaTpl: { kind: 'template', value: 'company={{steps.s1.output.company}}' },
                        },
                    },
                ],
                edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'out' }],
            },
        },
    };
}

function makeRow(overrides = {}) {
    return {
        id: '2f9c5e1a-0000-4000-8000-aaaaaaaaaaaa',
        userId: 'user-123',
        organizationId: 'org-456',
        kind: 'automation',
        title: 'Invoice sweep',
        description: 'Finds invoices and enriches senders',
        definition: makeDefinition(),
        version: 7,
        isActive: true,
        isDraft: false,
        needsFirstRunConfirm: false,
        triggerType: 'schedule',
        scheduleCron: '0 9 * * *',
        scheduleTz: 'Europe/Amsterdam',
        nextRunAt: '2026-06-11T07:00:00.000Z',
        runningInstanceId: 'pod-7',
        attempts: 3,
        builderSession: { messages: ['SECRET-TRANSCRIPT'] },
        createdFromChatId: 'chat-789',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
        ...overrides,
    };
}

// Sanity: the fixture itself validates (so later "post-rekey validates"
// assertions actually prove rekey didn't break anything).
{
    const v = validateDefinition(makeDefinition());
    assert.strictEqual(v.ok, true, `fixture must validate: ${JSON.stringify(v.errors)}`);
}

// ── 1. buildExport — allowlist envelope, no forbidden fields ────────────
{
    const row = makeRow();
    const before = JSON.stringify(row);
    const { envelope, warnings } = buildExport(row);

    assert.strictEqual(envelope.format, EXPORT_FORMAT);
    assert.strictEqual(envelope.format, 'beeflow.automation');
    assert.strictEqual(envelope.schemaVersion, EXPORT_SCHEMA_VERSION);
    assert.strictEqual(envelope.schemaVersion, 1);
    assert.ok(!Number.isNaN(Date.parse(envelope.exportedAt)), 'exportedAt is a parseable timestamp');
    assert.ok(Math.abs(Date.now() - Date.parse(envelope.exportedAt)) < 10_000, 'exportedAt is "now"');

    // Exactly the allowlisted keys — nothing else.
    assert.deepStrictEqual(
        Object.keys(envelope.automation).sort(),
        ['definition', 'description', 'scheduleCron', 'scheduleTz', 'title', 'triggerType'],
    );
    assert.strictEqual(envelope.automation.title, 'Invoice sweep');
    assert.strictEqual(envelope.automation.triggerType, 'schedule');
    assert.strictEqual(envelope.automation.scheduleCron, '0 9 * * *');

    // No forbidden values anywhere in the serialized envelope.
    const json = JSON.stringify(envelope);
    for (const leak of ['2f9c5e1a', 'user-123', 'org-456', 'SECRET-TRANSCRIPT', 'chat-789', 'pod-7', 'builderSession', 'isActive', 'nextRunAt', 'runningInstanceId']) {
        assert.ok(!json.includes(leak), `envelope must not contain "${leak}"`);
    }

    // Pinned data stripped everywhere (root step, loop body, layer step) + warned.
    assert.ok(!json.includes('pinnedOutput'), 'no pinnedOutput survives export');
    assert.ok(!json.includes('pinned-in-loop'), 'loop-body pinned value stripped');
    assert.ok(!json.includes('ACME'), 'layer pinned value stripped');
    assert.strictEqual(warnings.length, 3, `one warning per stripped pin (got ${JSON.stringify(warnings)})`);
    assert.ok(warnings.some(w => w.includes('"s1"') && !w.includes('layer')), 'root step pin warned');
    assert.ok(warnings.some(w => w.includes('"lb1"')), 'loop-body pin warned');
    assert.ok(warnings.some(w => w.includes('layer "enrich"')), 'layer pin warned with layer key');

    // Inline layers ride along; the source row is never mutated.
    assert.ok(envelope.automation.definition.layers.enrich, 'layers ride along in the definition');
    assert.strictEqual(JSON.stringify(row), before, 'buildExport must not mutate its input');
}

// ── 2. sanitizeImport — format / schemaVersion gate ─────────────────────
{
    const { envelope } = buildExport(makeRow());

    // Round trip: a fresh export imports cleanly.
    const ok = sanitizeImport(envelope);
    assert.deepStrictEqual(ok.errors, []);
    assert.strictEqual(ok.automation.title, 'Invoice sweep');

    // Bare { automation } body (no format/schemaVersion) is tolerated.
    const bare = sanitizeImport({ automation: envelope.automation });
    assert.deepStrictEqual(bare.errors, []);

    // Unknown sibling fields on the envelope are ignored (export may embed
    // exportWarnings; future-proofing for additive metadata).
    const extra = sanitizeImport({ ...envelope, exportWarnings: ['x'], somethingElse: 1 });
    assert.deepStrictEqual(extra.errors, []);

    // Wrong format → rejected.
    const badFormat = sanitizeImport({ ...envelope, format: 'n8n.workflow' });
    assert.strictEqual(badFormat.automation, null);
    assert.ok(badFormat.errors.some(e => e.includes('n8n.workflow')), `format error names the format: ${badFormat.errors}`);

    // Newer schemaVersion → clear "newer than this server" message.
    const newer = sanitizeImport({ ...envelope, schemaVersion: 2 });
    assert.strictEqual(newer.automation, null);
    assert.ok(newer.errors.some(e => /newer than this server supports/.test(e)), `newer-version message: ${newer.errors}`);

    // Junk schemaVersion → rejected too.
    const junk = sanitizeImport({ ...envelope, schemaVersion: '1' });
    assert.strictEqual(junk.automation, null);
    assert.ok(junk.errors.some(e => e.includes('Unsupported schemaVersion')));

    // Non-object / missing automation / bad shapes.
    assert.ok(sanitizeImport(null).errors.length === 1);
    assert.ok(sanitizeImport([1, 2]).errors.length === 1);
    assert.ok(sanitizeImport({}).errors.some(e => e.includes('automation')));
    assert.ok(sanitizeImport({ automation: { title: '', definition: {} } }).errors.some(e => e.includes('title')));
    assert.ok(sanitizeImport({ automation: { title: 'x', definition: 'nope' } }).errors.some(e => e.includes('definition')));
    assert.ok(sanitizeImport({ automation: { title: 'x', definition: {}, triggerType: 42 } }).errors.some(e => e.includes('triggerType')));
}

// ── 3. sanitizeImport — allowlist strips unknown/forbidden fields ───────
{
    const res = sanitizeImport({
        automation: {
            id: 'attacker-chosen-id',
            userId: 'someone-else',
            organizationId: 'their-org',
            isActive: true,
            isDraft: false,
            version: 99,
            builderSession: { messages: [] },
            webhooks: [{ slug: 'x', secret: 'y' }],
            title: '  Imported flow  ',
            description: 'desc',
            triggerType: 'manual',
            scheduleCron: null,
            scheduleTz: null,
            definition: { trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [], edges: [] },
        },
    });
    assert.deepStrictEqual(res.errors, []);
    assert.deepStrictEqual(
        Object.keys(res.automation).sort(),
        ['definition', 'description', 'scheduleCron', 'scheduleTz', 'title', 'triggerType'],
        'only allowlisted fields survive import',
    );
    assert.strictEqual(res.automation.title, 'Imported flow', 'title trimmed');
    // Defaults applied.
    const defaults = sanitizeImport({ automation: { title: 'x', definition: { a: 1 } } });
    assert.strictEqual(defaults.automation.triggerType, 'manual');
    assert.strictEqual(defaults.automation.scheduleCron, null);
    assert.strictEqual(defaults.automation.scheduleTz, null);
    // definition is cloned, not aliased.
    const srcDef = { trigger: { id: 't' }, steps: [], edges: [] };
    const cloned = sanitizeImport({ automation: { title: 'x', definition: srcDef } });
    assert.notStrictEqual(cloned.automation.definition, srcDef);
    assert.deepStrictEqual(cloned.automation.definition, srcDef);
}

// ── 4. rekeyDefinition — ids, edges, refs, templates, exprs ─────────────
{
    const def = makeDefinition();
    const before = JSON.stringify(def);
    const { definition: rk, renameMap } = rekeyDefinition(def);
    assert.strictEqual(JSON.stringify(def), before, 'rekeyDefinition must not mutate its input');

    const root = renameMap.root;
    const oldRootIds = ['trg', 's1', 'cond1', 'n1', 'loop1', 'lb1', 'par1', 'pb1', 'cl1', 'f1', 'stop1'];
    assert.deepStrictEqual(Object.keys(root).sort(), [...oldRootIds].sort(), 'every root id (incl. loop-body + parallel-branch steps) is renamed');
    for (const [oldId, newId] of Object.entries(root)) {
        assert.notStrictEqual(newId, oldId, `fresh id for ${oldId}`);
        assert.ok(newId.startsWith(`${oldId.split('_')[0]}_`) || newId.startsWith(`${oldId}_`), `prefix preserved for ${oldId} → ${newId}`);
    }
    const newIdSet = new Set(Object.values(root));
    assert.strictEqual(newIdSet.size, oldRootIds.length, 'no fresh-id collisions');

    // Trigger + steps carry the new ids.
    assert.strictEqual(rk.trigger.id, root.trg);
    const stepById = new Map(rk.steps.map(s => [s.id, s]));
    assert.ok(stepById.has(root.s1) && stepById.has(root.cl1));

    // Edges rewritten (root graph).
    for (const e of rk.edges) {
        assert.ok([...newIdSet].includes(e.from), `edge.from rewritten: ${e.from}`);
        assert.ok([...newIdSet].includes(e.to), `edge.to rewritten: ${e.to}`);
    }
    // Labels intact.
    assert.ok(rk.edges.some(e => e.from === root.cond1 && e.to === root.n1 && e.label === 'then'));

    // Expr rewritten; quoted string literal containing "steps.s1" preserved.
    const cond = stepById.get(root.cond1);
    assert.strictEqual(cond.expr, `steps.${root.s1}.output.count > 0 && steps.${root.s1}.output.label != "steps.s1 failed"`);

    // Template strings rewritten with spacing preserved.
    const notif = stepById.get(root.n1);
    assert.strictEqual(notif.title, `Found {{steps.${root.s1}.output.count}}`);
    assert.strictEqual(notif.body, `First: {{ steps.${root.s1}.output.items[0].subject }}`);
    const stop = stepById.get(root.stop1);
    assert.strictEqual(stop.message, `Nothing matched {{steps.${root.s1}.output.count}}`);

    // Loop: overRef rewritten; body step renamed; body bindings follow the
    // SAME (root) map; loop.item refs untouched.
    const loop = stepById.get(root.loop1);
    assert.strictEqual(loop.overRef, `steps.${root.s1}.output.items`);
    assert.strictEqual(loop.body[0].id, root.lb1);
    assert.strictEqual(loop.body[0].fields.subj.path, 'loop.item.subject');
    assert.strictEqual(loop.body[0].fields.parent.path, `steps.${root.s1}.output.count`);

    // Parallel branch: step renamed, datetime ref-string input rewritten.
    const par = stepById.get(root.par1);
    assert.strictEqual(par.branches[0][0].id, root.pb1);
    assert.strictEqual(par.branches[0][0].input, `steps.${root.s1}.output.items[0].date`);

    // call_layer: layerKey unchanged; bracket-form ref rewritten with the root map.
    const cl = stepById.get(root.cl1);
    assert.strictEqual(cl.layerKey, 'enrich', 'layer KEYS stay unchanged');
    assert.strictEqual(cl.inputs.email.path, `steps["${root.s1}"].output.items[0].from`);

    // Collection op: arrayRef rewritten; item-scoped expr untouched.
    const filt = stepById.get(root.f1);
    assert.strictEqual(filt.arrayRef, `steps.${root.s1}.output.items`);
    assert.strictEqual(filt.expr, 'item.amount > 10');

    // Literal binding values ship verbatim at run time → never rewritten.
    assert.strictEqual(stepById.get(root.s1).inputs.q.value, 'invoices {{steps.s1}}');

    // vars bindings follow the root map.
    assert.strictEqual(rk.vars.fromVar.path, `steps.${root.s1}.output.count`);

    // ── Per-layer scoping ────────────────────────────────────────────────
    const lmap = renameMap.layers.enrich;
    assert.deepStrictEqual(Object.keys(rk.layers), ['enrich'], 'layer keys unchanged');
    assert.deepStrictEqual(Object.keys(lmap).sort(), ['out', 's1', 'trg']);
    // The layer's rename of `s1` is INDEPENDENT of the root's.
    assert.notStrictEqual(lmap.s1, root.s1, 'layer s1 gets its own fresh id');
    const layer = rk.layers.enrich;
    assert.strictEqual(layer.trigger.id, lmap.trg);
    const lOut = layer.steps.find(s => s.type === 'layer_output');
    assert.strictEqual(lOut.id, lmap.out);
    // A layer step binding referencing a same-layer id follows THAT layer's
    // map — not the root's.
    assert.strictEqual(lOut.fields.company.path, `steps.${lmap.s1}.output.company`);
    assert.strictEqual(lOut.fields.viaTpl.value, `company={{steps.${lmap.s1}.output.company}}`);
    // Layer edges follow the layer map.
    assert.deepStrictEqual(layer.edges, [{ from: lmap.trg, to: lmap.s1 }, { from: lmap.s1, to: lmap.out }]);
    // trigger.output refs + ai_step prompts are untouched.
    const lAi = layer.steps.find(s => s.type === 'ai_step');
    assert.strictEqual(lAi.inputs.email.path, 'trigger.output.email');
    assert.strictEqual(lAi.prompt, 'Enrich {{email}} please');

    // The re-keyed document (WITH inline layers) still validates.
    const v = validateDefinition(rk);
    assert.strictEqual(v.ok, true, `re-keyed definition must validate: ${JSON.stringify(v.errors)}`);
}

// ── 5. Full round trip: export → sanitize → rekey → validate ────────────
{
    const { envelope } = buildExport(makeRow());
    const { automation, errors } = sanitizeImport(JSON.parse(JSON.stringify(envelope)));
    assert.deepStrictEqual(errors, []);
    const { definition } = rekeyDefinition(automation.definition);
    const v = validateDefinition(definition);
    assert.strictEqual(v.ok, true, `round-tripped definition validates: ${JSON.stringify(v.errors)}`);
    assert.ok(!JSON.stringify(definition).includes('pinnedOutput'));
    // Importing the same file twice yields different ids each time.
    const again = rekeyDefinition(automation.definition);
    assert.notStrictEqual(again.definition.trigger.id, definition.trigger.id);
}

// ── 6. Degenerate inputs don't throw ─────────────────────────────────────
{
    assert.deepStrictEqual(rekeyDefinition(null).renameMap, { root: {}, layers: {} });
    assert.deepStrictEqual(rekeyDefinition({}).renameMap, { root: {}, layers: {} });
    const weird = rekeyDefinition({ trigger: { id: 't' }, steps: [null, 'x', { id: 's_a', type: 'set' }], edges: [null, { from: 't', to: 's_a' }], layers: { bad: 'not-an-object' } });
    assert.ok(weird.renameMap.root.t && weird.renameMap.root.s_a);
    assert.strictEqual(weird.definition.edges[1].from, weird.renameMap.root.t);
    const { envelope } = buildExport({});
    assert.strictEqual(envelope.automation.title, '');
    assert.deepStrictEqual(envelope.automation.definition, {});
}

console.log('✓ server/automation/portability.test.js — all assertions passed');
