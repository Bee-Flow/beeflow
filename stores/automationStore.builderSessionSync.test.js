/**
 * Regression test: updating an automation's definition keeps the
 * builder-session snapshot's `draft` in lock-step with the row.
 *
 * Run: node stores/automationStore.builderSessionSync.test.js
 *
 * Without this sync, visual edits (drag / layer ops / inspector saves) update
 * automations.definition_json but NOT automations.builder_session.draft — so
 * the client rehydrates the stale snapshot draft on refresh and the user's
 * changes appear to vanish even though the row was saved.
 *
 * Requires a Postgres via CORE_DATABASE_URL. Skips with exit 0 when Postgres
 * is unreachable so CI on DB-less machines doesn't false-fail.
 */

const assert = require('assert');
const crypto = require('crypto');

(async () => {
    let store;
    try {
        store = require('./automationStore');
        await store.initDB();
    } catch (e) {
        console.warn(`[builderSessionSync.test] Postgres unavailable, skipping: ${e.message}`);
        process.exit(0);
    }
    const { pool } = require('../db');

    async function withRow(builderSession, fn) {
        const id = crypto.randomUUID();
        const userId = `tu_${crypto.randomBytes(4).toString('hex')}`;
        await pool.query(
            `INSERT INTO automations
                (id, user_id, title, definition_json, builder_session, version,
                 is_active, is_draft, needs_first_run_confirm, trigger_type,
                 schedule_cron, schedule_tz, last_status, attempts)
             VALUES ($1, $2, 'bs-sync-test', '{}'::jsonb, $3, 1,
                     FALSE, TRUE, FALSE, 'manual',
                     NULL, 'UTC', NULL, 0)`,
            [id, userId, builderSession ? JSON.stringify(builderSession) : null],
        );
        try { await fn({ id, userId }); }
        finally { await pool.query('DELETE FROM automations WHERE id = $1', [id]).catch(() => {}); }
    }

    // ── 1: a definition PUT refreshes snapshot.draft, preserving the rest ──
    await withRow(
        { draft: { trigger: { kind: 'manual' }, steps: [], edges: [] }, conversation: [{ role: 'user', content: 'hi' }], version: 3 },
        async ({ id, userId }) => {
            const newDef = {
                trigger: { id: 'trg', kind: 'manual' },
                steps: [{ id: 's1', type: 'code', code: 'return 1;' }],
                edges: [],
                layers: { l1: { title: 'L', description: 'does a thing' } },
            };
            await store.updateAutomation(id, { definition: newDef }, userId);
            const snap = await store.getBuilderSession(id, userId);
            assert.deepStrictEqual(snap.draft, newDef, 'builder_session.draft tracks the new definition');
            assert.deepStrictEqual(snap.conversation, [{ role: 'user', content: 'hi' }], 'conversation is preserved');
            assert.strictEqual(snap.version, 3, 'snapshot version is untouched by a definition PUT');
        },
    );

    // ── 2: a NULL snapshot stays NULL (we never fabricate one) ─────────────
    await withRow(null, async ({ id, userId }) => {
        await store.updateAutomation(id, { definition: { trigger: { kind: 'manual' }, steps: [], edges: [] } }, userId);
        const snap = await store.getBuilderSession(id, userId);
        assert.strictEqual(snap, null, 'no snapshot is created when none existed');
    });

    // ── 3: a non-definition update leaves snapshot.draft alone ─────────────
    await withRow({ draft: { keep: true }, version: 1 }, async ({ id, userId }) => {
        await store.updateAutomation(id, { title: 'Renamed' }, userId);
        const snap = await store.getBuilderSession(id, userId);
        assert.deepStrictEqual(snap.draft, { keep: true }, 'a title-only update does not touch the snapshot draft');
    });

    console.log('automationStore.builderSessionSync.test.js: all tests passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
