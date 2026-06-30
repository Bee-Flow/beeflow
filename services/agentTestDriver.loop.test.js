/**
 * Loop wiring test for the provider-agnostic agent test driver.
 *
 * Drives the REAL runAgentMode() through a fake unified adapter + provider + a
 * fake Playwright page, asserting (without a browser / DB / SDK) that:
 *   1. the model the "thinking" tier resolves to is the model that drives the
 *      browser — a non-Claude model is honoured, NO silent Claude fallback;
 *   2. adapter.chat() gets the resolving provider's creds + OpenAI-shaped tools;
 *   3. tool calls dispatch and their results are appended as role:'tool'
 *      messages keyed by tool_call_id, with the assistant turn carrying
 *      tool_calls and the system prompt leading the history;
 *   4. when the resolved model has no provider, it falls back to Claude.
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Eager deps (bound at driver load).
mock('../stores/testRunStore', {
    appendProgress: async () => {},
    publishEvent: () => {},
    isCancelRequested: () => false,
});
mock('../core/modelResolver', { resolveModelForTier: async () => 'devstral-medium-latest' });

// Lazy deps (required inside runAgentMode).
let providerLookup;
mock('../core/aiAgent', { getProviderForModel: async (m) => providerLookup(m) });
let adapterChat;
mock('../core/providers', { getAdapter: () => ({ chat: (...a) => adapterChat(...a) }) });

// Browser provider is required in the host-fallback path; give it a fake context.
const fakePage = {
    setDefaultTimeout() {},
    goto: async () => {},
    url: () => 'https://x.example/',
    title: async () => 'X',
    async screenshot() { return Buffer.from('jpeg'); },
    async innerText() { return 'hello'; },
    locator() { return { first: () => ({ click: async () => {}, fill: async () => {}, press: async () => {}, innerText: async () => 'hello' }) }; },
    accessibility: { snapshot: async () => ({ role: 'WebArea', name: 'x', children: [] }) },
    async close() {},
};
const fakeCtx = {
    async route() {},
    async addInitScript() {},
    async newPage() { return fakePage; },
    async close() {},
};
mock('./browserProvider', { newSharedContext: async () => fakeCtx });

const driver = require('./agentTestDriver');

test('honours a non-Claude tier model and drives the browser (no Claude fallback)', async () => {
    providerLookup = async (m) => ({
        providerType: 'mistral',
        url: 'http://fake-mistral/v1',
        apiKey: 'mistral-key',
        providerName: 'Mistral',
        model: m,
    });

    const chatCalls = [];
    let turn = 0;
    adapterChat = (apiKey, baseUrl, model, messages, options) => {
        chatCalls.push({ apiKey, baseUrl, model, options, messages: JSON.parse(JSON.stringify(messages)) });
        turn += 1;
        if (turn === 1) {
            return Promise.resolve({
                content: 'Looking at the page.',
                toolCalls: [{ id: 'c1', type: 'function', function: { name: 'pw_get_text', arguments: JSON.stringify({}) } }],
                usage: {}, stopReason: 'tool_use',
            });
        }
        if (turn === 2) {
            return Promise.resolve({
                content: '',
                toolCalls: [{ id: 'c2', type: 'function', function: { name: 'pw_record_finding', arguments: JSON.stringify({ name: 'Loads', status: 'passed', category: 'functionality' }) } }],
                usage: {}, stopReason: 'tool_use',
            });
        }
        return Promise.resolve({
            content: 'Done.',
            toolCalls: [{ id: 'c3', type: 'function', function: { name: 'pw_done', arguments: JSON.stringify({ summary: 'verified' }) } }],
            usage: {}, stopReason: 'tool_use',
        });
    };

    const result = await driver.runAgentMode({
        runId: 'r1',
        targetUrl: 'https://x.example',
        instructions: 'Verify the page loads',
        userId: 'u1',
        organizationId: null,
        maxSteps: 10,
    });

    // 1. The selected model drove the run, and a real finding → passed.
    assert.strictEqual(result.status, 'passed');

    // 2. adapter.chat got the resolving provider's creds + OpenAI tools.
    assert.strictEqual(chatCalls[0].apiKey, 'mistral-key');
    assert.strictEqual(chatCalls[0].baseUrl, 'http://fake-mistral/v1');
    assert.strictEqual(chatCalls[0].model, 'devstral-medium-latest');
    const tool0 = chatCalls[0].options.tools[0];
    assert.strictEqual(tool0.type, 'function');
    assert.ok(tool0.function.name && tool0.function.parameters, 'tools must be OpenAI function shape');
    assert.strictEqual(chatCalls[0].options.toolChoice, 'auto');

    // 3. Turn 2 history carries the assistant tool_calls turn AND the role:'tool'
    //    result keyed by tool_call_id, with system leading.
    const msgs2 = chatCalls[1].messages;
    assert.strictEqual(msgs2[0].role, 'system', 'system prompt leads the history');
    assert.ok(msgs2.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls[0].id === 'c1'), 'assistant replays tool_calls');
    assert.ok(msgs2.some((m) => m.role === 'tool' && m.tool_call_id === 'c1'), 'tool result is role:tool keyed by tool_call_id');
});

test('falls back to the Claude model when the resolved model has no provider', async () => {
    providerLookup = async (m) => {
        if (m === 'devstral-medium-latest') throw new Error('not served by any configured provider');
        return { providerType: 'claude', url: 'https://api.anthropic.com/v1', apiKey: 'claude-key', providerName: 'Claude', model: m };
    };
    let usedModel = null;
    adapterChat = (apiKey, baseUrl, model) => {
        usedModel = model;
        return Promise.resolve({
            content: '', usage: {}, stopReason: 'tool_use',
            toolCalls: [{ id: 'd1', type: 'function', function: { name: 'pw_done', arguments: JSON.stringify({ summary: 'noop' }) } }],
        });
    };

    const result = await driver.runAgentMode({
        runId: 'r2',
        targetUrl: 'https://x.example',
        instructions: 'check',
        userId: 'u1',
        maxSteps: 5,
    });

    assert.strictEqual(usedModel, 'claude-sonnet-4-6', 'should drive with the Claude fallback model');
    // No findings recorded → report status is 'error' by design; the point is it
    // ran on the fallback model rather than erroring on resolution.
    assert.ok(['error', 'passed', 'failed'].includes(result.status));
});
