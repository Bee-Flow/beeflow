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
const { matchFilter, applyDslFilter } = require('./triggers/dslFilters');

// §WS5 — matchers + dispatch live in ./triggerBus/{filters,dispatch}.js.
const { matchGmailMailFilter, matchGmailLabelFilter, matchCalendarChangedFilter, matchCalendarUpcomingFilter, matchDriveFileNewFilter, matchNextcloudFileFilter, matchNextcloudShareFilter, matchNextcloudShareGenericFilter, matchNextcloudActivityFilter, matchNextcloudNotificationFilter, matchNextcloudCommentFilter, matchNextcloudTagFilter, matchSupportTicketResolvedFilter, matchNextcloudCalendarFilter, matchNextcloudCalendarUpcomingFilter, matchNextcloudDeckCardFilter, matchNextcloudDeckCardMovedFilter, matchNextcloudTalkMessageFilter, matchNextcloudTaskFilter, matchNextcloudUserStatusFilter, matchTicketAssistantTicketNewFilter, matchTicketAssistantSyncFilter, containsCI, pickMatcher } = require('./triggerBus/filters');
const { dispatchEvent, dispatchOrgScopedEvent, dispatchTicketAssistantEvent, dispatchSupportEvent } = require('./triggerBus/dispatch');

/**
 * Gmail-aware mail.new filter. The shallow `matchFilter` above is fine
 * for app events with stable scalar payloads (msgraph webhooks, GitHub
 * push events) but Gmail's enriched payload — `from` is a header like
 * `"Boss Smith <boss@example.com>"`, `labelIds` is an array, `subject`
 * needs substring match — needs richer semantics.
 *
 * Supported filter fields (all optional; ALL specified fields must
 * match — AND across keys, OR within an array on a single key):
 *
 *   from              string, substring (case-insensitive). Matches the
 *                     raw From header so "boss@example.com" hits when
 *                     the header is "Boss Smith <boss@example.com>".
 *   to                same, against the To header.
 *   cc                same, against the Cc header.
 *   subjectContains   string, substring on Subject (case-insensitive).
 *   subjectRegex      string, JS regex against Subject. Capped at 200
 *                     chars; invalid patterns silently fail-closed (no
 *                     match), so a typo can't fire on every email.
 *   labelIds          string[]; match if the message has ANY of these.
 *   excludeLabelIds   string[]; match only if the message has NONE.
 *   hasAttachment     boolean; matches when the enriched payload has at
 *                     least one entry in `attachments[]`. Falls back to the
 *                     HAS_ATTACHMENT system label for legacy payloads.
 *   excludeFromSelf   boolean; drops messages the user sent themselves
 *                     (uses the SENT system label).
 *   maxAgeMinutes     number; drops messages whose Date header is older
 *                     than N minutes. Useful as a freshness cap so a
 *                     paused poller doesn't flood the user with backlog
 *                     when it resumes.
 */

// ── Polling pass (Gmail history, Calendar syncToken) ────

async function runPollingPass() {
    const subs = await automationStore.getPollingSubscriptions({ olderThanMs: 60_000 });
    if (subs.length > 0) {
        console.log(`[TriggerBus] poll tick — ${subs.length} due subscription(s)`);
    }
    for (const sub of subs) {
        try {
            const handler = POLLERS[sub.provider]?.[sub.eventType];
            if (!handler) {
                console.warn(`[TriggerBus] no handler for ${sub.provider}.${sub.eventType} (sub ${sub.id})`);
                continue;
            }
            const session = await loadSession(sub.userId);
            if (!session) {
                // Silent skip used to be the failure mode that hid every
                // missing-credential bug. Log it loudly and escalate after
                // the threshold so the user sees a notification instead of
                // an automation that quietly stops firing.
                console.warn(`[TriggerBus] no credentials for user ${sub.userId} (provider=${sub.provider}); skipping sub ${sub.id}`);
                await automationStore.updateSubscription(sub.id, { lastPolledAt: new Date().toISOString() });
                await escalateSubscriptionFailure(sub, POLL_FAILURE_THRESHOLD, 'no credentials');
                continue;
            }
            const events = await handler(sub, session);
            console.log(`[TriggerBus] sub ${sub.id} (${sub.provider}.${sub.eventType}) cursor=${sub.lastCursor || 'none'} → ${events.length} event(s)`);
            for (const ev of events) {
                await dispatchEvent({ provider: sub.provider, event: sub.eventType, payload: ev, userId: sub.userId });
            }
            await automationStore.updateSubscription(sub.id, { lastPolledAt: new Date().toISOString() });
            await automationStore.resetSubscriptionFailures(sub.id);
        } catch (e) {
            console.warn(`[TriggerBus] polling failed for sub ${sub.id}: ${e.message}`);
            await escalateSubscriptionFailure(sub, POLL_FAILURE_THRESHOLD, e.message);
        }
    }
}

/**
 * Resolve the session-shaped credentials a polling handler needs.
 *
 * Source order:
 *   1. routineAuth vault (`routine_credentials` table) — long-lived,
 *      auto-refreshing tokens. Works for users who connected after the
 *      vault feature shipped.
 *   2. user_sessions row — same store the chat path uses via `req.session`.
 *      This is the canonical source for users who connected before the
 *      vault existed; their tokens never landed in routine_credentials.
 *
 * Both paths return the same shape: `{ accessToken, refreshToken,
 *   oauthProvider, routineProviders, _source }`. The `_source` tag lets
 * the diagnose endpoint show the user where their credentials came from
 * ("vault" / "session") so they understand whether the Integrations page
 * needs a re-connect.
 *
 * Note: the user_sessions fallback used to be gated by ROUTINE_AUTH_LEGACY.
 * That gate is removed — when a user has working chat-side Gmail tokens
 * but an empty vault, we should ALWAYS use them rather than silently
 * failing the trigger. The trade-off: when their browser session expires,
 * the poller goes dark until they sign in again. Opportunistic vault
 * migration is a separate, future cleanup.
 */
