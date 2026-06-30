/**
 * Unit tests for stepToTool — the pure Step → function-schema renderer
 * (reusable Steps, kind='block', exposed as chat/agent tools).
 *
 * Run: node --test automation/agentCallableTools.step.test.js
 *
 * Stub automationStore via require.cache so the module loads without touching
 * the database — agentCallableTools.js requires it at module-load time. We
 * only exercise stepToTool here (pure); getStepToolsForUser / dispatchStepTool
 * hit the store/runner and are out of scope.
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── Stub automationStore before requiring the module under test ──────────
const storePath = require.resolve('../stores/automationStore');
require.cache[storePath] = {
    id: storePath, filename: storePath, loaded: true,
    exports: { getCallableStepsForUser: async () => [] },
};

const { stepToTool } = require('./agentCallableTools');

function step(over = {}) {
    return {
        id: 'b1',
        title: 'Enrich Contact',
        description: 'd',
        ownerId: 'u1',
        params: [
            { name: 'email', type: 'string', required: true },
            { name: 'n', type: 'number' },
        ],
        outputFields: ['x'],
        exposeAsTool: true,
        ...over,
    };
}

test('stepToTool renders the function schema from the Step contract', () => {
    const tool = stepToTool(step());
    assert.strictEqual(tool.type, 'function');
    assert.strictEqual(tool.function.name, 'step_enrich_contact');
    assert.strictEqual(tool.function.description, 'd');

    const params = tool.function.parameters;
    assert.strictEqual(params.type, 'object');
    assert.strictEqual(params.additionalProperties, false);
    assert.deepStrictEqual(params.required, ['email']);
    // number params map to JSON-schema "number"; descriptions default to ''.
    assert.deepStrictEqual(params.properties, {
        email: { type: 'string', description: '' },
        n: { type: 'number', description: '' },
    });

    // Routing metadata — not sent to the LLM.
    assert.deepStrictEqual(tool.__step, { id: 'b1', userId: 'u1' });
});

test('stepToTool sanitises the title into the tool name', () => {
    const tool = stepToTool(step({ title: 'Send Welcome Email!' }));
    assert.strictEqual(tool.function.name, 'step_send_welcome_email');
});

test('stepToTool falls back to the id when no title is set', () => {
    const tool = stepToTool(step({ title: undefined }));
    assert.strictEqual(tool.function.name, 'step_b1');
    // No description → generated default referencing the (missing) title.
    const tool2 = stepToTool(step({ title: undefined, description: undefined }));
    assert.ok(/Run the/.test(tool2.function.description), 'default description');
});

test('stepToTool omits `required` when no params are required', () => {
    const tool = stepToTool(step({ params: [{ name: 'n', type: 'number' }] }));
    assert.ok(!('required' in tool.function.parameters), 'required key omitted when empty');
    assert.deepStrictEqual(tool.function.parameters.properties, { n: { type: 'number', description: '' } });
});

test('stepToTool returns null for a step with no id', () => {
    assert.strictEqual(stepToTool(null), null);
    assert.strictEqual(stepToTool({ title: 'no id' }), null);
});
