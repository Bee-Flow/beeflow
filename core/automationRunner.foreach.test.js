/**
 * Unit tests for per-step iteration ("run once per item") — `step.forEach`.
 *
 * Exercises execForEachStep directly (with a stubbed leaf dispatcher) plus
 * the validate.js forEach rules. No DB / external services — heavy deps are
 * pre-mocked via the require cache before the runner is required (same
 * approach as automationRunner.collectioncap.test.js).
 *
 * Run: node --test core/automationRunner.foreach.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Read at runner load time — keep it small so the cap test arrays are cheap.
process.env.AUTOMATION_COLLECTION_MAX_ITEMS = '50';

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../stores/automationStore', {
    createRun: async (o) => ({ id: 'run', ...o }),
    updateRun: async () => true,
    markRunning: async () => {},
    recordRunStep: async () => {},
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
const { execForEachStep, ApprovalRequiredError, COLLECTION_OP_MAX_ITEMS } = runner;

const CAP = 50;

// State holding an upstream array at steps.src.output.results.
function stateWith(results) {
    return {
        trigger: { output: {} },
        steps: { src: { output: { query: 'q', total: results.length, results }, status: 'success' } },
        vars: {},
        secrets: {},
        loop: {},
    };
}

const emails = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, subject: `s${i}` }));

// A leaf step that reads loop.<itemVar>.id — proves the per-item binding
// context is live. Returns { got, idx } so we can assert per iteration.
const readIdStep = (extra = {}) => ({
    id: 's1',
    type: 'integration_action',
    tool: 'gmail_read_attachment',
    forEach: { overRef: 'steps.src.output.results', itemVar: 'result', maxIterations: 100 },
    inputs: { messageId: { kind: 'ref', path: 'loop.result.id' } },
    ...extra,
});

// Stub leaf dispatcher: echoes the per-item loop context the runner set up.
const echoLeaf = async (step, ctx, state) => ({
    output: { got: state.loop.result.id, idx: state.loop._index },
});

test('runs the leaf once per array element with loop.<itemVar> bound', async () => {
    const step = readIdStep();
    const r = await execForEachStep(step, {}, stateWith(emails(3)), 'live', echoLeaf);
    assert.strictEqual(r.output.iterations, 3);
    assert.strictEqual(r.output.succeeded, 3);
    assert.strictEqual(r.output.failed, 0);
    assert.strictEqual(r.output.results.length, 3);
    r.output.results.forEach((res, i) => {
        assert.strictEqual(res.status, 'success');
        assert.strictEqual(res.index, i);
        assert.strictEqual(res.item.id, `m${i}`);
        assert.strictEqual(res.output.got, `m${i}`, 'leaf saw loop.result.id for this item');
        assert.strictEqual(res.output.idx, i, 'loop._index is set per iteration');
    });
});

test('per-item failures are collected (continue-on-error), step does not throw', async () => {
    const step = readIdStep();
    const failOnSecond = async (s, ctx, state) => {
        if (state.loop._index === 1) {
            const e = new Error('attachment not found');
            e.errorClass = 'tool_error';
            throw e;
        }
        return { output: { got: state.loop.result.id } };
    };
    const r = await execForEachStep(step, {}, stateWith(emails(3)), 'live', failOnSecond);
    assert.strictEqual(r.output.iterations, 3);
    assert.strictEqual(r.output.succeeded, 2);
    assert.strictEqual(r.output.failed, 1);
    const bad = r.output.results[1];
    assert.strictEqual(bad.status, 'error');
    assert.strictEqual(bad.error, 'attachment not found');
    assert.strictEqual(bad.errorClass, 'tool_error');
    assert.strictEqual(bad.item.id, 'm1');
    // Surrounding items still succeeded.
    assert.strictEqual(r.output.results[0].status, 'success');
    assert.strictEqual(r.output.results[2].status, 'success');
});

test('errorClass falls back to classifyUnknownError when the leaf omits one', async () => {
    const step = readIdStep();
    // §WS2.5 — a forEach where every item fails now THROWS (all-failed is a real
    // step failure, no longer a green success). The per-item errorClass fallback
    // is still applied and is carried on err.foreachResults.
    await assert.rejects(
        () => execForEachStep(step, {}, stateWith(emails(1)), 'live', async () => { throw new Error('boom'); }),
        (err) => {
            assert.strictEqual(err.errorClass, 'foreach_all_failed');
            assert.strictEqual(err.foreachResults.length, 1);
            assert.ok(typeof err.foreachResults[0].errorClass === 'string' && err.foreachResults[0].errorClass.length > 0);
            return true;
        },
    );
});

test('§WS2.5 — all items failing throws foreach_all_failed; a partial failure does not', async () => {
    const step = readIdStep();
    // All fail → throw.
    await assert.rejects(
        () => execForEachStep(step, {}, stateWith(emails(3)), 'live', async () => { throw new Error('nope'); }),
        (err) => { assert.strictEqual(err.errorClass, 'foreach_all_failed'); assert.strictEqual(err.foreachResults.length, 3); return true; },
    );
    // Partial failure (1 of 2) → fulfilled, continue-on-error.
    let n = 0;
    const failFirst = async () => { n++; if (n === 1) throw new Error('first'); return { output: { ok: true } }; };
    const r = await execForEachStep(step, {}, stateWith(emails(2)), 'live', failFirst);
    assert.strictEqual(r.output.failed, 1);
    assert.strictEqual(r.output.succeeded, 1);
});

test('§WS2.5 — step.retry is applied per item (a flaky item succeeds on retry)', async () => {
    const step = readIdStep({ retry: { max: 2, backoffMs: 0 } });
    const attemptsByItem = {};
    // Each item fails once then succeeds on its first retry.
    const flaky = async (_s, _c, state) => {
        const id = state.loop.result.id;
        attemptsByItem[id] = (attemptsByItem[id] || 0) + 1;
        if (attemptsByItem[id] < 2) throw new Error('flaky');
        return { output: { id } };
    };
    const r = await execForEachStep(step, {}, stateWith(emails(2)), 'live', flaky);
    assert.strictEqual(r.output.failed, 0);
    assert.strictEqual(r.output.succeeded, 2);
    // Two attempts per item (1 fail + 1 retry success).
    assert.strictEqual(attemptsByItem.m0, 2);
    assert.strictEqual(attemptsByItem.m1, 2);
});

test('non-array overRef yields a skipped marker, never throws', async () => {
    const step = readIdStep({ forEach: { overRef: 'steps.src.output.total', itemVar: 'result' } });
    const r = await execForEachStep(step, {}, stateWith(emails(2)), 'live', echoLeaf);
    assert.strictEqual(r.output.iterations, 0);
    assert.deepStrictEqual(r.output.results, []);
    assert.match(r.output.skipped, /did not resolve to an array/);
});

test('maxIterations caps how many items run', async () => {
    const step = readIdStep({ forEach: { overRef: 'steps.src.output.results', itemVar: 'result', maxIterations: 2 } });
    const r = await execForEachStep(step, {}, stateWith(emails(5)), 'live', echoLeaf);
    assert.strictEqual(r.output.iterations, 2);
    assert.strictEqual(r.output.results.length, 2);
});

test('an array over the hard ceiling throws collection_too_large (fail loud, do not fan out)', async () => {
    assert.strictEqual(COLLECTION_OP_MAX_ITEMS, CAP);
    const step = readIdStep();
    await assert.rejects(
        () => execForEachStep(step, {}, stateWith(emails(CAP + 1)), 'live', echoLeaf),
        (err) => {
            assert.strictEqual(err.errorClass, 'collection_too_large');
            assert.match(err.message, /forEach input has 51 items \(max 50\)/);
            return true;
        },
    );
});

test('checkCancel is honoured between items and stops the fan-out promptly', async () => {
    const step = readIdStep();
    let calls = 0;
    const ran = [];
    const checkCancel = async () => { if (calls++ >= 2) throw new Error('Run cancelled'); };
    const trackingLeaf = async (s, ctx, state) => { ran.push(state.loop._index); return { output: {} }; };
    await assert.rejects(
        () => execForEachStep(step, {}, stateWith(emails(5)), 'live', trackingLeaf, checkCancel),
        (err) => err.message === 'Run cancelled',
    );
    // Items 0 and 1 ran; the 3rd checkCancel (index 2) aborts before item 2.
    assert.deepStrictEqual(ran, [0, 1]);
});

test('cancellation and approval propagate — never collected as a per-item error', async () => {
    const step = readIdStep();
    await assert.rejects(
        () => execForEachStep(step, {}, stateWith(emails(2)), 'live', async () => { throw new Error('Run cancelled'); }),
        (err) => err.message === 'Run cancelled',
    );
    await assert.rejects(
        () => execForEachStep(step, {}, stateWith(emails(2)), 'live', async () => { throw new ApprovalRequiredError('need approval'); }),
        (err) => err instanceof ApprovalRequiredError,
    );
});

// ── validate.js: forEach shape rules ────────────────────────────────────

function defWith(stepPatch) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'src', type: 'integration_action', tool: 'gmail_search', inputs: {} },
            { id: 's1', type: 'integration_action', tool: 'gmail_read_attachment', inputs: { messageId: { kind: 'ref', path: 'loop.result.id' } }, ...stepPatch },
        ],
        edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 's1' }],
    };
}

test('validate: a well-formed forEach passes', () => {
    const r = validateDefinition(defWith({ forEach: { overRef: 'steps.src.output.results', itemVar: 'result', maxIterations: 100 } }));
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
});

test('validate: forEach missing overRef / itemVar are errors', () => {
    const r1 = validateDefinition(defWith({ forEach: { itemVar: 'result' } }));
    assert.ok(r1.errors.some(e => e.code === 'foreach.overRef_missing'));
    const r2 = validateDefinition(defWith({ forEach: { overRef: 'steps.src.output.results' } }));
    assert.ok(r2.errors.some(e => e.code === 'foreach.itemVar_missing'));
});

test('validate: forEach maxIterations out of range is an error', () => {
    for (const bad of [0, 1001, -5]) {
        const r = validateDefinition(defWith({ forEach: { overRef: 'steps.src.output.results', itemVar: 'result', maxIterations: bad } }));
        assert.ok(r.errors.some(e => e.code === 'foreach.max_iterations_range'), `maxIterations=${bad} should fail`);
    }
});

test('validate: forEach on a control/container type is rejected', () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'c1', type: 'condition', expr: 'true', forEach: { overRef: 'steps.x.output.results', itemVar: 'i' } },
            { id: 't', type: 'set', fields: {} },
            { id: 'e', type: 'set', fields: {} },
        ],
        edges: [{ from: 'trg', to: 'c1' }, { from: 'c1', to: 't', label: 'then' }, { from: 'c1', to: 'e', label: 'else' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'foreach.type_unsupported'), JSON.stringify(r.errors.map(e => e.code)));
});

test('validate: non-object forEach is rejected', () => {
    const r = validateDefinition(defWith({ forEach: 'steps.src.output.results' }));
    assert.ok(r.errors.some(e => e.code === 'foreach.shape'));
});