async function loadSession(userId) {
    // Connector-bound users authenticate to NC via the ExApp reverse proxy
    // (HMAC-signed, no bearer token). Resolve their instance binding up front
    // so it can be merged into whichever credential path wins below. Without
    // it, nextcloudClient.resolveAuth has nothing to route through AND the
    // polling pass skips them entirely (loadSession → null → "no credentials"),
    // so every NC poller stays dark for the primary hosting model. getUser
    // returns raw columns, so the uid is `nc_uid` (snake_case).
    let connectorFields = null;
    try {
        const userStore = require('../stores/userStore');
        const u = await userStore.getUser(userId).catch(() => null);
        if (u && u.provider === 'nextcloud_connector') {
            connectorFields = {
                connectorOrgId: u.organizationId || null,
                connectorNcUid: u.nc_uid || null,
                user: { id: userId, provider: 'nextcloud_connector', organizationId: u.organizationId || null, ncUid: u.nc_uid || null },
            };
        }
    } catch (_) { /* non-fatal — fall through to token paths */ }

    // 1) Vault first.
    try {
        const routineAuth = require('../core/routineAuth');
        const built = await routineAuth.buildUserAuth(userId, {
            enabledIntegrations: ['gmail', 'google-calendar', 'google-drive', 'google-docs', 'google-contacts', 'google-keep', 'google-groups', 'outlook', 'ms-calendar', 'onedrive', 'ms-contacts', 'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts'],
        });
        if (built && built.accessToken) {
            return {
                accessToken: built.accessToken,
                refreshToken: built.refreshToken,
                oauthProvider: built.oauthProvider,
                routineProviders: built.routineProviders || {},
                _source: 'vault',
                // Merge connector binding so hybrid users (connector NC +
                // OAuth Google) can call both kinds of tool in one routine.
                ...(connectorFields || {}),
            };
        }
    } catch (err) {
        console.warn(`[TriggerBus] vault session lookup failed for user ${userId}: ${err.message}`);
    }

    // 1.5) Connector-bound users have no bearer token — return the connector
    // identity directly so resolveAuth routes through /nc/* and the polling
    // pass actually runs their NC triggers.
    if (connectorFields) {
        return { ...connectorFields, routineProviders: {}, _source: 'connector' };
    }

    // 2) user_sessions fallback. Same shape as req.session for the chat path:
    //    { user: { id, ... }, accessToken, refreshToken, oauthProvider, ... }
    //    (connector-bound users already returned above at step 1.5.)
    const { pool } = require('../db');
    try {
        const { rows } = await pool.query(
            `SELECT sess FROM user_sessions
             WHERE sess::jsonb -> 'user' ->> 'id' = $1 AND expire > NOW()
             ORDER BY expire DESC LIMIT 1`, [userId],
        );
        if (!rows[0]) return null;
        const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
        if (!sess?.accessToken) return null;
        return {
            accessToken: sess.accessToken,
            refreshToken: sess.refreshToken || null,
            oauthProvider: sess.oauthProvider || null,
            routineProviders: sess.routineProviders || {},
            _source: 'session',
        };
    } catch (e) {
        console.warn(`[TriggerBus] user_sessions fallback failed for user ${userId}: ${e.message}`);
        return null;
    }
}

// Module-scoped cache of the Nextcloud activity feed per-user. Five
// triggers (file.new / file.changed / share.received / activity.new /
// notification.new) can subscribe at once for the same user; without a
// cache they would each issue an HTTP request inside a single polling
// tick. Cache is short-lived (a few seconds) — long enough to coalesce
// the in-pass calls, short enough that the next tick still fetches fresh
// rows.
//
// Phase 4 fix: in-flight dedup. Two concurrent ticks (multi-pod, or a
// reaper-triggered re-poll) used to issue duplicate fetches because each
// only saw the empty resolved cache. We now park the in-flight Promise
// alongside the cached rows; concurrent callers await the same Promise
// instead of firing their own request.
const _ncActivityCache = new Map(); // userId → { ts, rows[], inflight? }
const NC_ACTIVITY_CACHE_TTL_MS = 5_000;

async function _ncFetchActivityRows(userId, session) {
    const cached = _ncActivityCache.get(userId);
    if (cached) {
        if (cached.inflight) {
            // Someone else is fetching; piggyback on their result.
            return cached.inflight;
        }
        if (Date.now() - cached.ts < NC_ACTIVITY_CACHE_TTL_MS) return cached.rows;
    }
    const promise = (async () => {
        let rows = [];
        try {
            const tools = require('../integrations/nextcloudActivityTools');
            const result = await tools.executeNextcloudActivityTool(
                'nextcloud_activity_list',
                { filter: 'all', limit: 200 },
                userId, session,
            );
            if (result?.activities) rows = result.activities;
            return rows;
        } catch (e) {
            console.warn(`[TriggerBus] nextcloud activity fetch threw for user ${userId}: ${e.message}`);
            return rows;
        }
    })().then((rows) => {
        rows.sort((a, b) => (a.id || 0) - (b.id || 0));
        _ncActivityCache.set(userId, { ts: Date.now(), rows, inflight: null });
        return rows;
    }).catch((e) => {
        // Clear the inflight slot so the next tick can retry.
        _ncActivityCache.set(userId, { ts: 0, rows: [], inflight: null });
        throw e;
    });

    _ncActivityCache.set(userId, { ts: cached?.ts || 0, rows: cached?.rows || [], inflight: promise });
    return promise;
}

/**
 * Map a raw activity row to the normalised payload our triggers emit, plus
 * `_kind` flags the per-trigger filter uses to route. Activity API type
 * slugs vary by Nextcloud version, so we look at both the `type` field
 * and the human-readable subject as a fallback (documented in the plan).
 */
function _ncNormaliseActivity(row, session) {
    const t = String(row.type || '').toLowerCase();
    const subj = String(row.subject || '').toLowerCase();
    const isFileCreated = t === 'file_created' || (t === 'files' && subj.includes('created'));
    const isFileChanged = t === 'file_changed' || t === 'file_updated' || (t === 'files' && (subj.includes('changed') || subj.includes('updated')));
    const isShareReceived = t === 'shared_with_you' || t === 'remote_share_received'
        || ((t === 'shares' || t === 'shared') && subj.includes('shared'));

    const path = row.objectName || '';
    const name = path.split('/').filter(Boolean).pop() || path;
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : null;

    const sessionUid = session?.nextcloudUid
        || session?.routineProviders?.nextcloud?.nextcloudUid
        || null;
    const isOwnAction = !!(sessionUid && row.actor === sessionUid);

    return {
        activityId: row.id,
        type: row.type,
        subject: row.subject,
        message: row.message,
        actor: row.actor,
        objectName: row.objectName,
        objectType: row.objectType,
        path,
        name,
        extension,
        // Folder vs file is fuzzy in the activity feed — Nextcloud only
        // sends `objectType:'files'` for both. Best-effort: treat trailing
        // slash or absent extension on the path as folder.
        kind: (path.endsWith('/') || !extension) ? 'folder' : 'file',
        link: row.link,
        datetime: row.datetime,
        isOwnAction,
        raw: row,
        _isFileCreated: isFileCreated,
        _isFileChanged: isFileChanged,
        _isShareReceived: isShareReceived,
    };
}

