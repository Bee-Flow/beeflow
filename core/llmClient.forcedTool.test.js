/**
 * Forced-tool contract for the LLM client.
 *
 * No provider adapter honours response_format/json_schema, so structured output
 * rides on a FORCED tool call. These tests pin:
 *  - the provider-correct toolChoice SHAPE that chatForcedTool / runToolLoop emit:
 *      · openai / claude / mistral / generic → {type:'function',function:{name}}
 *      · google (and google-vertex, which extends GoogleProvider) → 'required'
 *        (single-tool list + mode ANY === forcing that one tool)
 *  - chatForcedTool returns parsed `structured` args, and null (no throw) when the
 *    model declines the tool or emits unparseable args.
 *  - runToolLoop with finalTool forces the synthesis call on BOTH exit paths and
 *    is byte-for-byte backward compatible when finalTool is omitted.
 *
 * Strategy: stub `_resolve` on the singleton to inject a fake adapter and capture
 * exactly what options reach `adapter.chat`. The Google nuance is exercised with
 * the REAL exported googleAdapter (a genuine `GoogleProvider instanceof` check),
 * but with its `chat` stubbed so no SDK/network is touched.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const llmClient = require('./llmClient');
const { googleAdapter, openaiAdapter, claudeAdapter, mistralAdapter } = require('./providers');

const TOOL_DEF = {
    type: 'function',
    function: {
        name: 'emit_result',
        description: 'Emit the structured result',
        parameters: { type: 'object', properties: { ok: { type: 'boolean' } } },
    },
};

/**
 * Replace llmClient._resolve so it yields `adapter` (with a stubbed chat that
 * records its options and returns `chatResult`). Returns { calls, restore }.
 */
function stubResolve(adapter, chatResult) {
    const calls = [];
    const origResolve = llmClient._resolve;
    const origChat = adapter.chat;
    adapter.chat = async (_apiKey, _baseUrl, _modelId, messages, options) => {
        calls.push({ messages, options });
        return typeof chatResult === 'function' ? chatResult(calls.length) : chatResult;
    };
    llmClient._resolve = async () => ({
        apiKey: 'k', baseUrl: '', adapter, providerType: adapter.name, modelId: 'm',
        project: null, location: null, serviceAccountKey: null, apiVersion: null,
    });
    return {
        calls,
        restore() { llmClient._resolve = origResolve; adapter.chat = origChat; },
    };
}

function toolCall(name, args) {
    return { id: 'call_1', function: { name, arguments: args } };
}

// ─── chatForcedTool: toolChoice shape per provider ──────────────────────────

test('chatForcedTool forces object toolChoice for OpenAI', async () => {
    const s = stubResolve(openaiAdapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')], usage: { total: 1 } });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(s.calls[0].options.toolChoice, { type: 'function', function: { name: 'emit_result' } });
        assert.deepStrictEqual(s.calls[0].options.tools, [TOOL_DEF]);
        assert.deepStrictEqual(out.structured, { ok: true });
        assert.deepStrictEqual(out.usage, { total: 1 });
    } finally { s.restore(); }
});

