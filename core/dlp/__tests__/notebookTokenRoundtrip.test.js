/**
 * Integration test for the notebook/legal PII round-trip + PERSISTENCE.
 *
 * Proves the user-visible guarantee — tokenization survives a reload/restart —
 * using the REAL modules (piiDetection.tokenizeText / restoreTokens + dlpRunner),
 * mocking only the database. Two parts:
 *
 *   1. tokenize → restore round-trips in-process (token format compatibility).
 *   2. mergeTokenMap write-throughs to the `notebooks` table, and after a
 *      simulated restart (fresh dlpRunner module) the map re-hydrates from that
 *      table so restoreTokens still yields the original PII.
 *
 * Run: node server/core/dlp/__tests__/notebookTokenRoundtrip.test.js
 */

const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

// ── Mock db with a PERSISTENT notebooks-table backing store ─────────────
// The blob survives the simulated restart (we only re-require dlpRunner, not the
// db mock), exactly like a real Postgres row survives a server restart.
const notebookBlobs = {}; // notebookId → token map object (JSONB)
const mockDb = {
    run: async (sql, params) => {
        if (/UPDATE notebooks SET pii_token_map/i.test(sql)) {
            notebookBlobs[params[1]] = params[0] === null ? null : JSON.parse(params[0]);
            return { rowCount: notebookBlobs[params[1]] !== undefined ? 1 : 0 };
        }
        // agent/direct tables: no matching rows in this test.
        return { rowCount: 0 };
    },
    getOne: async (sql, params) => {
        if (/FROM notebooks/i.test(sql)) {
            const v = notebookBlobs[params[0]];
            return v ? { pii_token_map: v } : { pii_token_map: null };
        }
        return null; // agent/direct miss
    },
    getAll: async () => [],
    exec: async () => {},
};
const dbResolved = require.resolve(path.join(__dirname, '..', '..', '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const { tokenizeText, restoreTokens } = require('../../piiDetection');
const tick = () => new Promise(resolve => setImmediate(resolve));

function freshDlpRunner() {
    delete require.cache[require.resolve('../dlpRunner')];
    return require('../dlpRunner');
}

async function testTokenizeRestoreRoundtrip() {
    // A Wmo-style line with a person name. Build the entity span explicitly so the
    // test doesn't depend on the guard service.
    const text = 'Aan: ISD Bollenstreek, t.a.v. consulent M. van Zanten';
    const name = 'M. van Zanten';
    const offset = text.indexOf(name);
    const { tokenizedText, tokenMap } = tokenizeText(text, [
        { category: 'Person', offset, length: name.length, text: name },
    ]);
    assert.ok(!tokenizedText.includes(name), 'tokenized text must not contain the real name');
    assert.ok(/\[person_\d+\]/i.test(tokenizedText), `expected a [person_N] token, got: ${tokenizedText}`);
    // restoreTokens must put the real value back (the format the un-tokeniser uses).
    assert.strictEqual(restoreTokens(tokenizedText, tokenMap), text, 'tokenize→restore must round-trip');
    return { tokenizedText, tokenMap };
}

async function testPersistenceSurvivesRestart() {
    const notebookId = 'nb-legal-' + Date.now();
    const { tokenizedText, tokenMap } = await testTokenizeRestoreRoundtrip();

    // Turn 1: merge the doc's tokens into the notebook map → write-through to DB.
    let dlp = freshDlpRunner();
    dlp.mergeTokenMap(notebookId, tokenMap);
    await tick();
    assert.ok(notebookBlobs[notebookId], 'token map must be persisted to the notebooks row');

    // Simulate a server restart: a brand-new dlpRunner with empty in-process state.
    dlp = freshDlpRunner();
    assert.deepStrictEqual(dlp.getConversationTokenMap(notebookId), {}, 'in-process map starts empty after restart');

    // Reload path (GET /:id/conversation) hydrates from the notebooks row.
    const hydrated = await dlp.getConversationTokenMapAsync(notebookId);
    assert.deepStrictEqual(hydrated, tokenMap, 'hydrated map equals the originally persisted map');

    // The stored (tokenized) assistant/doc content restores to the real PII.
    const storedTokenized = `Reactie — ${tokenizedText}`;
    const restored = restoreTokens(storedTokenized, hydrated);
    assert.ok(restored.includes('M. van Zanten'), 'after restart, stored tokens still restore to the real value');
    assert.ok(!/\[person_\d+\]/i.test(restored), 'no raw placeholder should remain after restore');
}

(async () => {
    const tests = [
        ['tokenize → restore round-trips in-process', testTokenizeRestoreRoundtrip],
        ['token map persists + restores across a simulated restart', testPersistenceSurvivesRestart],
    ];
    let failed = 0;
    for (const [name, fn] of tests) {
        try { await fn(); console.log(`  ✓ ${name}`); }
        catch (err) { failed++; console.error(`  ✗ ${name}`); console.error(err); }
    }
    if (failed > 0) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
    console.log(`\nAll ${tests.length} tests passed`);
})();
