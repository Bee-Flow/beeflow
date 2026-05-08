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
 *   hasAttachment     boolean; checks for HAS_ATTACHMENT system label.
 *   excludeFromSelf   boolean; drops messages the user sent themselves
 *                     (uses the SENT system label).
 *   maxAgeMinutes     number; drops messages whose Date header is older
 *                     than N minutes. Useful as a freshness cap so a
 *                     paused poller doesn't flood the user with backlog
 *                     when it resumes.
 */
function matchGmailMailFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload || typeof payload !== 'object') return false;

    const containsCI = (haystack, needle) => {
        if (typeof haystack !== 'string' || typeof needle !== 'string') return false;
        return haystack.toLowerCase().includes(needle.toLowerCase());
    };

    if (typeof filter.from === 'string' && filter.from && !containsCI(payload.from, filter.from)) return false;
    if (typeof filter.to === 'string' && filter.to && !containsCI(payload.to, filter.to)) return false;
    if (typeof filter.cc === 'string' && filter.cc && !containsCI(payload.cc, filter.cc)) return false;

    if (typeof filter.subjectContains === 'string' && filter.subjectContains && !containsCI(payload.subject, filter.subjectContains)) return false;

    if (typeof filter.subjectRegex === 'string' && filter.subjectRegex) {
        const src = filter.subjectRegex.slice(0, 200);
        try {
            const re = new RegExp(src, 'i');
            if (!re.test(String(payload.subject || ''))) return false;
        } catch {
            // Invalid pattern → fail-closed (don't fire) so a typo
            // can't quietly match every email.
            return false;
        }
    }

    const labelIds = Array.isArray(payload.labelIds) ? payload.labelIds : [];
    if (Array.isArray(filter.labelIds) && filter.labelIds.length > 0) {
        if (!filter.labelIds.some(id => labelIds.includes(id))) return false;
    }
    if (Array.isArray(filter.excludeLabelIds) && filter.excludeLabelIds.length > 0) {
        if (filter.excludeLabelIds.some(id => labelIds.includes(id))) return false;
    }
    if (filter.hasAttachment === true) {
        if (!labelIds.includes('HAS_ATTACHMENT')) return false;
    }
    if (filter.excludeFromSelf === true) {
        if (labelIds.includes('SENT')) return false;
    }

    if (typeof filter.maxAgeMinutes === 'number' && filter.maxAgeMinutes > 0 && payload.date) {
        const t = Date.parse(payload.date);
        if (!Number.isFinite(t)) return false;
        const ageMin = (Date.now() - t) / 60_000;
        if (ageMin > filter.maxAgeMinutes) return false;
    }

    return true;
}

// ── Per-trigger matchers ───────────────────────────────────────────────
//
// Each matcher is a pure function `(payload, filter) → boolean`. They share
// these conventions with `matchGmailMailFilter`:
//   - undefined/empty filter → always pass.
//   - unknown filter keys are ignored (forward-compatible).
//   - regex fields are capped at 200 chars and fail-closed on parse error.
//   - case-insensitive substring is the default for free-text fields.

function containsCI(haystack, needle) {
    if (typeof haystack !== 'string' || typeof needle !== 'string') return false;
    return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * gmail.label.added — fires when a label is applied to a message.
 * Filter: { labelId (required), from?, subjectContains?, excludeLabelIds? }.
 */
function matchGmailLabelFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    const added = Array.isArray(payload.addedLabelIds) ? payload.addedLabelIds : [];
    if (filter.labelId && !added.includes(filter.labelId)) return false;
    if (filter.from && !containsCI(payload.from, filter.from)) return false;
    if (filter.subjectContains && !containsCI(payload.subject, filter.subjectContains)) return false;
    if (Array.isArray(filter.excludeLabelIds) && filter.excludeLabelIds.length) {
        const all = Array.isArray(payload.labelIds) ? payload.labelIds : [];
        if (filter.excludeLabelIds.some(id => all.includes(id))) return false;
    }
    return true;
}

/**
 * google-calendar.event.changed — fires when the syncToken poller surfaces
 * an event mutation. Filter: { calendarId?, statusEquals?, attendeeEmailContains? }.
 */
function matchCalendarChangedFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.calendarId && payload.calendarId && payload.calendarId !== filter.calendarId) return false;
    if (filter.statusEquals && payload.status !== filter.statusEquals) return false;
    if (filter.attendeeEmailContains) {
        const ats = Array.isArray(payload.attendees) ? payload.attendees : [];
        if (!ats.some(a => containsCI(a?.email || '', filter.attendeeEmailContains))) return false;
    }
    return true;
}

/**
 * google-calendar.event.upcoming — server-side already filtered to the
 * leadMinutes window so the matcher is effectively a passthrough; we still
 * honour calendarId / attendee filters for users whose `events.list` query
 * spans multiple calendars (calendarId='primary' default).
 */
function matchCalendarUpcomingFilter(payload, filter) {
    return matchCalendarChangedFilter(payload, filter);
}

/**
 * google-drive.file.new — fires when a new file appears in changes.list.
 * Filter: { folderId?, mimeType?, nameContains?, excludeOwnUploads? }.
 */
function matchDriveFileNewFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.folderId) {
        const parents = Array.isArray(payload.parents) ? payload.parents : [];
        if (!parents.includes(filter.folderId)) return false;
    }
    if (filter.mimeType && payload.mimeType !== filter.mimeType) return false;
    if (filter.nameContains && !containsCI(payload.name, filter.nameContains)) return false;
    if (filter.excludeOwnUploads === true) {
        const owners = Array.isArray(payload.owners) ? payload.owners : [];
        if (owners.some(o => o?.me === true)) return false;
    }
    return true;
}

/**
 * nextcloud.file.new / nextcloud.file.changed — shared filter shape.
 * Filter: { inFolder?, extension?, nameContains?, excludeOwnUploads? }.
 */
function matchNextcloudFileFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    const path = String(payload.path || payload.objectName || '');
    if (filter.inFolder) {
        const prefix = String(filter.inFolder).replace(/\/+$/, '');
        if (prefix && !path.startsWith(prefix.startsWith('/') ? prefix : `/${prefix}`)) {
            // Allow caller to omit leading slash.
            const alt = `/${prefix.replace(/^\/+/, '')}`;
            if (!path.startsWith(alt)) return false;
        }
    }
    if (filter.extension) {
        const want = String(filter.extension).replace(/^\./, '').toLowerCase();
        const got = path.split('.').pop()?.toLowerCase();
        if (want && got !== want) return false;
    }
    if (filter.nameContains && !containsCI(payload.name || path.split('/').pop() || '', filter.nameContains)) return false;
    if (filter.excludeOwnUploads === true) {
        // Activity feed actor is the user who performed the action; the
        // poller stamps `payload.isOwnAction` based on the session uid.
        if (payload.isOwnAction === true) return false;
    }
    return true;
}

/**
 * nextcloud.share.received — Filter: { actorEquals?, nameContains?, kindEquals? }.
 */
function matchNextcloudShareFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    if (filter.nameContains && !containsCI(payload.name || payload.objectName || '', filter.nameContains)) return false;
    if (filter.kindEquals && payload.kind !== filter.kindEquals) return false;
    return true;
}

/**
 * nextcloud.activity.new — power-user catch-all.
 * Filter: { type?, objectNameContains?, actorEquals? }.
 */
function matchNextcloudActivityFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.type && payload.type !== filter.type) return false;
    if (filter.objectNameContains && !containsCI(payload.objectName || '', filter.objectNameContains)) return false;
    if (filter.actorEquals && payload.actor !== filter.actorEquals) return false;
    return true;
}

/**
 * nextcloud.notification.new — Filter: { app?, subjectContains? }.
 */
function matchNextcloudNotificationFilter(payload, filter) {
    if (!filter || typeof filter !== 'object') return true;
    if (!payload) return false;
    if (filter.app && payload.app !== filter.app) return false;
    if (filter.subjectContains && !containsCI(payload.subject || '', filter.subjectContains)) return false;
    return true;
}

/**
 * Picks the right matcher for a (provider, event) pair. Falls back to the
 * shallow `matchFilter` for anything we haven't taught explicit semantics
 * — keeps webhook providers (msgraph, github) working unchanged.
 */
