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

const {
    matchGmailMailFilter,
    matchGmailLabelFilter,
    matchCalendarChangedFilter,
    matchCalendarUpcomingFilter,
    matchDriveFileNewFilter,
    matchNextcloudFileFilter,
    matchNextcloudShareFilter,
    matchNextcloudActivityFilter,
    matchNextcloudNotificationFilter,
    matchTicketAssistantTicketNewFilter,
    matchTicketAssistantSyncFilter,
} = require('./triggerBus');

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

// ── matchGmailLabelFilter ──────────────────────────────────────────────
const labelMsg = { ...baseMsg, addedLabelIds: ['Label_42'], labelIds: ['INBOX', 'Label_42'] };
assert.strictEqual(matchGmailLabelFilter(labelMsg, { labelId: 'Label_42' }), true);
assert.strictEqual(matchGmailLabelFilter(labelMsg, { labelId: 'Label_99' }), false, 'labelId mismatch must reject');
assert.strictEqual(matchGmailLabelFilter(labelMsg, { labelId: 'Label_42', from: 'boss@example.com' }), true);
assert.strictEqual(matchGmailLabelFilter(labelMsg, { labelId: 'Label_42', from: 'someone-else' }), false);
assert.strictEqual(matchGmailLabelFilter(labelMsg, { labelId: 'Label_42', subjectContains: 'order' }), true);
assert.strictEqual(matchGmailLabelFilter(labelMsg, { labelId: 'Label_42', excludeLabelIds: ['INBOX'] }), false);
assert.strictEqual(matchGmailLabelFilter(labelMsg, {}), true, 'empty filter passes');

// ── matchCalendarChangedFilter ─────────────────────────────────────────
const calEvent = {
    eventId: 'e1', summary: 'Quarterly review', status: 'confirmed', calendarId: 'primary',
    attendees: [{ email: 'martijn@beeflow.nl' }, { email: 'tom@beeflow.nl' }],
};
assert.strictEqual(matchCalendarChangedFilter(calEvent, { statusEquals: 'confirmed' }), true);
assert.strictEqual(matchCalendarChangedFilter(calEvent, { statusEquals: 'cancelled' }), false);
assert.strictEqual(matchCalendarChangedFilter(calEvent, { calendarId: 'primary' }), true);
assert.strictEqual(matchCalendarChangedFilter(calEvent, { calendarId: 'team@group.calendar.google.com' }), false);
assert.strictEqual(matchCalendarChangedFilter(calEvent, { attendeeEmailContains: 'martijn' }), true);
assert.strictEqual(matchCalendarChangedFilter(calEvent, { attendeeEmailContains: 'sandra' }), false);
assert.strictEqual(matchCalendarUpcomingFilter(calEvent, { statusEquals: 'confirmed' }), true, 'upcoming reuses changed semantics');

// ── matchDriveFileNewFilter ────────────────────────────────────────────
const driveFile = {
    fileId: 'f1', name: 'Invoice 042.pdf', mimeType: 'application/pdf',
    parents: ['folder-xyz'],
    owners: [{ emailAddress: 'tom@beeflow.nl', me: true }],
};
assert.strictEqual(matchDriveFileNewFilter(driveFile, { folderId: 'folder-xyz' }), true);
assert.strictEqual(matchDriveFileNewFilter(driveFile, { folderId: 'other-folder' }), false);
assert.strictEqual(matchDriveFileNewFilter(driveFile, { mimeType: 'application/pdf' }), true);
assert.strictEqual(matchDriveFileNewFilter(driveFile, { mimeType: 'image/jpeg' }), false);
assert.strictEqual(matchDriveFileNewFilter(driveFile, { nameContains: 'invoice' }), true);
assert.strictEqual(matchDriveFileNewFilter(driveFile, { excludeOwnUploads: true }), false, 'me:true owner → excluded');

// ── matchNextcloudFileFilter ───────────────────────────────────────────
const ncFile = {
    activityId: 7, path: '/Invoices/042.pdf', name: '042.pdf', extension: 'pdf',
    actor: 'martijn', isOwnAction: false,
};
assert.strictEqual(matchNextcloudFileFilter(ncFile, { inFolder: '/Invoices' }), true);
assert.strictEqual(matchNextcloudFileFilter(ncFile, { inFolder: 'Invoices' }), true, 'leading slash optional');
assert.strictEqual(matchNextcloudFileFilter(ncFile, { inFolder: '/Outbox' }), false);
assert.strictEqual(matchNextcloudFileFilter(ncFile, { extension: 'pdf' }), true);
assert.strictEqual(matchNextcloudFileFilter(ncFile, { extension: '.pdf' }), true, 'leading dot tolerated');
assert.strictEqual(matchNextcloudFileFilter(ncFile, { extension: 'docx' }), false);
assert.strictEqual(matchNextcloudFileFilter(ncFile, { nameContains: '042' }), true);
assert.strictEqual(matchNextcloudFileFilter({ ...ncFile, isOwnAction: true }, { excludeOwnUploads: true }), false);