/** Generic Nextcloud poller body — every Nextcloud channel uses this
 *  with a different `predicate` to pick which rows to emit. */
async function _ncPollChannel({ sub, session, predicate }) {
    const rows = await _ncFetchActivityRows(sub.userId, session);
    const cursorId = sub.lastCursor ? Number(sub.lastCursor) : 0;
    const fresh = rows.filter(r => Number(r.id || 0) > cursorId);

    // Bootstrap: first poll only anchors the cursor; we don't deliver
    // historic rows the moment the user activates the trigger (mirrors
    // the Gmail bootstrap convention).
    if (!sub.lastCursor) {
        const maxId = rows.length ? rows[rows.length - 1].id : null;
        if (maxId != null) {
            await automationStore.updateSubscription(sub.id, { lastCursor: String(maxId) });
            console.log(`[TriggerBus] nextcloud bootstrap sub ${sub.id} anchored at activity_id=${maxId}`);
        }
        return [];
    }

    const events = [];
    let highest = cursorId;
    for (const row of fresh) {
        const normalised = _ncNormaliseActivity(row, session);
        if (predicate(normalised)) events.push(normalised);
        if (Number(row.id || 0) > highest) highest = Number(row.id);
    }
    if (highest > cursorId) {
        await automationStore.updateSubscription(sub.id, { lastCursor: String(highest) });
    }
    return events;
}

