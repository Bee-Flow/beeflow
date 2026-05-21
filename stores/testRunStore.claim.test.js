/**
 * Integration tests for testRunStore — atomic createRun + outbox claim.
 *
 * Run: node server/stores/testRunStore.claim.test.js
 *
 * Requires a Postgres available via CORE_DATABASE_URL. Schema is bootstrapped
 * lazily by testRunStore.initDB(). If Postgres is unreachable the test exits 0
 * so CI on machines without a local DB doesn't false-fail.
 */

const assert = require('assert');
const crypto = require('crypto');

(async () => {
    let store;
    try {
        store = require('./testRunStore');
        await store.initDB();
    } catch (e) {
        console.warn(`[testRunStore.claim.test] Postgres unavailable, skipping: ${e.message}`);
        process.exit(0);
    }

    const { pool } = require('../db');

    async function withRun(fn, { mode = 'explore', targetUrl = 'https://example.com' } = {}) {
        const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
        const runId = await store.createRun({ userId, targetUrl, mode });
        try { await fn({ runId, userId }); }
        finally {
            // CASCADE drops outbox + artifacts.
            await pool.query('DELETE FROM test_runs WHERE id = $1', [runId]).catch(() => {});
        }
    }

    // ── Test 1: createRun is atomic — both rows exist after one call ──────
    await withRun(async ({ runId }) => {
        const run = await pool.query('SELECT id, status FROM test_runs WHERE id = $1', [runId]);
        assert.strictEqual(run.rows.length, 1, 'test_runs row created');
        assert.strictEqual(run.rows[0].status, 'queued');

        const job = await pool.query('SELECT id, run_id, attempt_count FROM test_run_jobs WHERE run_id = $1', [runId]);
        assert.strictEqual(job.rows.length, 1, 'matching outbox row created');
        assert.strictEqual(job.rows[0].attempt_count, 0);
    });

    // ── Test 2: claimDueJobs returns the row exactly once across two callers ─
    await withRun(async ({ runId }) => {
        const [a, b] = await Promise.all([
            store.claimDueJobs({ batchSize: 10, targetRunId: runId, workerId: 'A' }),
            store.claimDueJobs({ batchSize: 10, targetRunId: runId, workerId: 'B' }),
        ]);
        const total = a.length + b.length;
        assert.strictEqual(total, 1, `exactly one worker claims the row (got ${total})`);
    });

    // ── Test 3: state machine — markFinished rejects illegal terminal status ─
    await withRun(async ({ runId }) => {
        await store.markRunning(runId);
        await assert.rejects(() => store.markFinished(runId, { status: 'queued' }), /invalid terminal status/);
        await store.markFinished(runId, { status: 'passed', reportJson: { tests: [] } });
        const r = await store.getRun(runId);
        assert.strictEqual(r.status, 'passed', 'transition to passed succeeded');
        // Second finalization is a no-op (returns false).
        const second = await store.markFinished(runId, { status: 'failed' });
        assert.strictEqual(second, false, 'cannot re-finalize a terminal run');
    });

    // ── Test 4: hasActiveRunForUser flips correctly ────────────────────
    {
        const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
        assert.strictEqual(await store.hasActiveRunForUser(userId), false, 'no run yet');
        const runId = await store.createRun({ userId, targetUrl: 'https://example.com', mode: 'explore' });
        assert.strictEqual(await store.hasActiveRunForUser(userId), true, 'queued run counts as active');
        await store.markRunning(runId);
        assert.strictEqual(await store.hasActiveRunForUser(userId), true, 'running counts as active');
        await store.markFinished(runId, { status: 'passed', reportJson: { tests: [] } });
        assert.strictEqual(await store.hasActiveRunForUser(userId), false, 'terminal does not count');
        await pool.query('DELETE FROM test_runs WHERE id = $1', [runId]).catch(() => {});
    }

    // ── Test 5: subscribe receives publishEvent payloads ─────────────────
    await withRun(async ({ runId }) => {
        const received = [];
        const unsub = store.subscribe(runId, (msg) => received.push(msg));
        store.publishEvent(runId, 'progress', { line: 'hello' });
        // small wait for the listener to drain
        await new Promise(r => setTimeout(r, 10));
        unsub();
        assert.ok(received.find(m => m.type === 'progress' && m.data.line === 'hello'), 'subscriber saw the published event');
    });

    console.log('✓ server/stores/testRunStore.claim.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ testRunStore.claim.test.js failed:', err);
    process.exit(1);
});
