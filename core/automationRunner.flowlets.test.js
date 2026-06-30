/**
 * Unit tests for the INLINE Layers runtime in automationRunner.
 *
 * Layers live at definition.layers[<key>] (resolved via ctx.layers — no DB
 * fetch). Exercises execCallLayer's key resolution, legacy-layerId error,
 * recursion + depth guards, the layer_output contract, shared-vars
 * semantics, namespaced sub-step recording (stepId 'cl1/out' +
 * parentStepId 'cl1', nested 'cl1/cl2/out'), loop suppression, the
 * approval-inside-layer guard, and that recordRunStep still receives
 * secretValues (WS5.2) — WITHOUT a DB or any external services; heavy deps
 * are pre-mocked via the require cache.
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Capture every recordRunStep call so the sub-step recording assertions can
// inspect stepId / parentStepId / secretValues.
let recorded = [];
mock('../stores/automationStore', {
    getAutomation: async () => null,
    recordRunStep: async (row) => { recorded.push(row); },
});
// DB + service deps the runner pulls in at load time (unused by these tests).
mock('../stores/configStore', {});
mock('../stores/notificationStore', {});
mock('../db', { pool: {} });
mock('./aiAgent', { getProviderForModel: async () => null });
mock('./providers', { getAdapter: () => ({}) });
mock('../automation/codeSandbox', { run: async () => ({}) });

const runner = require('./automationRunner');

// A dispatch stub: call_layer routes back into the real execCallLayer (so
// nested layers + sub-recording work); everything else returns a fixed
// output, like the original stub did.
const dispatch = async (step, ctx, runState, mode) => {
    if (step.type === 'call_layer') {
        const r = await runner.execCallLayer(step, ctx, runState, mode, dispatch);
        r.startedAt = new Date().toISOString();
        r.inputSnapshot = null;
        return r;
    }
    return { output: { result: 42 }, startedAt: new Date().toISOString(), inputSnapshot: null };
};

function layerDef() {
    return {
        title: 'Test layer',
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'x', type: 'string' }] },
        steps: [{ id: 'out', type: 'layer_output', fields: { result: { kind: 'literal', value: 42 } } }],
        edges: [{ from: 'trg', to: 'out' }],
    };
}

function rootRecord() {
    return { prefix: '', parentStepId: null, suppress: false };
}

test.beforeEach(() => { recorded = []; });

test('execCallLayer rejects a legacy layerId reference with a migration hint', async () => {
    const step = { id: 'cl1', type: 'call_layer', layerId: 'L1', inputs: {} };
    await assert.rejects(
        () => runner.execCallLayer(step, { layers: {} }, { secrets: {} }, 'dry_run', dispatch),
        /legacy layer reference.*re-save/i,
    );
});

test('execCallLayer rejects a step with no layerKey at all', async () => {
    const step = { id: 'cl1', type: 'call_layer', inputs: {} };
    await assert.rejects(
        () => runner.execCallLayer(step, { layers: {} }, { secrets: {} }, 'dry_run', dispatch),
        /missing layerKey/i,
    );
});

test('execCallLayer rejects an unknown layerKey, listing available keys', async () => {
    const step = { id: 'cl1', type: 'call_layer', layerKey: 'nope', inputs: {} };
    const ctx = { layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    await assert.rejects(
        () => runner.execCallLayer(step, ctx, { secrets: {} }, 'dry_run', dispatch),
        /Unknown layer "nope".*enrich/s,
    );
});

test('execCallLayer rejects direct + transitive recursion (layerKey stack)', async () => {
    const step = { id: 'cl1', type: 'call_layer', layerKey: 'b', inputs: {} };
    const ctx = { layers: { a: layerDef(), b: layerDef() }, layerStack: ['a', 'b'] };
    await assert.rejects(
        () => runner.execCallLayer(step, ctx, { secrets: {} }, 'dry_run', dispatch),
        /recursion.*a → b → b/i,
    );
});

test('execCallLayer enforces the max nesting depth', async () => {
    const step = { id: 'cl1', type: 'call_layer', layerKey: 'x', inputs: {} };
    const stack = Array.from({ length: runner.MAX_LAYER_DEPTH }, (_, i) => `l${i}`);
    const ctx = { layers: { x: layerDef() }, layerStack: stack };
    await assert.rejects(
        () => runner.execCallLayer(step, ctx, { secrets: {} }, 'dry_run', dispatch),
        /depth/i,
    );
});

test('execCallLayer resolves ctx.layers, runs the mini-def, returns the layer_output contract', async () => {
    const step = {
        id: 'cl1', type: 'call_layer', layerKey: 'enrich',
        inputs: { x: { kind: 'literal', value: 'hi' } },
    };
    const ctx = { layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    const res = await runner.execCallLayer(step, ctx, { secrets: {}, vars: {} }, 'dry_run', dispatch);
    assert.deepStrictEqual(res.output, { result: 42 });
});

test('layer sub-state shares the parent vars object BY REFERENCE and maps inputs into trigger.output', async () => {
    let seenSub = null;
    const probe = async (step, ctx, runState) => {
        seenSub = runState;
        return { output: { ok: true }, startedAt: '', inputSnapshot: null };
    };
    const step = { id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: { x: { kind: 'literal', value: 'val-1' } } };
    const parentVars = { shared: 1 };
    const ctx = { layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    await runner.execCallLayer(step, ctx, { secrets: {}, vars: parentVars }, 'dry_run', probe);
    assert.ok(seenSub, 'sub-dispatch ran');
    assert.strictEqual(seenSub.vars, parentVars, 'vars must be the SAME object reference');
    assert.strictEqual(seenSub.trigger.output.x, 'val-1', 'resolved inputs land in trigger.output');
});

test('sub-step recording: stepId "cl1/out" with parentStepId "cl1"; secretValues still passed', async () => {
    const parentDef = {
        trigger: { id: 'ptrg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: {} }],
        edges: [{ from: 'ptrg', to: 'cl1' }],
    };
    const ctx = { runId: 'r1', layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    const state = { trigger: { output: {} }, steps: {}, vars: {}, secrets: { tok: 's3cr3t-value' }, loop: {} };
    await runner.runDag(parentDef, ctx, state, 'live', dispatch, { recordSteps: true });

    const ids = recorded.map(r => [r.stepId, r.parentStepId ?? null]);
    assert.deepStrictEqual(ids, [
        ['cl1/out', 'cl1'],
        ['cl1', null],
    ], `unexpected recorded rows: ${JSON.stringify(ids)}`);
    // WS5.2 — every record site must keep threading secretValues so the
    // persistence chokepoint can mask them.
    for (const r of recorded) {
        assert.ok(Array.isArray(r.secretValues), 'secretValues array present');
        assert.ok(r.secretValues.includes('s3cr3t-value'), 'in-flight secret handed to recordRunStep');
    }
});

test('nested layers record "cl1/cl2/out" with parentStepId "cl1/cl2"', async () => {
    const layerB = layerDef();
    const layerA = {
        title: 'A',
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [
            { id: 'cl2', type: 'call_layer', layerKey: 'b', inputs: {} },
            { id: 'out', type: 'layer_output', fields: { r: { kind: 'ref', path: 'steps.cl2.output.result' } } },
        ],
        edges: [{ from: 'trg', to: 'cl2' }, { from: 'cl2', to: 'out' }],
    };
    const parentDef = {
        trigger: { id: 'ptrg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'a', inputs: {} }],
        edges: [{ from: 'ptrg', to: 'cl1' }],
    };
    const ctx = { runId: 'r1', layers: { a: layerA, b: layerB }, stepRecord: rootRecord() };
    const state = { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {} };
    await runner.runDag(parentDef, ctx, state, 'live', dispatch, { recordSteps: true });

    const byId = new Map(recorded.map(r => [r.stepId, r.parentStepId ?? null]));
    assert.strictEqual(byId.get('cl1'), null);
    assert.strictEqual(byId.get('cl1/cl2'), 'cl1');
    assert.strictEqual(byId.get('cl1/cl2/out'), 'cl1/cl2');
    assert.strictEqual(byId.get('cl1/out'), 'cl1');
    assert.strictEqual(recorded.length, 4, `expected 4 rows, got ${JSON.stringify([...byId.keys()])}`);
});

test('loop suppression: a call_layer inside a loop body records NOTHING', async () => {
    const loopStep = {
        id: 'loop1', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item',
        maxIterations: 10,
        body: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich', inputs: {} }],
    };
    const ctx = { runId: 'r1', layers: { enrich: layerDef() }, stepRecord: rootRecord() };
    const state = { trigger: { output: { items: [1, 2] } }, steps: {}, vars: {}, secrets: {}, loop: {} };
    const res = await runner.execLoop(loopStep, ctx, state, 'live', dispatch);
    assert.strictEqual(res.output.iterations, 2, 'loop ran');
    assert.deepStrictEqual(res.output.results.map(r => r.output), [{ result: 42 }, { result: 42 }], 'layer output flowed back');
    assert.strictEqual(recorded.length, 0, `loop bodies stay unrecorded, got ${JSON.stringify(recorded.map(r => r.stepId))}`);
});

test('execApproval throws inside a layer (runtime backstop)', async () => {
    const step = { id: 'ap1', type: 'approval', prompt: 'ok?' };
    await assert.rejects(
        () => runner.execApproval(step, { layerStack: ['a'] }, { secrets: {} }, 'live'),
        /not supported inside layers/i,
    );
});

test('execLayerOutput resolves its fields map', async () => {
    const step = { id: 'out', type: 'layer_output', fields: { a: { kind: 'literal', value: 7 } } };
    const res = await runner.execLayerOutput(step, {}, { secrets: {} });
    assert.deepStrictEqual(res.output, { a: 7 });
});
