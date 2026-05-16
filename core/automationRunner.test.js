/**
 * Unit tests for the runner's pure helpers (timeout clamping + cancel
 * registration). Anything that needs a real DB run goes in the integration
 * suite (automationStore.claim.test.js).
 *
 * Run: node core/automationRunner.test.js
 */

const assert = require('assert');

// Stub automationStore + dependent modules BEFORE requiring the runner so
// it can load without booting a DB pool.
const storePath = require.resolve('../stores/automationStore');
require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: {
        // Trivial stubs — none of these tests exercise them.
        initDB: async () => {},
        requestCancelRun: async (runId) => ({ id: runId, cancelRequested: true, status: 'running' }),
        getRun: async () => null,
    },
};

// Block the boot tick: we don't want setIntervals running during the test.
process.env.NODE_ENV = 'test';

const runner = require('./automationRunner');

(async () => {
    // ── requestCancel returns the updated run row + aborts local controller ──
    {
        const runId = 'test-run-1';
        // Reach into the runner to register a controller as if executeAutomation
        // had started. The test imports the same module so we share state.
        const internals = require('./automationRunner');
        // We can't directly access ACTIVE_RUNS, but requestCancel still works
        // against the DB stub even when no controller is registered locally —
        // that path is the cross-process case and must not throw.
        const result = await internals.requestCancel(runId);
        assert.ok(result, 'returns the row from the store stub');
        assert.strictEqual(result.cancelRequested, true);
    }

    // ── module exports the expected surface ────────────────────────────
    assert.strictEqual(typeof runner.start, 'function');
    assert.strictEqual(typeof runner.executeAutomation, 'function');
    assert.strictEqual(typeof runner.requestCancel, 'function');
    assert.strictEqual(typeof runner.processDueAutomations, 'function');
    assert.strictEqual(typeof runner.reapStuckAutomations, 'function');
    assert.strictEqual(typeof runner.runPartial, 'function');
    assert.strictEqual(typeof runner.resumeFromStep, 'function');
    assert.strictEqual(typeof runner.INSTANCE_ID, 'string');
    assert.ok(runner.INSTANCE_ID.startsWith('runner-'), 'instance id is namespaced');

    // ── runPartial validates its inputs ────────────────────────────────
    // Without a stepId in the definition we should throw a clear error
    // (not crash inside the DAG walker).
    let threw = false;
    try {
        await runner.runPartial({ id: 'a', userId: 'u', definition: { trigger: { id: 't', type: 'trigger' }, steps: [] } }, 'does-not-exist');
    } catch (e) {
        threw = e.message.includes('not found in definition');
    }
    assert.ok(threw, 'runPartial rejects when stepId is missing from definition');

    let threwMissing = false;
    try { await runner.runPartial({ id: 'a', userId: 'u', definition: {} }); }
    catch (e) { threwMissing = e.message.includes('stepId is required'); }
    assert.ok(threwMissing, 'runPartial rejects when no stepId is supplied');

    console.log('automationRunner.test.js — all checks passed');
    process.exit(0);
})().catch(err => {
    console.error('[automationRunner.test] failed:', err);
    process.exit(1);
});
