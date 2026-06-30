/**
 * Unit tests — Mistral provider tool_choice mapping (§C4).
 *
 * Plain assert-based suite (no jest/mocha in this repo).
 * Run: node core/providers/mistral.test.js
 *
 * Mistral expects 'auto' | 'any' | 'none' | a function object. Our stack emits
 * 'required' (OpenAI's word) for "must call a tool" — Mistral calls that 'any'.
 * Without this mapping the forced-first-tool turn (small Mistral models) broke.
 */

const assert = require('assert');
const MistralProvider = require('./mistral');

const p = new MistralProvider();

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('mistral mapToolChoice');

t("maps 'required' → 'any' (Mistral's must-call value)", () => {
    assert.strictEqual(p.mapToolChoice('required'), 'any');
});

t("passes 'auto' / 'none' / 'any' through unchanged", () => {
    assert.strictEqual(p.mapToolChoice('auto'), 'auto');
    assert.strictEqual(p.mapToolChoice('none'), 'none');
    assert.strictEqual(p.mapToolChoice('any'), 'any');
});

t('defaults to "auto" when unset', () => {
    assert.strictEqual(p.mapToolChoice(undefined), 'auto');
    assert.strictEqual(p.mapToolChoice(null), 'auto');
});

t('passes a specific function tool_choice object through', () => {
    const fn = { type: 'function', function: { name: 'builder_propose_trigger' } };
    assert.strictEqual(p.mapToolChoice(fn), fn);
});

console.log(`\nmistral.test.js: ${passed} assertions passed`);
