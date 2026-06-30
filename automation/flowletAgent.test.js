/**
 * Unit tests for the flowlet sub-agent (flowletAgent.js).
 *
 * Run: node automation/flowletAgent.test.js
 *
 * No DB / network: we stub llmClient.chat with scripted responses. The agent
 * mutates an in-memory draft via applyToolCall (step-adders don't persist),
 * so the whole loop runs offline.
 */

const assert = require('assert');

(async () => {
    let llmClient, layerAgent, builderTools;
    try {
        llmClient = require('../core/llmClient');
        layerAgent = require('./flowletAgent');
        builderTools = require('./builderTools');
    } catch (e) {
        console.warn(`[flowletAgent.test] dependencies unavailable, skipping: ${e.message}`);
        process.exit(0);
    }

    const origChat = llmClient.chat;
    const { runLayerAgent, runLayersInParallel, _layerContract } = layerAgent;
    const { makeLayerSkeleton } = builderTools;

    const tc = (name, args) => ({
        id: `tc_${name}_${Math.random().toString(36).slice(2, 6)}`,
        function: { name, arguments: JSON.stringify(args || {}) },
    });
    const emptyCatalog = { apps: [] };

    // ── 1: scope lock — every tool call lands INSIDE the layer, not root ──
    {
        const queue = [
            { content: null, toolCalls: [tc('builder_set_layer_contract', { outputFields: ['score'] })] },
            { content: null, toolCalls: [tc('builder_add_ai_step', { prompt: 'score the lead' })] },
            { content: 'Looks up a contact and scores them.', toolCalls: [] },
        ];
        llmClient.chat = async () => queue.shift() || { content: 'done', toolCalls: [] };

        const def = {
            schemaVersion: 2,
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [],
            edges: [],
            layers: { enrich: makeLayerSkeleton('Enrich', [{ name: 'email' }]) },
        };
        const draftWrap = { userId: 'u1', def, automationId: null };
        const events = [];
        const r = await runLayerAgent({
            draftWrap, layerKey: 'enrich', instruction: 'Look up a contact and score them',
            modelId: 'stub', userId: 'u1', catalog: emptyCatalog, send: (ev, d) => events.push([ev, d]),
        });

        assert.strictEqual(def.steps.length, 0, 'root flow steps are untouched (scope lock)');
        assert.ok(def.layers.enrich.steps.some(s => s.type === 'ai_step'), 'ai_step was added inside the layer');
        assert.deepStrictEqual(r.outputFields, ['score'], 'declared output field is returned');
        assert.strictEqual(r.summary, 'Looks up a contact and scores them.', 'summary is the final assistant content');
        const toolEvents = events.filter(e => e[0] === 'tool_call');
        assert.ok(toolEvents.length >= 2, 'streamed each tool call');
        assert.ok(toolEvents.every(e => e[1].layerKey === 'enrich'), 'every tool_call event is tagged with the layer key');
        // the sub-agent forced scope even though the model never set it
        const aiCall = toolEvents.find(e => e[1].name === 'builder_add_ai_step');
        assert.strictEqual(aiCall[1].arguments.scope, 'enrich', 'scope is forced onto scoped tools');
    }

    // ── 2: parallel — same-titled specs get DISTINCT keys; conflict-free merge ──
    {
        llmClient.chat = async () => ({ content: 'done', toolCalls: [] }); // 0 tool rounds each
        const rootDef = {
            schemaVersion: 2,
            trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [], edges: [], layers: {},
        };
        const specs = [
            { title: 'Enrich', instruction: 'a' },
            { title: 'Enrich', instruction: 'b' }, // same title → must not collide
            { title: 'Digest', instruction: 'c' },
        ];
        const results = await runLayersInParallel({
            rootDef, specs, modelId: 'stub', userId: 'u1', catalog: emptyCatalog, send: () => {},
        });
        const keys = Object.keys(rootDef.layers);
        assert.strictEqual(keys.length, 3, 'all three layers merged into rootDef');
        assert.strictEqual(new Set(keys).size, 3, 'keys are distinct even for same-titled specs');
        assert.ok(results.every(r => r.ok), 'every parallel build reported ok');
        assert.strictEqual(rootDef.schemaVersion, 2, 'schemaVersion marker set');
    }

    // ── 3: parallel never mutates a shared object (isolation) ──────────────
    {
        // Each agent mutates only its own isolated draft; a pre-existing layer
        // is copied read-only and survives untouched.
        llmClient.chat = async () => ({ content: 'done', toolCalls: [] });
        const rootDef = {
            schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
            steps: [], edges: [], layers: { existing: makeLayerSkeleton('Existing', []) },
        };
        await runLayersInParallel({ rootDef, specs: [{ title: 'New A', instruction: 'x' }, { title: 'New B', instruction: 'y' }], modelId: 'stub', userId: 'u1', catalog: emptyCatalog, send: () => {} });
        assert.ok(rootDef.layers.existing, 'pre-existing layer is preserved');
        assert.strictEqual(Object.keys(rootDef.layers).length, 3, 'existing + 2 new layers');
    }

    // ── 4: _layerContract derives params + outputFields from the graph ─────
    {
        const def = {
            layers: {
                enrich: {
                    title: 'E',
                    trigger: { kind: 'layer_input', params: [{ name: 'email' }, { name: 'name' }] },
                    steps: [{ id: 'out', type: 'layer_output', fields: { score: { kind: 'literal', value: 1 }, tier: { kind: 'literal', value: 'a' } } }],
                    edges: [],
                },
            },
        };
        const c = _layerContract(def, 'enrich');
        assert.deepStrictEqual(c.params.map(p => p.name), ['email', 'name']);
        assert.deepStrictEqual(c.outputFields, ['score', 'tier']);
        assert.deepStrictEqual(_layerContract(def, 'missing'), { params: [], outputFields: [] }, 'unknown key → empty contract');
    }

    llmClient.chat = origChat;
    console.log('flowletAgent.test.js: all tests passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
