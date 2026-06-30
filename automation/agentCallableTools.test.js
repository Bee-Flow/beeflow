/**
 * Unit tests for the agent-callable routine helpers (trigger.kind === 'agent_call').
 *
 * Run: node --test automation/agentCallableTools.test.js
 *
 * Stub automationStore + automationRunner via require.cache so the module
 * loads without touching the database, and so dispatch is observable.
 */

const { test } = require('node:test');
const assert = require('node:assert');

// ── Stub automationStore before requiring the module under test ──────────
const storePath = require.resolve('../stores/automationStore');
const fakeStore = {
    automations: [],
    getAutomationsForUser: async (userId) => fakeStore.automations.filter(a => a.userId === userId),
    getAutomation: async (id) => fakeStore.automations.find(a => a.id === id) || null,
};
require.cache[storePath] = { id: storePath, filename: storePath, loaded: true, exports: fakeStore };

// ── Stub the runner (lazy-required inside dispatch) ──────────────────────
const runnerPath = require.resolve('../core/automationRunner');
let lastRun = null;
require.cache[runnerPath] = {
    id: runnerPath, filename: runnerPath, loaded: true,
    exports: {
        executeAutomation: async (automation, opts) => {
            lastRun = { automationId: automation.id, opts };
            return { lastOutput: { ok: true, echoed: opts.triggerPayload } };
        },
    },
};

const {
    automationToTool,
    getAgentCallableToolsForUser,
    dispatchAgentCallableTool,
} = require('./agentCallableTools');

function agentAutomation(over = {}) {
    return {
        id: 'auto_1',
        userId: 'user_1',
        organizationId: 'org_1',
        title: 'Summarise inbox',
        isActive: true,
        definition: {
            trigger: {
                kind: 'agent_call',
                toolName: 'summarise_inbox',
                description: 'Summarise the unread inbox',
                parametersSchema: {
                    type: 'object',
                    properties: { limit: { type: 'number', description: 'how many' } },
                    required: ['limit'],
                },
            },
        },
        ...over,
    };
}

test('automationToTool renders the declared function schema', () => {
    const tool = automationToTool(agentAutomation());
    assert.strictEqual(tool.type, 'function');
    assert.strictEqual(tool.function.name, 'summarise_inbox');
    assert.strictEqual(tool.function.description, 'Summarise the unread inbox');
    assert.deepStrictEqual(tool.function.parameters.required, ['limit']);
    // routing metadata is present but not part of the function schema
    assert.deepStrictEqual(tool.__automation, { id: 'auto_1', userId: 'user_1', organizationId: 'org_1' });
});

test('automationToTool ignores non-agent_call triggers', () => {
    assert.strictEqual(automationToTool(agentAutomation({ definition: { trigger: { kind: 'schedule' } } })), null);
    assert.strictEqual(automationToTool({ id: 'x' }), null);
});

test('automationToTool defaults missing parametersSchema to an open object', () => {
    const a = agentAutomation();
    delete a.definition.trigger.parametersSchema;
    const tool = automationToTool(a);
    assert.strictEqual(tool.function.parameters.type, 'object');
    assert.strictEqual(tool.function.parameters.additionalProperties, true);
});

test('getAgentCallableToolsForUser filters out inactive routines', async () => {
    fakeStore.automations = [
        agentAutomation({ id: 'active', isActive: true }),
        agentAutomation({ id: 'inactive', isActive: false }),
    ];
    const tools = await getAgentCallableToolsForUser('user_1');
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].__automation.id, 'active');
});

test('dispatchAgentCallableTool runs the routine and returns its output', async () => {
    fakeStore.automations = [agentAutomation()];
    lastRun = null;
    const out = await dispatchAgentCallableTool({ id: 'auto_1', userId: 'user_1' }, { limit: 5 }, { userId: 'user_1' });
    assert.strictEqual(lastRun.automationId, 'auto_1');
    assert.strictEqual(lastRun.opts.triggerKind, 'agent_call');
    assert.deepStrictEqual(lastRun.opts.triggerPayload, { limit: 5 });
    assert.deepStrictEqual(out, { ok: true, echoed: { limit: 5 } });
});

test('dispatchAgentCallableTool rejects a non-owner', async () => {
    fakeStore.automations = [agentAutomation()];
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1', userId: 'user_1' }, {}, { userId: 'someone_else' }),
        /Forbidden/,
    );
});

test('dispatchAgentCallableTool refuses an inactive routine', async () => {
    fakeStore.automations = [agentAutomation({ isActive: false })];
    await assert.rejects(
        () => dispatchAgentCallableTool({ id: 'auto_1', userId: 'user_1' }, {}, { userId: 'user_1' }),
        /not active/,
    );
});
