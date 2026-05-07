/**
 * Unit tests for matchGmailMailFilter.
 *
 * Run: node automation/triggerBus.test.js
 *
 * Pure function — no DB required. Stub out the automationStore require
 * so the rest of triggerBus.js (poller wiring, etc.) doesn't try to
 * reach the database during module load.
 */

const assert = require('assert');
const path = require('path');

// Stub automationStore so loading triggerBus doesn't run initDB().
const storePath = require.resolve('../stores/automationStore');
require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
        getSubscriptionsForProvider: async () => [],
        updateSubscription: async () => null,
        getPollingSubscriptions: async () => [],
        getExpiringSubscriptions: async () => [],
    },
};

const { matchGmailMailFilter } = require('./triggerBus');

const baseMsg = {
    messageId: 'm1',
    threadId: 't1',
    from: 'Boss Smith <boss@example.com>',
    to: 'me@example.com',
    cc: '',
    subject: 'Order #1234 — payment received',
    date: new Date().toUTCString(),
    snippet: 'Thanks for your order',
    labelIds: ['INBOX', 'IMPORTANT', 'Label_3'],
    sizeEstimate: 12345,
};

// ── No filter → match everything ────────────────────────────────────────
assert.strictEqual(matchGmailMailFilter(baseMsg, null), true);
assert.strictEqual(matchGmailMailFilter(baseMsg, {}), true);

// ── from: substring match against the whole header ─────────────────────
assert.strictEqual(matchGmailMailFilter(baseMsg, { from: 'boss@example.com' }), true);
assert.strictEqual(matchGmailMailFilter(baseMsg, { from: 'BOSS@example.com' }), true, 'case-insensitive');
assert.strictEqual(matchGmailMailFilter(baseMsg, { from: 'someone-else@x.com' }), false);

// ── to / cc same semantics ─────────────────────────────────────────────
assert.strictEqual(matchGmailMailFilter(baseMsg, { to: 'me@example.com' }), true);
assert.strictEqual(matchGmailMailFilter(baseMsg, { to: 'other@example.com' }), false);

// ── subject contains / regex ───────────────────────────────────────────
assert.strictEqual(matchGmailMailFilter(baseMsg, { subjectContains: 'order' }), true, 'CI substring');
assert.strictEqual(matchGmailMailFilter(baseMsg, { subjectContains: 'invoice' }), false);
assert.strictEqual(matchGmailMailFilter(baseMsg, { subjectRegex: '^Order #\\d+' }), true);
assert.strictEqual(matchGmailMailFilter(baseMsg, { subjectRegex: '^Invoice' }), false);
// Invalid regex → fail-closed (no match), not exception, not pass-through
assert.strictEqual(matchGmailMailFilter(baseMsg, { subjectRegex: '[unterminated' }), false);

// ── labelIds: any-of ───────────────────────────────────────────────────
assert.strictEqual(matchGmailMailFilter(baseMsg, { labelIds: ['Label_3'] }), true);
assert.strictEqual(matchGmailMailFilter(baseMsg, { labelIds: ['Label_99'] }), false);
assert.strictEqual(matchGmailMailFilter(baseMsg, { labelIds: ['Label_99', 'IMPORTANT'] }), true, 'OR within array');

// ── excludeLabelIds: must have NONE ────────────────────────────────────
assert.strictEqual(matchGmailMailFilter(baseMsg, { excludeLabelIds: ['SPAM'] }), true);
assert.strictEqual(matchGmailMailFilter(baseMsg, { excludeLabelIds: ['IMPORTANT'] }), false);

// ── hasAttachment ──────────────────────────────────────────────────────
assert.strictEqual(matchGmailMailFilter(baseMsg, { hasAttachment: true }), false);
assert.strictEqual(matchGmailMailFilter({ ...baseMsg, labelIds: [...baseMsg.labelIds, 'HAS_ATTACHMENT'] }, { hasAttachment: true }), true);

// ── excludeFromSelf ────────────────────────────────────────────────────
assert.strictEqual(matchGmailMailFilter(baseMsg, { excludeFromSelf: true }), true);
assert.strictEqual(matchGmailMailFilter({ ...baseMsg, labelIds: [...baseMsg.labelIds, 'SENT'] }, { excludeFromSelf: true }), false);

// ── maxAgeMinutes (freshness cap) ──────────────────────────────────────
const oldMsg = { ...baseMsg, date: new Date(Date.now() - 90 * 60_000).toUTCString() };
assert.strictEqual(matchGmailMailFilter(oldMsg, { maxAgeMinutes: 30 }), false, 'older than cap → drop');
assert.strictEqual(matchGmailMailFilter(oldMsg, { maxAgeMinutes: 120 }), true, 'within cap → keep');
assert.strictEqual(matchGmailMailFilter({ ...baseMsg, date: 'not-a-date' }, { maxAgeMinutes: 30 }), false, 'unparseable date → drop');

// ── Combined: AND across keys ──────────────────────────────────────────
assert.strictEqual(matchGmailMailFilter(baseMsg, {
    from: 'boss@example.com',
    subjectContains: 'order',
    labelIds: ['Label_3'],
}), true);
assert.strictEqual(matchGmailMailFilter(baseMsg, {
    from: 'boss@example.com',
    subjectContains: 'invoice', // doesn't match — whole filter fails
}), false);

console.log('triggerBus.test.js — all checks passed');
