'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// These pure helpers back the executions-table keyset pagination + server-side
// filtering. They don't touch the DB, so they're unit-testable directly.
const { encodeRunCursor, decodeRunCursor, buildRunFilterWhere } = require('./automationStore');

test('run cursor round-trips (started_at, id)', () => {
    const row = { started_at: '2026-06-27T10:00:00.000Z', id: 'run-123' };
    const cur = encodeRunCursor(row);
    assert.equal(typeof cur, 'string');
    const back = decodeRunCursor(cur);
    assert.equal(back.startedAt, '2026-06-27T10:00:00.000Z');
    assert.equal(back.id, 'run-123');
});

test('encodeRunCursor returns null without a started_at (queued rows)', () => {
    assert.equal(encodeRunCursor({ id: 'x', started_at: null }), null);
    assert.equal(encodeRunCursor(null), null);
});

test('decodeRunCursor tolerates garbage → null (falls back to page 1)', () => {
    assert.equal(decodeRunCursor('not-base64!!'), null);
    assert.equal(decodeRunCursor(''), null);
    assert.equal(decodeRunCursor(undefined), null);
    // Valid base64 but wrong shape:
    assert.equal(decodeRunCursor(Buffer.from('{"nope":1}').toString('base64url')), null);
});

test('buildRunFilterWhere always scopes to the user and parameterises', () => {
    const w = buildRunFilterWhere('user-1', {}, 1);
    assert.match(w.clause, /r\.user_id = \$1/);
    assert.deepEqual(w.params, ['user-1']);
    assert.equal(w.nextIdx, 2);
});

test('buildRunFilterWhere builds ANY() for array filters + scalar clauses', () => {
    const w = buildRunFilterWhere('u', {
        status: ['error', 'success'],
        triggerKind: 'manual',
        automationId: 'a1',
        kind: 'block',
        sinceTs: '2026-06-26T00:00:00Z',
        untilTs: '2026-06-27T00:00:00Z',
        mode: ['live'],
    }, 1);
    assert.match(w.clause, /r\.status = ANY\(\$2\)/);
    assert.match(w.clause, /r\.trigger_kind = ANY\(\$3\)/);
    assert.match(w.clause, /r\.mode = ANY\(\$4\)/);
    assert.match(w.clause, /r\.automation_id = \$5/);
    assert.match(w.clause, /a\.kind = \$6/);
    assert.match(w.clause, /r\.started_at >= \$7/);
    assert.match(w.clause, /r\.started_at < \$8/);
    // user + 7 filters = 8 params, all positional and in order. status/trigger/
    // mode are normalised to arrays for ANY(); scalars stay scalar.
    assert.deepEqual(w.params, ['u', ['error', 'success'], ['manual'], ['live'], 'a1', 'block', '2026-06-26T00:00:00Z', '2026-06-27T00:00:00Z']);
});

test('buildRunFilterWhere ignores empty/blank filter values', () => {
    const w = buildRunFilterWhere('u', { status: [], triggerKind: '', automationId: null }, 1);
    assert.equal(w.clause, 'r.user_id = $1');
    assert.deepEqual(w.params, ['u']);
});
