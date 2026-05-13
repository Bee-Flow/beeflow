/**
 * Unit tests for the DB persistence layer added to dlpRunner:
 *   - write-through on mergeTokenMap
 *   - one-shot hydrate from DB on first getConversationTokenMapAsync
 *   - clearConversationState nulls the DB column
 *
 * The tests inject a fake `db` module into require.cache so dlpRunner's
 * lazy `require('../../db')` picks up the mock. No real database needed.
 *
 * Run: node server/core/dlp/__tests__/dlpRunner.persistence.test.js
 */

const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

// ─── Mock db ─────────────────────────────────────────────────────────
// Track every call so each test can inspect what dlpRunner did.
const dbCalls = {
    run: [],   // { sql, params }
    getOne: [],
};
// Each test sets these to control the SELECT response from the mock.
let getOneAgentResult = null;
let getOneDirectResult = null;
// Each test sets these to control which UPDATE "matches" (rowCount > 0).
let updateAgentRowCount = 0;
let updateDirectRowCount = 0;

function resetMockDb() {
    dbCalls.run.length = 0;
    dbCalls.getOne.length = 0;
    getOneAgentResult = null;
    getOneDirectResult = null;
    updateAgentRowCount = 0;
    updateDirectRowCount = 0;
}

const mockDb = {
    run: async (sql, params) => {
        dbCalls.run.push({ sql, params });
        if (/agent_conversations/i.test(sql)) return { rowCount: updateAgentRowCount };
        if (/direct_conversations/i.test(sql)) return { rowCount: updateDirectRowCount };
        return { rowCount: 0 };
    },
    getOne: async (sql, params) => {
        dbCalls.getOne.push({ sql, params });
        if (/agent_conversations/i.test(sql)) return getOneAgentResult;
        if (/direct_conversations/i.test(sql)) return getOneDirectResult;
        return null;
    },
    // dlpRunner only touches `run` and `getOne`; provide stubs for the rest
    // in case future code touches them.
    getAll: async () => [],
    exec: async () => {},
};

// Install BEFORE dlpRunner is required so its lazy `_db()` picks the mock up.
const dbResolved = require.resolve(path.join(__dirname, '..', '..', '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

// Force a fresh dlpRunner module so we start with empty in-process state.
delete require.cache[require.resolve('../dlpRunner')];
const dlpRunner = require('../dlpRunner');

// Small helper to wait for the fire-and-forget DB write inside mergeTokenMap.
const tick = () => new Promise(resolve => setImmediate(resolve));

async function testMergeWritesThroughAgentTable() {
    resetMockDb();
    const convId = 'conv-A-' + Date.now();
    updateAgentRowCount = 1; // agent_conversations row exists
    updateDirectRowCount = 0;

    dlpRunner.clearConversationState(convId);
    // Discard the DB calls produced by clear so the test only asserts on the merge writes.
    await tick();
    resetMockDb();
    updateAgentRowCount = 1;
    updateDirectRowCount = 0;

    dlpRunner.mergeTokenMap(convId, { '[email_1]': 'tom@beeflow.nl' });
    await tick();

    const writes = dbCalls.run.filter(c => /pii_token_map/i.test(c.sql));
    assert.ok(writes.length > 0, 'expected at least one UPDATE … pii_token_map');
    const first = writes[0];
    assert.match(first.sql, /agent_conversations/i, 'agent_conversations should be tried first');
    const stored = JSON.parse(first.params[0]);
    assert.deepStrictEqual(stored, { '[email_1]': 'tom@beeflow.nl' });
    assert.strictEqual(first.params[1], convId);
}

async function testMergeFallsBackToDirectTable() {
    resetMockDb();
    const convId = 'conv-D-' + Date.now();
    // agent_conversations row absent, direct_conversations row exists
    updateAgentRowCount = 0;
    updateDirectRowCount = 1;

    dlpRunner.clearConversationState(convId);
    await tick();
    resetMockDb();
    updateAgentRowCount = 0;
    updateDirectRowCount = 1;

    dlpRunner.mergeTokenMap(convId, { '[person_1]': 'Gerard' });
    await tick();

    const writes = dbCalls.run.filter(c => /pii_token_map/i.test(c.sql));
    assert.strictEqual(writes.length, 2, 'expected 2 UPDATEs (agent + fallback to direct)');
    assert.match(writes[0].sql, /agent_conversations/i);
    assert.match(writes[1].sql, /direct_conversations/i);
}

async function testHydrateFromDb() {
    resetMockDb();
    const convId = 'conv-H-' + Date.now();
    // No in-process map yet, DB has a stored map on agent_conversations.
    getOneAgentResult = { pii_token_map: { '[email_5]': 'alice@x.com' } };
    getOneDirectResult = null;

    // Sanity: sync getter returns empty before hydrate.
    assert.deepStrictEqual(dlpRunner.getConversationTokenMap(convId), {});

    const map = await dlpRunner.getConversationTokenMapAsync(convId);
    assert.deepStrictEqual(map, { '[email_5]': 'alice@x.com' });

    // Sync getter now returns the hydrated values.
    assert.deepStrictEqual(dlpRunner.getConversationTokenMap(convId), { '[email_5]': 'alice@x.com' });
}

async function testHydrateCacheSkipsSecondQuery() {
    resetMockDb();
    const convId = 'conv-C-' + Date.now();
    getOneAgentResult = { pii_token_map: { '[email_7]': 'bob@x.com' } };

    await dlpRunner.getConversationTokenMapAsync(convId);
    const queriesAfterFirst = dbCalls.getOne.length;

    await dlpRunner.getConversationTokenMapAsync(convId);
    assert.strictEqual(dbCalls.getOne.length, queriesAfterFirst, 'second call must NOT re-query the DB');
}

async function testClearNullsDbColumn() {
    resetMockDb();
    const convId = 'conv-X-' + Date.now();
    dlpRunner.mergeTokenMap(convId, { '[phone_1]': '+316' });
    await tick();
    resetMockDb();

    dlpRunner.clearConversationState(convId);
    await tick();

    const nullings = dbCalls.run.filter(c => /pii_token_map\s*=\s*NULL/i.test(c.sql));
    assert.strictEqual(nullings.length, 2, 'expected NULL update on both tables');
    assert.match(nullings[0].sql, /agent_conversations/i);
    assert.match(nullings[1].sql, /direct_conversations/i);
}

(async () => {
    const tests = [
        ['mergeTokenMap writes through to agent_conversations', testMergeWritesThroughAgentTable],
        ['mergeTokenMap falls back to direct_conversations when no agent row', testMergeFallsBackToDirectTable],
        ['getConversationTokenMapAsync hydrates from DB on first call', testHydrateFromDb],
        ['hydration is cached — second async call does not re-query', testHydrateCacheSkipsSecondQuery],
        ['clearConversationState nulls the DB column on both tables', testClearNullsDbColumn],
    ];
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`  ✓ ${name}`);
        } catch (err) {
            failed++;
            console.error(`  ✗ ${name}`);
            console.error(err);
        }
    }
    if (failed > 0) {
        console.error(`\n${failed} test(s) failed`);
        process.exit(1);
    } else {
        console.log(`\nAll ${tests.length} tests passed`);
    }
})();
