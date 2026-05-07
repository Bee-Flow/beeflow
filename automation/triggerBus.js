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

async function dispatchEvent({ provider, event, payload = {}, userId = null }) {
    const subs = await automationStore.getSubscriptionsForProvider(provider, event);
    const runs = [];
    const isGmailMailNew = provider === 'gmail' && event === 'mail.new';
    for (const sub of subs) {
        if (userId && sub.userId !== userId) continue;
        // Gmail mail.new gets a richer matcher; everything else keeps
        // the shallow object-equality semantics that webhook providers
        // rely on.
        const ok = isGmailMailNew
            ? matchGmailMailFilter(payload, sub.filter)
            : matchFilter(payload, sub.filter);
        if (!ok) {
            console.log(`[TriggerBus] sub ${sub.id} filter rejected event (subject="${payload.subject || ''}" from="${payload.from || ''}")`);
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

module.exports = { dispatchEvent, runPollingPass, renewExpiringSubscriptions, matchGmailMailFilter, fetchLatestGmailMatch, loadSession };
