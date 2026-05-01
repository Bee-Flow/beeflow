/**
 * Trigger Bus — fans incoming app events into matching automation runs.
 *
 * dispatchEvent({ provider, event, payload, userId? })
 *   - finds matching automation_event_subscriptions rows
 *   - applies any per-subscription filter
 *   - calls automationRunner.executeAutomation(...) for each match
 *
 * Also owns:
 *   - runPollingPass()             : polling-mode subscriptions
 *   - renewExpiringSubscriptions() : MS Graph subscription refresh
 */

const automationStore = require('../stores/automationStore');

function matchFilter(payload, filter) {
    if (!filter) return true;
    if (typeof filter !== 'object') return true;
    for (const k of Object.keys(filter)) {
        const want = filter[k];
        const got = payload?.[k];
        if (Array.isArray(want)) { if (!want.includes(got)) return false; }
        else if (typeof want === 'object' && want !== null) { if (!matchFilter(got, want)) return false; }
        else if (got !== want) return false;
    }
    return true;
}

async function dispatchEvent({ provider, event, payload = {}, userId = null }) {
    const subs = await automationStore.getSubscriptionsForProvider(provider, event);
    const runs = [];
    for (const sub of subs) {
        if (userId && sub.userId !== userId) continue;
        if (!matchFilter(payload, sub.filter)) continue;
        const automation = await automationStore.getAutomation(sub.automationId);
        if (!automation || !automation.isActive || automation.isDraft) continue;
        const runner = require('../core/automationRunner');
        try {
            const run = await runner.executeAutomation(automation, {
                triggerKind: 'app_event',
                triggerPayload: { provider, event, ...payload },
            });
            runs.push({ subId: sub.id, runId: run?.id });
        } catch (e) {
            console.error('[TriggerBus] dispatch error:', e.message);
        }
    }
    return runs;
}

// ── Polling pass (Gmail history, Calendar syncToken) ────

async function runPollingPass() {
    const subs = await automationStore.getPollingSubscriptions({ olderThanMs: 60_000 });
    for (const sub of subs) {
        try {
            const handler = POLLERS[sub.provider]?.[sub.eventType];
            if (!handler) continue;
            const session = await loadSession(sub.userId);
            if (!session) continue;
            const events = await handler(sub, session);
            for (const ev of events) {
                await dispatchEvent({ provider: sub.provider, event: sub.eventType, payload: ev, userId: sub.userId });
            }
            await automationStore.updateSubscription(sub.id, { lastPolledAt: new Date().toISOString() });
        } catch (e) {
            console.warn(`[TriggerBus] polling failed for sub ${sub.id}: ${e.message}`);
        }
    }
}

async function loadSession(userId) {
    const { pool } = require('../db');
    try {
        const { rows } = await pool.query(
            `SELECT sess FROM user_sessions
             WHERE sess::jsonb -> 'user' ->> 'id' = $1 AND expire > NOW()
             ORDER BY expire DESC LIMIT 1`, [userId],
        );
        return rows[0] ? (typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess) : null;
    } catch { return null; }
}

const POLLERS = {
    gmail: {
        'mail.new': async (sub, session) => {
            try {
                const { google } = require('googleapis');
                const auth = new google.auth.OAuth2();
                auth.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken });
                const gmail = google.gmail({ version: 'v1', auth });
                if (sub.lastCursor) {
                    const r = await gmail.users.history.list({ userId: 'me', startHistoryId: sub.lastCursor, historyTypes: ['messageAdded'] });
                    const events = [];
                    for (const h of (r.data.history || [])) {
                        for (const m of (h.messagesAdded || [])) events.push({ messageId: m.message?.id, threadId: m.message?.threadId });
                    }
                    if (r.data.historyId) await automationStore.updateSubscription(sub.id, { lastCursor: String(r.data.historyId) });
                    return events;
                }
                // Bootstrap cursor
                const profile = await gmail.users.getProfile({ userId: 'me' });
                if (profile.data.historyId) await automationStore.updateSubscription(sub.id, { lastCursor: String(profile.data.historyId) });
                return [];
            } catch (e) {
                console.warn('[TriggerBus] gmail poll error:', e.message);
                return [];
            }
        },
    },
    'google-calendar': {
        'event.changed': async (sub, session) => {
            try {
                const { google } = require('googleapis');
                const auth = new google.auth.OAuth2();
                auth.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken });
                const cal = google.calendar({ version: 'v3', auth });
                const res = await cal.events.list({
                    calendarId: 'primary',
                    syncToken: sub.lastCursor || undefined,
                    maxResults: 50,
                });
                if (res.data.nextSyncToken) await automationStore.updateSubscription(sub.id, { lastCursor: res.data.nextSyncToken });
                return (res.data.items || []).map(ev => ({
                    eventId: ev.id, summary: ev.summary, start: ev.start, end: ev.end, status: ev.status,
                }));
            } catch (e) {
                console.warn('[TriggerBus] calendar poll error:', e.message);
                return [];
            }
        },
    },
};

// ── Subscription renewal (MS Graph) ─────────────────────

async function renewExpiringSubscriptions() {
    try {
        const subs = await automationStore.getExpiringSubscriptions({ withinMs: 5 * 60_000 });
        for (const sub of subs) {
            if (sub.provider !== 'msgraph') continue;
            // Best-effort PATCH with new expirationDateTime; silently no-op on failure.
            try {
                const session = await loadSession(sub.userId);
                if (!session?.accessToken) continue;
                const newExpiry = new Date(Date.now() + 50 * 60_000).toISOString();
                await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${sub.externalRef}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ expirationDateTime: newExpiry }),
                });
                await automationStore.updateSubscription(sub.id, { expiresAt: newExpiry });
            } catch (e) {
                console.warn(`[TriggerBus] msgraph sub renewal failed: ${e.message}`);
            }
        }
    } catch (e) {
        console.warn('[TriggerBus] renewal pass error:', e.message);
    }
}

module.exports = { dispatchEvent, runPollingPass, renewExpiringSubscriptions };
