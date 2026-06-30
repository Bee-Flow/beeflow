/**
 * Unit tests for automation/diffSummary — the human-readable change summary
 * stored per version and mirrored in the builder's diff modal.
 *
 * Run: node --test automation/diffSummary.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { summarizeDefinitionDiff, summarizeDefinitionDiffLine } = require('./diffSummary');

test('no changes → empty phrases / formatting-only line', () => {
    const def = { steps: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] };
    assert.deepStrictEqual(summarizeDefinitionDiff(def, def), []);
    assert.strictEqual(summarizeDefinitionDiffLine(def, def), 'No structural changes');
});

test('key reordering is not a change', () => {
    const prev = { description: 'x', trigger: { kind: 'manual' } };
    const next = { trigger: { kind: 'manual' }, description: 'x' };
    assert.deepStrictEqual(summarizeDefinitionDiff(prev, next), []);
});

test('counts steps added / removed / changed by id', () => {
    const prev = { steps: [{ id: 'a', t: 1 }, { id: 'b' }, { id: 'c' }] };
    const next = { steps: [{ id: 'a', t: 2 }, { id: 'b' }, { id: 'd' }] }; // a changed, c removed, d added
    const phrases = summarizeDefinitionDiff(prev, next);
    assert.ok(phrases.includes('1 step added'), phrases.join(' | '));
    assert.ok(phrases.includes('1 step removed'), phrases.join(' | '));
    assert.ok(phrases.includes('1 step changed'), phrases.join(' | '));
});

test('pluralizes step counts', () => {
    const prev = { steps: [] };
    const next = { steps: [{ id: 'a' }, { id: 'b' }] };
    assert.deepStrictEqual(summarizeDefinitionDiff(prev, next), ['2 steps added']);
});

test('counts connections (edges) added and removed', () => {
    const prev = { edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] };
    const next = { edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'd' }] };
    const phrases = summarizeDefinitionDiff(prev, next);
    assert.ok(phrases.includes('1 connection added'), phrases.join(' | '));
    assert.ok(phrases.includes('1 connection removed'), phrases.join(' | '));
});

test('reports scalar/object field changes', () => {
    const prev = { description: 'old', notificationSettings: { onError: { enabled: true } } };
    const next = { description: 'new', notificationSettings: { onError: { enabled: false } } };
    const phrases = summarizeDefinitionDiff(prev, next);
    assert.ok(phrases.includes('Description changed'));
    assert.ok(phrases.includes('Notification settings changed'));
});

test('one-line summary joins with separators', () => {
    const prev = { steps: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }], description: 'x' };
    const next = { steps: [{ id: 'a' }, { id: 'b' }], edges: [], description: 'y' };
    assert.strictEqual(
        summarizeDefinitionDiffLine(prev, next),
        '1 step added · 1 connection removed · Description changed',
    );
});

test('tolerates non-object / missing definitions', () => {
    assert.deepStrictEqual(summarizeDefinitionDiff(null, undefined), []);
    assert.deepStrictEqual(summarizeDefinitionDiff({ steps: 'nope' }, {}), []);
});
