/**
 * builderSessions.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, exec, getClient, pool } = require('./core');
const { rowToAutomation, rowToRun, rowToRunStep, safeParse, fromJsonb } = require('./rowMappers');

// ── Builder session snapshot ───────────────────────────────────────────
//
// The builder loop persists a small snapshot {sessionId, version, messages,
// draft, lastValidation} into automations.builder_session after every
// mutation. On SSE reconnect the client rehydrates from the latest snapshot
// so the chat history isn't lost when the connection drops.
//
// `version` is a monotonically-increasing integer used for optimistic
// locking: setBuilderSession only succeeds when the caller's expected
// version matches the persisted one. Two-tab edits get a 409 on the second
// write so the loser can refresh instead of clobbering.

const SNAPSHOT_MAX_BYTES = 64 * 1024;

function trimSnapshot(snapshot) {
    if (!snapshot) return null;
    let payload = JSON.stringify(snapshot);
    if (payload.length <= SNAPSHOT_MAX_BYTES) return snapshot;
    // Drop oldest non-trigger messages until we fit. Keep the most recent
    // assistant turn intact so resume always shows the user the latest
    // model output.
    const trimmed = { ...snapshot, messages: Array.isArray(snapshot.messages) ? [...snapshot.messages] : [] };
    while (trimmed.messages.length > 2) {
        trimmed.messages.shift();
        payload = JSON.stringify(trimmed);
        if (payload.length <= SNAPSHOT_MAX_BYTES) break;
    }
    return trimmed;
}

async function getBuilderSession(automationId, userId) {
    await initDB();
    const r = await getOne(
        'SELECT builder_session, user_id FROM automations WHERE id = $1',
        [automationId],
    );
    if (!r) return null;
    if (userId && r.user_id !== userId) return null;
    const raw = typeof r.builder_session === 'string' ? safeParse(r.builder_session, null) : (r.builder_session ?? null);
    return raw;
}

/**
 * Persist a builder-session snapshot. When `expectedVersion` is provided,
 * the write only succeeds if the persisted snapshot's version matches —
 * mismatches return { ok: false, conflict: true, current }. When omitted,
 * the write is unconditional and the version increments by 1.
 */
async function setBuilderSession(automationId, userId, snapshot, { expectedVersion = null } = {}) {
    await initDB();
    const trimmed = trimSnapshot(snapshot) || {};
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            'SELECT user_id, builder_session FROM automations WHERE id = $1 FOR UPDATE',
            [automationId],
        );
        if (cur.rows.length === 0) {
            await client.query('ROLLBACK');
            return { ok: false, notFound: true };
        }
        if (userId && cur.rows[0].user_id !== userId) {
            await client.query('ROLLBACK');
            return { ok: false, forbidden: true };
        }
        const currentSnap = (typeof cur.rows[0].builder_session === 'string'
            ? safeParse(cur.rows[0].builder_session, null)
            : (cur.rows[0].builder_session ?? null)) || {};
        const currentVersion = Number.isFinite(currentSnap.version) ? currentSnap.version : 0;
        if (expectedVersion != null && currentVersion !== expectedVersion) {
            await client.query('ROLLBACK');
            return { ok: false, conflict: true, current: currentSnap };
        }
        const next = { ...trimmed, version: currentVersion + 1 };
        await client.query(
            `UPDATE automations SET builder_session = $1::jsonb, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(next), automationId],
        );
        await client.query('COMMIT');
        return { ok: true, snapshot: next };
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
    } finally {
        client.release();
    }
}

async function clearBuilderSession(automationId, userId) {
    await initDB();
    if (userId) {
        await run(
            `UPDATE automations SET builder_session = NULL WHERE id = $1 AND user_id = $2`,
            [automationId, userId],
        );
    } else {
        await run(`UPDATE automations SET builder_session = NULL WHERE id = $1`, [automationId]);
    }
}

module.exports = { getBuilderSession, setBuilderSession, clearBuilderSession };
