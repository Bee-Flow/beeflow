'use strict';

// supportInboxStore (required transitively by access.js) throws at load unless
// SESSION_SECRET is set; its background initDB() failure is caught and harmless.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-which-is-long-enough-32+';

const test = require('node:test');
const assert = require('node:assert');
const { canUserAccessInbox } = require('./access');

const USER = 'u1';
const ORG = 'org-1';
const orgSet = new Set([ORG]);

function inbox(over = {}) {
    return { id: 'i1', organization_id: ORG, created_by: 'owner', shared_groups: [], ...over };
}

test('open inbox (empty shared_groups) is accessible to any in-org member', () => {
    assert.equal(canUserAccessInbox(inbox(), USER, orgSet, [], {}), true);
});

test('owner always has access, even when restricted to a group they are not in', () => {
    const i = inbox({ created_by: USER, shared_groups: ['g-other'] });
    assert.equal(canUserAccessInbox(i, USER, orgSet, [], {}), true);
});

test('super admin (orgIds === null) always has access', () => {
    const i = inbox({ shared_groups: ['g-other'], organization_id: 'someone-elses-org' });
    assert.equal(canUserAccessInbox(i, USER, null, [], {}), true);
});

test('org admin sees a group-restricted inbox in their org', () => {
    const i = inbox({ shared_groups: ['g-sales'] });
    assert.equal(canUserAccessInbox(i, USER, orgSet, [], { isOrgAdmin: true }), true);
});

test('member in a different org is denied', () => {
    const i = inbox({ organization_id: 'org-2' });
    assert.equal(canUserAccessInbox(i, USER, orgSet, [], {}), false);
});

test('restricted inbox: member of a shared group is granted', () => {
    const i = inbox({ shared_groups: ['g-sales', 'g-billing'] });
    assert.equal(canUserAccessInbox(i, USER, orgSet, ['g-billing'], {}), true);
});

test('restricted inbox: member not in any shared group is denied', () => {
    const i = inbox({ shared_groups: ['g-sales'] });
    assert.equal(canUserAccessInbox(i, USER, orgSet, ['g-support'], {}), false);
});

test('restricted inbox: non-admin in-org member without the group is denied even as org member', () => {
    const i = inbox({ shared_groups: ['g-sales'] });
    assert.equal(canUserAccessInbox(i, USER, orgSet, [], { isOrgAdmin: false }), false);
});

test('shared_groups tolerated as a JSON string (defensive parse)', () => {
    const i = inbox({ shared_groups: '["g-sales"]' });
    assert.equal(canUserAccessInbox(i, USER, orgSet, ['g-sales'], {}), true);
    assert.equal(canUserAccessInbox(i, USER, orgSet, ['g-other'], {}), false);
});

test('null inbox is denied', () => {
    assert.equal(canUserAccessInbox(null, USER, orgSet, [], {}), false);
});
