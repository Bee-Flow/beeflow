'use strict';

// Focused unit tests for the tokenise/restore round-trip correctness fixes
// (single-pass restoreTokens — no cross-token cascade). Run: node --test.

const { test } = require('node:test');
const assert = require('node:assert');

const { tokenizeText, restoreTokens, restoreTokensInRichText } = require('./piiDetection');

test('restoreTokens restores a single token, including repeated occurrences', () => {
    const map = { '[email_1]': 'jack@example.com' };
    assert.strictEqual(
        restoreTokens('Mail [email_1] and again [email_1].', map),
        'Mail jack@example.com and again jack@example.com.',
    );
});

test('restoreTokens does NOT cascade when one real value contains another token literal', () => {
    // [a_1] -> "see [b_1]" ; if restoration were sequential and [a_1] ran first,
    // a later [b_1] pass would wrongly substitute inside the just-restored text.
    const map = { '[a_1]': 'see [b_1] here', '[b_1]': 'SECRET' };
    // Single-pass: [a_1] becomes the literal "see [b_1] here" and is NOT re-scanned.
    assert.strictEqual(restoreTokens('start [a_1] end', map), 'start see [b_1] here end');
});

test('restoreTokens disambiguates [x_1] vs [x_10] (no prefix collision)', () => {
    const map = { '[person_1]': 'Ann', '[person_10]': 'Bob' };
    assert.strictEqual(
        restoreTokens('[person_10] then [person_1]', map),
        'Bob then Ann',
    );
});

test('tokenize → restore is identity for duplicate values at distinct offsets', () => {
    const text = 'Jack Smith and Jack Brown';
    // Two distinct people both starting with "Jack" — offsets must not collide.
    const entities = [
        { category: 'person', text: 'Jack Smith', offset: 0, length: 10 },
        { category: 'person', text: 'Jack Brown', offset: 15, length: 10 },
    ];
    const { tokenizedText, tokenMap } = tokenizeText(text, entities);
    assert.ok(!tokenizedText.includes('Jack'), 'both names tokenised');
    assert.strictEqual(restoreTokens(tokenizedText, tokenMap), text);
});

test('restoreTokens is a no-op with an empty map or empty text', () => {
    assert.strictEqual(restoreTokens('hello [email_1]', {}), 'hello [email_1]');
    assert.strictEqual(restoreTokens('', { '[email_1]': 'x' }), '');
});

// ── Drift-tolerant restore ──────────────────────────────────────────────
// The model naturalises tokens while writing long documents — drops the
// underscore or pushes the counter outside the brackets — so the exact-match
// pass misses them. Pass 2 normalises bracketed token-like spans and restores.

test('restoreTokens restores tokens the model mangled (dropped underscore)', () => {
    const map = { '[person_2]': 'Jane Doe' };
    assert.strictEqual(restoreTokens('Ondergetekende, [person2], wonende', map), 'Ondergetekende, Jane Doe, wonende');
});

test('restoreTokens restores a counter pushed outside the brackets ([email]2)', () => {
    const map = { '[email_2]': 'jane@example.nl' };
    assert.strictEqual(restoreTokens('Mail: [email]2 graag', map), 'Mail: jane@example.nl graag');
    // and the `[person] 2` (space) variant
    assert.strictEqual(restoreTokens('consulent [person] 1', { '[person_1]': 'Piet' }), 'consulent Piet');
});

test('restoreTokens restores capitalised / spaced drift ([Person 2])', () => {
    const map = { '[person_2]': 'Jane Doe' };
    assert.strictEqual(restoreTokens('zie [Person 2] hierboven', map), 'zie Jane Doe hierboven');
    assert.strictEqual(restoreTokens('zie [ person_2 ] hierboven', map), 'zie Jane Doe hierboven');
});

test('restoreTokens drift pass handles repeated + multiple mangled tokens', () => {
    const map = { '[person_1]': 'Ann', '[person_2]': 'Bob', '[email_2]': 'a@b.nl' };
    assert.strictEqual(
        restoreTokens('[person1] schreef aan [person2]; mail [email]2; nogmaals [person1].', map),
        'Ann schreef aan Bob; mail a@b.nl; nogmaals Ann.',
    );
});

test('restoreTokens: exact token followed by an unrelated digit keeps the digit', () => {
    // Exact pass runs first, so `[person_2]` restores and the literal "5" stays.
    const map = { '[person_2]': 'Jane' };
    assert.strictEqual(restoreTokens('[person_2]5 dossiers', map), 'Jane5 dossiers');
    // Same protection on the drifted form: bracket-only fallback keeps the digit.
    assert.strictEqual(restoreTokens('[person2]5 dossiers', map), 'Jane5 dossiers');
});

test('restoreTokens leaves non-token bracketed text untouched', () => {
    const map = { '[person_2]': 'Jane', '[email_2]': 'j@x.nl' };
    assert.strictEqual(restoreTokens('zie [exhibit] 3 voor details', map), 'zie [exhibit] 3 voor details');
    assert.strictEqual(restoreTokens('[click here](https://x.nl) en [note]', map), '[click here](https://x.nl) en [note]');
});

test('restoreTokens drift pass does not corrupt a restored value containing brackets', () => {
    // Real value itself has a `[...]`; exact pass restores it, drift pass must
    // not re-match the brackets inside the now-real text (norm "jr" not a key).
    const map = { '[person_1]': 'Smith [Jr]' };
    assert.strictEqual(restoreTokens('client [person_1] today', map), 'client Smith [Jr] today');
});

// ── restoreTokensInRichText — tokens broken by HTML/Markdown formatting ──────
// A token typed in italic/bold gets split by inline tags or has its brackets /
// underscore escaped, so plain restoreTokens leaves it raw in the document.

test('restoreTokensInRichText restores tokens split by inline HTML emphasis', () => {
    const map = { '[person_4]': 'Dhr. T. Kooy' };
    assert.ok(restoreTokensInRichText('[person<em>4</em>]', map).includes('Dhr. T. Kooy'));
    assert.ok(restoreTokensInRichText('<strong>[person_4]</strong>', map).includes('Dhr. T. Kooy'));
});

test('restoreTokensInRichText restores markdown-escaped tokens', () => {
    const map = { '[person_4]': 'Dhr. T. Kooy', '[email_1]': 'a@b.nl' };
    assert.strictEqual(restoreTokensInRichText('\\[person\\_4\\]', map), 'Dhr. T. Kooy');
    assert.strictEqual(restoreTokensInRichText('[person\\_4]', map), 'Dhr. T. Kooy');
    assert.strictEqual(restoreTokensInRichText('\\[email\\_1\\]', map), 'a@b.nl');
});

test('restoreTokensInRichText still restores clean + drifted tokens (fast path)', () => {
    const map = { '[person_2]': 'Mw. Duinhoven' };
    assert.strictEqual(restoreTokensInRichText('Cliënt: [person_2].', map), 'Cliënt: Mw. Duinhoven.');
    assert.strictEqual(restoreTokensInRichText('*[person2]* (partner)', map), '*Mw. Duinhoven* (partner)');
});

test('restoreTokensInRichText leaves non-token brackets / markdown links untouched', () => {
    const map = { '[person_4]': 'Dhr. T. Kooy' };
    assert.strictEqual(restoreTokensInRichText('[exhibit] 3', map), '[exhibit] 3');
    assert.strictEqual(restoreTokensInRichText('[click here](http://x.nl)', map), '[click here](http://x.nl)');
});