// ── matchNextcloudShareFilter ──────────────────────────────────────────
const ncShare = { activityId: 9, path: '/Shared/spec.md', name: 'spec.md', kind: 'file', actor: 'martijn' };
assert.strictEqual(matchNextcloudShareFilter(ncShare, { actorEquals: 'martijn' }), true);
assert.strictEqual(matchNextcloudShareFilter(ncShare, { actorEquals: 'someone-else' }), false);
assert.strictEqual(matchNextcloudShareFilter(ncShare, { kindEquals: 'file' }), true);
assert.strictEqual(matchNextcloudShareFilter(ncShare, { kindEquals: 'folder' }), false);
assert.strictEqual(matchNextcloudShareFilter(ncShare, { nameContains: 'spec' }), true);

// ── matchNextcloudActivityFilter ───────────────────────────────────────
const ncAct = { activityId: 11, type: 'comments', subject: 'Tom commented', actor: 'tom', objectName: '/Docs/spec.md' };
assert.strictEqual(matchNextcloudActivityFilter(ncAct, { type: 'comments' }), true);
assert.strictEqual(matchNextcloudActivityFilter(ncAct, { type: 'files' }), false);
assert.strictEqual(matchNextcloudActivityFilter(ncAct, { actorEquals: 'tom' }), true);
assert.strictEqual(matchNextcloudActivityFilter(ncAct, { objectNameContains: 'spec' }), true);

// ── matchNextcloudNotificationFilter ───────────────────────────────────
const ncNotif = { notificationId: 5, app: 'spreed', subject: 'New chat message in Office room' };
assert.strictEqual(matchNextcloudNotificationFilter(ncNotif, { app: 'spreed' }), true);
assert.strictEqual(matchNextcloudNotificationFilter(ncNotif, { app: 'files_sharing' }), false);
assert.strictEqual(matchNextcloudNotificationFilter(ncNotif, { subjectContains: 'office room' }), true, 'case-insensitive');
assert.strictEqual(matchNextcloudNotificationFilter(ncNotif, { subjectContains: 'invoice' }), false);

// ── matchTicketAssistantTicketNewFilter ────────────────────────────────
const taTicket = {
    ticketId: 'JIRA-123',
    connectionId: 'conn-1',
    provider: 'jira',
    subject: 'Outage in production',
    body: 'Customers cannot reach the api endpoint.',
    status: 'Open',
    status_bucket: 'open',
    priority: 'high',
    category: 'incident',
    sourceUri: 'https://example.atlassian.net/browse/JIRA-123',
};
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, {}), true, 'empty filter passes');
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { provider: 'jira' }), true);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { provider: 'zendesk' }), false);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { connectionId: 'conn-1' }), true);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { connectionId: 'conn-2' }), false);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { priorityEquals: 'high' }), true);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { priorityEquals: 'low' }), false);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { categoryEquals: 'incident' }), true);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { subjectContains: 'outage' }), true, 'subject case-insensitive');
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { subjectContains: 'release notes' }), false);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { bodyContains: 'api endpoint' }), true);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { bodyContains: 'database' }), false);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { statusEquals: 'open' }), true, 'status_bucket fallback');
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { statusEquals: 'Open' }), true, 'native status field');
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, { statusEquals: 'Closed' }), false);
// Combined: AND across keys.
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, {
    provider: 'jira', priorityEquals: 'high', subjectContains: 'outage',
}), true);
assert.strictEqual(matchTicketAssistantTicketNewFilter(taTicket, {
    provider: 'jira', priorityEquals: 'high', subjectContains: 'release',
}), false, 'one mismatch fails the whole filter');

// ── matchTicketAssistantSyncFilter ─────────────────────────────────────
const taSync = { connectionId: 'conn-1', provider: 'zendesk', outcome: 'success', stats: {} };
assert.strictEqual(matchTicketAssistantSyncFilter(taSync, {}), true);
assert.strictEqual(matchTicketAssistantSyncFilter(taSync, { connectionId: 'conn-1' }), true);
assert.strictEqual(matchTicketAssistantSyncFilter(taSync, { connectionId: 'conn-2' }), false);
assert.strictEqual(matchTicketAssistantSyncFilter(taSync, { provider: 'zendesk' }), true);
assert.strictEqual(matchTicketAssistantSyncFilter(taSync, { provider: 'jira' }), false);
assert.strictEqual(matchTicketAssistantSyncFilter(taSync, { outcomeEquals: 'success' }), true);
assert.strictEqual(matchTicketAssistantSyncFilter(taSync, { outcomeEquals: 'error' }), false);
assert.strictEqual(matchTicketAssistantSyncFilter(taSync, { provider: 'zendesk', outcomeEquals: 'success' }), true);

console.log('triggerBus.test.js — all checks passed');