test('chatForcedTool forces object toolChoice for Claude', async () => {
    const s = stubResolve(claudeAdapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":false}')] });
    try {
        const out = await llmClient.chatForcedTool('claude-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(s.calls[0].options.toolChoice, { type: 'function', function: { name: 'emit_result' } });
        assert.deepStrictEqual(out.structured, { ok: false });
    } finally { s.restore(); }
});

test('chatForcedTool forces object toolChoice for Mistral', async () => {
    const s = stubResolve(mistralAdapter, { content: null, toolCalls: [toolCall('emit_result', '{"ok":true}')] });
    try {
        await llmClient.chatForcedTool('mistral-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.deepStrictEqual(s.calls[0].options.toolChoice, { type: 'function', function: { name: 'emit_result' } });
    } finally { s.restore(); }
});

test("chatForcedTool forces single-tool-list + 'required' for Google", async () => {
    const s = stubResolve(googleAdapter, { content: null, toolCalls: [{ id: 'c', function: { name: 'emit_result' }, input: { ok: true } }] });
    try {
        const out = await llmClient.chatForcedTool('gemini-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        // Google has no object/name case → 'required' (mode ANY) with a single-tool list.
        assert.strictEqual(s.calls[0].options.toolChoice, 'required');
        assert.deepStrictEqual(s.calls[0].options.tools, [TOOL_DEF]);
        // Google args arrive already-parsed via `input`, not a JSON string.
        assert.deepStrictEqual(out.structured, { ok: true });
    } finally { s.restore(); }
});

// ─── chatForcedTool: untrusted output, never throws ─────────────────────────

test('chatForcedTool returns null structured when model emits no tool call (prose)', async () => {
    const s = stubResolve(openaiAdapter, { content: 'I refuse to use the tool', toolCalls: [] });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured, null);
        assert.strictEqual(out.content, 'I refuse to use the tool');
    } finally { s.restore(); }
});

test('chatForcedTool returns null structured on unparseable args without throwing', async () => {
    const s = stubResolve(openaiAdapter, { content: null, toolCalls: [toolCall('emit_result', '{not valid json')] });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured, null);
    } finally { s.restore(); }
});

test('chatForcedTool returns null structured when toolCalls absent entirely', async () => {
    const s = stubResolve(openaiAdapter, { content: 'hello' });
    try {
        const out = await llmClient.chatForcedTool('gpt-x', [{ role: 'user', content: 'hi' }], TOOL_DEF);
        assert.strictEqual(out.structured, null);
    } finally { s.restore(); }
});

// ─── runToolLoop: finalTool forcing on both exit paths ──────────────────────

test('runToolLoop with finalTool forces structured synthesis when model stops calling tools', async () => {
    // Round 1: a normal tool call. Round 2: model stops → forced finalTool synthesis.
    const s = stubResolve(openaiAdapter, (n) => {
        if (n === 1) return { content: null, toolCalls: [toolCall('search', '{"q":"x"}')] };
        if (n === 2) return { content: 'done thinking', toolCalls: [] };      // model stops
        return { content: null, toolCalls: [toolCall('final_emit', '{"summary":"ok"}')] }; // forced synthesis
    });
    try {
        const finalTool = { type: 'function', function: { name: 'final_emit', parameters: {} } };
        const res = await llmClient.runToolLoop(
            'gpt-x',
            [{ role: 'user', content: 'go' }],
            [{ type: 'function', function: { name: 'search' } }],
            { finalTool },
            async () => 'tool-result',
            5,
        );
        // 3 chats: round1 (auto), round2 (auto, no tools), synthesis (forced)
        assert.strictEqual(s.calls.length, 3);
        assert.strictEqual(s.calls[0].options.toolChoice, 'auto');
        assert.strictEqual(s.calls[1].options.toolChoice, 'auto');
        assert.deepStrictEqual(s.calls[2].options.toolChoice, { type: 'function', function: { name: 'final_emit' } });
        assert.deepStrictEqual(s.calls[2].options.tools, [finalTool]);
        assert.deepStrictEqual(res.structured, { summary: 'ok' });
        // finalTool must NOT leak into chat options as a stray field.
        assert.strictEqual(s.calls[0].options.finalTool, undefined);
    } finally { s.restore(); }
});

test('runToolLoop with finalTool forces structured synthesis on max-rounds-hit', async () => {
    // Always returns a tool call → never naturally exits → max rounds, then forced synthesis.
    const s = stubResolve(openaiAdapter, (n) => {
        if (n <= 2) return { content: null, toolCalls: [toolCall('search', '{}')] };
        return { content: null, toolCalls: [toolCall('final_emit', '{"summary":"capped"}')] };
    });
    try {
        const finalTool = { type: 'function', function: { name: 'final_emit', parameters: {} } };
        const res = await llmClient.runToolLoop(
            'gpt-x',
            [{ role: 'user', content: 'go' }],
            [{ type: 'function', function: { name: 'search' } }],
            { finalTool },
            async () => 'tool-result',
            2, // maxRounds
        );
        // 2 loop chats + 1 forced synthesis
        assert.strictEqual(s.calls.length, 3);
        assert.deepStrictEqual(s.calls[2].options.toolChoice, { type: 'function', function: { name: 'final_emit' } });
        assert.deepStrictEqual(res.structured, { summary: 'capped' });
        assert.strictEqual(res.toolCallRounds, 2);
    } finally { s.restore(); }
});

