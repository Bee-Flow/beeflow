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

/**
 * Resolve the session-shaped credentials a polling handler needs.
 *
 * Source order matches automationRunner.resolveUserSession():
 *   1. routineAuth vault — long-lived per-user OAuth tokens (works without
 *      an active browser session). This is what makes the Gmail "new
 *      email" trigger fire even when the user is signed out.
 *   2. user_sessions row — last-resort fallback for installs that haven't
 *      been migrated to the vault yet, gated by ROUTINE_AUTH_LEGACY.
 *
 * Returns `{ accessToken, refreshToken, oauthProvider, routineProviders }`
 * so the existing googleapis client setup keeps working unchanged.
 */
async function loadSession(userId) {
    try {
        const routineAuth = require('../core/routineAuth');
        // We don't know which integrations this particular automation uses
        // here, so ask for ALL providers the user has connected. The vault
        // helper returns a primary + per-provider map.
        const built = await routineAuth.buildUserAuth(userId, {
            enabledIntegrations: ['gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-contacts', 'google-keep', 'google-groups', 'outlook', 'ms-calendar', 'onedrive', 'ms-contacts', 'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts'],
        });
        if (built && built.accessToken) {
            return {
                accessToken: built.accessToken,
                refreshToken: built.refreshToken,
                oauthProvider: built.oauthProvider,
                routineProviders: built.routineProviders || {},
            };
        }
    } catch (err) {
        console.warn(`[TriggerBus] vault session lookup failed for user ${userId}: ${err.message}`);
    }

    if (process.env.ROUTINE_AUTH_LEGACY !== '0') {
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
    return null;
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
                    const r = await gmail.users.history.list({
                        userId: 'me',
                        startHistoryId: sub.lastCursor,
                        historyTypes: ['messageAdded'],
                    });
                    // Collect new message ids first so we can de-duplicate
                    // (Gmail's history endpoint can list the same message
                    // under multiple history records during label changes).
                    const seen = new Set();
                    const ids = [];
                    for (const h of (r.data.history || [])) {
                        for (const m of (h.messagesAdded || [])) {
                            const id = m.message?.id;
                            if (id && !seen.has(id)) { seen.add(id); ids.push({ id, threadId: m.message?.threadId }); }
                        }
                    }
                    // Enrich each new message with the headers / snippet /
                    // labels that automations actually want to filter on.
                    // Without this the trigger payload is just `{messageId}`
                    // and downstream steps need a separate gmail_read call.
                    // Capped at 20 per tick to avoid hammering the Gmail
                    // API on a busy inbox; the rest will be picked up next tick.
                    const events = [];
                    for (const { id, threadId } of ids.slice(0, 20)) {
                        const enriched = await fetchGmailMessageMetadata(gmail, id).catch(() => null);
                        events.push({
                            messageId: id,
                            threadId,
                            ...(enriched || {}),
                        });
                    }
                    if (r.data.historyId) await automationStore.updateSubscription(sub.id, { lastCursor: String(r.data.historyId) });
                    return events;
                }
                // Bootstrap cursor — first poll just snapshots the current
                // history id so we don't deliver a year of historic emails
                // the moment a user activates the trigger.
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

/**
 * Fetch the headers / snippet / labelIds for one Gmail message so the
 * mail.new event payload carries enough context for shallow filters
 * (e.g. `filter: { labelIds: ['Label_3'] }`) and downstream binding
 * (`{{trigger.output.subject}}`) without an extra round-trip.
 *
 * `format: 'metadata'` is much cheaper than `format: 'full'` — we only
 * pull the half-dozen headers users actually filter on. Body fetching is
 * left to an explicit `gmail_read` step.
 */
async function fetchGmailMessageMetadata(gmail, messageId) {
    const r = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID'],
    });
    const headers = r.data.payload?.headers || [];
    const get = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || null;
    return {
        from: get('From'),
        to: get('To'),
        cc: get('Cc'),
        subject: get('Subject') || '(no subject)',
        date: get('Date'),
        snippet: r.data.snippet || '',
        labelIds: r.data.labelIds || [],
        sizeEstimate: r.data.sizeEstimate || null,
        historyId: r.data.historyId || null,
    };
}

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
