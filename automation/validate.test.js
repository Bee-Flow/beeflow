/**
 * Unit tests for the structured automation validator.
 *
 * Run: node automation/validate.test.js
 *
 * No DB needed — validator is a pure function over a definition object.
 */

const assert = require('assert');
const { validateDefinition } = require('./validate');

function trigger() {
    return { id: 'trg', kind: 'manual' };
}

// ── Smoke: empty graph (just a trigger) is valid ────────────────────────
{
    const def = { trigger: trigger(), steps: [], edges: [] };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'empty graph should validate');
    assert.deepStrictEqual(r.errors, [], 'no errors expected');
}

// ── Records carry the structured shape (code/severity/path/message/hint) ─
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'condition' }], edges: [{ from: 'trg', to: 's1' }] };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'condition without expr is an error');
    const rec = r.errors.find(e => e.code === 'condition.expr_missing');
    assert.ok(rec, 'expected condition.expr_missing record');
    assert.strictEqual(rec.severity, 'error');
    assert.ok(rec.path.includes('s1'), 'path includes step id');
    assert.ok(typeof rec.message === 'string' && rec.message.length > 0, 'has message');
    assert.ok(typeof rec.hint === 'string' && rec.hint.length > 0, 'has hint');
}

// ── Condition with no edges → ERROR (was a warning before) ───────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'c1', type: 'condition', expr: 'true' }],
        edges: [{ from: 'trg', to: 'c1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'dead-branch condition must block');
    const rec = r.errors.find(e => e.code === 'condition.dead_branch');
    assert.ok(rec, 'expected condition.dead_branch error record');
}

// ── Condition with only one branch wired → WARNING (still ok) ────────────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'c1', type: 'condition', expr: 'true' },
            { id: 'n1', type: 'notification', title: 'hi' },
        ],
        edges: [
            { from: 'trg', to: 'c1' },
            { from: 'c1', to: 'n1', label: 'then' },
        ],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'partial branch is just a warning');
    const w = r.warnings.find(x => x.code === 'condition.partial_branch');
    assert.ok(w, 'expected partial_branch warning record');
}

// ── Cycle detection still works ──────────────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'a', type: 'notification', title: 'a' },
            { id: 'b', type: 'notification', title: 'b' },
        ],
        edges: [
            { from: 'trg', to: 'a' },
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
        ],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.find(e => e.code === 'graph.cycle'), 'expected graph.cycle');
}

// ── Unknown step type produces a stable code ─────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'wat' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.find(e => e.code === 'step.unknown_type'));
}

// ── Forward ref to a real step still warns (not error) ──────────────────
// "future" step EXISTS in the def but appears after `n1` in topo order.
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'n1', type: 'notification', title: 'using {{steps.future.output.x}}' },
            { id: 'future', type: 'notification', title: 'placeholder' },
        ],
        edges: [{ from: 'trg', to: 'n1' }, { from: 'n1', to: 'future' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'forward refs to real steps only warn');
    assert.ok(r.warnings.find(w => w.code === 'ref.forward'), 'expected ref.forward warning');
}

// ── Ref to a step that DOESN'T exist → error with did-you-mean hint ─────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'a_4a3d50', type: 'notification', title: 'real step' },
            { id: 'n1', type: 'notification', title: 'using {{steps.step_1.output.x}}' },
        ],
        edges: [{ from: 'trg', to: 'a_4a3d50' }, { from: 'a_4a3d50', to: 'n1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'unknown-step ref must error');
    const rec = r.errors.find(e => e.code === 'ref.unknown_step');
    assert.ok(rec, 'expected ref.unknown_step record');
    assert.ok(/a_4a3d50/.test(rec.hint), `hint must surface the real id, got: ${rec.hint}`);
}

// ── position: optional but must be {x, y} numbers when present ──────────
{
    const def = {
        trigger: { id: 'trg', kind: 'manual', position: { x: 12, y: 34 } },
        steps: [{ id: 's1', type: 'notification', title: 'hi', position: { x: 100, y: 200 } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'valid positions should pass');
}
{
    const def = {
        trigger: { id: 'trg', kind: 'manual', position: { x: 'NaN', y: 0 } },
        steps: [], edges: [],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'non-numeric x must error');
    assert.ok(r.errors.some(e => e.code === 'position.coord'), 'expected position.coord error');
}
{
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 's1', type: 'notification', title: 'hi', position: 'left' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'non-object position must error');
    assert.ok(r.errors.some(e => e.code === 'position.shape'), 'expected position.shape error');
}

// ── n8n-style utility nodes ─────────────────────────────────────────────
//
// One pass + one fail case per new step type. We don't exhaustively cover
// every per-op variant of datetime — the validator's per-op checks are
// straightforward and additional coverage would just rehash the validator's
// own enum lists.

// set: passes when fields is omitted; fails when fields is non-object.
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'set', fields: { name: { kind: 'literal', value: 'Alice' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'set with valid fields should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'set', fields: 'not-an-object' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'set with non-object fields must error');
    assert.ok(r.errors.some(e => e.code === 'set.fields_shape'), 'expected set.fields_shape error');
}

// datetime
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'datetime', op: 'now' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'datetime op:now should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'datetime', op: 'addDays', input: 'trigger.output.t' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'addDays without amount must error');
    assert.ok(r.errors.some(e => e.code === 'datetime.amount_missing'));
}

// wait
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'wait', seconds: 5 }], edges: [{ from: 'trg', to: 's1' }] };
    assert.strictEqual(validateDefinition(def).ok, true, 'wait 5s should pass');
}
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'wait', seconds: 0 }], edges: [{ from: 'trg', to: 's1' }] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'wait.seconds_range'), 'wait < 1 must error');
}

// stop_error
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'stop_error', message: 'boom' }], edges: [{ from: 'trg', to: 's1' }] };
    assert.strictEqual(validateDefinition(def).ok, true, 'stop_error with message should pass');
}
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'stop_error' }], edges: [{ from: 'trg', to: 's1' }] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'stop_error.message_missing'));
}

// switch — needs at least one case AND at least one wired case edge.
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'sw', type: 'switch', expr: 'trigger.output.priority', cases: [{ name: 'urgent', value: 'high' }] },
            { id: 'n1', type: 'notification', title: 'urgent path' },
        ],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'n1', label: 'case:urgent', caseName: 'urgent' },
        ],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'switch with one wired case should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'sw', type: 'switch', expr: 'trigger.output.x', cases: [] }],
        edges: [{ from: 'trg', to: 'sw' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'switch.cases_missing'), 'empty cases must error');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'sw', type: 'switch', expr: 'x', cases: [{ name: 'a', value: 1 }] }],
        edges: [{ from: 'trg', to: 'sw' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'switch.no_branches'), 'unwired switch must error');
}

// filter / limit / aggregate / summarize — arrayRef required
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'filter', arrayRef: 'trigger.output.items', expr: 'item.flag' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'filter with arrayRef + expr should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'filter', expr: 'item.flag' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'filter.arrayRef_missing'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'limit', arrayRef: 'trigger.output.items', count: 5 }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'limit with arrayRef + count should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'aggregate', arrayRef: 'trigger.output.items' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'aggregate.field_missing'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'summarize', arrayRef: 'trigger.output.items', field: 'amount', op: 'sum' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'summarize with all fields should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'summarize', arrayRef: 'trigger.output.items', field: 'amount', op: 'median' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'summarize.op_invalid'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'dedupe', arrayRef: 'trigger.output.items', keyField: 'id' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'dedupe with keyField should pass');
}

console.log('validate.test.js — all checks passed');