// ─── runToolLoop: backward compatibility when finalTool omitted ─────────────

test('runToolLoop without finalTool is unchanged (auto loop, final chat drops tools, structured null)', async () => {
    const s = stubResolve(openaiAdapter, (n) => {
        if (n <= 2) return { content: null, toolCalls: [toolCall('search', '{}')] };
        return { content: 'final prose', toolCalls: [] };
    });
    try {
        const res = await llmClient.runToolLoop(
            'gpt-x',
            [{ role: 'user', content: 'go' }],
            [{ type: 'function', function: { name: 'search' } }],
            {},
            async () => 'tool-result',
            2,
        );
        // Final (post-max-rounds) chat drops tools entirely.
        assert.strictEqual(s.calls[2].options.tools, undefined);
        assert.strictEqual(res.content, 'final prose');
        assert.strictEqual(res.structured, null);
    } finally { s.restore(); }
});

// ─── claude.js actually TRANSLATES the forced toolChoice shape ──────────────
// The tests above stub adapter.chat, so they only pin the SHAPE chatForcedTool
// emits — they never exercise the provider's own toolChoice → tool_choice
// mapping. claude.js previously only honoured a top-level `.name`, so the
// OpenAI wire shape {type:'function',function:{name}} that forcedToolChoice emits
// fell through and ran with tool_choice UNSET (auto) — the model declined the
// tool and every forced scan returned 0 suggestions. Pin the real mapping.

test('claude _buildSdkParams maps the OpenAI forced-tool shape to {type:tool,name}', () => {
    const params = claudeAdapter._buildSdkParams('claude-haiku-4-5', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF],
        toolChoice: { type: 'function', function: { name: 'emit_result' } },
    });
    assert.deepStrictEqual(params.tool_choice, { type: 'tool', name: 'emit_result' });
});

test('claude _buildSdkParams still honours the bare {name} forced-tool shape', () => {
    const params = claudeAdapter._buildSdkParams('claude-haiku-4-5', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF],
        toolChoice: { name: 'emit_result' },
    });
    assert.deepStrictEqual(params.tool_choice, { type: 'tool', name: 'emit_result' });
});

test("claude _buildSdkParams maps 'required'/'auto' to Anthropic shapes", () => {
    const req = claudeAdapter._buildSdkParams('claude-haiku-4-5', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF], toolChoice: 'required',
    });
    assert.deepStrictEqual(req.tool_choice, { type: 'any' });
    const auto = claudeAdapter._buildSdkParams('claude-haiku-4-5', [{ role: 'user', content: 'hi' }], {
        tools: [TOOL_DEF], toolChoice: 'auto',
    });
    assert.deepStrictEqual(auto.tool_choice, { type: 'auto' });
});

test('runToolLoop without finalTool: natural exit returns content and structured null', async () => {
    const s = stubResolve(openaiAdapter, { content: 'just an answer', toolCalls: [] });
    try {
        const res = await llmClient.runToolLoop(
            'gpt-x',
            [{ role: 'user', content: 'go' }],
            [{ type: 'function', function: { name: 'search' } }],
            {},
            async () => 'tool-result',
            5,
        );
        assert.strictEqual(s.calls.length, 1);
        assert.strictEqual(s.calls[0].options.toolChoice, 'auto');
        assert.strictEqual(res.content, 'just an answer');
        assert.strictEqual(res.structured, null);
    } finally { s.restore(); }
});
