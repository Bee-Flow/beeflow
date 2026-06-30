/**
 * Regression test: rowToRunStep must pass jsonb output/input through verbatim.
 *
 * `automation_run_steps.output_json` / `input_json` are jsonb columns, which
 * node-postgres already parses to a JS value. The old mapping re-ran JSON.parse
 * on string values, so a bare-STRING output (an AI step's free text, or a
 * ```json fenced reply that isn't valid JSON) was turned into `null` and the
 * Run/Output panels showed "no output" even though the DB held the text.
 *
 * Pure mapper — no DB. `../db` is mocked so requiring the store doesn't try to
 * connect. Run: node stores/automationStore.runStepOutput.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}
mock('../db', { run: async () => {}, getOne: async () => null, getAll: async () => [], exec: async () => {}, getClient: async () => ({}), pool: { query: async () => ({ rows: [] }) } });

const store = require('./automationStore');

// node-postgres returns jsonb already parsed: a JSON string value comes back as
// a JS string, an object as an object, etc.
function row(output_json) {
    return {
        run_id: 'r1', step_id: 's1', parent_step_id: null, step_type: 'ai_step',
        attempts: 1, status: 'success', started_at: null, finished_at: null,
        input_json: null, output_json, error: null, error_class: null, branch_index: null,
    };
}

test('bare-string output is preserved (not parsed away to null)', () => {
    const text = '```json\n[{"invoice":"Q850"}]\n```';
    assert.strictEqual(store.rowToRunStep(row(text)).output, text);
});

test('plain free-text output is preserved', () => {
    assert.strictEqual(store.rowToRunStep(row('No urgent reply needed.')).output, 'No urgent reply needed.');
});

test('a numeric-looking string stays a string (not retyped to a number)', () => {
    assert.strictEqual(store.rowToRunStep(row('42')).output, '42');
});

test('object and array outputs pass through unchanged', () => {
    const obj = { a: 1, b: ['x'] };
    assert.deepStrictEqual(store.rowToRunStep(row(obj)).output, obj);
    const arr = [{ k: 'v' }];
    assert.deepStrictEqual(store.rowToRunStep(row(arr)).output, arr);
});

test('null output maps to null', () => {
    assert.strictEqual(store.rowToRunStep(row(null)).output, null);
});

test('fromJsonb is a verbatim pass-through (with null coalescing)', () => {
    assert.strictEqual(store.fromJsonb('hi'), 'hi');
    assert.strictEqual(store.fromJsonb(undefined), null);
    assert.strictEqual(store.fromJsonb(null), null);
    assert.deepStrictEqual(store.fromJsonb({ x: 1 }), { x: 1 });
});
