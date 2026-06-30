/**
 * subscriptions.js — automationStore aggregate (§WS5, extracted verbatim).
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll, exec, getClient, pool } = require('./core');
const { rowToAutomation, rowToRun, rowToRunStep, safeParse, fromJsonb } = require('./rowMappers');

// ── Event subscriptions ───────────────────────────────

async function createSubscription({ automationId, userId, provider, eventType, mode = 'webhook', externalRef = null, expiresAt = null, lastCursor = null, filter = null, clientState = null }) {
    await initDB();
    const id = crypto.randomUUID();
    await run(
        `INSERT INTO automation_event_subscriptions
            (id, automation_id, user_id, provider, event_type, mode, external_ref, expires_at, last_cursor, filter_json, client_state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, automationId, userId, provider, eventType, mode, externalRef, expiresAt, lastCursor, filter ? JSON.stringify(filter) : null, clientState],
    );
    return getSubscription(id);
}

function rowToSubscription(r) {
    if (!r) return null;
    return {
        id: r.id, automationId: r.automation_id, userId: r.user_id,
        provider: r.provider, eventType: r.event_type, mode: r.mode,
        externalRef: r.external_ref, expiresAt: r.expires_at,
        lastCursor: r.last_cursor, lastPolledAt: r.last_polled_at,
        filter: typeof r.filter_json === 'string' ? safeParse(r.filter_json, null) : r.filter_json,
        // Failure tracking + MS Graph clientState (added by automation-timeout-and-subs-2026-05).
        consecutiveFailures: r.consecutive_failures ?? 0,
        errorNotifiedAt: r.error_notified_at ? new Date(r.error_notified_at).toISOString() : null,
        clientState: r.client_state ?? null,
        // Push/poll preference (added by automation-event-mode-2026-05).
        // 'hybrid' = push when connector available, polling as backstop;
        // 'webhook' = push only (used by msgraph + nextcloud connector);
        // 'polling' = legacy polling-only path.
        modePreference: r.mode_preference ?? 'hybrid',
        lastPushAt: r.last_push_at ? new Date(r.last_push_at).toISOString() : null,
    };
}

async function getSubscription(id) {
    await initDB();
    const r = await getOne('SELECT * FROM automation_event_subscriptions WHERE id = $1', [id]);
    return rowToSubscription(r);
}

/**
 * Look up a subscription by provider + externalRef. Used by the MS Graph
 * notification handler to validate clientState against the row that owns
 * this subscriptionId — without it, anyone who learns the notificationUrl
 * can forge events on behalf of another tenant.
 */
async function getSubscriptionByExternalRef(provider, externalRef) {
    await initDB();
    if (!externalRef) return null;
    const r = await getOne(
        'SELECT * FROM automation_event_subscriptions WHERE provider = $1 AND external_ref = $2 LIMIT 1',
        [provider, externalRef],
    );
    return rowToSubscription(r);
}

async function getSubscriptionsForProvider(provider, eventType) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_event_subscriptions WHERE provider = $1 AND event_type = $2',
        [provider, eventType],
    );
    return rows.map(rowToSubscription);
}

/**
 * All subscriptions for one automation. Used by activate/deactivate to
 * dedupe and clean up, and by an automation's settings panel to show
 * which event sources are wired up.
 */
/**
 * Subscriptions for one user + provider + event. Used by the push-event
 * webhook handler to find every automation listening for this NC event
 * for this user, so it can dispatch and stamp last_push_at on each row.
 */
async function getSubscriptionsForUserAndEvent(userId, provider, eventType) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_event_subscriptions WHERE user_id = $1 AND provider = $2 AND event_type = $3',
        [userId, provider, eventType],
    );
    return rows.map(rowToSubscription);
}

async function getSubscriptionsForAutomation(automationId) {
    await initDB();
    const rows = await getAll(
        'SELECT * FROM automation_event_subscriptions WHERE automation_id = $1',
        [automationId],
    );
    return rows.map(rowToSubscription);
}

/**
 * Delete every subscription for an automation. Called from /deactivate
 * (and /delete) so the poller stops firing for paused / removed
 * automations the moment the user toggles them off.
 */
async function deleteSubscriptionsForAutomation(automationId) {
    await initDB();
    await run('DELETE FROM automation_event_subscriptions WHERE automation_id = $1', [automationId]);
}