function pickMatcher(provider, event) {
    if (provider === 'gmail' && event === 'mail.new') return matchGmailMailFilter;
    if (provider === 'gmail' && event === 'label.added') return matchGmailLabelFilter;
    if (provider === 'google-calendar' && event === 'event.changed')  return matchCalendarChangedFilter;
    if (provider === 'google-calendar' && event === 'event.upcoming') return matchCalendarUpcomingFilter;
    if (provider === 'google-drive' && event === 'file.new')          return matchDriveFileNewFilter;
    if (provider === 'nextcloud' && (event === 'file.new' || event === 'file.changed')) return matchNextcloudFileFilter;
    if (provider === 'nextcloud' && event === 'share.received')       return matchNextcloudShareFilter;
    if (provider === 'nextcloud' && event === 'activity.new')         return matchNextcloudActivityFilter;
    if (provider === 'nextcloud' && event === 'notification.new')     return matchNextcloudNotificationFilter;
    return matchFilter;
}

async function dispatchEvent({ provider, event, payload = {}, userId = null }) {
    const subs = await automationStore.getSubscriptionsForProvider(provider, event);
    const runs = [];
    const matcher = pickMatcher(provider, event);
    for (const sub of subs) {
        if (userId && sub.userId !== userId) continue;
        const ok = matcher(payload, sub.filter);
        if (!ok) {
            console.log(`[TriggerBus] sub ${sub.id} filter rejected event (subject="${payload.subject || payload.objectName || ''}" from="${payload.from || payload.actor || ''}")`);
            continue;
        }
        const automation = await automationStore.getAutomation(sub.automationId);
        if (!automation) { console.warn(`[TriggerBus] sub ${sub.id} — automation ${sub.automationId} not found`); continue; }
        if (!automation.isActive) { console.log(`[TriggerBus] sub ${sub.id} — automation ${automation.id} is inactive; skipping`); continue; }
        if (automation.isDraft)   { console.log(`[TriggerBus] sub ${sub.id} — automation ${automation.id} is still a draft; skipping`); continue; }
        const runner = require('../core/automationRunner');
        try {
            console.log(`[TriggerBus] dispatch automation=${automation.id} via sub ${sub.id} (subject="${payload.subject || ''}")`);
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
                // missing-credential bug. Log it loudly so operators can
                // spot a user who connected via session-only and never
                // landed in the routine-auth vault.
                console.warn(`[TriggerBus] no credentials for user ${sub.userId} (provider=${sub.provider}); skipping sub ${sub.id}`);
                // Touch lastPolledAt so we don't hot-loop on this sub every tick.
                await automationStore.updateSubscription(sub.id, { lastPolledAt: new Date().toISOString() });
                continue;
            }
            const events = await handler(sub, session);
            console.log(`[TriggerBus] sub ${sub.id} (${sub.provider}.${sub.eventType}) cursor=${sub.lastCursor || 'none'} → ${events.length} event(s)`);
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
            };
        }
    } catch (err) {
        console.warn(`[TriggerBus] vault session lookup failed for user ${userId}: ${err.message}`);
    }

    // 2) user_sessions fallback. Same shape as req.session for the chat path:
    //    { user: { id, ... }, accessToken, refreshToken, oauthProvider, ... }
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
const _ncActivityCache = new Map(); // userId → { ts, rows[] }
const NC_ACTIVITY_CACHE_TTL_MS = 5_000;

async function _ncFetchActivityRows(userId, session) {
    const cached = _ncActivityCache.get(userId);
    if (cached && Date.now() - cached.ts < NC_ACTIVITY_CACHE_TTL_MS) return cached.rows;
    let rows = [];
    try {
        const tools = require('../integrations/nextcloudActivityTools');
        const result = await tools.executeNextcloudActivityTool(
            'nextcloud_activity_list',
            { filter: 'all', limit: 200 },
            userId, session,
        );
        if (result?.activities) rows = result.activities;
        else if (result?.error) console.warn(`[TriggerBus] nextcloud activity fetch failed for user ${userId}: ${result.error}`);
    } catch (e) {
        console.warn(`[TriggerBus] nextcloud activity fetch threw for user ${userId}: ${e.message}`);
    }
    rows.sort((a, b) => (a.id || 0) - (b.id || 0));
    _ncActivityCache.set(userId, { ts: Date.now(), rows });
    return rows;
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
                    const maxId = items.length ? items[items.length - 1].id : 0;
                    await automationStore.updateSubscription(sub.id, { lastCursor: String(maxId || 0) });
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

module.exports = {
    dispatchEvent,
    runPollingPass,
    renewExpiringSubscriptions,
    fetchLatestGmailMatch,
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
    matchNextcloudActivityFilter,
    matchNextcloudNotificationFilter,
};
