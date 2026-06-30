process.env.LEAD_CRM_TASK_TICK = 'false'; // no scheduler during tests

const test = require('node:test');
const assert = require('node:assert');

const { _internals } = require('./leadCrmStore');
const { ACTIVITY_TYPES, mapTask, mapActivity, mapContact } = _internals;

test('ACTIVITY_TYPES covers the timeline + auto-logged kinds', () => {
    for (const t of ['note', 'call', 'email', 'meeting', 'stage_change', 'task', 'ai', 'system']) {
        assert.ok(ACTIVITY_TYPES.has(t), `${t} should be a valid activity type`);
    }
    assert.ok(!ACTIVITY_TYPES.has('bogus'));
});

test('mapActivity maps a row to camelCase + parses metadata', () => {
    const a = mapActivity({ id: 'a1', lead_id: 'l1', organization_id: 'o1', type: 'call', body: 'belde', metadata: '{"x":1}', actor_user_id: 'u1', created_at: '2026-06-16T10:00:00Z' });
    assert.strictEqual(a.leadId, 'l1');
    assert.strictEqual(a.type, 'call');
    assert.deepStrictEqual(a.metadata, { x: 1 });
    assert.strictEqual(a.actorUserId, 'u1');
});

test('mapTask maps fields + only exposes companyName when joined', () => {
    const base = { id: 't1', lead_id: 'l1', organization_id: 'o1', title: 'Bellen', due_at: '2026-06-20T09:00:00Z', assignee_user_id: 'u1', completed_at: null, created_at: '2026-06-16T10:00:00Z' };
    const t1 = mapTask(base);
    assert.strictEqual(t1.title, 'Bellen');
    assert.strictEqual(t1.assigneeUserId, 'u1');
    assert.strictEqual(t1.completedAt, null);
    assert.ok(!('companyName' in t1)); // not joined
    const t2 = mapTask({ ...base, company_name: 'Acme BV' });
    assert.strictEqual(t2.companyName, 'Acme BV'); // joined
});

test('mapContact reflects the primary flag', () => {
    const c = mapContact({ id: 'c1', lead_id: 'l1', organization_id: 'o1', name: 'Jan', title: 'CEO', email: 'jan@x.nl', is_primary: true });
    assert.strictEqual(c.name, 'Jan');
    assert.strictEqual(c.isPrimary, true);
    assert.strictEqual(c.email, 'jan@x.nl');
});