const POLLERS = {
    gmail: {
        'mail.new': async (sub, session) => {
            const { google } = require('googleapis');
            const auth = new google.auth.OAuth2();
            auth.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken });
            const gmail = google.gmail({ version: 'v1', auth });

            // Recoverable failure: history.list 404 / "Requested entity was
            // not found" / "invalid" means the cursor has aged out of
            // Gmail's ~7 day retention window. We drop the cursor and let
            // the bootstrap branch run on the next tick (or this tick after
            // re-entry). Without this the subscription was permanently
            // broken once it crossed the retention boundary.
            const isCursorStaleError = (err) => {
                const code = err?.code || err?.response?.status;
                const msg = String(err?.message || '').toLowerCase();
                return code === 404
                    || msg.includes('requested entity was not found')
                    || msg.includes('invalid history id')
                    || msg.includes('invalid_grant'); // expired refresh — surface but treat as stale
            };

            if (sub.lastCursor) {
                try {
                    const r = await gmail.users.history.list({
                        userId: 'me',
                        startHistoryId: sub.lastCursor,
                        historyTypes: ['messageAdded'],
                    });
                    const seen = new Set();
                    const ids = [];
                    for (const h of (r.data.history || [])) {
                        for (const m of (h.messagesAdded || [])) {
                            const id = m.message?.id;
                            if (id && !seen.has(id)) { seen.add(id); ids.push({ id, threadId: m.message?.threadId }); }
                        }
                    }
                    const events = [];
                    for (const { id, threadId } of ids.slice(0, 20)) {
                        const enriched = await fetchGmailMessageMetadata(gmail, id).catch(() => null);
                        events.push({ messageId: id, threadId, ...(enriched || {}) });
                    }
                    if (r.data.historyId) await automationStore.updateSubscription(sub.id, { lastCursor: String(r.data.historyId) });
                    return events;
                } catch (err) {
                    if (isCursorStaleError(err)) {
                        console.warn(`[TriggerBus] gmail cursor ${sub.lastCursor} stale for sub ${sub.id} — clearing and re-bootstrapping. (${err.message})`);
                        await automationStore.updateSubscription(sub.id, { lastCursor: null });
                        // Fall through to the bootstrap branch below.
                    } else {
                        console.warn('[TriggerBus] gmail poll error:', err.message);
                        return [];
                    }
                }
            }

            // Bootstrap branch. Used on first poll AND after a cursor reset.
            //
            // Rather than `getProfile()` (which only returns the current
            // historyId and gives the user a silent no-op on activate), we
            // pull the most recent matching message via messages.list. That:
            //   1. anchors the cursor at a definitely-fresh historyId, and
            //   2. lets us optionally surface that message as the "first"
            //      event so activation immediately produces a run.
            //
            // We do NOT auto-deliver the bootstrap message here, because
            // that's already handled by the immediate-dispatch path in
            // routes/automation.js POST /:id/activate. Returning it twice
            // would double-fire the automation. So this branch only
            // anchors the cursor.
            try {
                const list = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
                const newest = list.data.messages?.[0];
                if (newest?.id) {
                    const meta = await gmail.users.messages.get({
                        userId: 'me', id: newest.id, format: 'metadata', metadataHeaders: ['Date'],
                    });
                    const hid = meta.data.historyId;
                    if (hid) {
                        await automationStore.updateSubscription(sub.id, { lastCursor: String(hid) });
                        console.log(`[TriggerBus] gmail bootstrap sub ${sub.id} anchored at historyId=${hid}`);
                        return [];
                    }
                }
                // Empty mailbox or no messages.list result — fall back to profile.
                const profile = await gmail.users.getProfile({ userId: 'me' });
                if (profile.data.historyId) {
                    await automationStore.updateSubscription(sub.id, { lastCursor: String(profile.data.historyId) });
                    console.log(`[TriggerBus] gmail bootstrap sub ${sub.id} anchored at profile historyId=${profile.data.historyId}`);
                }
                return [];
            } catch (e) {
                console.warn('[TriggerBus] gmail bootstrap error:', e.message);
                return [];
            }
        },

        /**
         * label.added — fires when a label is applied to a message. Reuses
         * the same Gmail history machinery as mail.new but watches a
         * different `historyType`. Bootstrap path is identical.
         */
        'label.added': async (sub, session) => {
            const { google } = require('googleapis');
            const auth = new google.auth.OAuth2();
            auth.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken });
            const gmail = google.gmail({ version: 'v1', auth });

            const isCursorStaleError = (err) => {
                const code = err?.code || err?.response?.status;
                const msg = String(err?.message || '').toLowerCase();
                return code === 404
                    || msg.includes('requested entity was not found')
                    || msg.includes('invalid history id')
                    || msg.includes('invalid_grant');
            };

            if (sub.lastCursor) {
                try {
                    const r = await gmail.users.history.list({
                        userId: 'me',
                        startHistoryId: sub.lastCursor,
                        historyTypes: ['labelAdded'],
                    });
                    // Group label-added rows by messageId so a single
                    // message that picked up multiple labels in one batch
                    // fires once with all addedLabelIds aggregated.
                    const byMsg = new Map();
                    for (const h of (r.data.history || [])) {
                        for (const la of (h.labelsAdded || [])) {
                            const id = la.message?.id;
                            if (!id) continue;
                            const existing = byMsg.get(id) || { messageId: id, threadId: la.message?.threadId, addedLabelIds: [] };
                            for (const lid of (la.labelIds || [])) {
                                if (!existing.addedLabelIds.includes(lid)) existing.addedLabelIds.push(lid);
                            }
                            byMsg.set(id, existing);
                        }
                    }
                    const events = [];
                    for (const ev of [...byMsg.values()].slice(0, 20)) {
                        const enriched = await fetchGmailMessageMetadata(gmail, ev.messageId).catch(() => null);
                        events.push({ ...ev, ...(enriched || {}) });
                    }
                    if (r.data.historyId) await automationStore.updateSubscription(sub.id, { lastCursor: String(r.data.historyId) });
                    return events;
                } catch (err) {
                    if (isCursorStaleError(err)) {
                        console.warn(`[TriggerBus] gmail label cursor ${sub.lastCursor} stale for sub ${sub.id} — clearing.`);
                        await automationStore.updateSubscription(sub.id, { lastCursor: null });
                    } else {
                        console.warn('[TriggerBus] gmail label poll error:', err.message);
                        return [];
                    }
                }
            }

            // Bootstrap — anchor at the current historyId without delivering historic events.
            try {
                const list = await gmail.users.messages.list({ userId: 'me', maxResults: 1 });
                const newest = list.data.messages?.[0];
                if (newest?.id) {
                    const meta = await gmail.users.messages.get({
                        userId: 'me', id: newest.id, format: 'metadata', metadataHeaders: ['Date'],
                    });
                    if (meta.data.historyId) {
                        await automationStore.updateSubscription(sub.id, { lastCursor: String(meta.data.historyId) });
                        console.log(`[TriggerBus] gmail.label.added bootstrap sub ${sub.id} anchored at historyId=${meta.data.historyId}`);
                        return [];
                    }
                }
                const profile = await gmail.users.getProfile({ userId: 'me' });
                if (profile.data.historyId) {
                    await automationStore.updateSubscription(sub.id, { lastCursor: String(profile.data.historyId) });
                }
                return [];
            } catch (e) {
                console.warn('[TriggerBus] gmail label bootstrap error:', e.message);
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
                // Calendar's syncToken expires after ~1 month of disuse and
                // returns 410 Gone — same recoverable shape as Gmail's 404.
                // Drop the cursor and let the next tick re-bootstrap.
                try {
                    const res = await cal.events.list({
                        calendarId: 'primary',
                        syncToken: sub.lastCursor || undefined,
                        maxResults: 50,
                    });
                    if (res.data.nextSyncToken) await automationStore.updateSubscription(sub.id, { lastCursor: res.data.nextSyncToken });
                    return (res.data.items || []).map(ev => ({
                        eventId: ev.id,
                        summary: ev.summary || '',
                        description: ev.description || null,
                        start: ev.start || null,
                        end: ev.end || null,
                        status: ev.status || null,
                        calendarId: 'primary',
                        organizer: ev.organizer || null,
                        attendees: ev.attendees || [],
                        htmlLink: ev.htmlLink || null,
                    }));
                } catch (err) {
                    const code = err?.code || err?.response?.status;
                    if (code === 410 || /sync token/i.test(err?.message || '')) {
                        console.warn(`[TriggerBus] calendar syncToken stale for sub ${sub.id} — clearing.`);
                        await automationStore.updateSubscription(sub.id, { lastCursor: null });
                        // Bootstrap on the next tick — return [] so we don't
                        // dump a year of historic events into the user's lap.
                        return [];
                    }
                    throw err;
                }
            } catch (e) {
                console.warn('[TriggerBus] calendar poll error:', e.message);
                return [];
            }
        },

        /**
         * event.upcoming — fire N minutes before the start of an event.
         * Cursor JSON: { firedIds:[…last 200] }.
         */
        'event.upcoming': async (sub, session) => {
            try {
                const { google } = require('googleapis');
                const auth = new google.auth.OAuth2();
                auth.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken });
                const cal = google.calendar({ version: 'v3', auth });

                const filter = sub.filter || {};
                const leadMinutes = Math.max(1, Math.min(Number(filter.leadMinutes) || 15, 240));
                const calendarId = filter.calendarId || 'primary';
                const includeAllDay = filter.includeAllDay === true;

                const now = Date.now();
                // Query a slightly wider window than leadMinutes so a slow
                // tick doesn't miss the boundary.
                const SAFETY_MIN = 5;
                const timeMin = new Date(now).toISOString();
                const timeMax = new Date(now + (leadMinutes + SAFETY_MIN) * 60_000).toISOString();

                const res = await cal.events.list({
                    calendarId,
                    timeMin, timeMax,
                    singleEvents: true,
                    orderBy: 'startTime',
                    maxResults: 50,
                });

                let cursor = { firedIds: [] };
                try { if (sub.lastCursor) cursor = JSON.parse(sub.lastCursor) || cursor; } catch { /* ignore */ }
                const fired = new Set(Array.isArray(cursor.firedIds) ? cursor.firedIds : []);

                const events = [];
                const newlyFired = [];
                for (const ev of (res.data.items || [])) {
                    if (!ev.id || fired.has(ev.id)) continue;
                    if (!includeAllDay && !ev.start?.dateTime) continue; // skip all-day unless asked
                    const startMs = ev.start?.dateTime ? Date.parse(ev.start.dateTime) : NaN;
                    if (!Number.isFinite(startMs)) continue;
                    const minutesUntilStart = Math.round((startMs - now) / 60_000);
                    if (minutesUntilStart > leadMinutes) continue; // not yet within window
                    if (minutesUntilStart < -SAFETY_MIN) continue; // already started > safety ago
                    events.push({
                        eventId: ev.id,
                        summary: ev.summary || '',
                        description: ev.description || null,
                        start: ev.start, end: ev.end,
                        status: ev.status || null,
                        calendarId,
                        organizer: ev.organizer || null,
                        attendees: ev.attendees || [],
                        htmlLink: ev.htmlLink || null,
                        minutesUntilStart,
                    });
                    newlyFired.push(ev.id);
                }

                if (newlyFired.length > 0) {
                    const all = [...fired, ...newlyFired].slice(-200);
                    await automationStore.updateSubscription(sub.id, {
                        lastCursor: JSON.stringify({ firedIds: all }),
                    });
                } else if (!sub.lastCursor) {
                    // Initialise an empty cursor so we don't keep hitting
                    // the bootstrap branch.
                    await automationStore.updateSubscription(sub.id, {
                        lastCursor: JSON.stringify({ firedIds: [] }),
                    });
                }
                return events;
            } catch (e) {
                console.warn('[TriggerBus] calendar upcoming poll error:', e.message);
                return [];
            }
        },
    },

    'google-drive': {
        /**
         * file.new — fires when a file is created in the user's Drive.
         * Bootstraps with `getStartPageToken`; subsequent ticks use
         * `changes.list({pageToken})` and emit creates only.
         */
        'file.new': async (sub, session) => {
            const { google } = require('googleapis');
            const auth = new google.auth.OAuth2();
            auth.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken });
            const drive = google.drive({ version: 'v3', auth });

            const isStaleCursor = (err) => {
                const code = err?.code || err?.response?.status;
                const msg = String(err?.message || '').toLowerCase();
                return code === 404 || msg.includes('invalid_grant') || msg.includes('start page token');
            };

            if (!sub.lastCursor) {
                try {
                    const r = await drive.changes.getStartPageToken();
                    if (r.data?.startPageToken) {
                        await automationStore.updateSubscription(sub.id, { lastCursor: String(r.data.startPageToken) });
                        console.log(`[TriggerBus] drive bootstrap sub ${sub.id} anchored at pageToken=${r.data.startPageToken}`);
                    }
                } catch (e) {
                    console.warn('[TriggerBus] drive bootstrap error:', e.message);
                }
                return [];
            }

            try {
                const r = await drive.changes.list({
                    pageToken: sub.lastCursor,
                    includeRemoved: false,
                    spaces: 'drive',
                    fields: 'changes(time,removed,fileId,file(id,name,mimeType,parents,createdTime,modifiedTime,owners(emailAddress,me),webViewLink,trashed)),newStartPageToken,nextPageToken',
                    pageSize: 100,
                });
                const events = [];
                for (const ch of (r.data.changes || [])) {
                    const f = ch.file;
                    if (!f || ch.removed || f.trashed) continue;
                    // Treat as "new" when createdTime is recent (within the
                    // last 24h relative to the change time). Modifications
                    // of older files have createdTime predating the change
                    // and are skipped.
                    const created = Date.parse(f.createdTime || '') || 0;
                    const changeT = Date.parse(ch.time || '') || Date.now();
                    if (changeT - created > 24 * 60 * 60_000) continue;
                    events.push({
                        fileId: f.id,
                        name: f.name || '',
                        mimeType: f.mimeType || '',
                        parents: f.parents || [],
                        createdTime: f.createdTime || null,
                        owners: f.owners || [],
                        webViewLink: f.webViewLink || null,
                    });
                }
                const next = r.data.newStartPageToken || r.data.nextPageToken;
                if (next) await automationStore.updateSubscription(sub.id, { lastCursor: String(next) });
                return events;
            } catch (err) {
                if (isStaleCursor(err)) {
                    console.warn(`[TriggerBus] drive cursor ${sub.lastCursor} stale for sub ${sub.id} — clearing.`);
                    await automationStore.updateSubscription(sub.id, { lastCursor: null });
                    return [];
                }
                console.warn('[TriggerBus] drive poll error:', err.message);
                return [];
            }
        },
    },

    nextcloud: {
        'file.new':       (sub, session) => _ncPollChannel({ sub, session, predicate: r => r._isFileCreated }),
        'file.changed':   (sub, session) => _ncPollChannel({ sub, session, predicate: r => r._isFileChanged }),
        'share.received': (sub, session) => _ncPollChannel({ sub, session, predicate: r => r._isShareReceived }),
        'activity.new':   (sub, session) => _ncPollChannel({ sub, session, predicate: () => true }),

        /**
         * notification.new — separate Notifications API, not the activity
         * feed. Cursor = highest seen notification id.
         */
        'notification.new': async (sub, session) => {
            try {
                const tools = require('../integrations/nextcloudNotificationsTools');
                const result = await tools.executeNextcloudNotificationsTool(
                    'nextcloud_notifications_list', { limit: 100 }, sub.userId, session,
                );
                if (result?.error) {
                    console.warn(`[TriggerBus] nextcloud notifications fetch failed for sub ${sub.id}: ${result.error}`);
                    return [];
                }
                const items = Array.isArray(result?.notifications) ? result.notifications.slice() : [];
                items.sort((a, b) => (a.id || 0) - (b.id || 0));
                const cursorId = sub.lastCursor ? Number(sub.lastCursor) : 0;

                if (!sub.lastCursor) {
                    // Only anchor once notifications actually exist. Anchoring at
                    // 0 on an empty first poll would make the next non-empty tick
                    // treat the entire list as "fresh" and replay it.
                    if (items.length) {
                        await automationStore.updateSubscription(sub.id, { lastCursor: String(items[items.length - 1].id) });
                    }
                    return [];
                }

                const fresh = items.filter(n => Number(n.id || 0) > cursorId);
                let highest = cursorId;
                const events = [];
                for (const n of fresh) {
                    if (Number(n.id || 0) > highest) highest = Number(n.id);
                    events.push({
                        notificationId: n.id,
                        app: n.app || null,
                        subject: n.subject || '',
                        message: n.message || '',
                        link: n.link || null,
                        datetime: n.datetime || null,
                    });
                }
                if (highest > cursorId) await automationStore.updateSubscription(sub.id, { lastCursor: String(highest) });
                return events;
            } catch (e) {
                console.warn('[TriggerBus] nextcloud notifications poll error:', e.message);
                return [];
            }
        },

        /**
         * calendar.event.upcoming — fire N minutes before a Nextcloud calendar
         * event starts. NC has no real-time push class for "starting soon", so
         * this is poll-derived (mirrors the google-calendar event.upcoming
         * handler above). Cursor JSON: { firedIds:[…last 200] }, keyed
         * `uid|dtstart` so recurring-event instances dedupe independently.
         * Emits the shape matchNextcloudCalendarUpcomingFilter expects
         * (startsAt / summary / calendarId / attendees).
         */
        'calendar.event.upcoming': async (sub, session) => {
            try {
                const tools = require('../integrations/nextcloudCalendarTools');
                const filter = sub.filter || {};
                const leadMinutes = Math.max(1, Math.min(Number(filter.leadMinutes) || 15, 240));
                const calendar = filter.calendar || filter.calendarId || 'personal';
                const includeAllDay = filter.includeAllDay === true;

                const now = Date.now();
                const SAFETY_MIN = 5; // widen the window so a slow tick doesn't miss the boundary
                const result = await tools.executeNextcloudCalendarTool(
                    'nextcloud_calendar_list_events',
                    {
                        calendar,
                        start: new Date(now).toISOString(),
                        end: new Date(now + (leadMinutes + SAFETY_MIN) * 60_000).toISOString(),
                        limit: 50,
                    },
                    sub.userId, session,
                );
                if (result?.error) {
                    console.warn(`[TriggerBus] nextcloud calendar upcoming fetch failed for sub ${sub.id}: ${result.error}`);
                    return [];
                }
                const items = Array.isArray(result?.events) ? result.events : [];

                let cursor = { firedIds: [] };
                try { if (sub.lastCursor) cursor = JSON.parse(sub.lastCursor) || cursor; } catch { /* ignore */ }
                const fired = new Set(Array.isArray(cursor.firedIds) ? cursor.firedIds : []);

                const events = [];
                const newlyFired = [];
                for (const ev of items) {
                    const startsAt = ev.dtstart || null;
                    const startMs = startsAt ? Date.parse(startsAt) : NaN;
                    if (!Number.isFinite(startMs)) continue;
                    if (!includeAllDay && ev.allDay) continue; // skip all-day unless asked
                    const key = `${ev.uid || ev.href || ''}|${startsAt}`;
                    if (fired.has(key)) continue;
                    const minutesUntilStart = Math.round((startMs - now) / 60_000);
                    if (minutesUntilStart > leadMinutes) continue;  // not yet within window
                    if (minutesUntilStart < -SAFETY_MIN) continue;  // already started > safety ago
                    events.push({
                        uid: ev.uid || null,
                        summary: ev.summary || '',
                        description: ev.description || null,
                        startsAt,
                        endsAt: ev.dtend || null,
                        location: ev.location || null,
                        calendar,
                        calendarId: calendar,
                        // attendees come back as {cn,email} objects; flatten to
                        // strings so matchNextcloudCalendarFilter's attendeeContains works.
                        attendees: (ev.attendees || []).map(a => (a && (a.email || a.cn)) || a).filter(Boolean),
                        organizer: ev.organizer || null,
                        allDay: !!ev.allDay,
                        minutesUntilStart,
                    });
                    newlyFired.push(key);
                }

                if (newlyFired.length > 0) {
                    const all = [...fired, ...newlyFired].slice(-200);
                    await automationStore.updateSubscription(sub.id, { lastCursor: JSON.stringify({ firedIds: all }) });
                } else if (!sub.lastCursor) {
                    // Anchor an empty cursor so we stop hitting the bootstrap branch.
                    await automationStore.updateSubscription(sub.id, { lastCursor: JSON.stringify({ firedIds: [] }) });
                }
                return events;
            } catch (e) {
                console.warn('[TriggerBus] nextcloud calendar upcoming poll error:', e.message);
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
 * We use `format: 'full'` rather than 'metadata' so the payload also
 * exposes `attachments[]` (filename, mimeType, size, attachmentId). The
 * AI builder can then branch on `trigger.output.hasAttachment` and pass
 * `trigger.output.attachments[i].attachmentId` straight into
 * `gmail_read_attachment` — saving an extra `gmail_read` round-trip and
 * letting attachment bytes flow via `sourceHandle` to upload tools
 * without ever passing through the model context.
 */
async function fetchGmailMessageMetadata(gmail, messageId) {
    const { extractAttachments } = require('../integrations/gmailTools');
    const r = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
    });
    const headers = r.data.payload?.headers || [];
    const get = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || null;
    const threadId = r.data.threadId || null;
    const attachments = extractAttachments(r.data.payload, { messageId, threadId }).map(a => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        attachmentId: a.attachmentId,
        // messageId + threadId so trigger.output.attachments[i] feeds
        // gmail_read_attachment directly (it needs both ids).
        messageId: a.messageId,
        threadId: a.threadId,
    }));
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
        attachments,
        hasAttachment: attachments.length > 0,
    };
}

