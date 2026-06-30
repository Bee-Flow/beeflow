/**
 * Unit tests for WS5.4 — collection-op input caps + secretValues threading
 * into step recording.
 *
 * Exercises resolveArrayRef's cap (via the exported execFilter/execDedupe),
 * the on_error routing of the structured 'collection_too_large' error through
 * runDag, secretValues on the runDag record sites, and an end-to-end
 * executeAutomation run hitting the dispatchStep catch-side record site —
 * WITHOUT a DB or external services. Heavy deps are pre-mocked via the
 * require cache before the runner is required (same approach as
 * automationRunner.flowlets.test.js).
 *
 * Run: node core/automationRunner.collectioncap.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Must be set BEFORE the runner is required — the cap is read at load time.
// A small cap keeps the test arrays cheap while proving the env knob works.
process.env.AUTOMATION_COLLECTION_MAX_ITEMS = '500';

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Captured recordRunStep payloads + run updates, reset per test.
let recorded = [];
let runUpdates = [];

mock('../stores/automationStore', {
    createRun: async (o) => ({ id: 'run-e2e', ...o }),
    updateRun: async (id, updates) => { runUpdates.push(updates); return true; },
    markRunning: async () => {},
    recordRunStep: async (rec) => { recorded.push(rec); },
    updateAutomation: async () => true,
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    getRun: async (id) => ({ id, cancelRequested: false }),
    requestCancelRun: async () => null,
    getAutomation: async () => null,
});
mock('../stores/configStore', { getConfig: async () => null });
mock('../stores/notificationStore', { createNotification: async () => {} });
mock('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
mock('../db', { pool: { query: async () => ({ rows: [] }) } });
mock('./aiAgent', { getProviderForModel: async () => null });
mock('./providers', { getAdapter: () => ({}) });
mock('./routineAuth', { buildUserAuth: async () => null });
mock('../auth/audience', { resolveUserGroups: async () => [] });
mock('../automation/codeSandbox', { run: async () => ({}) });

const runner = require('./automationRunner');
const { validateDefinition } = require('../automation/validate');

const CAP = 500;
const items = (n) => Array.from({ length: n }, (_, i) => ({ i }));
const TOO_LARGE_MSG = (n, max) => `Collection op input has ${n} items (max ${max}). Add a filter/limit step upstream or raise AUTOMATION_COLLECTION_MAX_ITEMS.`;

function stateWith(arr, secrets = {}) {
    return {
        trigger: { output: {} },
        steps: { src: { output: { items: arr }, status: 'success' } },
        vars: {},
        secrets,
        loop: {},
    };
}

test('env knob applied at load time', () => {
    assert.strictEqual(runner.COLLECTION_OP_MAX_ITEMS, CAP);
});

test('array over the cap throws collection_too_large with the exact message', async () => {
    const step = { id: 'f1', type: 'filter', arrayRef: 'steps.src.output.items', expr: 'true' };
    await assert.rejects(
        () => runner.execFilter(step, {}, stateWith(items(CAP + 1))),
        (err) => {
            assert.strictEqual(err.errorClass, 'collection_too_large');
            assert.strictEqual(err.message, TOO_LARGE_MSG(CAP + 1, CAP));
            return true;
        },
    );
});

test('cap-1 (and exactly cap) pass through', async () => {
    const step = { id: 'f1', type: 'filter', arrayRef: 'steps.src.output.items', expr: 'true' };
    const r1 = await runner.execFilter(step, {}, stateWith(items(CAP - 1)));
    assert.strictEqual(r1.output.count, CAP - 1);
    const r2 = await runner.execFilter(step, {}, stateWith(items(CAP)));
    assert.strictEqual(r2.output.count, CAP);
});

test('step.maxItems tightens the cap', async () => {
    const step = { id: 'f1', type: 'filter', arrayRef: 'steps.src.output.items', expr: 'true', maxItems: 100 };
    await assert.rejects(
        () => runner.execFilter(step, {}, stateWith(items(101))),
        (err) => err.errorClass === 'collection_too_large' && err.message === TOO_LARGE_MSG(101, 100),
    );
    const ok = await runner.execFilter(step, {}, stateWith(items(100)));
    assert.strictEqual(ok.output.count, 100);
});

test('step.maxItems cannot raise the cap above the global ceiling', async () => {
    const step = { id: 'f1', type: 'filter', arrayRef: 'steps.src.output.items', expr: 'true', maxItems: 10_000 };
    await assert.rejects(
        () => runner.execFilter(step, {}, stateWith(items(CAP + 1))),
        (err) => err.errorClass === 'collection_too_large' && err.message === TOO_LARGE_MSG(CAP + 1, CAP),
    );
});

test('malformed maxItems is ignored (platform cap still applies)', async () => {
    for (const bad of [0, -5, '50', NaN]) {
        const step = { id: 'f1', type: 'filter', arrayRef: 'steps.src.output.items', expr: 'true', maxItems: bad };
        const ok = await runner.execFilter(step, {}, stateWith(items(60)));
        assert.strictEqual(ok.output.count, 60, `maxItems=${bad} should fall back to the platform cap`);
        await assert.rejects(
            () => runner.execFilter(step, {}, stateWith(items(CAP + 1))),
            (err) => err.errorClass === 'collection_too_large',
        );
    }
});

test('dedupe shares the same capped entry point', async () => {
    const step = { id: 'd1', type: 'dedupe', arrayRef: 'steps.src.output.items' };
    await assert.rejects(
        () => runner.execDedupe(step, {}, stateWith(items(CAP + 1))),
        (err) => err.errorClass === 'collection_too_large',
    );
});

// ── runDag wiring: on_error routing + secretValues on record sites ──────

const SECRETS = { A: 'sk-secret-A', EMPTY: '', NUM: 42, B: 'tok-B' };
const EXPECTED_SECRET_VALUES = ['sk-secret-A', 'tok-B'];

function capDef() {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'f1', type: 'filter', arrayRef: 'vars.items', expr: 'true' },
            { id: 'h1', type: 'set', fields: {} },
            { id: 's1', type: 'set', fields: {} },
        ],
        edges: [
            { from: 'trg', to: 'f1' },
            { from: 'f1', to: 'h1', label: 'on_error' },
            { from: 'f1', to: 's1', label: 'on_success' },
        ],
    };
}

// Dispatch stub: filter runs the REAL capped handler; set is a no-op marker.
const dispatch = async (step, ctx, state) => {
    if (step.type === 'filter') {
        const r = await runner.execFilter(step, ctx, state);
        return { ...r, startedAt: '', inputSnapshot: null };
    }
    return { output: { ran: step.id }, startedAt: '', inputSnapshot: null };
};

function dagState(arr) {
    return { trigger: { output: {} }, steps: {}, vars: { items: arr }, secrets: { ...SECRETS }, loop: {}, _templateWarnings: [] };
}

test('cap breach routes the on_error edge and records the error row with secretValues', async () => {
    recorded = [];
    await runner.runDag(capDef(), { runId: 'r1' }, dagState(items(CAP + 1)), 'live', dispatch);
    const errRow = recorded.find(r => r.stepId === 'f1');
    assert.ok(errRow, 'f1 error row recorded');
    assert.strictEqual(errRow.status, 'error');
    assert.strictEqual(errRow.errorClass, 'collection_too_large');
    assert.strictEqual(errRow.error, TOO_LARGE_MSG(CAP + 1, CAP));
    assert.deepStrictEqual(errRow.secretValues, EXPECTED_SECRET_VALUES);
    // Error branch ran; success branch did not.
    const h1 = recorded.find(r => r.stepId === 'h1');
    assert.ok(h1, 'on_error branch dispatched');
    assert.strictEqual(h1.status, 'success');
    assert.deepStrictEqual(h1.secretValues, EXPECTED_SECRET_VALUES);
    assert.ok(!recorded.some(r => r.stepId === 's1'), 'on_success branch must not run');
});

test('under the cap the success path runs and rows carry secretValues', async () => {
    recorded = [];
    await runner.runDag(capDef(), { runId: 'r2' }, dagState(items(CAP - 1)), 'live', dispatch);
    const f1 = recorded.find(r => r.stepId === 'f1');
    assert.strictEqual(f1.status, 'success');
    assert.deepStrictEqual(f1.secretValues, EXPECTED_SECRET_VALUES);
    assert.ok(recorded.some(r => r.stepId === 's1'), 'success branch ran');
    assert.ok(!recorded.some(r => r.stepId === 'h1'), 'error branch must not run');
});

test('secrets populated mid-run are picked up by later record sites', async () => {
    recorded = [];
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [{ id: 'a', type: 'set', fields: {} }, { id: 'b', type: 'set', fields: {} }],
        edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }],
    };
    const lateDispatch = async (step, ctx, state) => {
        if (step.id === 'a') state.secrets.LATE = 'late-secret';
        return { output: { ran: step.id }, startedAt: '', inputSnapshot: null };
    };
    await runner.runDag(def, { runId: 'r3' }, dagState([]), 'live', lateDispatch);
    const b = recorded.find(r => r.stepId === 'b');
    assert.ok(b.secretValues.includes('late-secret'), 'late secret threads into later rows');
});

test('without an on_error edge the structured error bubbles out of runDag', async () => {
    recorded = [];
    const def = capDef();
    def.edges = def.edges.filter(e => e.label !== 'on_error');
    await assert.rejects(
        () => runner.runDag(def, { runId: 'r4' }, dagState(items(CAP + 1)), 'live', dispatch),
        (err) => err.errorClass === 'collection_too_large',
    );
});

// ── End-to-end: executeAutomation hits the dispatchStep catch-side site ─

test('executeAutomation records the catch-side error row and fails the run with collection_too_large', async () => {
    recorded = [];
    runUpdates = [];
    const automation = {
        id: 'auto-1',
        userId: 'u1',
        version: 1,
        title: 'cap e2e',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'f1', type: 'filter', arrayRef: 'trigger.output.items', expr: 'true' }],
            edges: [{ from: 'trg', to: 'f1' }],
        },
    };
    const run = await runner.executeAutomation(automation, {
        triggerKind: 'manual',
        triggerPayload: { items: items(CAP + 1) },
        mode: 'live',
    });
    assert.ok(run, 'returns the run row');
    const errRow = recorded.find(r => r.stepId === 'f1' && r.status === 'error');
    assert.ok(errRow, 'catch-side error row recorded');
    assert.strictEqual(errRow.errorClass, 'collection_too_large');
    assert.strictEqual(errRow.error, TOO_LARGE_MSG(CAP + 1, CAP));
    assert.ok(Array.isArray(errRow.secretValues), 'secretValues threads through the dispatch catch');
    const final = runUpdates.find(u => u.errorClass);
    assert.ok(final, 'final run update carries the error class');
    assert.strictEqual(final.status, 'error');
    assert.strictEqual(final.errorClass, 'collection_too_large');
});

// ── validate.js: optional maxItems shape check ──────────────────────────

function defWithMaxItems(maxItems) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'f1', type: 'filter', arrayRef: 'trigger.output.items', expr: 'true', ...(maxItems !== undefined ? { maxItems } : {}) }],
        edges: [{ from: 'trg', to: 'f1' }],
    };
}

test('validate: maxItems is optional and a positive integer passes', () => {
    assert.strictEqual(validateDefinition(defWithMaxItems(undefined)).ok, true);
    const r = validateDefinition(defWithMaxItems(250));
    assert.strictEqual(r.ok, true);
    assert.ok(!r.warnings.some(w => w.code === 'filter.maxItems_exceeds_cap'));
});

test('validate: non-positive / non-integer maxItems is an error', () => {
    for (const bad of [0, -1, 1.5, '100', true]) {
        const r = validateDefinition(defWithMaxItems(bad));
        assert.strictEqual(r.ok, false, `maxItems=${bad} should fail validation`);
        assert.ok(r.errors.some(e => e.code === 'filter.maxItems_invalid'), `expected filter.maxItems_invalid for ${bad}`);
    }
});

test('validate: maxItems above 10000 warns but does not block', () => {
    const r = validateDefinition(defWithMaxItems(20_000));
    assert.strictEqual(r.ok, true);
    assert.ok(r.warnings.some(w => w.code === 'filter.maxItems_exceeds_cap'));
});

test('validate: maxItems checked on every collection op type', () => {
    const base = { trigger: { id: 'trg', kind: 'manual' }, edges: [{ from: 'trg', to: 's1' }] };
    const shapes = {
        filter: { expr: 'true' },
        limit: { count: 5 },
        dedupe: {},
        aggregate: { field: 'x' },
        summarize: { field: 'x', op: 'sum' },
    };
    for (const [type, extra] of Object.entries(shapes)) {
        const def = { ...base, steps: [{ id: 's1', type, arrayRef: 'trigger.output.items', maxItems: -1, ...extra }] };
        const r = validateDefinition(def);
        assert.ok(r.errors.some(e => e.code === `${type}.maxItems_invalid`), `expected ${type}.maxItems_invalid`);
    }
});
