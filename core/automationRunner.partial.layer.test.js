/**
 * Regression test for runPartial() when the targeted step lives INSIDE a
 * flowlet/layer (definition.layers[*]) rather than the root graph.
 *
 * Before the fix, "Execute step" on a node inside a flowlet threw
 *   `runPartial: step <id> not found in definition`
 * because runPartial only searched def.trigger + def.steps. Now it locates the
 * step inside the layer and runs the LAYER's own sub-graph in isolation with
 * the step as the partial-run target.
 *
 * Pure in-process `set` / `layer_output` steps (binding resolution only) keep
 * this deterministic — no LLM / tool / sandbox / DB.
 *
 * Run: node --test core/automationRunner.partial.layer.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── In-memory automationStore stub ────────────────────────────────────────
const runs = new Map();          // runId -> run row
const runStepsByRun = new Map(); // runId -> [step row]
let runSeq = 0;

function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId }) {
    const id = `run-${++runSeq}`;
    const row = {
        id, automationId, version, userId, triggerKind,
        triggerPayload: triggerPayload || null, mode, status: 'queued',
        startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
        error: null, summary: null, parentRunId: parentRunId ?? null,
        cancelRequested: false, awaitingStepId: null, approvalToken: null,
        awaitingStepExpiresAt: null, errorClass: null, handledErrorCount: 0,
    };
    runs.set(id, row);
    runStepsByRun.set(id, []);
    return row;
}

const storeStub = {
    initDB: async () => {},
    createRun: async (args) => makeRun(args),
    getRun: async (id) => runs.get(id) || null,
    updateRun: async (id, updates) => {
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    // Most-recently-created run for this automation first — lets a test seed a
    // "prior run" whose recorded call_layer input becomes the layer's input.
    getRunsForAutomation: async (automationId, { limit = 50 } = {}) =>
        [...runs.values()]
            .filter(r => r.automationId === automationId)
            .reverse()
            .slice(0, limit),
    getRunSteps: async (runId) => (runStepsByRun.get(runId) || []).slice(),
    recordRunStep: async (rec) => {
        const list = runStepsByRun.get(rec.runId);
        if (!list) return;
        const existing = list.find(s => s.stepId === rec.stepId && s.attempts === (rec.attempts ?? 1));
        const row = {
            runId: rec.runId,
            stepId: rec.stepId,
            parentStepId: rec.parentStepId ?? null,
            stepType: rec.stepType,
            attempts: rec.attempts ?? 1,
            status: rec.status,
            startedAt: rec.startedAt ?? null,
            finishedAt: rec.finishedAt ?? null,
            input: rec.input ?? null,
            output: rec.output ?? null,
            error: rec.error ?? null,
            errorClass: rec.errorClass ?? null,
            branchIndex: rec.branchIndex ?? null,
        };
        if (existing) Object.assign(existing, row);
        else list.push(row);
    },
    markRunning: async () => {},
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => {},
    requestCancelRun: async () => null,
};

function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stub('../stores/automationStore', storeStub);
stub('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
stub('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
stub('../stores/notificationStore', { createNotification: async () => {} });
// Heavy load-time deps the runner pulls in. Mocking them (as the flowlets test
// does) keeps the process from holding open a DB pool / pricing-fetch interval,
// so `node --test` can exit. The `set` / `layer_output` steps under test live
// inside the runner itself and don't touch any of these.
stub('../db', { pool: {} });
stub('./aiAgent', { getProviderForModel: async () => null });
stub('./providers', { getAdapter: () => ({}) });
stub('../automation/codeSandbox', { run: async () => ({}) });

process.env.ROUTINE_AUTH_LEGACY = '0';
process.env.NODE_ENV = 'test';

const runner = require('./automationRunner');

// Root: trigger → cl1 (call_layer 'L1'). Layer L1: layer_input → A (echoes the
// input field) → layer_output. The AI-step bug in the field maps onto step 'A'.
function automationWithLayer() {
    return {
        id: 'auto-1',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'Layer partial run',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [
                { id: 'cl1', type: 'call_layer', layerKey: 'L1', inputs: { x: { kind: 'literal', value: 'root-val' } } },
            ],
            edges: [{ from: 'trig', to: 'cl1' }],
            layers: {
                L1: {
                    title: 'Enrich',
                    trigger: { id: 'li1', type: 'trigger', kind: 'layer_input', params: [{ name: 'x', type: 'string' }] },
                    steps: [
                        { id: 'A', type: 'set', fields: { echoed: { kind: 'ref', path: 'trigger.output.x' } } },
                        { id: 'out', type: 'layer_output', fields: { result: { kind: 'ref', path: 'steps.A.output.echoed' } } },
                    ],
                    edges: [{ from: 'li1', to: 'A' }, { from: 'A', to: 'out' }],
                },
            },
        },
    };
}

function reset() { runs.clear(); runStepsByRun.clear(); runSeq = 0; }

test('runPartial(only) on a step inside a flowlet executes it (no "not found" error)', async () => {
    reset();
    const automation = automationWithLayer();
    // Explicit payload stands in for the layer_input — same as passing a
    // triggerPayload through the /steps/:id/run route.
    const result = await runner.runPartial(automation, 'A', { mode: 'only', triggerPayload: { x: 99 } });

    assert.ok(result, 'returns a finished run row');
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const steps = await storeStub.getRunSteps(result.id);
    const a = steps.find(s => s.stepId === 'A');
    assert.ok(a, 'the layer step A was recorded under its bare id (inspector can find it)');
    assert.strictEqual(a.status, 'success', 'A succeeded');
    assert.deepStrictEqual(a.output, { echoed: 99 }, 'A resolved against the seeded layer input');
});

test('runPartial(only) seeds the layer input from a prior run\'s call_layer input', async () => {
    reset();
    const automation = automationWithLayer();

    // Seed a prior run whose recorded call_layer step carries the input the
    // layer was last invoked with. runPartial should reuse it as the input.
    const prior = makeRun({ automationId: 'auto-1', version: 1, userId: 'user-1', triggerKind: 'manual', mode: 'live' });
    await storeStub.recordRunStep({
        runId: prior.id, stepId: 'cl1', stepType: 'call_layer', attempts: 1, status: 'success',
        input: { x: 'from-prior-run' }, output: { result: 'from-prior-run' },
    });

    const result = await runner.runPartial(automation, 'A', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const steps = await storeStub.getRunSteps(result.id);
    const a = steps.find(s => s.stepId === 'A');
    assert.ok(a, 'A recorded');
    assert.deepStrictEqual(a.output, { echoed: 'from-prior-run' }, 'A used the prior call_layer input');
});

test('runPartial(only) on the flowlet input synthesizes a trigger-only run', async () => {
    reset();
    const automation = automationWithLayer();
    const result = await runner.runPartial(automation, 'li1', { mode: 'only', triggerPayload: { x: 'seed' } });

    assert.strictEqual(result.status, 'success', `run status (got ${result.status})`);
    assert.deepStrictEqual(result.output, { x: 'seed' }, 'the input payload is the output');

    const steps = await storeStub.getRunSteps(result.id);
    const li = steps.find(s => s.stepId === 'li1');
    assert.ok(li, 'flowlet input recorded');
    assert.strictEqual(li.stepType, 'trigger', 'recorded as a trigger step');
});

test('runPartial still throws for a genuinely unknown step id', async () => {
    reset();
    const automation = automationWithLayer();
    await assert.rejects(
        () => runner.runPartial(automation, 'does-not-exist', { mode: 'only' }),
        /not found in definition/i,
    );
});