// ── MS Graph subscription provisioning ──────────────────
//
// Until now the inbound `/events/msgraph` route existed but no code created
// the corresponding subscriptions at MS Graph itself, so events never
// arrived. provisionSubscription POSTs to /v1.0/subscriptions on activate;
// revokeSubscription DELETEs it on deactivate so we don't leak orphan
// subscriptions when an automation is paused or removed.
//
// Both helpers are best-effort: a provisioning failure is logged and the
// row is left without an externalRef so the caller can fall back to polling
// (or, if the eventType has no polling handler, raise it as an activation
// warning). Throws are converted to return values to keep callers simple.

const MSGRAPH_RESOURCE_MAP = {
    'mail.new':       { resource: "me/mailFolders('Inbox')/messages", changeType: 'created' },
    'mail.flagged':   { resource: "me/mailFolders('Inbox')/messages", changeType: 'updated' },
    'event.created':  { resource: 'me/events',                        changeType: 'created' },
    'event.updated':  { resource: 'me/events',                        changeType: 'updated' },
    'event.changed':  { resource: 'me/events',                        changeType: 'updated' },
    'file.changed':   { resource: 'me/drive/root',                    changeType: 'updated' },
    'file.new':       { resource: 'me/drive/root',                    changeType: 'created' },
};