async function getPollingSubscriptions({ olderThanMs = 60_000, webhookStaleMs = 15 * 60_000 } = {}) {
    await initDB();
    // Two cases:
    //  1. mode='polling'  → poll on every tick where last_polled_at is old enough
    //  2. mode='webhook'  → poll as crash-recovery when last_push_at is stale
    //                       (push pipeline may be down — connector crashed,
    //                        AppAPI events_listener silently dropped, etc.).
    //     Healthy webhook subs are skipped entirely; this only kicks in
    //     after `webhookStaleMs` of silence.
    const rows = await getAll(
        `SELECT * FROM automation_event_subscriptions
         WHERE (
                  mode = 'polling'
                  AND (last_polled_at IS NULL OR last_polled_at < NOW() - ($1 * INTERVAL '1 millisecond'))
              )
            OR (
                  mode = 'webhook'
                  AND (last_push_at IS NULL OR last_push_at < NOW() - ($2 * INTERVAL '1 millisecond'))
                  AND (last_polled_at IS NULL OR last_polled_at < NOW() - ($1 * INTERVAL '1 millisecond'))
              )
         LIMIT 50`,
        [olderThanMs, webhookStaleMs],
    );
    return rows.map(rowToSubscription);
}

async function getExpiringSubscriptions({ withinMs = 5 * 60_000 } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automation_event_subscriptions
         WHERE mode = 'webhook'
           AND expires_at IS NOT NULL
           AND expires_at < NOW() + ($1 * INTERVAL '1 millisecond')`,
        [withinMs],
    );
    return rows.map(rowToSubscription);
}

async function updateSubscription(id, updates) {
    await initDB();
    const map = {
        externalRef: 'external_ref',
        expiresAt: 'expires_at',
        lastCursor: 'last_cursor',
        lastPolledAt: 'last_polled_at',
        consecutiveFailures: 'consecutive_failures',
        errorNotifiedAt: 'error_notified_at',
        clientState: 'client_state',
        modePreference: 'mode_preference',
        lastPushAt: 'last_push_at',
    };
    const setClauses = []; const params = []; let idx = 1;
    for (const [jsKey, dbCol] of Object.entries(map)) {
        if (updates[jsKey] === undefined) continue;
        setClauses.push(`"${dbCol}" = $${idx++}`);
        params.push(updates[jsKey]);
    }
    if (params.length === 0) return false;
    params.push(id);
    const { rowCount } = await run(`UPDATE automation_event_subscriptions SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);
    return rowCount > 0;
}

/**
 * Atomically increment `consecutive_failures` and return the new value.
 * Used by the polling/renewal paths to drive the failure-escalation
 * notification: callers compare the returned count to the threshold
 * (5 for polling, 2 for renewal) and notify once when it crosses.
 */
async function incrementSubscriptionFailures(id) {
    await initDB();
    const { rows } = await pool.query(
        `UPDATE automation_event_subscriptions
            SET consecutive_failures = consecutive_failures + 1
          WHERE id = $1
          RETURNING consecutive_failures, error_notified_at`,
        [id],
    );
    if (!rows[0]) return { consecutiveFailures: 0, errorNotifiedAt: null };
    return {
        consecutiveFailures: rows[0].consecutive_failures,
        errorNotifiedAt: rows[0].error_notified_at ? new Date(rows[0].error_notified_at).toISOString() : null,
    };
}

async function resetSubscriptionFailures(id) {
    await initDB();
    await run(
        `UPDATE automation_event_subscriptions
            SET consecutive_failures = 0,
                error_notified_at = NULL
          WHERE id = $1
            AND (consecutive_failures > 0 OR error_notified_at IS NOT NULL)`,
        [id],
    );
}

async function deleteSubscription(id) {
    await initDB();
    const { rowCount } = await run('DELETE FROM automation_event_subscriptions WHERE id = $1', [id]);
    return rowCount > 0;
}

module.exports = { createSubscription, getSubscription, getSubscriptionByExternalRef, getSubscriptionsForProvider, getSubscriptionsForUserAndEvent, getSubscriptionsForAutomation, deleteSubscriptionsForAutomation, getPollingSubscriptions, getExpiringSubscriptions, updateSubscription, incrementSubscriptionFailures, resetSubscriptionFailures, deleteSubscription };
