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

// ── Forward ref still emits a warning, not an error ──────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'n1', type: 'notification', title: 'using {{steps.future.output.x}}' },
        ],
        edges: [{ from: 'trg', to: 'n1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'forward refs only warn');
    assert.ok(r.warnings.find(w => w.code === 'ref.forward'));
}

console.log('validate.test.js — all checks passed');
