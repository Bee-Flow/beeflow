/**
 * Unit tests — OpenAI/Azure model capability helpers.
 *
 * Plain assert-based suite (no jest/mocha in this repo).
 * Run: node core/providers/openaiModelCaps.test.js
 */

const assert = require('assert');
const {
    clampEffort,
    buildReasoningParams,
    defaultVerbosity,
    supportsVerbosity,
    supportsParallelToolCalls,
    mapToolChoice,
    isProModel,
} = require('./openaiModelCaps');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// ─── clampEffort ──────────────────────────────────────────────────────────
console.log('clampEffort');
t('returns null when no effort requested', () => {
    assert.strictEqual(clampEffort('gpt-5', undefined), null);
    assert.strictEqual(clampEffort('gpt-5', ''), null);
});
t('passes minimal through on the GPT-5 family', () => {
    assert.strictEqual(clampEffort('gpt-5', 'minimal'), 'minimal');
    assert.strictEqual(clampEffort('gpt-5-mini', 'minimal'), 'minimal');
    assert.strictEqual(clampEffort('gpt-5.4-nano', 'minimal'), 'minimal');
});
t('floors minimal to low on o-series (no minimal tier)', () => {
    assert.strictEqual(clampEffort('o3', 'minimal'), 'low');
    assert.strictEqual(clampEffort('o4-mini', 'minimal'), 'low');
});
t('keeps xhigh only for codex-max, caps elsewhere', () => {
    assert.strictEqual(clampEffort('gpt-5.1-codex-max', 'xhigh'), 'xhigh');
    assert.strictEqual(clampEffort('gpt-5', 'xhigh'), 'high');
    assert.strictEqual(clampEffort('gpt-5.2', 'xhigh'), 'high');
});
t('locks pro models to high regardless of requested effort', () => {
    assert.strictEqual(clampEffort('gpt-5-pro', 'minimal'), 'high');
    assert.strictEqual(clampEffort('gpt-5.2-pro', 'low'), 'high');
    assert.strictEqual(clampEffort('gpt-5.4-pro', 'medium'), 'high');
});
t('passes valid efforts through unchanged', () => {
    assert.strictEqual(clampEffort('gpt-5', 'low'), 'low');
    assert.strictEqual(clampEffort('gpt-5', 'medium'), 'medium');
    assert.strictEqual(clampEffort('gpt-5', 'high'), 'high');
    assert.strictEqual(clampEffort('gpt-5', 'none'), 'none');
});

// ─── buildReasoningParams ───────────────────────────────────────────────────
console.log('buildReasoningParams');
t('omits summary entirely when not requested (never "concise")', () => {
    const r = buildReasoningParams('gpt-5', { reasoningEffort: 'medium', reasoningSummary: false });
    assert.strictEqual(r.effort, 'medium');
    assert.ok(!('summary' in r), 'summary should be absent');
});
t('uses auto summary when enabled', () => {
    const r = buildReasoningParams('gpt-5', { reasoningEffort: 'high', reasoningSummary: true });
    assert.strictEqual(r.summary, 'auto');
});
t('honours detailed summary', () => {
    const r = buildReasoningParams('gpt-5', { reasoningSummary: 'detailed' });
    assert.strictEqual(r.summary, 'detailed');
});
t('never emits the GPT-5-unsupported "concise" value', () => {
    for (const v of [false, true, 'detailed', undefined]) {
        const r = buildReasoningParams('gpt-5', { reasoningSummary: v });
        assert.notStrictEqual(r.summary, 'concise');
    }
});
t('defaults effort to medium when unset, clamps pro to high', () => {
    assert.strictEqual(buildReasoningParams('gpt-5', {}).effort, 'medium');
    assert.strictEqual(buildReasoningParams('gpt-5-pro', { reasoningEffort: 'low' }).effort, 'high');
});

// ─── verbosity ──────────────────────────────────────────────────────────────
console.log('verbosity');
t('supportsVerbosity only for GPT-5 family', () => {
    assert.strictEqual(supportsVerbosity('gpt-5'), true);
    assert.strictEqual(supportsVerbosity('gpt-5-nano'), true);
    assert.strictEqual(supportsVerbosity('o3'), false);
    assert.strictEqual(supportsVerbosity('gpt-4o'), false);
});
t('defaultVerbosity is tier-aware and undefined for non-GPT-5', () => {
    assert.strictEqual(defaultVerbosity('gpt-5', 'fast'), 'low');
    assert.strictEqual(defaultVerbosity('gpt-5', 'writer'), 'high');
    assert.strictEqual(defaultVerbosity('gpt-5', 'thinking'), 'medium');
    assert.strictEqual(defaultVerbosity('o3', 'fast'), undefined);
});

// ─── tool helpers ─────────────────────────────────────────────────────────
console.log('tool helpers');
t('supportsParallelToolCalls is false only for minimal effort', () => {
    assert.strictEqual(supportsParallelToolCalls('minimal'), false);
    assert.strictEqual(supportsParallelToolCalls('low'), true);
    assert.strictEqual(supportsParallelToolCalls('high'), true);
});
t('mapToolChoice maps any/required, passes auto/none, defaults objects', () => {
    assert.strictEqual(mapToolChoice('any'), 'required');
    assert.strictEqual(mapToolChoice('required'), 'required');
    assert.strictEqual(mapToolChoice('auto'), 'auto');
    assert.strictEqual(mapToolChoice('none'), 'none');
    assert.strictEqual(mapToolChoice(undefined), undefined);
    const obj = { type: 'function', name: 'x' };
    assert.strictEqual(mapToolChoice(obj), obj);
});
t('isProModel matches gpt-5 pro variants only', () => {
    assert.ok(isProModel('gpt-5-pro'));
    assert.ok(isProModel('gpt-5.2-pro'));
    assert.ok(isProModel('gpt-5.4-pro'));
    assert.ok(!isProModel('gpt-5'));
    assert.ok(!isProModel('gpt-5-mini'));
});

console.log(`\n${passed} assertions passed.`);
