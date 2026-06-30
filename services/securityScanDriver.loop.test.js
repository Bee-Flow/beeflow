/**
 * Loop wiring test for the provider-agnostic security scan driver.
 *
 * Drives the REAL runAgentScan() through a fake unified adapter + provider so we
 * can assert, without a live stack, that:
 *   1. the model the tier resolves to is the model that drives the scan (a
 *      non-Claude model is honoured — NO silent Claude fallback);
 *   2. adapter.chat() is called with the resolving provider's creds + the
 *      OpenAI-shaped tools;
 *   3. tool calls are dispatched and their results are appended as role:'tool'
 *      messages keyed by tool_call_id, with the assistant turn carrying
 *      tool_calls — i.e. the exact history shape every adapter expects;
 *   4. when the resolved model has no provider, the loop falls back to the
 *      known-good Claude model instead of failing.
 *
 * Modules the driver pulls in are stubbed via require.cache BEFORE the driver is
 * required, so no DB / network / SDK is touched.
 */

const test = require('node:test');
const assert = require('node:assert');

// ── Stub the driver's module dependencies ───────────────────────────────────
function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Eager (top-level) deps — must be in place before requiring the driver.
mock('../core/modelResolver', { resolveModelForTier: async () => 'devstral-medium-latest' });
mock('../stores/securityScanStore', {
    appendProgress: async () => {},
    isCancelRequested: () => false,
    publishEvent: () => {},
});
mock('../stores/usageStore', { logUsage: async () => {} });
mock('../stores/configStore', { getConfig: async () => ({}), getSecret: async () => null, setConfig: async () => {} });
mock('./zapClient', { makeZapClient: () => ({}) });
mock('./securityReportBuilder', {
    aggregate: () => ({ findings: [], severitySummary: { high: 0, medium: 0, low: 0, informational: 0 } }),
    renderReportHtml: () => ({ html: '<html></html>', css: '' }),
    persistReportWebpage: async () => 'wp-1',
    normalizeZap: () => [], normalizeNuclei: () => [], normalizeTestssl: () => [],
});

// Lazy deps (required inside runAgentScan) — set the cache up front too.
let providerLookup; // overridden per test
mock('../core/aiAgent', { getProviderForModel: async (m) => providerLookup(m) });

let adapterChat; // overridden per test
mock('../core/providers', { getAdapter: () => ({ chat: (...a) => adapterChat(...a) }) });

// securecore/securityAggression loads for real (pure, deterministic).
const driver = require('./securityScanDriver');

const fakeTerminal = {
    exec: async (cmd, opts) => {
        if (opts && typeof opts.onChunk === 'function') opts.onChunk({ chunk: 'root\n', stream: 'stdout' });
        return { exitCode: 0, timedOut: false };
    },
};
const fakeRunEngine = async () => ({});

test('honours a non-Claude tier model and dispatches tools (no Claude fallback)', async () => {
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
        // Deep-clone the live (mutated) message array so per-turn assertions hold.
        chatCalls.push({ apiKey, baseUrl, model, options, messages: JSON.parse(JSON.stringify(messages)) });
        turn += 1;
        if (turn === 1) {
            return Promise.resolve({
                content: 'Starting recon.',
                toolCalls: [{ id: 't1', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: 'whoami' }) } }],
                usage: { prompt_tokens: 12, completion_tokens: 4 },
                stopReason: 'tool_use',
            });
        }
        return Promise.resolve({
            content: 'Finished.',
            toolCalls: [{ id: 't2', type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: 'all good', report: '# Assessment' }) } }],
            usage: { prompt_tokens: 20, completion_tokens: 6 },
            stopReason: 'tool_use',
        });
    };

    const logs = [];
    const result = await driver.runAgentScan({
        scanId: 's1',
        targetUrl: 'https://x.example',
        engines: [{ engine: 'zap' }],
        userId: 'u1',
        organizationId: null,
        modelTier: 'thinking',
        aggression: 'recon',
        maxSteps: 10,
        zap: { baseUrl: 'http://zap', apiKey: 'z' },
        terminal: fakeTerminal,
        runEngine: fakeRunEngine,
        onLine: (l) => logs.push(l),
    });

    // 1. The selected model drove the scan — no fallback to Claude.
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.reportJson.model, 'devstral-medium-latest');
    assert.ok(!logs.some((l) => /falling back/i.test(l)), 'must not log a Claude fallback');
    assert.ok(logs.some((l) => /using model devstral-medium-latest.*via Mistral/.test(l)), 'should log the resolved provider');

    // 2. adapter.chat got the resolving provider's creds + tools in OpenAI shape.
    assert.strictEqual(chatCalls[0].apiKey, 'mistral-key');
    assert.strictEqual(chatCalls[0].baseUrl, 'http://fake-mistral/v1');
    assert.strictEqual(chatCalls[0].model, 'devstral-medium-latest');
    const tool0 = chatCalls[0].options.tools[0];
    assert.strictEqual(tool0.type, 'function');
    assert.ok(tool0.function.name && tool0.function.parameters, 'tools must be OpenAI function shape');
    assert.strictEqual(chatCalls[0].options.toolChoice, 'auto');

    // 3. The second turn's history carries the assistant tool_calls turn AND the
    //    role:'tool' result keyed by tool_call_id — the shape every adapter needs.
    const msgs2 = chatCalls[1].messages;
    assert.ok(msgs2.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls[0].id === 't1'), 'assistant turn must replay tool_calls');
    assert.ok(msgs2.some((m) => m.role === 'tool' && m.tool_call_id === 't1'), 'tool result must be role:tool keyed by tool_call_id');
    assert.ok(msgs2[0].role === 'system', 'system prompt leads the history');

    // done() ended the loop after exactly two model turns.
    assert.strictEqual(result.reportJson.stepCount, 2);
    assert.strictEqual(result.reportJson.narrative, '# Assessment');
});

test('falls back to the Claude model when the resolved model has no provider', async () => {
    providerLookup = async (m) => {
        if (m === 'devstral-medium-latest') throw new Error('not served by any configured provider');
        return { providerType: 'claude', url: 'https://api.anthropic.com/v1', apiKey: 'claude-key', providerName: 'Claude', model: m };
    };
    adapterChat = () => Promise.resolve({
        content: 'Nothing to do.',
        toolCalls: [{ id: 'd1', type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: 'noop' }) } }],
        usage: {},
        stopReason: 'tool_use',
    });

    const logs = [];
    const result = await driver.runAgentScan({
        scanId: 's2',
        targetUrl: 'https://x.example',
        engines: [{ engine: 'zap' }],
        userId: 'u1',
        modelTier: 'thinking',
        aggression: 'recon',
        maxSteps: 5,
        zap: { baseUrl: 'http://zap', apiKey: 'z' },
        terminal: fakeTerminal,
        runEngine: fakeRunEngine,
        onLine: (l) => logs.push(l),
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.reportJson.model, 'claude-sonnet-4-6');
    assert.ok(logs.some((l) => /falling back to claude-sonnet-4-6/i.test(l)), 'should log the graceful fallback');
});
