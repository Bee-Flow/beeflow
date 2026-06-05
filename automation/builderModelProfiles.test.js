/**
 * Unit tests for model-class banding used by the automation builder.
 *
 * Run: node automation/builderModelProfiles.test.js
 */

const assert = require('assert');
const { classifyModel } = require('./builderModelProfiles');

// ── Small band (lean prompt, core toolset, filtered catalog) ──
for (const id of [
    'claude-haiku-4-5-20251001',
    'gpt-5-mini',
    'gemini-3.1-flash',
    'ministral-8b',
    'qwen2.5-3b',
    'mistral-small-latest',
]) {
    assert.strictEqual(classifyModel(id), 'small', `${id} should be small`);
}

// ── Mid band (default) ──
for (const id of ['claude-sonnet-4-6', 'gpt-4o', 'gpt-4.1', 'mistral-medium-latest']) {
    assert.strictEqual(classifyModel(id), 'mid', `${id} should be mid`);
}

// ── Frontier band ──
for (const id of ['claude-opus-4-8', 'mistral-large-latest']) {
    assert.strictEqual(classifyModel(id), 'frontier', `${id} should be frontier`);
}

// ── Reasoning overlay (thinking/magistral) ──
for (const id of ['magistral-medium', 'some-thinking-model']) {
    assert.strictEqual(classifyModel(id), 'reasoning', `${id} should be reasoning`);
}

// ── Empty / unknown falls back to mid ──
assert.strictEqual(classifyModel(''), 'mid', 'empty id → mid');
assert.strictEqual(classifyModel(null), 'mid', 'null id → mid');

console.log('builderModelProfiles.test.js: all classifyModel tests passed');
