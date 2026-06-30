'use strict';

// Unit tests for the streaming un-tokeniser, focused on the `restore` helper
// added for BFSF-253 (PII tokens must be reversed in the model's "thinking"
// stream, not just in content) plus a regression guard on push/flush.
// Run: node --test core/dlp/untokeniseStream.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const { createUntokeniser } = require('./untokeniseStream');

test('restore() reverses complete tokens in a one-shot (thinking) chunk', () => {
    const ut = createUntokeniser({ '[email_1]': 'jack@example.com', '[url_1]': 'https://beeflow.nl/app' });
    assert.strictEqual(
        ut.restore('I should email [email_1] and link [url_1] for them.'),
        'I should email jack@example.com and link https://beeflow.nl/app for them.',
    );
});

test('restore() is a no-op when the token map is empty', () => {
    const ut = createUntokeniser({});
    assert.strictEqual(ut.restore('nothing to do [email_1]'), 'nothing to do [email_1]');
});

test('restore() tolerates null/empty input', () => {
    const ut = createUntokeniser({ '[email_1]': 'jack@example.com' });
    assert.strictEqual(ut.restore(''), '');
    assert.strictEqual(ut.restore(undefined), '');
});

test('restore() records substitutions in getReplacedTokens (so the privacy panel still shows)', () => {
    const ut = createUntokeniser({ '[email_1]': 'jack@example.com' });
    ut.restore('reasoning about [email_1] twice: [email_1]');
    const replaced = ut.getReplacedTokens();
    assert.ok(replaced.has('[email_1]'));
    assert.strictEqual(replaced.get('[email_1]').count, 2);
    assert.strictEqual(replaced.get('[email_1]').value, 'jack@example.com');
});

test('restore() works with a live getter map (late-added tokens)', () => {
    let map = {};
    const ut = createUntokeniser(() => map);
    assert.strictEqual(ut.restore('[phone_1]'), '[phone_1]'); // not yet known
    map = { '[phone_1]': '+31 6 1234 5678' };
    assert.strictEqual(ut.restore('call [phone_1] now'), 'call +31 6 1234 5678 now');
});

test('push()/flush() still buffer a token split across two chunks (regression)', () => {
    const ut = createUntokeniser({ '[email_1]': 'jack@example.com' });
    // The token arrives split across two SSE chunks; push must hold the partial.
    const a = ut.push('contact [emai');
    const b = ut.push('l_1] please');
    const tail = ut.flush();
    assert.strictEqual((a + b + tail), 'contact jack@example.com please');
});

// ── Drift-tolerant streaming (parity with restoreTokens) ─────────────────

test('restore() reverses LLM-mangled tokens ([person2], [email]2, [Person 2])', () => {
    const ut = createUntokeniser({ '[person_2]': 'Jane Doe', '[email_2]': 'jane@x.nl' });
    assert.strictEqual(
        ut.restore('Beste [person2], mail naar [email]2 of vraag [Person 2].'),
        'Beste Jane Doe, mail naar jane@x.nl of vraag Jane Doe.',
    );
});

test('restore() drift match still records in getReplacedTokens under the canonical token', () => {
    const ut = createUntokeniser({ '[person_2]': 'Jane Doe' });
    ut.restore('[person2] en nogmaals [person2]');
    const replaced = ut.getReplacedTokens();
    assert.ok(replaced.has('[person_2]'));
    assert.strictEqual(replaced.get('[person_2]').count, 2);
    assert.strictEqual(replaced.get('[person_2]').value, 'Jane Doe');
});

test('restore() keeps a real token followed by an unrelated digit (no over-consume)', () => {
    const ut = createUntokeniser({ '[person_2]': 'Jane' });
    assert.strictEqual(ut.restore('[person_2]5 dossiers'), 'Jane5 dossiers');
    assert.strictEqual(ut.restore('[person2]5 dossiers'), 'Jane5 dossiers');
});

test('restore() leaves non-token bracketed text untouched', () => {
    const ut = createUntokeniser({ '[person_2]': 'Jane' });
    assert.strictEqual(ut.restore('zie [exhibit] 3 en [note]'), 'zie [exhibit] 3 en [note]');
});

test('push()/flush() restores a drift counter split across chunks ([email]2 | 3)', () => {
    const ut = createUntokeniser({ '[email_23]': 'big@list.nl' });
    const a = ut.push('mail [email]2');
    const b = ut.push('3 nu');
    const tail = ut.flush();
    assert.strictEqual((a + b + tail), 'mail big@list.nl nu');
});