// MS Graph subscriptions live for at most ~71h for mail/events and 2h for
// drive resources. Renewing every 50 minutes keeps the renewal pass simple
// and works for every resource type.
const MSGRAPH_LIFETIME_MS = 50 * 60_000;

function getPublicBaseUrl() {
    return process.env.PUBLIC_BASE_URL || process.env.SERVER_PUBLIC_URL || null;
}

function buildClientState(userId, automationId) {
    const secret = process.env.MSGRAPH_CLIENT_STATE_SECRET || process.env.SESSION_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error('MSGRAPH_CLIENT_STATE_SECRET or SESSION_SECRET must be set (≥32 chars) for OAuth-state CSRF protection.');
    }
    return require('crypto')
        .createHmac('sha256', secret)
        .update(`${userId}|${automationId}`)
        .digest('hex');
}

/**
 * Provision an MS Graph subscription for a webhook-mode subscription row.
 * Returns `{ externalRef, expiresAt, clientState }` on success, or null on
 * failure (caller should log and proceed without webhook delivery).
 *
 * Skipped (returns null) when no PUBLIC_BASE_URL is configured — without a
 * publicly-reachable HTTPS endpoint MS Graph cannot validate the
 * notificationUrl and the POST would fail with 400.
 */
async function provisionSubscription(sub, session) {
    if (sub.provider !== 'msgraph') return null;
    const baseUrl = getPublicBaseUrl();
    if (!baseUrl) {
        console.warn(`[TriggerBus] MS Graph subscription skipped for ${sub.id} — PUBLIC_BASE_URL not set`);
        return null;
    }
    if (!session?.accessToken) {
        console.warn(`[TriggerBus] MS Graph subscription skipped for ${sub.id} — no access token`);
        return null;
    }
    const map = MSGRAPH_RESOURCE_MAP[sub.eventType];
    if (!map) {
        console.warn(`[TriggerBus] MS Graph subscription skipped for ${sub.id} — unsupported eventType ${sub.eventType}`);
        return null;
    }
    const expiresAt = new Date(Date.now() + MSGRAPH_LIFETIME_MS).toISOString();
    const clientState = buildClientState(sub.userId, sub.automationId);
    const body = {
        changeType: map.changeType,
        notificationUrl: `${baseUrl.replace(/\/+$/, '')}/api/automation/events/msgraph`,
        resource: map.resource,
        expirationDateTime: expiresAt,
        clientState,
    };
    try {
        const r = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!r.ok) {
            const text = await r.text().catch(() => '');
            console.warn(`[TriggerBus] MS Graph subscribe failed for ${sub.id}: ${r.status} ${text.slice(0, 200)}`);
            return null;
        }
        const data = await r.json().catch(() => ({}));
        if (!data?.id) {
            console.warn(`[TriggerBus] MS Graph subscribe returned no id for ${sub.id}`);
            return null;
        }
        return { externalRef: data.id, expiresAt: data.expirationDateTime || expiresAt, clientState };
    } catch (e) {
        console.warn(`[TriggerBus] MS Graph subscribe threw for ${sub.id}: ${e.message}`);
        return null;
    }
}

