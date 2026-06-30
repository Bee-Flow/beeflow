'use strict';

const test = require('node:test');
const assert = require('node:assert');

const supportStore = require('../stores/supportStore');
const audit = require('./audit');

test('actorKindFor maps the real engine action strings to precise kinds', () => {
    assert.equal(audit.actorKindFor('ai_action'), 'ai');
    assert.equal(audit.actorKindFor('ai_draft'), 'ai');
    assert.equal(audit.actorKindFor('ai_reply'), 'ai');
    assert.equal(audit.actorKindFor('ai_escalated'), 'ai');
    assert.equal(audit.actorKindFor('classified_not_support'), 'automation');
    assert.equal(audit.actorKindFor('sla_breach'), 'automation');
    assert.equal(audit.actorKindFor('email_ingested'), 'system');
    assert.equal(audit.actorKindFor('auto_assigned'), 'system');
    assert.equal(audit.actorKindFor('staff_reply'), 'staff');
    assert.equal(audit.actorKindFor('inbox_access_changed'), 'staff');
    assert.equal(audit.actorKindFor('reply'), 'requester');
    assert.equal(audit.actorKindFor('reopened'), 'requester');
});

test('actorKindFor falls back for unknown actions', () => {
    assert.equal(audit.actorKindFor('totally_unknown'), 'system');
    assert.equal(audit.actorKindFor('totally_unknown', 'staff'), 'staff');
});

test('emit() resolves staff actor from the request and forwards to recordAuditEvent', () => {
    const calls = [];
    const orig = supportStore.recordAuditEvent;
    supportStore.recordAuditEvent = async (ev) => { calls.push(ev); return ev; };
    try {
        const req = {
            session: { user: { id: 'staff-7' } },
            headers: { 'user-agent': 'jest', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
        };
        audit.emit(req, { organizationId: 'org-1', inboxId: 'i1', threadId: 't1', action: 'inbox_settings_changed', payload: { changed: ['signature'] } });
        assert.equal(calls.length, 1);
        const ev = calls[0];
        assert.equal(ev.actorKind, 'staff');
        assert.equal(ev.actorUserId, 'staff-7');
        assert.equal(ev.organizationId, 'org-1');
        assert.equal(ev.inboxId, 'i1');
        assert.equal(ev.ip, '203.0.113.9');
        assert.deepEqual(ev.payload, { changed: ['signature'] });
    } finally {
        supportStore.recordAuditEvent = orig;
    }
});

test('emit() does not attribute a staff user to a system action', () => {
    const calls = [];
    const orig = supportStore.recordAuditEvent;
    supportStore.recordAuditEvent = async (ev) => { calls.push(ev); return ev; };
    try {
        const req = { session: { user: { id: 'staff-7' } }, headers: {} };
        audit.emit(req, { organizationId: 'org-1', inboxId: 'i1', action: 'email_ingested' });
        assert.equal(calls[0].actorKind, 'system');
        assert.equal(calls[0].actorUserId, null);
    } finally {
        supportStore.recordAuditEvent = orig;
    }
});

test('emit() never throws even if recordAuditEvent rejects', () => {
    const orig = supportStore.recordAuditEvent;
    supportStore.recordAuditEvent = async () => { throw new Error('db down'); };
    try {
        assert.doesNotThrow(() => audit.emit({ session: {}, headers: {} }, { action: 'scan_started' }));
    } finally {
        supportStore.recordAuditEvent = orig;
    }
});
