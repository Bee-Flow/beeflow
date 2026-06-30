/**
 * Unit tests for the pure Step-contract helpers.
 *
 * Run: node --test automation/stepContract.test.js
 *
 * Pure module — stepContract reads the trigger.params + layer_output fields,
 * requiredIntegrations resolves integration_action tools (the real
 * integrationToolMap is dependency-light and load-safe), and walkSteps
 * descends into loop bodies / parallel branches. No DB/network.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { stepContract, requiredIntegrations, walkSteps, stepParams, stepOutputFields } = require('./stepContract');

// A Step definition: layer_input trigger declaring params + a layer_output
// step declaring its returned fields.
function stepDef(overrides = {}) {
    return {
        trigger: {
            id: 'trg',
            type: 'trigger',
            kind: 'layer_input',
            params: [
                { name: 'email', type: 'string', required: true },
                { name: 'limit', type: 'number' },
            ],
        },
        steps: [
            { id: 's1', type: 'ai_step', prompt: 'enrich' },
            { id: 'out', type: 'layer_output', fields: { score: { kind: 'literal', value: 1 }, summary: { kind: 'ref', path: 'steps.s1.output.text' } } },
        ],
        edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 'out' }],
        ...overrides,
    };
}

// ── stepContract: params from the trigger + output field keys ────────────
test('stepContract returns params and outputFields from the contract', () => {
    const c = stepContract(stepDef());
    assert.deepStrictEqual(c.params, [
        { name: 'email', type: 'string', required: true, description: '' },
        { name: 'limit', type: 'number', required: false, description: '' },
    ]);
    assert.deepStrictEqual(c.outputFields, ['score', 'summary']);
});

test('stepContract defaults gracefully on an empty / malformed definition', () => {
    assert.deepStrictEqual(stepContract({}), { params: [], outputFields: [] });
    assert.deepStrictEqual(stepContract(null), { params: [], outputFields: [] });
    // params that aren't objects, or lack a name, are dropped.
    const def = { trigger: { params: ['nope', { type: 'string' }, { name: 'ok' }] }, steps: [] };
    assert.deepStrictEqual(stepParams(def), [{ name: 'ok', type: 'string', required: false, description: '' }]);
    assert.deepStrictEqual(stepOutputFields(def), []);
});

// ── requiredIntegrations: walk integration_action steps → integration ids ─
test('requiredIntegrations resolves an integration_action tool to its integration id', () => {
    const def = stepDef({
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_send' },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
    });
    const ids = requiredIntegrations(def);
    assert.ok(Array.isArray(ids), 'returns an array');
    assert.ok(ids.includes('gmail'), `expected 'gmail', got ${JSON.stringify(ids)}`);
});

test('requiredIntegrations returns a sorted unique array and ignores non-integration steps', () => {
    const def = stepDef({
        steps: [
            { id: 's1', type: 'integration_action', tool: 'gmail_send' },
            { id: 's2', type: 'integration_action', tool: 'gmail_read' },
            { id: 's3', type: 'ai_step', prompt: 'no integration here' },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
    });
    const ids = requiredIntegrations(def);
    // Two gmail tools dedupe to one 'gmail'.
    assert.deepStrictEqual(ids, ['gmail']);
    // sorted-unique invariant: a copy sorted equals the original.
    assert.deepStrictEqual([...ids].sort(), ids);
});

test('requiredIntegrations descends into nested layers', () => {
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 'cl', type: 'call_layer', layerKey: 'enrich', inputs: {} }],
        edges: [],
        layers: {
            enrich: {
                trigger: { id: 'lt', kind: 'layer_input', params: [] },
                steps: [{ id: 'ls', type: 'integration_action', tool: 'gmail_send' }],
                edges: [],
            },
        },
    };
    assert.deepStrictEqual(requiredIntegrations(def), ['gmail']);
});

test('requiredIntegrations returns [] for a non-object definition', () => {
    assert.deepStrictEqual(requiredIntegrations(null), []);
    assert.deepStrictEqual(requiredIntegrations('nope'), []);
});

// ── walkSteps: flat steps + descend into loop bodies and parallel branches ─
test('walkSteps descends into loop bodies and parallel branches', () => {
    const steps = [
        { id: 'a', type: 'ai_step' },
        {
            id: 'lp', type: 'loop',
            body: [
                { id: 'b', type: 'ai_step' },
                {
                    id: 'par', type: 'parallel',
                    branches: [
                        [{ id: 'c', type: 'ai_step' }],
                        [{ id: 'd', type: 'ai_step' }],
                    ],
                },
            ],
        },
    ];
    const seen = [];
    walkSteps(steps, (s) => seen.push(s.id));
    assert.deepStrictEqual(seen, ['a', 'lp', 'b', 'par', 'c', 'd']);
});

test('walkSteps is a no-op on a non-array', () => {
    let called = 0;
    walkSteps(undefined, () => { called++; });
    walkSteps(null, () => { called++; });
    assert.strictEqual(called, 0);
});
