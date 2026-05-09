/**
 * Integration tests for the atomic claim + reaper paths.
 *
 * Run: node stores/automationStore.claim.test.js
 *
 * Requires a Postgres available via CORE_DATABASE_URL. The migration is
 * applied lazily by automationStore.initDB() so the test is self-bootstrap.
 * Skips with a non-zero exit only when assertions fail; if Postgres is
 * unreachable it skips with exit 0 so CI on machines without a local DB
 * doesn't false-fail.
 */

const assert = require('assert');
const crypto = require('crypto');

(async () => {
    let store;
    try {
        store = require('./automationStore');
        // Force init early so we surface connection errors before the assertions.
        await store.initDB();
    } catch (e) {
        console.warn(`[claim.test] Postgres unavailable, skipping: ${e.message}`);
        process.exit(0);
    }

    const { pool } = require('../db');

    async function withRow(fn) {
        const id = crypto.randomUUID();
        const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
        // Insert directly so we can pin the lock-relevant columns without
        // running the full createAutomation flow.
        await pool.query(
            `INSERT INTO automations
                (id, user_id, title, definition_json, version, is_active, is_draft,
                 needs_first_run_confirm, trigger_type, schedule_cron, schedule_tz,
                 next_run_at, last_status, attempts)
             VALUES ($1, $2, 'claim-test', '{}'::jsonb, 1, TRUE, FALSE, FALSE,
                     'schedule', '* * * * *', 'UTC',
                     NOW() - INTERVAL '1 minute', NULL, 0)`,
            [id, userId],
        );
        try { await fn({ id, userId }); }
        finally { await pool.query('DELETE FROM automations WHERE id = $1', [id]).catch(() => {}); }
    }

    // ── Test 1: only one of two concurrent claims wins a row ────────────
    await withRow(async ({ id }) => {
        const [a, b] = await Promise.all([
            store.claimDueAutomations('worker-A', 10),
            store.claimDueAutomations('worker-B', 10),
        ]);
        const winners = [...a, ...b].filter(r => r.id === id);
        assert.strictEqual(winners.length, 1, 'exactly one worker should claim a given row');
        assert.strictEqual(winners[0].lastStatus, 'running', 'claim flips last_status to running');

        // Second pass while still "running" returns nothing.
        const empty = await store.claimDueAutomations('worker-C', 10);
        assert.ok(!empty.find(r => r.id === id), 'claimed row is invisible to subsequent claims');
    });

    // ── Test 2: release clears the marker so the row is reclaimable ─────
    await withRow(async ({ id }) => {
        const claim1 = await store.claimDueAutomations('worker-X', 10);
        assert.ok(claim1.find(r => r.id === id));

        await store.releaseAutomation(id);
        // Reset last_status manually (release alone keeps last_status — the
        // runner sets it to success/error before releasing).
        await pool.query(`UPDATE automations SET last_status = NULL WHERE id = $1`, [id]);

        const claim2 = await store.claimDueAutomations('worker-Y', 10);
        assert.ok(claim2.find(r => r.id === id), 'released row claimable again');
    });

    // ── Test 3: reaper resets stuck rows + bumps attempts ───────────────
    await withRow(async ({ id }) => {
        await store.claimDueAutomations('worker-stuck', 10);
        // Backdate running_started_at so the reaper sees it as stale.
        await pool.query(
            `UPDATE automations SET running_started_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`,
            [id],
        );
        const reaped = await store.reapStuckAutomations({ staleAfterMs: 60_000, maxAttempts: 5 });
        const found = reaped.find(r => r.id === id);
        assert.ok(found, 'reaper picked up the stuck row');
        assert.strictEqual(found.runningInstanceId ?? null, null, 'reaper cleared instance id');
        assert.ok((found.attempts || 0) >= 1, 'reaper incremented attempts');

        const post = (await pool.query('SELECT last_status, attempts FROM automations WHERE id = $1', [id])).rows[0];
        assert.notStrictEqual(post.last_status, 'running', 'no longer marked running');
        assert.ok(post.attempts >= 1);
    });

    // ── Test 4: reaper drops to error after maxAttempts ─────────────────
    await withRow(async ({ id }) => {
        await pool.query(
            `UPDATE automations
                SET last_status = 'running',
                    running_started_at = NOW() - INTERVAL '20 minutes',
                    attempts = 4
              WHERE id = $1`,
            [id],
        );
        await store.reapStuckAutomations({ staleAfterMs: 60_000, maxAttempts: 5 });
        const post = (await pool.query('SELECT last_status, attempts FROM automations WHERE id = $1', [id])).rows[0];
        assert.strictEqual(post.last_status, 'error', 'after max attempts, marked error');
        assert.strictEqual(post.attempts, 5);
    });

    // ── Test 5: reaper window respects per-row run_timeout_ms ───────────
    // A row with a 30-min override should NOT be reaped at 20 min stale,
    // even though the floor (60s) was exceeded long ago.
    await withRow(async ({ id }) => {
        await pool.query(
            `UPDATE automations
                SET last_status = 'running',
                    running_started_at = NOW() - INTERVAL '20 minutes',
                    run_timeout_ms = 1800000
              WHERE id = $1`,
            [id],
        );
        const reaped = await store.reapStuckAutomations({
            staleAfterMs: 60_000,
            maxAttempts: 5,
            bufferMs: 60_000,
        });
        assert.ok(!reaped.find(r => r.id === id), 'row with 30-min override survives 20-min stale');
        const post = (await pool.query('SELECT last_status FROM automations WHERE id = $1', [id])).rows[0];
        assert.strictEqual(post.last_status, 'running', 'still running, not reaped');
    });

    // ── Test 6: requestCancelRun flips cancel_requested ─────────────────
    await withRow(async ({ id }) => {
        const runId = crypto.randomUUID();
        await pool.query(
            `INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, mode, status)
             VALUES ($1, $2, 1, 'test-user', 'manual', 'live', 'running')`,
            [runId, id],
        );
        try {
            const updated = await store.requestCancelRun(runId);
            assert.ok(updated, 'returns updated row');
            assert.strictEqual(updated.cancelRequested, true, 'flag flipped');

            const ignored = await store.requestCancelRun(runId);
            // Already running state → row matches but flag stays true;
            // for runs in terminal state the WHERE clause excludes them.
            assert.ok(ignored, 'idempotent for already-running');
        } finally {
            await pool.query('DELETE FROM automation_runs WHERE id = $1', [runId]).catch(() => {});
        }

        const terminalRunId = crypto.randomUUID();
        await pool.query(
            `INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, mode, status)
             VALUES ($1, $2, 1, 'test-user', 'manual', 'live', 'success')`,
            [terminalRunId, id],
        );
        try {
            const noop = await store.requestCancelRun(terminalRunId);
            assert.strictEqual(noop, null, 'terminal-state runs cannot be cancelled');
        } finally {
            await pool.query('DELETE FROM automation_runs WHERE id = $1', [terminalRunId]).catch(() => {});
        }
    });

    console.log('automationStore.claim.test.js — all checks passed');
    await pool.end();
})().catch(err => {
    console.error('[claim.test] failed:', err);
    process.exit(1);
});