/**
 * Best-effort revoke. We don't surface failures to the caller because
 * deactivation must succeed even if MS Graph rejects the DELETE — the next
 * renewal tick will simply not refresh the subscription, and it expires
 * naturally within ~50min.
 */
async function revokeSubscription(sub, session) {
    if (sub.provider !== 'msgraph') return false;
    if (!sub.externalRef) return false;
    if (!session?.accessToken) return false;
    try {
        const r = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${sub.externalRef}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${session.accessToken}` },
        });
        // 404 = already gone, treat as success.
        return r.ok || r.status === 404;
    } catch (e) {
        console.warn(`[TriggerBus] MS Graph unsubscribe threw for ${sub.id}: ${e.message}`);
        return false;
    }
}

// ── Failure escalation ──────────────────────────────────
//
// Polling and renewal both used to silently skip on error. That hid token
// expiry and provider outages — users only noticed when they checked the
// run log and saw no activity. The escalation flow:
//
//   - Each fault increments consecutive_failures.
//   - On crossing the threshold we send ONE notification, recording
//     error_notified_at to debounce subsequent firings for 24h.
//   - Any successful poll/renew resets the counter and clears the timestamp.
//
// Polling threshold is 5 (≈5 minutes of bad polls) because providers can
// intermittently rate-limit. Renewal is 2 (≈2 minutes of bad PATCHes)
// because a missed renewal silently kills the subscription within the hour.

const POLL_FAILURE_THRESHOLD = 5;
const RENEW_FAILURE_THRESHOLD = 2;
const FAILURE_NOTIFY_DEBOUNCE_MS = 24 * 60 * 60_000;

async function escalateSubscriptionFailure(sub, threshold, errorMsg) {
    try {
        const { consecutiveFailures, errorNotifiedAt } = await automationStore.incrementSubscriptionFailures(sub.id);
        if (consecutiveFailures < threshold) return;
        const lastNotified = errorNotifiedAt ? Date.parse(errorNotifiedAt) : 0;
        if (Number.isFinite(lastNotified) && Date.now() - lastNotified < FAILURE_NOTIFY_DEBOUNCE_MS) return;

        const automation = await automationStore.getAutomation(sub.automationId).catch(() => null);
        if (!automation) return;
        try {
            const notificationStore = require('../stores/notificationStore');
            await notificationStore.createNotification({
                userId: sub.userId,
                category: 'urgent',
                title: `⚠️ Trigger niet bereikbaar: ${automation.title}`,
                message: `Automation "${automation.title}" trigger (${sub.provider} ${sub.eventType}) faalt herhaaldelijk: ${errorMsg || 'onbekende fout'}. Controleer je integratie of activeer de automation opnieuw.`,
            });
        } catch (e) {
            console.warn(`[TriggerBus] notify failure for sub ${sub.id} failed: ${e.message}`);
        }
        await automationStore.updateSubscription(sub.id, { errorNotifiedAt: new Date().toISOString() }).catch(() => {});
    } catch (e) {
        console.warn(`[TriggerBus] escalateSubscriptionFailure error: ${e.message}`);
    }
}

// ── Subscription renewal (MS Graph) ─────────────────────

async function renewExpiringSubscriptions() {
    try {
        const subs = await automationStore.getExpiringSubscriptions({ withinMs: 5 * 60_000 });
        for (const sub of subs) {
            if (sub.provider !== 'msgraph') continue;
            try {
                const session = await loadSession(sub.userId);
                if (!session?.accessToken) {
                    await escalateSubscriptionFailure(sub, RENEW_FAILURE_THRESHOLD, 'no access token');
                    continue;
                }
                const newExpiry = new Date(Date.now() + MSGRAPH_LIFETIME_MS).toISOString();
                const r = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${sub.externalRef}`, {
                    method: 'PATCH',
                    headers: { 'Authorization': `Bearer ${session.accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ expirationDateTime: newExpiry }),
                });
                if (!r.ok) {
                    const text = await r.text().catch(() => '');
                    console.warn(`[TriggerBus] msgraph sub renewal failed: ${r.status} ${text.slice(0, 200)}`);
                    await escalateSubscriptionFailure(sub, RENEW_FAILURE_THRESHOLD, `${r.status}`);
                    continue;
                }
                await automationStore.updateSubscription(sub.id, { expiresAt: newExpiry });
                await automationStore.resetSubscriptionFailures(sub.id);
            } catch (e) {
                console.warn(`[TriggerBus] msgraph sub renewal failed: ${e.message}`);
                await escalateSubscriptionFailure(sub, RENEW_FAILURE_THRESHOLD, e.message);
            }
        }
    } catch (e) {
        console.warn('[TriggerBus] renewal pass error:', e.message);
    }
}

/**
 * Find the most recent Gmail message that matches a mail.new filter and
 * return it shaped like a regular trigger payload. Used by:
 *   - manual run of a Gmail-triggered automation, so the user gets a
 *     real test against actual inbox content instead of a null payload.
 *   - activate, so flipping the toggle immediately processes the latest
 *     matching email rather than only firing on subsequent arrivals.
 *
 * Returns null if no message matches (or if the user has no Gmail tokens).
 * The caller decides what to do with that — typically: skip dispatch and
 * let the run record an explanatory error.
 *
 * Filter is applied client-side via matchGmailMailFilter so the semantics
 * are identical to the polling path (case-insensitive, system-label aware,
 * fail-closed regex). Server-side `q` is used only as a coarse pre-filter
 * to keep the API call cheap.
 */
async function fetchLatestGmailMatch(userId, filter) {
    try {
        const session = await loadSession(userId);
        if (!session?.accessToken) return null;
        const { google } = require('googleapis');
        const auth = new google.auth.OAuth2();
        auth.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken });
        const gmail = google.gmail({ version: 'v1', auth });

        // Coarse server-side narrowing. Only fields Gmail's `q` understands
        // get pre-filtered; the rest (regex, exclude labels, freshness, ...)
        // are caught by the client-side matcher.
        const q = [];
        if (filter?.from) q.push(`from:${filter.from}`);
        if (filter?.to) q.push(`to:${filter.to}`);
        if (filter?.subjectContains) q.push(`subject:${JSON.stringify(filter.subjectContains)}`);
        if (filter?.hasAttachment === true) q.push('has:attachment');
        if (filter?.excludeFromSelf === true) q.push('-in:sent');
        // We sort by recency by default; cap to 10 candidates so a popular
        // sender can't make us page through hundreds of messages just to
        // find one that passes the regex/freshness filter.
        const list = await gmail.users.messages.list({
            userId: 'me',
            q: q.join(' ') || undefined,
            maxResults: 10,
        });
        const ids = (list.data.messages || []).map(m => m.id).filter(Boolean);
        if (ids.length === 0) return null;

        for (const id of ids) {
            const meta = await fetchGmailMessageMetadata(gmail, id).catch(() => null);
            if (!meta) continue;
            const payload = { messageId: id, threadId: list.data.messages.find(m => m.id === id)?.threadId || null, ...meta };
            if (matchGmailMailFilter(payload, filter || null)) return payload;
        }
        return null;
    } catch (e) {
        console.warn(`[TriggerBus] fetchLatestGmailMatch failed for user ${userId}: ${e.message}`);
        return null;
    }
}

/**
 * Find the most recent Nextcloud activity that matches an automation's trigger,
 * shaped as the trigger payload. Used to seed MANUAL runs and trigger
 * simulation for NC-triggered automations — without this an NC automation run
 * by hand gets `triggerPayload=null`, so `trigger.output.path` is undefined and
 * the first NC action fails with "path is required" (the "Sort Invoices" bug).
 * Mirrors fetchLatestGmailMatch. Returns null when nothing matches.
 */
async function fetchLatestNextcloudMatch(userId, event, filter) {
    try {
        const session = await loadSession(userId);
        if (!session) return null;
        const rows = await _ncFetchActivityRows(userId, session);
        if (!rows || !rows.length) return null;
        const baseMatcher = pickMatcher('nextcloud', event);
        // Newest first so a manual run binds against the latest matching item.
        const sorted = rows.slice().sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        for (const row of sorted) {
            const payload = _ncNormaliseActivity(row, session);
            const ok = baseMatcher ? applyDslFilter(payload, filter || null, baseMatcher) : true;
            if (ok) return payload;
        }
        return null;
    } catch (e) {
        console.warn(`[TriggerBus] fetchLatestNextcloudMatch failed for user ${userId}: ${e.message}`);
        return null;
    }
}

module.exports = {
    dispatchEvent,
    dispatchTicketAssistantEvent,
    dispatchSupportEvent,
    runPollingPass,
    renewExpiringSubscriptions,
    provisionSubscription,
    revokeSubscription,
    buildClientState,
    getPublicBaseUrl,
    fetchLatestGmailMatch,
    fetchLatestNextcloudMatch,
    loadSession,
    // Matchers — exported for unit testing + so other server code can
    // re-use them (e.g. a future Diagnose endpoint that wants to show
    // "would this filter match this sample payload?").
    matchGmailMailFilter,
    matchGmailLabelFilter,
    matchCalendarChangedFilter,
    matchCalendarUpcomingFilter,
    matchDriveFileNewFilter,
    matchNextcloudFileFilter,
    matchNextcloudShareFilter,
    matchNextcloudShareGenericFilter,
    matchNextcloudActivityFilter,
    matchNextcloudNotificationFilter,
    matchNextcloudCommentFilter,
    matchNextcloudTagFilter,
    matchSupportTicketResolvedFilter,
    matchNextcloudCalendarFilter,
    matchNextcloudCalendarUpcomingFilter,
    matchNextcloudDeckCardFilter,
    matchNextcloudDeckCardMovedFilter,
    matchNextcloudTalkMessageFilter,
    matchNextcloudTaskFilter,
    matchNextcloudUserStatusFilter,
    applyDslFilter,
    matchTicketAssistantTicketNewFilter,
    matchTicketAssistantSyncFilter,
};
