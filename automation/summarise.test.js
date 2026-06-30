/**
 * Tests for the automation summarisers.
 *
 * Run: node --test automation/summarise.test.js
 *
 * No DB / network — pure functions over an in-memory definition.
 */

const { test } = require('node:test');
const assert = require('assert');
const { summariseDefinition, renderAgentDraftState } = require('./summarise');

const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'a_search', type: 'integration_action', tool: 'gmail_search', label: 'Search', inputs: { q: { kind: 'literal', value: 'label:invoices' } } },
        { id: 'a_read', type: 'integration_action', tool: 'gmail_read', forEach: { overRef: 'steps.a_search.output.messages', itemVar: 'email' }, inputs: { messageId: { kind: 'ref', path: 'loop.email.id' } } },
    ],
    edges: [{ from: 'trg', to: 'a_search' }, { from: 'a_search', to: 'a_read' }],
    layers: {
        enrich: {
            title: 'Enrich',
            trigger: { id: 'trg', kind: 'layer_input', params: [{ name: 'supplierName' }] },
            steps: [
                { id: 'out', type: 'layer_output', fields: { invoices: { kind: 'ref', path: 'steps.set1.output.invoices' } } },
                { id: 'set1', type: 'set', fields: { invoices: { kind: 'ref', path: 'steps.agg.output.values' } } },
            ],
            edges: [{ from: 'trg', to: 'set1' }, { from: 'set1', to: 'out' }],
        },
    },
};

test('renderAgentDraftState exposes real step IDs, settings, bindings + layers', () => {
    const s = renderAgentDraftState(DEF);
    // Real step ids (not 1./2. numbering) for the main flow.
    assert.ok(s.includes('`a_search`') && s.includes('`a_read`'), 'root step ids present');
    // Tool + its input binding (the mapping between steps).
    assert.ok(s.includes('gmail_read') && s.includes('messageId=`loop.email.id`'), 'tool + input binding shown');
    // Per-step forEach iteration is surfaced.
    assert.ok(/forEach over `steps\.a_search\.output\.messages` as loop\.email/.test(s), 'forEach iteration shown');
    // Layers are rendered (summariseDefinition ignores them — this is the fix).
    assert.ok(s.includes('FLOWLET `enrich`') && s.includes('supplierName'), 'flowlet + its declared input shown');
    assert.ok(s.includes('returns=') && s.includes('steps.set1.output.invoices'), 'layer_output return binding shown');
    // Edge wiring (order/mapping) for both graphs.
    assert.ok(s.includes('wiring: trg→a_search'), 'main-flow edges shown');
    assert.ok(s.includes('wiring: trg→set1'), 'layer edges shown');
});

test('renderAgentDraftState handles an empty / missing draft', () => {
    assert.strictEqual(renderAgentDraftState(null), '_(empty draft)_');
    const s = renderAgentDraftState({ trigger: { id: 'trg', kind: 'manual' }, steps: [], edges: [] });
    assert.ok(s.startsWith('MAIN FLOW:'), 'renders the main-flow header even with no steps');
});

test('summariseDefinition stays human-readable (no raw step IDs)', () => {
    const { summary } = summariseDefinition(DEF);
    assert.ok(summary.includes('**Trigger:**'), 'human summary keeps its prose shape');
    assert.ok(!summary.includes('`a_search`'), 'human summary does not leak raw step ids');
});
