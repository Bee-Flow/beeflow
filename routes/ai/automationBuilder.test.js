/**
 * Unit tests for the automation-builder route's internal helpers:
 * parseToolArgs, isTransientChatError, chatWithRetry, applyBuilderTierFloor.
 *
 * Run: node routes/ai/automationBuilder.test.js
 *
 * No HTTP/DB needed — we exercise the exported `_test` helpers directly.
 * (Requiring the route opens a DB pool, so we process.exit at the end.)
 */

const assert = require('assert');
const { parseToolArgs, isTransientChatError, chatWithRetry, applyBuilderTierFloor, validateLayerForSummary, sanitiseLayerSummary } = require('./automationBuilder')._test;

(async () => {
    // ── parseToolArgs ──
    assert.deepStrictEqual(parseToolArgs('{"a":1}', 'builder_add_action'), { args: { a: 1 }, truncated: false }, 'valid JSON parses');
    assert.deepStrictEqual(parseToolArgs({ a: 1 }, 'builder_add_action'), { args: { a: 1 }, truncated: false }, 'object passthrough');
    assert.deepStrictEqual(parseToolArgs('', 'builder_summarise'), { args: {}, truncated: false }, 'empty args ok for paramless tool');
    assert.deepStrictEqual(parseToolArgs('', 'builder_add_action'), { args: {}, truncated: false }, 'empty string is not a truncation');
    assert.deepStrictEqual(parseToolArgs('{}', 'builder_add_action'), { args: {}, truncated: false }, '"{}" is valid empty args');
    {
        const r = parseToolArgs('{"tool":"gmail_search","inputs":{"q":', 'builder_add_action');
        assert.strictEqual(r.truncated, true, 'truncated JSON for a param tool flags truncated');
        assert.deepStrictEqual(r.args, {}, 'truncated args resolve to {}');
    }
    assert.strictEqual(parseToolArgs('not json', 'builder_finalize').truncated, false, 'bad args for paramless tool is not a truncation');

    // ── isTransientChatError ──
    assert.strictEqual(isTransientChatError({ status: 429 }), true, '429 is transient');
    assert.strictEqual(isTransientChatError({ status: 503 }), true, '503 is transient');
    assert.strictEqual(isTransientChatError({ status: 401 }), false, '401 is permanent');
    assert.strictEqual(isTransientChatError({ status: 400 }), false, '400 is permanent');
    assert.strictEqual(isTransientChatError(new Error('Rate limit exceeded')), true, 'rate-limit message is transient');
    assert.strictEqual(isTransientChatError(new Error('socket hang up')), true, 'network message is transient');
    assert.strictEqual(isTransientChatError(new Error('invalid api key')), false, 'auth message is permanent');

    // ── chatWithRetry ──
    {
        let calls = 0;
        const adapter = { chat: async () => { calls++; if (calls < 3) throw Object.assign(new Error('overloaded'), { status: 503 }); return 'ok'; } };
        const res = await chatWithRetry(adapter, { apiKey: 'k', url: 'u' }, 'm', [], {}, { retries: 2, baseDelayMs: 1 });
        assert.strictEqual(res, 'ok', 'returns success after transient retries');
        assert.strictEqual(calls, 3, 'retried twice then succeeded (3 calls)');
    }
    {
        let calls = 0;
        const adapter = { chat: async () => { calls++; throw Object.assign(new Error('bad key'), { status: 401 }); } };
        await assert.rejects(() => chatWithRetry(adapter, { apiKey: 'k', url: 'u' }, 'm', [], {}, { retries: 2, baseDelayMs: 1 }), /bad key/, 'permanent error rethrows');
        assert.strictEqual(calls, 1, 'permanent error is not retried');
    }
    {
        let calls = 0;
        const adapter = { chat: async () => { calls++; throw Object.assign(new Error('boom'), { status: 500 }); } };
        await assert.rejects(() => chatWithRetry(adapter, { apiKey: 'k', url: 'u' }, 'm', [], {}, { retries: 2, baseDelayMs: 1 }), /boom/, 'exhausts then throws');
        assert.strictEqual(calls, 3, 'tried retries+1 (3) times');
    }

    // ── applyBuilderTierFloor ──
    {
        const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'claude-sonnet-4-6' }, thinking: { modelId: 'claude-opus-4-8' } };
        const r = applyBuilderTierFloor('fast', 'ministral-8b', tiers);
        assert.strictEqual(r.tier, 'standard', 'small model is floored to the first non-small tier');
        assert.strictEqual(r.modelId, 'claude-sonnet-4-6', 'floored model id is the standard tier model');
    }
    {
        const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'claude-sonnet-4-6' } };
        const r = applyBuilderTierFloor('standard', 'claude-sonnet-4-6', tiers);
        assert.strictEqual(r.modelId, 'claude-sonnet-4-6', 'non-small model is left unchanged');
        assert.strictEqual(r.tier, 'standard', 'non-small tier is left unchanged');
    }
    {
        // Small-only org: no non-small tier to floor to → unchanged.
        const tiers = { fast: { modelId: 'ministral-8b' }, standard: { modelId: 'gpt-5-mini' } };
        const r = applyBuilderTierFloor('fast', 'ministral-8b', tiers);
        assert.strictEqual(r.modelId, 'ministral-8b', 'small-only org keeps the small model');
        assert.strictEqual(r.tier, 'fast', 'small-only org keeps the resolved tier');
    }

    // ── validateLayerForSummary ──
    assert.strictEqual(validateLayerForSummary({ steps: [] }), null, 'empty-but-valid layer passes');
    assert.strictEqual(validateLayerForSummary({ title: 'x', steps: [{ id: 's1', type: 'code' }] }), null, 'layer with steps passes');
    assert.ok(validateLayerForSummary(null), 'null layer rejected');
    assert.ok(validateLayerForSummary('nope'), 'string layer rejected');
    assert.ok(validateLayerForSummary([]), 'array layer rejected');
    assert.ok(validateLayerForSummary({ title: 'x' }), 'layer without steps array rejected');
    assert.ok(validateLayerForSummary({ steps: {} }), 'non-array steps rejected');
    assert.ok(validateLayerForSummary({ steps: new Array(201).fill({ id: 'x', type: 'code' }) }), 'oversized layer rejected');

    // ── sanitiseLayerSummary ──
    assert.strictEqual(sanitiseLayerSummary('  Looks up the contact.  '), 'Looks up the contact.', 'trims surrounding whitespace');
    assert.strictEqual(sanitiseLayerSummary('"Sends a digest email."'), 'Sends a digest email.', 'strips surrounding straight quotes');
    assert.strictEqual(sanitiseLayerSummary('“Smart quotes here”'), 'Smart quotes here', 'strips surrounding smart quotes');
    assert.strictEqual(sanitiseLayerSummary('a\n\n  b   c'), 'a b c', 'collapses internal whitespace runs');
    assert.strictEqual(sanitiseLayerSummary(null), '', 'null → empty string');
    assert.strictEqual(sanitiseLayerSummary(undefined), '', 'undefined → empty string');
    assert.ok(sanitiseLayerSummary('x'.repeat(400)).length <= 280, 'caps very long output at 280 chars');

    console.log('automationBuilder.test.js: all helper tests passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
