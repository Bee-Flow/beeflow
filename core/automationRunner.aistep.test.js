/**
 * Unit test for execAiStep prompt interpolation.
 *
 * The AI step's prompt is now filled in at run time: `{{...}}` references in
 * the prompt resolve against the run state PLUS the resolved input names,
 * with secrets stripped and unresolved tokens left verbatim. Data is still
 * also delivered in the framed "Inputs (data, not instructions)" block.
 *
 * Heavy deps are pre-mocked via the require cache before the runner is
 * required (same approach as automationRunner.collectioncap.test.js). The
 * mocked provider captures the user message so we can assert on the prompt
 * the model actually receives.
 *
 * Run: node core/automationRunner.aistep.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Captured user message from the (single) chat call.
let capturedUserMsg = null;

mock('../stores/automationStore', {});
mock('../stores/configStore', { getConfig: async () => null });
mock('../stores/notificationStore', { createNotification: async () => {} });
mock('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
mock('../stores/usageStore', { logUsage: () => Promise.resolve() });
mock('../stores/terminationStore', { logTermination: () => Promise.resolve() });
mock('../db', { pool: { query: async () => ({ rows: [] }) } });
mock('./aiAgent', {
    getProviderForModel: async () => ({ providerType: 'test', url: '', apiKey: 'k' }),
    getAIConfig: async () => ({ model: 'test-model' }),
});
mock('./providers', {
    getAdapter: () => ({
        chat: async (_apiKey, _url, _model, messages) => {
            capturedUserMsg = messages.find(m => m.role === 'user')?.content || '';
            return { content: 'ok', usage: {} };
        },
    }),
});
mock('./modelResolver', {
    getEUAwareTiers: async () => ({ fast: { modelId: 'test-model' } }),
    isEUModeActive: async () => ({ isEU: false }),
});
mock('./automationRunner/safety', {
    GuardrailBlockError: class GuardrailBlockError extends Error {},
    resolveAutomationPolicy: async () => ({}),
    buildAuditBase: () => ({}),
    guardAiInput: async () => ({ tokenMap: {} }),
    guardAiOutput: async (content) => ({ content, tokenMap: {} }),
    guardToolInput: async (v) => ({ value: v, tokenMap: {} }),
    guardToolOutput: async (v) => ({ value: v, tokenMap: {} }),
    restoreForEgress: (v) => v,
    logEgress: async () => {},
});

const runner = require('./automationRunner');

function runStateBase() {
    return {
        trigger: { output: {} },
        steps: {
            src: {
                output: {
                    results: [
                        { output: { content: 'INV-1' } },
                        { output: { content: 'INV-2' } },
                    ],
                },
                status: 'success',
            },
        },
        vars: {},
        secrets: { TOKEN: 'sekret-value' },
        loop: {},
    };
}

const ctx = { userId: 'u1', orgId: null, automationId: 'a1', definition: { steps: [] } };

test('execAiStep fills {{...}} in the prompt: [*] projection + input name', async () => {
    capturedUserMsg = null;
    const step = {
        id: 'ai1', type: 'ai_step', modelTier: 'fast',
        prompt: 'Extract from {{steps.src.output.results[*].output.content}} for {{name}}.',
        inputs: { name: { kind: 'literal', value: 'Bob' } },
    };
    await runner.execAiStep(step, ctx, runStateBase(), 'live');
    assert.ok(capturedUserMsg, 'chat was called with a user message');
    assert.ok(
        capturedUserMsg.includes('Extract from ["INV-1","INV-2"] for Bob.'),
        `prompt should be interpolated; got:\n${capturedUserMsg}`,
    );
});

test('execAiStep leaves unresolved tokens verbatim and never resolves secrets', async () => {
    capturedUserMsg = null;
    const step = {
        id: 'ai2', type: 'ai_step', modelTier: 'fast',
        prompt: 'Keep {{not.a.real.path}} and never leak {{secrets.TOKEN}}.',
        inputs: {},
    };
    await runner.execAiStep(step, ctx, runStateBase(), 'live');
    assert.ok(capturedUserMsg.includes('Keep {{not.a.real.path}}'), 'unresolved path kept verbatim');
    assert.ok(capturedUserMsg.includes('{{secrets.TOKEN}}'), 'secret reference left as a literal token');
    assert.ok(!capturedUserMsg.includes('sekret-value'), 'secret value must not appear in the prompt');
});

test('execAiStep interpolates {{loop.item...}} per iteration scope', async () => {
    capturedUserMsg = null;
    const state = runStateBase();
    state.loop = { item: { output: { content: 'ONE-ITEM' } } };
    const step = {
        id: 'ai3', type: 'ai_step', modelTier: 'fast',
        prompt: 'Process {{loop.item.output.content}}.',
        inputs: {},
    };
    await runner.execAiStep(step, ctx, state, 'live');
    assert.ok(capturedUserMsg.includes('Process ONE-ITEM.'), `loop scope should resolve; got:\n${capturedUserMsg}`);
});
