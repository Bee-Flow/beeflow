/**
 * Unit tests for branch-aware edge wiring in the automation builder tools.
 *
 * Run: node automation/builderTools.test.js
 *
 * No DB needed — the add-* tools only mutate the in-memory draft definition
 * (only builder_request_dry_run / builder_finalize touch the store).
 */

const assert = require('assert');
const { applyToolCall, emptyDefinition, MUTATING_TOOLS, SCOPED_GRAPH_TOOLS, TOOL_SCHEMAS } = require('./builderTools');
const { validateDefinition } = require('./validate');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}
function edge(def, fromId) {
    return def.edges.filter(e => e.from === fromId);
}

(async () => {
    // ── Appending after a condition auto-labels then (first) / else (second) ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        const condId = cond.added.id;
        // Incoming edge from the (manual) trigger must stay UNLABELLED — the
        // trigger is not a branching step.
        const incoming = dw.def.edges.find(e => e.to === condId);
        assert.ok(incoming && incoming.label === undefined, 'incoming edge to condition must be unlabelled');

        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: condId }, dw);
        const a2 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: condId }, dw);
        const outs = edge(dw.def, condId);
        const e1 = outs.find(e => e.to === a1.added.id);
        const e2 = outs.find(e => e.to === a2.added.id);
        assert.strictEqual(e1.label, 'then', 'first append after condition → then');
        assert.strictEqual(e2.label, 'else', 'second append after condition → else');

        // The branch/caseName args must NOT leak onto the created step.
        assert.ok(!('branch' in a1.added) && !('caseName' in a1.added), 'branch/caseName must not leak onto the step');

        // Definition now validates — no dead_branch / partial_branch.
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => e.code === 'condition.dead_branch'), 'no dead_branch after wiring both branches');
        assert.ok(!v.warnings.some(e => e.code === 'condition.partial_branch'), 'no partial_branch after wiring both branches');
    }

    // ── Explicit branch override wins over auto-infer ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        const condId = cond.added.id;
        const a1 = await applyToolCall('builder_add_notification', { title: 'hi', afterStepId: condId, branch: 'else' }, dw);
        const e1 = edge(dw.def, condId).find(e => e.to === a1.added.id);
        assert.strictEqual(e1.label, 'else', 'explicit branch:"else" overrides the auto then-first');
    }

    // ── A one-sided condition is a WARNING (partial_branch), not an error ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw);
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => e.code === 'condition.dead_branch'), 'one wired branch is not a dead_branch error');
        assert.ok(v.warnings.some(e => e.code === 'condition.partial_branch'), 'one-sided condition warns partial_branch');
    }

    // ── Appending after a switch with caseName labels case:<name> ──
    {
        const dw = freshWrap();
        const sw = await applyToolCall('builder_add_switch', { expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] }, dw);
        const swId = sw.added.id;
        const withCase = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: swId, caseName: 'urgent' }, dw);
        const e1 = edge(dw.def, swId).find(e => e.to === withCase.added.id);
        assert.strictEqual(e1.label, 'case:urgent', 'switch append with caseName → case:<name>');
        assert.strictEqual(e1.caseName, 'urgent', 'switch edge carries caseName');

        // default routes to case:default
        const dwd = freshWrap();
        const sw2 = await applyToolCall('builder_add_switch', { expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] }, dwd);
        const def2 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: sw2.added.id, caseName: 'default' }, dwd);
        const ed = edge(dwd.def, sw2.added.id).find(e => e.to === def2.added.id);
        assert.strictEqual(ed.label, 'case:default', 'switch append with caseName:"default" → case:default');
    }

    // ── Appending after a switch WITHOUT caseName leaves the edge unlabelled ──
    {
        const dw = freshWrap();
        const sw = await applyToolCall('builder_add_switch', { expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] }, dw);
        const noCase = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: sw.added.id }, dw);
        const e1 = edge(dw.def, sw.added.id).find(e => e.to === noCase.added.id);
        assert.strictEqual(e1.label, undefined, 'switch append without caseName stays unlabelled (today behaviour)');
    }

    // ── Appending after a NORMAL step is unchanged (plain unlabelled edge) ──
    {
        const dw = freshWrap();
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const a2 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: a1.added.id }, dw);
        const e1 = edge(dw.def, a1.added.id).find(e => e.to === a2.added.id);
        assert.strictEqual(e1.label, undefined, 'append after a normal step is an unlabelled edge');
    }

    // ═══ WS3: inline layers (create / contract / scope / call / recursion) ═══

    // ── builder_create_layer creates the skeleton + returns layerKey ──
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', {
            title: 'Enrich Contact',
            params: [{ name: 'email', type: 'string', required: true }],
        }, dw);
        assert.ok(!r.error, `create_layer must not error: ${r.error}`);
        assert.ok(/^[a-z][a-z0-9_]*$/.test(r.layerKey), `layerKey matches the key grammar: ${r.layerKey}`);
        const layer = dw.def.layers[r.layerKey];
        assert.ok(layer, 'layer stored at definition.layers[key]');
        assert.strictEqual(layer.title, 'Enrich Contact');
        assert.strictEqual(layer.trigger.kind, 'layer_input');
        assert.deepStrictEqual(layer.trigger.params, [{ name: 'email', type: 'string', required: true }]);
        assert.strictEqual(layer.steps.length, 1);
        assert.strictEqual(layer.steps[0].type, 'layer_output');
        assert.deepStrictEqual(layer.edges, [{ from: 'trg', to: 'out' }]);
        assert.strictEqual(dw.def.schemaVersion, 2, 'layers present → schemaVersion 2');
        // The _draftSteps reminder gains a per-layer section.
        const layerSection = (r._draftSteps || []).find(x => x.layer === r.layerKey);
        assert.ok(layerSection, '_draftSteps includes a per-layer section');
        assert.deepStrictEqual(layerSection.steps[0].params, ['email'], 'layer section lists the params');

        // ── scope param targets the layer graph, not the root ──
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: 'trg', scope: r.layerKey }, dw);
        assert.ok(!a1.error, `scoped add must not error: ${a1.error}`);
        assert.ok(layer.steps.some(s => s.id === a1.added.id), 'scoped step lands inside the layer');
        assert.ok(!dw.def.steps.some(s => s.id === a1.added.id), 'scoped step does NOT land in the root');
        assert.ok(layer.edges.some(e => e.from === 'trg' && e.to === a1.added.id), 'edge wired inside the layer');

        // builder_remove_step honours scope too.
        const rm = await applyToolCall('builder_remove_step', { stepId: a1.added.id, scope: r.layerKey }, dw);
        assert.ok(!rm.error && !layer.steps.some(s => s.id === a1.added.id), 'scoped remove deletes from the layer');

        // ── unknown scope → structured error ──
        const bad = await applyToolCall('builder_add_action', { tool: 'gmail_search', scope: 'nope' }, dw);
        assert.ok(bad.error && /Unknown flowlet scope/.test(bad.error), 'unknown scope rejected');

        // ── builder_set_layer_contract: params + outputFields (bindings preserved) ──
        layer.steps[0].fields = {
            score: { kind: 'ref', path: 'steps.x.output.s' },
            junk: { kind: 'literal', value: 'drop-me' },
        };
        const c = await applyToolCall('builder_set_layer_contract', {
            layerKey: r.layerKey,
            params: [{ name: 'email', required: true }, { name: 'name' }],
            outputFields: ['score', 'extra'],
        }, dw);
        assert.ok(!c.error, `set_layer_contract must not error: ${c.error}`);
        assert.deepStrictEqual(layer.trigger.params.map(p => p.name), ['email', 'name']);
        assert.deepStrictEqual(Object.keys(layer.steps[0].fields), ['score', 'extra']);
        assert.deepStrictEqual(layer.steps[0].fields.score, { kind: 'ref', path: 'steps.x.output.s' }, 'kept key keeps its binding');
        assert.deepStrictEqual(layer.steps[0].fields.extra, { kind: 'literal', value: '' }, 'new key starts as empty literal');
        const unknown = await applyToolCall('builder_set_layer_contract', { layerKey: 'nope' }, dw);
        assert.ok(unknown.error && /Unknown layerKey/.test(unknown.error), 'unknown layerKey rejected');

        // ── builder_add_call_layer by key (root scope) ──
        const cl = await applyToolCall('builder_add_call_layer', {
            layerKey: r.layerKey,
            inputs: { email: { kind: 'ref', path: 'trigger.output.email' } },
        }, dw);
        assert.ok(!cl.error, `add_call_layer must not error: ${cl.error}`);
        assert.strictEqual(cl.added.type, 'call_layer');
        assert.strictEqual(cl.added.layerKey, r.layerKey);
        assert.ok(!('layerId' in cl.added) && !('inputContract' in cl.added) && !('outputContract' in cl.added), 'no legacy fields on the new step');
        assert.ok(dw.def.steps.some(s => s.id === cl.added.id), 'call step lands in the root');

        // unknown target key
        const clBad = await applyToolCall('builder_add_call_layer', { layerKey: 'ghost' }, dw);
        assert.ok(clBad.error && /Unknown layerKey/.test(clBad.error), 'unknown layerKey rejected on call');
        // legacy layerId arg
        const clLegacy = await applyToolCall('builder_add_call_layer', { layerId: 'uuid' }, dw);
        assert.ok(clLegacy.error && /layerKey/.test(clLegacy.error), 'layerId arg rejected with a layerKey hint');
    }

    // ── recursion rejection: target closure must not reach the calling scope ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_create_layer', { title: 'Layer A' }, dw);
        const b = await applyToolCall('builder_create_layer', { title: 'Layer B' }, dw);
        // Direct self-call: inside A, call A.
        const self = await applyToolCall('builder_add_call_layer', { layerKey: a.layerKey, scope: a.layerKey, afterStepId: 'trg' }, dw);
        assert.ok(self.error && /Recursive/.test(self.error), 'A calling A is rejected');
        // Sibling call B from inside A is fine…
        const ok = await applyToolCall('builder_add_call_layer', { layerKey: b.layerKey, scope: a.layerKey, afterStepId: 'trg' }, dw);
        assert.ok(!ok.error, `sibling call must pass: ${ok.error}`);
        // …but now B (transitively reached from A) calling A would close the cycle.
        const cyc = await applyToolCall('builder_add_call_layer', { layerKey: a.layerKey, scope: b.layerKey, afterStepId: 'trg' }, dw);
        assert.ok(cyc.error && /Recursive/.test(cyc.error), 'A→B→A transitive recursion rejected');
    }

    // ── builder_propose_trigger refuses a scope (root-only) ──
    {
        const dw = freshWrap();
        await applyToolCall('builder_create_layer', { title: 'L' }, dw);
        const r = await applyToolCall('builder_propose_trigger', { kind: 'manual', scope: 'l' }, dw);
        assert.ok(r.error && /does not accept a scope/.test(r.error), 'propose_trigger with scope rejected');
    }

    // ═══ Layers keep their layer_output ("Return") TERMINAL while building ═══
    // Regression: the skeleton wires trigger→layer_output, so naively appending
    // chained new steps AFTER the output — the layer returned nothing and ran
    // its real work as dead code. Appending (no afterStepId) must splice each
    // step in BEFORE the output so the output stays the sink.
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', {
            title: 'Find invoices',
            params: [{ name: 'supplierName', type: 'string', required: true }],
        }, dw);
        const key = r.layerKey;
        const layer = dw.def.layers[key];
        const outId = layer.steps.find(s => s.type === 'layer_output').id;

        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search', scope: key }, dw);
        const agg = await applyToolCall('builder_add_aggregate', { scope: key }, dw);

        // The output must never have an OUTGOING edge — it is the terminal node.
        assert.ok(!layer.edges.some(e => e.from === outId), 'layer_output has no outgoing edge (stays terminal)');
        // Linear chain trg → action → aggregate → out.
        assert.ok(layer.edges.some(e => e.from === 'trg' && e.to === a.added.id), 'trigger → first step');
        assert.ok(layer.edges.some(e => e.from === a.added.id && e.to === agg.added.id), 'first step → aggregate');
        assert.ok(layer.edges.some(e => e.from === agg.added.id && e.to === outId), 'aggregate → output (output is last)');
        // No duplicate edge into the output left behind by the splice.
        assert.strictEqual(layer.edges.filter(e => e.to === outId).length, 1, 'output has exactly one incoming edge');
    }

    // ═══ builder_set_layer_contract `outputs` binds the Return step directly ═══
    // The layer returns data by binding its layer_output fields — never via a
    // separate `set` step. One call declares AND binds.
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', { title: 'Bind out', params: [] }, dw);
        const key = r.layerKey;
        const layer = dw.def.layers[key];
        const agg = await applyToolCall('builder_add_aggregate', { scope: key }, dw);

        const c = await applyToolCall('builder_set_layer_contract', {
            layerKey: key,
            outputs: { invoices: { kind: 'ref', path: `steps.${agg.added.id}.output.values` } },
        }, dw);
        assert.ok(!c.error, `outputs binding must not error: ${c.error}`);
        const out = layer.steps.find(s => s.type === 'layer_output');
        assert.deepStrictEqual(out.fields.invoices, { kind: 'ref', path: `steps.${agg.added.id}.output.values` }, 'Return field bound to the aggregate output');
        assert.deepStrictEqual(c.outputFields, ['invoices'], 'contract reports the bound field');

        // A non-object outputs is rejected with a helpful message.
        const bad = await applyToolCall('builder_set_layer_contract', { layerKey: key, outputs: ['nope'] }, dw);
        assert.ok(bad.error && /outputs must be a map/.test(bad.error), 'array outputs rejected');
    }

    // ═══ Per-step forEach: a single leaf step iterates WITHOUT a loop ═══
    {
        const dw = freshWrap();
        const search = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: {} }, dw);
        const over = `steps.${search.added.id}.output.messages`;

        const read = await applyToolCall('builder_add_action', {
            tool: 'gmail_read', forEach: { overRef: over, itemVar: 'email' },
        }, dw);
        assert.ok(!read.error, `forEach add must not error: ${read.error}`);
        assert.deepStrictEqual(read.added.forEach, { overRef: over, itemVar: 'email' }, 'step carries the validated forEach');

        // itemVar defaults to "item"
        const read2 = await applyToolCall('builder_add_action', { tool: 'gmail_read', forEach: { overRef: over } }, dw);
        assert.strictEqual(read2.added.forEach.itemVar, 'item', 'itemVar defaults to "item"');

        // rootless overRef rejected (same ref rules as inputs)
        const bad = await applyToolCall('builder_add_action', { tool: 'gmail_read', forEach: { overRef: 'messages' } }, dw);
        assert.ok(bad.error && /forEach\.overRef/.test(bad.error), 'forEach with a rootless overRef is rejected');
        // missing overRef rejected
        const bad2 = await applyToolCall('builder_add_action', { tool: 'gmail_read', forEach: {} }, dw);
        assert.ok(bad2.error && /overRef/.test(bad2.error), 'forEach without overRef is rejected');
        // maxIterations out of range rejected
        const bad3 = await applyToolCall('builder_add_action', { tool: 'gmail_read', forEach: { overRef: over, maxIterations: 9999 } }, dw);
        assert.ok(bad3.error && /maxIterations/.test(bad3.error), 'forEach maxIterations range enforced');

        // a forEach action produces no `foreach.*` validation errors.
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => String(e.code).startsWith('foreach.')), 'integration_action + forEach validates with no foreach errors');
    }

    // ═══ forEach honours scope + the validator rejects it on non-leaf types ═══
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', { title: 'Iter', params: [{ name: 'items' }] }, dw);
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_read', scope: r.layerKey, forEach: { overRef: 'trigger.output.items', itemVar: 'it' } }, dw);
        assert.ok(!a.error, `scoped forEach add must not error: ${a.error}`);
        assert.ok(dw.def.layers[r.layerKey].steps.some(s => s.id === a.added.id && s.forEach?.overRef === 'trigger.output.items'), 'forEach step lands inside the layer with its overRef');

        // validate.js backstop: forEach on a loop (a container) is unsupported.
        const loopDef = {
            schemaVersion: 2,
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [{ id: 'l1', type: 'loop', overRef: 'trigger.output.x', itemVar: 'i', body: [], forEach: { overRef: 'trigger.output.x', itemVar: 'i' } }],
            edges: [{ from: 'trg', to: 'l1' }],
        };
        const lv = validateDefinition(loopDef);
        assert.ok(lv.errors.some(e => e.code === 'foreach.type_unsupported'), 'forEach on a loop step is rejected by the validator');
    }

    // ═══════════════════════════════════════════════════════════════════
    // §A — in-place editing: builder_update_step / replace_step / update_steps
    //      and safe-delete reconnect.
    // ═══════════════════════════════════════════════════════════════════

    // ── update preserves id + ALL wiring; only patched fields change ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw); // then
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw);           // else
        const edgesBefore = JSON.stringify(dw.def.edges);
        const up = await applyToolCall('builder_update_step', { stepId: a1.added.id, patch: { label: 'Renamed', inputs: { q: { kind: 'literal', value: 'x' } } } }, dw);
        assert.ok(!up.error, `update must not error: ${up.error}`);
        assert.strictEqual(up.updated.id, a1.added.id, 'id unchanged by update');
        assert.strictEqual(up.updated.label, 'Renamed', 'label patched');
        assert.deepStrictEqual(up.updated.inputs.q, { kind: 'literal', value: 'x' }, 'inputs patched + validated');
        assert.strictEqual(JSON.stringify(dw.def.edges), edgesBefore, 'edges untouched by update (wiring preserved)');
    }

    // ── inputs merge (default) vs null-delete vs replace ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { q: { kind: 'literal', value: '1' }, max: { kind: 'literal', value: '2' } } }, dw);
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { inputs: { q: { kind: 'literal', value: '9' }, c: { kind: 'literal', value: '3' } } } }, dw);
        let step = dw.def.steps.find(s => s.id === a.added.id);
        assert.deepStrictEqual(Object.keys(step.inputs).sort(), ['c', 'max', 'q'], 'merge keeps untouched keys, adds new');
        assert.strictEqual(step.inputs.q.value, '9', 'merge overwrites a touched key');
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { inputs: { max: null } } }, dw);
        step = dw.def.steps.find(s => s.id === a.added.id);
        assert.ok(!('max' in step.inputs), 'value:null deletes that one key');
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { inputs: { only: { kind: 'literal', value: 'z' } } }, inputsMode: 'replace' }, dw);
        step = dw.def.steps.find(s => s.id === a.added.id);
        assert.deepStrictEqual(Object.keys(step.inputs), ['only'], 'inputsMode:replace overwrites the whole map');
    }

    // ── invalid binding in a patch is rejected with no mutation ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search', inputs: { q: { kind: 'literal', value: '1' } } }, dw);
        const before = JSON.stringify(dw.def.steps.find(s => s.id === a.added.id));
        const r = await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { inputs: { bad: { kind: 'ref', path: 'nope.field' } } } }, dw);
        assert.ok(r.error, 'bad ref root rejected');
        assert.strictEqual(JSON.stringify(dw.def.steps.find(s => s.id === a.added.id)), before, 'step unchanged on error');
    }

    // ── forEach add then clear; non-forEach-capable type rejects it ──
    {
        const dw = freshWrap();
        const search = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_read', afterStepId: search.added.id }, dw);
        const over = `steps.${search.added.id}.output.messages`;
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { forEach: { overRef: over, itemVar: 'email' } } }, dw);
        assert.deepStrictEqual(dw.def.steps.find(s => s.id === a.added.id).forEach, { overRef: over, itemVar: 'email' }, 'forEach added via patch');
        await applyToolCall('builder_update_step', { stepId: a.added.id, patch: { forEach: null } }, dw);
        assert.ok(!('forEach' in dw.def.steps.find(s => s.id === a.added.id)), 'forEach cleared via null');
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x==1', afterStepId: a.added.id }, dw);
        const bad = await applyToolCall('builder_update_step', { stepId: cond.added.id, patch: { forEach: { overRef: over } } }, dw);
        assert.ok(bad.error && /not patchable/.test(bad.error), 'forEach not patchable on a condition');
    }

    // ── non-patchable field + type change + unknown id are rejected ──
    {
        const dw = freshWrap();
        const ai = await applyToolCall('builder_add_ai_step', { prompt: 'x' }, dw);
        const r1 = await applyToolCall('builder_update_step', { stepId: ai.added.id, patch: { type: 'condition' } }, dw);
        assert.ok(r1.error && /type/.test(r1.error), 'changing type via update_step rejected');
        const r2 = await applyToolCall('builder_update_step', { stepId: ai.added.id, patch: { tool: 'gmail_search' } }, dw);
        assert.ok(r2.error && /not patchable/.test(r2.error), 'tool not patchable on ai_step');
        const r3 = await applyToolCall('builder_update_step', { stepId: 'ghost', patch: { label: 'x' } }, dw);
        assert.ok(r3.error && /Unknown stepId/.test(r3.error), 'unknown stepId rejected');
    }

    // ── replace ai_step → integration_action keeps id + incoming edge ──
    {
        const dw = freshWrap();
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const ai = await applyToolCall('builder_add_ai_step', { prompt: 'x', afterStepId: a1.added.id }, dw);
        const incomingBefore = dw.def.edges.find(e => e.to === ai.added.id);
        const rep = await applyToolCall('builder_replace_step', { stepId: ai.added.id, newType: 'integration_action', spec: { tool: 'gmail_compose' } }, dw);
        assert.ok(!rep.error, `replace must not error: ${rep.error}`);
        assert.strictEqual(rep.replaced.id, ai.added.id, 'id preserved across type swap');
        assert.strictEqual(rep.replaced.type, 'integration_action', 'type changed');
        assert.strictEqual(rep.replaced.tool, 'gmail_compose');
        assert.ok(rep.replaced.sideEffect === true, 'derived sideEffect computed on the new step');
        assert.deepStrictEqual(dw.def.edges.find(e => e.to === ai.added.id), incomingBefore, 'incoming edge intact');
        assert.strictEqual(dw.def.steps.find(s => s.id === ai.added.id).type, 'integration_action', 'node replaced in place');
    }

    // ── replace condition → notification strips now-invalid branch labels ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x==1' }, dw);
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw); // then
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw); // else
        assert.ok(dw.def.edges.some(x => x.from === cond.added.id && x.label === 'then'), 'precondition: then label present');
        const rep = await applyToolCall('builder_replace_step', { stepId: cond.added.id, newType: 'notification', spec: { title: 'hi' } }, dw);
        assert.ok(!rep.error, `replace must not error: ${rep.error}`);
        assert.ok(rep.rewired && /Stripped/.test(rep.rewired), 'rewired note reports stripped labels');
        assert.ok(dw.def.edges.filter(x => x.from === cond.added.id).every(x => x.label === undefined), 'branch labels stripped (no dead-end)');
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => e.code === 'condition.dead_branch'), 'no dead_branch after strip');
    }

    // ── replace action → condition leaves the self-correction breadcrumb ──
    {
        const dw = freshWrap();
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: a1.added.id }, dw);
        const rep = await applyToolCall('builder_replace_step', { stepId: a1.added.id, newType: 'condition', spec: { expr: 'trigger.output.x==1' } }, dw);
        assert.ok(!rep.error, `replace must not error: ${rep.error}`);
        assert.ok(rep.rewired && /branching/.test(rep.rewired), 'breadcrumb tells the agent to wire branch targets');
    }

    // ── scoped update inside a flowlet mutates the layer, not the root ──
    {
        const dw = freshWrap();
        const r = await applyToolCall('builder_create_layer', { title: 'L', params: [] }, dw);
        const a = await applyToolCall('builder_add_ai_step', { prompt: 'x', scope: r.layerKey }, dw);
        const up = await applyToolCall('builder_update_step', { stepId: a.added.id, scope: r.layerKey, patch: { prompt: 'y' } }, dw);
        assert.ok(!up.error, `scoped update must not error: ${up.error}`);
        assert.strictEqual(dw.def.layers[r.layerKey].steps.find(s => s.id === a.added.id).prompt, 'y', 'layer step patched');
        assert.ok(!dw.def.steps.some(s => s.id === a.added.id), 'root untouched by scoped update');
    }

    // ── loop-body step patch via the locator; top-level edges untouched ──
    {
        const dw = freshWrap();
        const search = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const over = `steps.${search.added.id}.output.messages`;
        const loop = await applyToolCall('builder_add_loop', { overRef: over, itemVar: 'it', afterStepId: search.added.id, body: [{ type: 'ai_step', id: 'lb1', prompt: 'a' }] }, dw);
        const edgesBefore = JSON.stringify(dw.def.edges);
        const up = await applyToolCall('builder_update_step', { stepId: 'lb1', patch: { prompt: 'b' } }, dw);
        assert.ok(!up.error, `loop-body update must not error: ${up.error}`);
        assert.strictEqual(dw.def.steps.find(s => s.id === loop.added.id).body.find(b => b.id === 'lb1').prompt, 'b', 'loop body step patched');
        assert.strictEqual(JSON.stringify(dw.def.edges), edgesBefore, 'top-level edges untouched');
    }

    // ── delete with reconnect bridges A→B→C into A→C; reconnect:false severs ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const b = await applyToolCall('builder_add_ai_step', { prompt: 'x', afterStepId: a.added.id }, dw);
        const c = await applyToolCall('builder_add_notification', { title: 't', afterStepId: b.added.id }, dw);
        const rm = await applyToolCall('builder_remove_step', { stepId: b.added.id }, dw);
        assert.ok(!rm.error, `remove must not error: ${rm.error}`);
        assert.ok(!dw.def.steps.some(s => s.id === b.added.id), 'B removed');
        assert.ok(dw.def.edges.some(e => e.from === a.added.id && e.to === c.added.id), 'A→C bridged');
        assert.ok(!dw.def.edges.some(e => e.from === b.added.id || e.to === b.added.id), 'B incident edges gone');

        const dw2 = freshWrap();
        const a2 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw2);
        const b2 = await applyToolCall('builder_add_ai_step', { prompt: 'x', afterStepId: a2.added.id }, dw2);
        const c2 = await applyToolCall('builder_add_notification', { title: 't', afterStepId: b2.added.id }, dw2);
        await applyToolCall('builder_remove_step', { stepId: b2.added.id, reconnect: false }, dw2);
        assert.ok(!dw2.def.edges.some(e => e.from === a2.added.id && e.to === c2.added.id), 'reconnect:false does not bridge');
    }

    // ── deleting a branching anchor returns a dropped-targets note ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x==1', afterStepId: a.added.id }, dw);
        await applyToolCall('builder_add_notification', { title: 't', afterStepId: cond.added.id }, dw);
        await applyToolCall('builder_add_notification', { title: 'e', afterStepId: cond.added.id }, dw);
        const rm = await applyToolCall('builder_remove_step', { stepId: cond.added.id }, dw);
        assert.ok(!rm.error, `remove must not error: ${rm.error}`);
        assert.ok(rm.note && /branching/.test(rm.note), 'branch-anchor delete returns a note about dropped branches');
        assert.ok(!dw.def.steps.some(s => s.id === cond.added.id), 'condition removed');
    }

    // ── batch update is all-or-nothing (snapshot + rollback) ──
    {
        const dw = freshWrap();
        const a = await applyToolCall('builder_add_ai_step', { prompt: 'x' }, dw);
        const b = await applyToolCall('builder_add_ai_step', { prompt: 'y', afterStepId: a.added.id }, dw);
        const r = await applyToolCall('builder_update_steps', {
            updates: [
                { stepId: a.added.id, patch: { prompt: 'A2' } },
                { stepId: b.added.id, patch: { inputs: { bad: { kind: 'ref', path: 'nope.x' } } } }, // invalid → whole batch fails
            ],
        }, dw);
        assert.ok(r.error && r._rolledBack, 'batch with one bad patch errors + rolls back');
        assert.strictEqual(dw.def.steps.find(s => s.id === a.added.id).prompt, 'x', 'first (valid) patch rolled back too');
    }

    // ═══════════════════════════════════════════════════════════════════
    // §B — progressive context: builder_inspect_tool inputs + add-action gate
    // ═══════════════════════════════════════════════════════════════════

    function gatedWrap() {
        return {
            userId: 'u_test',
            def: emptyDefinition(),
            _inputSchemasByTool: {
                gmail_compose: { type: 'object', properties: { to: { type: 'string', description: 'recipient' }, subject: { type: 'string' }, body: { type: 'string' }, cc: { type: 'string' } }, required: ['to', 'body'] },
                gmail_archive: { type: 'object', properties: { id: { type: 'string' } }, required: [] }, // 1 input, 0 required → trivial
            },
            _inspectedTools: new Set(),
        };
    }

    // ── inspect returns inputs + requiredInputs and records the tool ──
    {
        const dw = gatedWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const insp = await applyToolCall('builder_inspect_tool', { tool: 'gmail_compose' }, dw);
        assert.ok(insp.inputs && insp.inputs.to && insp.inputs.to.required === true, 'inspect returns inputs with required flags');
        assert.deepStrictEqual(insp.requiredInputs.sort(), ['body', 'to'], 'requiredInputs listed');
        assert.ok(dw._inspectedTools.has('gmail_compose'), 'inspected tool recorded for the gate');
        // unknown tool → null inputs, empty requiredInputs
        const unk = await applyToolCall('builder_inspect_tool', { tool: 'totally_unknown_tool' }, dw);
        assert.strictEqual(unk.inputs, null, 'unknown tool → inputs null');
        assert.deepStrictEqual(unk.requiredInputs, [], 'unknown tool → requiredInputs empty');
    }

    // ── gate: non-trivial add blocked without inspect; escape hatch + trivial exempt ──
    {
        const dw = gatedWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        const blocked = await applyToolCall('builder_add_action', { tool: 'gmail_compose' }, dw);
        assert.ok(blocked.error && blocked._needsInspect === 'gmail_compose', 'non-trivial add blocked without inspect');
        assert.ok(!dw.def.steps.some(s => s.type === 'integration_action'), 'no step added when blocked');
        // escape hatch: all required params already bound → allowed without inspect
        const ok = await applyToolCall('builder_add_action', { tool: 'gmail_compose', inputs: { to: { kind: 'literal', value: 'a@b.c' }, body: { kind: 'literal', value: 'hi' } } }, dw);
        assert.ok(!ok.error, `escape hatch (required bound) must allow: ${ok.error}`);
        // trivial tool (1 input, 0 required) is exempt
        const triv = await applyToolCall('builder_add_action', { tool: 'gmail_archive', afterStepId: ok.added.id }, dw);
        assert.ok(!triv.error, `trivial tool must be exempt: ${triv.error}`);
    }

    // ── gate: after inspecting, the add goes through ──
    {
        const dw = gatedWrap();
        await applyToolCall('builder_propose_trigger', { kind: 'manual' }, dw);
        await applyToolCall('builder_inspect_tool', { tool: 'gmail_compose' }, dw);
        const ok = await applyToolCall('builder_add_action', { tool: 'gmail_compose', inputs: { to: { kind: 'literal', value: 'a@b.c' }, body: { kind: 'literal', value: 'hi' } } }, dw);
        assert.ok(!ok.error, `add after inspect must succeed: ${ok.error}`);
    }

    // ── gate is a no-op when no catalog map is attached (tests / older callers) ──
    {
        const dw = freshWrap(); // no _inputSchemasByTool
        const ok = await applyToolCall('builder_add_action', { tool: 'gmail_compose' }, dw);
        assert.ok(!ok.error, 'no catalog attached → gate exempt');
    }

    // ── registration sanity: new tools wired into the mutation/scope sets ──
    {
        for (const n of ['builder_update_step', 'builder_update_steps', 'builder_replace_step']) {
            assert.ok(MUTATING_TOOLS.has(n), `${n} in MUTATING_TOOLS`);
            assert.ok(SCOPED_GRAPH_TOOLS.has(n), `${n} in SCOPED_GRAPH_TOOLS`);
        }
        const us = TOOL_SCHEMAS.find(t => t.function.name === 'builder_update_step');
        assert.ok(us && us.function.parameters.properties.scope, 'scope param injected into builder_update_step');
    }

    console.log('builderTools.test.js: all branch-wiring tests passed');
    // builderTools requires automationStore, which opens a DB pool that keeps
    // the event loop alive — exit explicitly once assertions pass.
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
