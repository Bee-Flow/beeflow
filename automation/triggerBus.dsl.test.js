/**
 * Unit tests for the rich filter DSL added in Phase 1.4.
 *
 * Covers any/none/expr/age combinators and the new Nextcloud matchers
 * (deck card moved, talk message, calendar upcoming).
 *
 * Run: node automation/triggerBus.dsl.test.js
 *
 * No DB required. Stubs automationStore so triggerBus loads cleanly.
 */

const assert = require('assert');

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
        incrementSubscriptionFailures: async () => ({ consecutiveFailures: 0, errorNotifiedAt: null }),
        resetSubscriptionFailures: async () => null,
        getAutomation: async () => null,
    },
};

const tb = require('./triggerBus');

// ── applyDslFilter — any[] ─────────────────────────────────────────────
{
    const payload = { path: '/Receipts/2026.pdf', extension: 'pdf' };
    const filter = { any: [{ inFolder: '/Invoices/' }, { inFolder: '/Receipts/' }] };
    const ok = tb.applyDslFilter(payload, filter, tb.matchNextcloudFileFilter);
    assert.strictEqual(ok, true, 'any[] passes when one branch matches');
}
{
    const payload = { path: '/Other/file.pdf' };
    const filter = { any: [{ inFolder: '/Invoices/' }, { inFolder: '/Receipts/' }] };
    const ok = tb.applyDslFilter(payload, filter, tb.matchNextcloudFileFilter);
    assert.strictEqual(ok, false, 'any[] rejects when no branch matches');
}

// ── applyDslFilter — none[] ────────────────────────────────────────────
{
    const payload = { path: '/Invoices/x.pdf', extension: 'pdf' };
    const filter = { none: [{ extension: 'tmp' }] };
    const ok = tb.applyDslFilter(payload, filter, tb.matchNextcloudFileFilter);
    assert.strictEqual(ok, true, 'none[] passes when no branch matches');
}
{
    const payload = { path: '/Invoices/x.tmp', extension: 'tmp' };
    const filter = { none: [{ extension: 'tmp' }] };
    const ok = tb.applyDslFilter(payload, filter, tb.matchNextcloudFileFilter);
    assert.strictEqual(ok, false, 'none[] rejects when one branch matches');
}

// ── applyDslFilter — expr ──────────────────────────────────────────────
{
    const payload = { size: 2_000_000 };
    const filter = { expr: 'trigger.size > 1000000' };
    const ok = tb.applyDslFilter(payload, filter, () => true);
    assert.strictEqual(ok, true, 'expr passes when boolean is truthy');
}
{
    const payload = { size: 100 };
    const filter = { expr: 'trigger.size > 1000000' };
    const ok = tb.applyDslFilter(payload, filter, () => true);
    assert.strictEqual(ok, false, 'expr rejects when boolean is falsy');
}
{
    const payload = { size: 100 };
    const filter = { expr: '(((' }; // invalid grammar
    const ok = tb.applyDslFilter(payload, filter, () => true);
    assert.strictEqual(ok, false, 'invalid expr fails closed');
}

// ── applyDslFilter — age ───────────────────────────────────────────────
{
    const recent = { datetime: new Date().toISOString() };
    const filter = { age: { olderThanMinutes: 60 } };
    const ok = tb.applyDslFilter(recent, filter, () => true);
    assert.strictEqual(ok, false, 'age.olderThanMinutes rejects fresh events');
}
{
    const old = { datetime: new Date(Date.now() - 2 * 60 * 60_000).toISOString() };
    const filter = { age: { olderThanMinutes: 60 } };
    const ok = tb.applyDslFilter(old, filter, () => true);
    assert.strictEqual(ok, true, 'age.olderThanMinutes passes for old events');
}

// ── applyDslFilter combines AND with structured filter ─────────────────
{
    const payload = { path: '/Invoices/x.pdf', extension: 'pdf' };
    const filter = { extension: 'pdf', any: [{ inFolder: '/Invoices/' }, { inFolder: '/Receipts/' }] };
    const ok = tb.applyDslFilter(payload, filter, tb.matchNextcloudFileFilter);
    assert.strictEqual(ok, true, 'structured + any[] both must match (AND)');
}
{
    const payload = { path: '/Invoices/x.txt', extension: 'txt' };
    const filter = { extension: 'pdf', any: [{ inFolder: '/Invoices/' }] };
    const ok = tb.applyDslFilter(payload, filter, tb.matchNextcloudFileFilter);
    assert.strictEqual(ok, false, 'structured filter still applies (extension mismatch)');
}

// ── New matchers — deck card moved ─────────────────────────────────────
{
    const payload = { boardId: 1, fromStackId: 5, toStackId: 9, title: 'Onboard new hire' };
    assert.strictEqual(tb.matchNextcloudDeckCardMovedFilter(payload, { boardId: 1 }), true);
    assert.strictEqual(tb.matchNextcloudDeckCardMovedFilter(payload, { boardId: 2 }), false);
    assert.strictEqual(tb.matchNextcloudDeckCardMovedFilter(payload, { fromStackId: 5, toStackId: 9 }), true);
    assert.strictEqual(tb.matchNextcloudDeckCardMovedFilter(payload, { toStackId: 7 }), false);
    assert.strictEqual(tb.matchNextcloudDeckCardMovedFilter(payload, { titleContains: 'onboard' }), true);
}

// ── New matchers — talk message ────────────────────────────────────────
{
    const payload = { roomToken: 'abc', actor: 'alice', message: 'Hello team', isOwn: false };
    assert.strictEqual(tb.matchNextcloudTalkMessageFilter(payload, { roomToken: 'abc' }), true);
    assert.strictEqual(tb.matchNextcloudTalkMessageFilter(payload, { roomToken: 'xyz' }), false);
    assert.strictEqual(tb.matchNextcloudTalkMessageFilter(payload, { messageContains: 'team' }), true);
    assert.strictEqual(tb.matchNextcloudTalkMessageFilter(payload, { actorEquals: 'alice' }), true);
    assert.strictEqual(tb.matchNextcloudTalkMessageFilter({ ...payload, isOwn: true }, { excludeOwnMessages: true }), false);
}

// ── New matchers — calendar upcoming ──────────────────────────────────
{
    const inTen = new Date(Date.now() + 10 * 60_000).toISOString();
    const inHour = new Date(Date.now() + 60 * 60_000).toISOString();
    const past = new Date(Date.now() - 5 * 60_000).toISOString();
    assert.strictEqual(tb.matchNextcloudCalendarUpcomingFilter({ startsAt: inTen }, { leadMinutes: 15 }), true);
    assert.strictEqual(tb.matchNextcloudCalendarUpcomingFilter({ startsAt: inHour }, { leadMinutes: 15 }), false, 'further out than leadMinutes');
    assert.strictEqual(tb.matchNextcloudCalendarUpcomingFilter({ startsAt: past }, { leadMinutes: 15 }), false, 'past events do not fire');
}

// ── New matchers — share generic ──────────────────────────────────────
{
    const payload = { actor: 'alice', name: 'budget.xlsx', kind: 'file', shareType: 'link' };
    assert.strictEqual(tb.matchNextcloudShareGenericFilter(payload, { shareType: 'link' }), true);
    assert.strictEqual(tb.matchNextcloudShareGenericFilter(payload, { shareType: 'user' }), false);
    assert.strictEqual(tb.matchNextcloudShareGenericFilter(payload, { kindEquals: 'folder' }), false);
}

console.log('triggerBus.dsl.test.js — all checks passed');
