/**
 * Unit tests for the tool-boundary DLP behavior wired into chatStream.js:
 *   1. redactAndTokenizeToolResult — tokenize non-blocked PII, redact blocked
 *      PII, correct ordering (tokenize-then-redact).
 *   2. Round-trip: result-minted tokens merged into the conversation map are
 *      restored on the response (restoreTokens) AND restored to real values if
 *      the model later passes them into a tool (untokeniseToolArgs).
 *   3. Ordering: the block check operates on REAL values (args detokenized first).
 *   4. MF-6: a turn-1 user token survives a flood of result tokens (cap raised).
 *
 * Hermetic: stub `db` and `configStore` in require.cache so the DLP modules
 * load without a real database. The PII engine functions used here (tokenizeText,
 * restoreTokens) are pure and need no guard service.
 *
 * Run: node server/core/dlp/__tests__/toolBoundary.test.js
 */

const assert = require('assert');
const path = require('path');

// ── Stubs (load DLP modules without a DB) ──────────────────────────────
const dbPath = path.resolve(__dirname, '../../../db.js');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { async run() { return { rowCount: 0 }; }, async getOne() { return null; }, async getAll() { return []; }, async exec() {} },
};
const cfgPath = path.resolve(__dirname, '../../../stores/configStore.js');
require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: { async getConfig() { return null; }, async setConfig() { return true; }, async getAllConfig() { return {}; } },
};

const { redactAndTokenizeToolResult } = require('../toolResultRedact');
const { restoreTokens } = require('../../piiDetection');
const { untokeniseToolArgs } = require('../applyTokenMapToOutbound');
const dlpRunner = require('../dlpRunner');
const { isBlockedForTool } = require('../../orgShield');

let passed = 0;
function check(label, cond) { assert.ok(cond, label); passed++; console.log(`  ✓ ${label}`); }

// Build detectPii-shaped entities with correct offsets into `text`.
function ent(text, value, category, label) {
    return { text: value, category, label, offset: text.indexOf(value), length: value.length };
}

console.log('redactAndTokenizeToolResult (ordering: tokenize non-blocked, redact blocked):');
{
    const text = '{"to":"john@acme.com","name":"John Smith","note":"call 020-1234567"}';
    const entities = [
        ent(text, 'john@acme.com', 'Email', 'Email Address'),
        ent(text, 'John Smith', 'Person', 'Person Name'),
        ent(text, '020-1234567', 'PhoneNumber', 'Phone Number'),
    ];
    const r = redactAndTokenizeToolResult(text, entities, new Set(['Email']), {});
    check('blocked Email → [blocked:email] marker', r.content.includes('[blocked:email]'));
    check('non-blocked Person → token', /\[person_\d+\]/.test(r.content));
    check('non-blocked Phone → token', /\[phonenumber_\d+\]/.test(r.content));
    check('raw email removed', !r.content.includes('john@acme.com'));
    check('raw name removed', !r.content.includes('John Smith'));
    check('raw phone removed', !r.content.includes('020-1234567'));
    check('tokenMap maps person → real value', Object.values(r.tokenMap).includes('John Smith'));
    check('tokenMap maps phone → real value', Object.values(r.tokenMap).includes('020-1234567'));
    check('tokenMap does NOT contain the blocked email', !Object.values(r.tokenMap).includes('john@acme.com'));
    check('redactedLabels reports the blocked category', r.redactedLabels.includes('Email Address'));
    check('counts: 1 blocked, 2 tokenized', r.blockedCount === 1 && r.tokenizedCount === 2);
}
{
    // No block list → everything tokenized, nothing redacted.
    const text = 'contact alice@x.nl';
    const r = redactAndTokenizeToolResult(text, [ent(text, 'alice@x.nl', 'Email', 'Email Address')], new Set(), {});
    check('empty block set → email tokenized not blocked', /\[email_\d+\]/.test(r.content) && !r.content.includes('[blocked'));
}
check('no entities → passthrough', redactAndTokenizeToolResult('plain text', [], new Set(['Email']), {}).content === 'plain text');

console.log('round-trip: result tokens restore on response AND into later tool args:');
{
    const convId = 'conv-roundtrip-1';
    const text = 'Found contact John Smith';
    const entities = [ent(text, 'John Smith', 'Person', 'Person Name')];
    const r = redactAndTokenizeToolResult(text, entities, new Set(), dlpRunner.getConversationTokenMap(convId) || {});
    dlpRunner.mergeTokenMap(convId, r.tokenMap);
    const convMap = dlpRunner.getConversationTokenMap(convId);
    const personToken = Object.keys(r.tokenMap)[0];
    check('conv map gained the result token', convMap[personToken] === 'John Smith');
    // (i) restored for the user on the response stream
    check('restoreTokens restores result PII in the reply', restoreTokens(`I found ${personToken}.`, convMap) === 'I found John Smith.');
    // (ii) restored to the real value when the model passes it into a later tool
    const restoredArgs = untokeniseToolArgs({ query: `email ${personToken}` }, convMap);
    check('untokeniseToolArgs restores result token in a later tool arg', restoredArgs.query === 'email John Smith');
}

console.log('ordering: block check sees REAL values (args detokenized first):');
{
    const convMap = { '[email_1]': 'john@acme.com' };
    const realArgs = untokeniseToolArgs({ to: '[email_1]', subject: 'hi' }, convMap);
    check('detok turns [email_1] into the real email', realArgs.to === 'john@acme.com');
    // detectPii (mocked output) over the REAL args would surface Email…
    const detected = ['Email'];
    const policy = { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } };
    const verdict = isBlockedForTool('gmail_send', detected, policy);
    check('…and the block check then refuses the external tool', verdict.blocked === true && verdict.toolClass === 'external');
    // If the check had run on the still-tokenized arg, no Email category would
    // be detected and nothing would block — the ordering is what makes it work.
}

console.log('MF-6: turn-1 user token survives a flood of result tokens:');
{
    const convId = 'conv-flood-1';
    dlpRunner.mergeTokenMap(convId, { '[email_1]': 'user@x.nl' });          // turn-1 user PII
    const flood = {};
    for (let i = 0; i < 600; i++) flood[`[person_${i + 2}]`] = `Name ${i}`; // a KB/multi-tool-heavy turn
    dlpRunner.mergeTokenMap(convId, flood);
    const m = dlpRunner.getConversationTokenMap(convId);
    check('user token NOT evicted under a 600-token flood', m['[email_1]'] === 'user@x.nl');
    check('map size within the raised cap', Object.keys(m).length <= 2000);
}

console.log(`\nAll ${passed} assertions passed.`);
