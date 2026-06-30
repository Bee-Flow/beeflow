// §WS5 #4 — run execution + run listing/facets/stream endpoints, extracted
// verbatim from routes/automation.js. parseRunFilters co-located.
const express = require('express');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const cron = require('../../automation/cron');
const { getDeliverableEvents, isPushPending } = require('../../automation/deliverableEvents');
const triggerBus = require('../../automation/triggerBus');

router.post('/:id/run', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const runner = require('../../core/automationRunner');

        // Manual runs are user-initiated and should execute synchronously
        // so the UI can immediately show what happened (success / per-step
        // output / errors). Cap the wait so a misbehaving step can't hang
        // the request; if the cap is hit, fall back to fire-and-forget.
        const RESPONSE_TIMEOUT_MS = 60_000;
        let timedOut = false;
        const guard = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, RESPONSE_TIMEOUT_MS));

        // For Gmail-triggered automations the manual run is meaningless
        // without a real email payload (every binding resolves to undefined,
        // gmail_compose then errors with "to is required" etc.). Synthesize
        // a payload from the user's most recent matching inbox message so
        // the test mirrors a real fire of the trigger.
        let triggerPayload = req.body?.triggerPayload || null;
        const trig = a.definition?.trigger;
        const isGmailTrig = trig?.kind === 'app_event'
            && trig?.appEvent?.provider === 'gmail'
            && trig?.appEvent?.event === 'mail.new';
        const isNcTrig = trig?.kind === 'app_event' && trig?.appEvent?.provider === 'nextcloud';
        if (isGmailTrig && !triggerPayload) {
            const triggerBus = require('../../automation/triggerBus');
            const latest = await triggerBus.fetchLatestGmailMatch(userId, trig.appEvent.filter || null);
            if (latest) {
                triggerPayload = { provider: 'gmail', event: 'mail.new', ...latest };
            } else {
                return res.status(200).json({
                    accepted: true,
                    pending: false,
                    skipped: true,
                    message: 'No matching email found in your inbox to test against. The automation is ready — it will fire when a new matching email arrives.',
                });
            }
        }
        // Nextcloud-triggered automations need the same treatment: a manual run
        // with no payload leaves trigger.output.path undefined and the first NC
        // action fails ("path is required") — the "Sort Invoices" symptom.
        if (isNcTrig && !triggerPayload) {
            const triggerBus = require('../../automation/triggerBus');
            const ev = String(trig.appEvent.event || '').replace(/^nextcloud\./, '');
            const latest = await triggerBus.fetchLatestNextcloudMatch(userId, ev, trig.appEvent.filter || null);
            if (latest) {
                triggerPayload = { provider: 'nextcloud', event: trig.appEvent.event, ...latest };
            } else {
                return res.status(200).json({
                    accepted: true,
                    pending: false,
                    skipped: true,
                    message: 'No matching recent Nextcloud activity to test against. The automation is ready — it will fire when a matching event arrives.',
                });
            }
        }

        const runPromise = runner.executeAutomation(a, {
            triggerKind: 'manual',
            triggerPayload,
            mode: 'live',
        }).catch(e => { console.error('[automation/run] error:', e.message); return null; });

        const run = await Promise.race([runPromise, guard]);

        if (timedOut || !run) {
            return res.status(202).json({
                accepted: true,
                pending: true,
                message: 'Run is still in progress. Check the run history shortly.',
            });
        }
        const steps = await automationStore.getRunSteps(run.id).catch(() => []);
        return res.status(200).json({
            accepted: true,
            run,
            steps,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Run a one-shot health check on the trigger pipeline for one automation.
 *
 * Without this endpoint, "the trigger doesn't fire" produces no actionable
 * feedback for the user — the polling tick is silent unless something
 * succeeds. This endpoint walks every link in the chain (subscription row →
 * vault credentials → live Gmail call → filter match) and returns a
 * structured result the UI can render.
 *
 * Tokens are NEVER returned — only booleans and high-level shape.
 */
router.post('/:id/diagnose-trigger', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        const trig = a.definition?.trigger;
        const provider = trig?.appEvent?.provider;
        const event = trig?.appEvent?.event;

        // ── Nextcloud diagnostics ─────────────────────────────────────────
        // READ-ONLY / observational. Reports the state of the trigger so the
        // user can see why a routine is (or isn't) firing. It does NOT change
        // how Nextcloud connects or how auth is resolved. Mirrors the Gmail
        // check shape so the generic TriggerDiagnosePanel renders it unchanged.
        if (trig?.kind === 'app_event' && provider === 'nextcloud') {
            const checks = [];
            const finish = (ok) => res.json({ ok, kind: `nextcloud.${event}`, checks });
            const ncAppIdForEvent = (ev) => {
                if (!ev) return 'nextcloud';
                if (ev.startsWith('calendar.')) return 'nextcloud-calendar';
                if (ev.startsWith('deck.')) return 'nextcloud-deck';
                if (ev.startsWith('talk.')) return 'nextcloud-talk';
                if (ev.startsWith('task.')) return 'nextcloud-tasks';
                if (ev === 'notification.new') return 'nextcloud-notifications';
                if (ev === 'activity.new') return 'nextcloud-activity';
                if (ev.startsWith('user.status')) return 'nextcloud-status';
                return 'nextcloud';
            };

            // 1) Integration enabled for this user/org
            try {
                const apps = await require('../../core/integrationTools').getUserPermittedApps({
                    userId, session: req.session,
                    isAdmin: !!req.session?.isAdmin || req.session?.user?.role === 'admin',
                });
                const appId = ncAppIdForEvent(event);
                checks.push(apps.has(appId)
                    ? { name: 'integration_enabled', status: 'ok', message: `${appId} is enabled.` }
                    : { name: 'integration_enabled', status: 'error', message: `${appId} is not enabled for your account.`, detail: { remediation: 'Ask your org admin to enable this Nextcloud app.' } });
            } catch (e) {
                checks.push({ name: 'integration_enabled', status: 'warn', message: `Could not resolve permitted apps: ${e.message}` });
            }

            // 2) Auth mode (observational — reports how NC tools authenticate)
            let session = null;
            try { session = await require('../../automation/triggerBus').loadSession(userId); } catch { session = null; }
            const isConnector = !!(session && (session._source === 'connector' || session.connectorOrgId || session.user?.provider === 'nextcloud_connector'));
            if (isConnector) {
                checks.push({ name: 'auth_mode', status: 'ok', message: 'Connector identity present — NC tools route via the Bee Flow ExApp proxy.', detail: { source: session._source || 'connector' } });
            } else if (session && require('../../integrations/nextcloudClient').isNextcloudOAuthSession(session)) {
                checks.push({ name: 'auth_mode', status: 'ok', message: 'Nextcloud OAuth session found (bearer token).', detail: { source: session._source || 'oauth' } });
            } else if (session?.accessToken) {
                checks.push({ name: 'auth_mode', status: 'ok', message: 'Nextcloud session found.', detail: { source: session._source || 'session' } });
            } else {
                checks.push({ name: 'auth_mode', status: 'error', message: 'No Nextcloud credentials found for scheduled/offline runs.', detail: { remediation: 'Connect Nextcloud in Settings → Integrations.' } });
            }

            // 3) Subscription state (cursor / lastPolledAt / lastPushAt / failures)
            const subs = await automationStore.getSubscriptionsForAutomation(a.id);
            const sub = subs.find(s => s.provider === 'nextcloud' && s.eventType === event) || null;
            if (!sub) {
                checks.push({ name: 'subscription', status: 'error', message: 'No subscription yet — click Activate to create it.' });
            } else {
                const failing = (sub.consecutiveFailures || 0) > 0;
                checks.push({
                    name: 'subscription',
                    status: failing ? 'warn' : 'ok',
                    message: failing ? `Subscription ${sub.id} has ${sub.consecutiveFailures} recent failure(s).` : `Subscription ${sub.id} active (mode=${sub.mode}).`,
                    detail: { mode: sub.mode, modePreference: sub.modePreference, lastCursor: sub.lastCursor, lastPolledAt: sub.lastPolledAt, lastPushAt: sub.lastPushAt, consecutiveFailures: sub.consecutiveFailures },
                });
            }

            // 4) Deliverability — poller-backed fires today; push-only needs the
            // (deferred) Bee Flow ExApp connector push pipeline.
            const pollerBacked = getDeliverableEvents().nextcloud.has(event);
            if (pollerBacked) {
                checks.push({ name: 'deliverability', status: 'ok', message: 'Poller-backed — fires on the poll tick with no connector dependency.' });
            } else if (isPushPending('nextcloud', event)) {
                checks.push({ name: 'deliverability', status: 'warn', message: 'This event requires the Bee Flow ExApp connector and is pending live validation.' });
            } else {
                checks.push({ name: 'deliverability', status: 'warn', message: 'No producer for this event yet — it will not fire until a poller or the connector delivers it.' });
            }

            // 5) Recent-match probe — only meaningful for poller-backed events
            if (pollerBacked) {
                try {
                    const match = await require('../../automation/triggerBus').fetchLatestNextcloudMatch(userId, event, trig.appEvent.filter || null);
                    checks.push(match
                        ? { name: 'recent_match', status: 'ok', message: 'Found a recent matching item — the trigger has data to fire on.', detail: match }
                        : { name: 'recent_match', status: 'warn', message: 'No recent matching activity — the trigger fires when a match arrives.' });
                } catch (e) {
                    const { classifyNextcloudError } = require('../../core/nextcloudErrorClassifier');
                    const c = classifyNextcloudError(e);
                    checks.push({ name: 'recent_match', status: 'warn', message: c.message, detail: { remediation: c.remediation } });
                }
            }

            return finish(checks.every(c => c.status !== 'error'));
        }

        if (trig?.kind !== 'app_event' || provider !== 'gmail' || event !== 'mail.new') {
            return res.json({
                ok: true,
                kind: trig?.kind || 'unknown',
                checks: [{ name: 'trigger_type', status: 'skipped', message: 'This automation is not Gmail-triggered; nothing to diagnose.' }],
            });
        }

        const checks = [];
        const finish = (ok) => res.json({ ok, kind: 'gmail.mail.new', checks });

        // 1) Subscription row
        const subs = await automationStore.getSubscriptionsForAutomation(a.id);
        const sub = subs.find(s => s.provider === 'gmail' && s.eventType === 'mail.new') || null;
        if (!sub) {
            checks.push({
                name: 'subscription',
                status: 'error',
                message: 'No automation_event_subscriptions row exists. Click Activate to create one.',
            });
            return finish(false);
        }
        checks.push({
            name: 'subscription',
            status: 'ok',
            message: `Subscription ${sub.id} found (mode=${sub.mode}).`,
            detail: {
                lastCursor: sub.lastCursor,
                lastPolledAt: sub.lastPolledAt,
                filter: sub.filter,
            },
        });

        // 2) Credentials. Use the same loadSession the polling pass uses —
        // tries the vault first, then falls back to user_sessions (where
        // the chat-side OAuth flow puts tokens for users who connected
        // before the vault existed). Reporting the source helps the user
        // understand whether they're on a stable long-lived vault entry or
        // depending on their browser session staying alive.
        let session = null;
        try {
            const triggerBus = require('../../automation/triggerBus');
            session = await triggerBus.loadSession(userId);
        } catch (e) {
            checks.push({ name: 'credentials', status: 'error', message: `Credential lookup threw: ${e.message}` });
            return finish(false);
        }
        if (!session?.accessToken) {
            checks.push({
                name: 'credentials',
                status: 'error',
                message: 'No Gmail OAuth tokens found in either the routine vault or the active browser session. Sign in to Bee Flow and re-connect Gmail in Integrations.',
            });
            return finish(false);
        }
        checks.push({
            name: 'credentials',
            status: session._source === 'vault' ? 'ok' : 'warn',
            message: session._source === 'vault'
                ? `Gmail tokens loaded from the routine vault (long-lived, auto-refresh).`
                : `Gmail tokens loaded from your browser session. The trigger will keep firing while you stay signed in; re-connect Gmail in Integrations to upgrade to a long-lived vault entry.`,
            detail: { source: session._source, hasAccessToken: true, hasRefreshToken: !!session.refreshToken, oauthProvider: session.oauthProvider || null },
        });

        // 3) Live Gmail history call (or bootstrap)
        try {
            const { google } = require('googleapis');
            const auth = new google.auth.OAuth2();
            auth.setCredentials({ access_token: session.accessToken, refresh_token: session.refreshToken });
            const gmail = google.gmail({ version: 'v1', auth });
            if (sub.lastCursor) {
                try {
                    const r = await gmail.users.history.list({
                        userId: 'me',
                        startHistoryId: sub.lastCursor,
                        historyTypes: ['messageAdded'],
                    });
                    const count = (r.data.history || []).reduce((acc, h) => acc + (h.messagesAdded?.length || 0), 0);
                    checks.push({
                        name: 'gmail_history',
                        status: 'ok',
                        message: `history.list succeeded; ${count} new message(s) since cursor.`,
                        detail: { newCount: count, currentHistoryId: r.data.historyId || null },
                    });
                } catch (err) {
                    const stale = err.code === 404 || /not found|invalid history id/i.test(err.message || '');
                    checks.push({
                        name: 'gmail_history',
                        status: stale ? 'warn' : 'error',
                        message: stale
                            ? `Cursor ${sub.lastCursor} is stale (Gmail returned: ${err.message}). The poller will reset it on the next tick.`
                            : `gmail.users.history.list failed: ${err.message}`,
                    });
                }
            } else {
                const profile = await gmail.users.getProfile({ userId: 'me' });
                checks.push({
                    name: 'gmail_history',
                    status: 'warn',
                    message: 'No cursor yet — bootstrap needed. The next poll tick will anchor the cursor.',
                    detail: { profileHistoryId: profile.data.historyId || null },
                });
            }
        } catch (e) {
            checks.push({ name: 'gmail_history', status: 'error', message: `Gmail API not reachable: ${e.message}` });
            return finish(false);
        }

        // 4) Latest matching message — same lookup the manual run uses
        try {
            const triggerBus = require('../../automation/triggerBus');
            const latest = await triggerBus.fetchLatestGmailMatch(userId, trig.appEvent.filter || null);
            if (!latest) {
                checks.push({
                    name: 'recent_match',
                    status: 'warn',
                    message: 'No recent inbox messages match the filter. The trigger will fire as soon as a matching email arrives.',
                });
            } else {
                checks.push({
                    name: 'recent_match',
                    status: 'ok',
                    message: `Most recent matching email: "${latest.subject}" from ${latest.from}.`,
                    detail: { subject: latest.subject, from: latest.from, date: latest.date, labelIds: latest.labelIds },
                });
            }
        } catch (e) {
            checks.push({ name: 'recent_match', status: 'error', message: `Filter probe failed: ${e.message}` });
        }

        return finish(checks.every(c => c.status !== 'error'));
    } catch (e) {
        console.error('[automation/diagnose-trigger] error:', e);
        res.status(500).json({ error: e.message });
    }
});

router.post('/:id/dry-run', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const runner = require('../../core/automationRunner');
        const run = await runner.executeAutomation(a, { triggerKind: 'dry_run', triggerPayload: req.body?.triggerPayload || null, mode: 'dry_run' });
        const steps = await automationStore.getRunSteps(run.id);
        res.json({ run, steps });
    } catch (e) {
        console.error('[automation/dry-run] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * n8n-style "Execute step" — run a single step using replay data from
 * the most recent prior run (and any pinned outputs). Returns the
 * resulting step record so the inspector can show input/output without
 * the user waiting for a full dry-run.
 *
 * mode='only' (default) runs just `stepId`. mode='from' runs the step
 * and every downstream node — used by the retry-from-failed-step UI.
 */
router.post('/:id/steps/:stepId/run', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const partialMode = req.body?.mode === 'from' ? 'from' : 'only';
        const runner = require('../../core/automationRunner');
        const run = await runner.runPartial(a, req.params.stepId, {
            mode: partialMode,
            triggerKind: 'manual_step',
            triggerPayload: req.body?.triggerPayload || null,
        });
        const steps = await automationStore.getRunSteps(run.id);
        const stepRecord = steps.find(s => s.stepId === req.params.stepId) || null;
        res.json({ run, steps, stepRecord });
    } catch (e) {
        console.error('[automation/steps/run] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Active runs for the current user — drives the sidebar "● Running" dot
 * and the concurrent-run guard. Lightweight: returns a flat list of
 * `{ runId, automationId, status, startedAt }`.
 */
router.get('/_runs/active', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const active = await automationStore.getActiveRunsForUser(userId);
        res.json({ active });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Preview a cron expression. Used by the visual schedule builder to
 * show the user the next N firing times in their chosen timezone and
 * to validate ad-hoc expressions before they save. Delegates to the
 * same `cron.nextRunAt` the runner uses, so the preview is bit-exact
 * with what would actually fire.
 *
 * Body: { cron, tz, count? } — count defaults to 3, capped at 20.
 */
router.post('/_schedule/preview', async (req, res) => {
    try {
        const cronExpr = String(req.body?.cron || '').trim();
        const tz = String(req.body?.tz || 'Europe/Amsterdam').trim() || 'Europe/Amsterdam';
        const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 3, 1), 20);
        if (!cronExpr) return res.status(400).json({ valid: false, error: 'cron expression is required' });
        try {
            cron.parseCron(cronExpr);
        } catch (e) {
            return res.json({ valid: false, error: e.message });
        }
        const next = [];
        let from = Date.now();
        for (let i = 0; i < count; i++) {
            const iso = cron.nextRunAt(cronExpr, tz, from);
            if (!iso) break;
            next.push(iso);
            // Step 60s past the matched time so the next iteration finds a
            // STRICTLY-later match rather than re-returning the same minute.
            from = new Date(iso).getTime() + 60_000;
        }
        res.json({ valid: true, cron: cronExpr, tz, next });
    } catch (e) {
        res.status(500).json({ valid: false, error: e.message });
    }
});

// Parse the executions-table filters off a query string. Arrays are
// comma-separated (status, triggerKind, mode); since/until are ISO timestamps
// on started_at. Shared by /:id/runs, /_runs/recent and /_runs/facets so the
// list and the filter chips always agree.
function parseRunFilters(req) {
    const q = req.query || {};
    const csv = (v) => (typeof v === 'string' && v.trim())
        ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined;
    const filters = {};
    const status = csv(q.status); if (status) filters.status = status;
    const triggerKind = csv(q.triggerKind || q.trigger); if (triggerKind) filters.triggerKind = triggerKind;
    const mode = csv(q.mode); if (mode) filters.mode = mode;
    if (q.automationId) filters.automationId = String(q.automationId);
    if (q.kind) filters.kind = String(q.kind);
    if (q.since) filters.sinceTs = String(q.since);
    if (q.until) filters.untilTs = String(q.until);
    return filters;
}

router.get('/:id/runs', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        // Scope to this automation (or Step — block runs are automation_runs too)
        // and apply the same cursor/filter machinery as the global list.
        const filters = { ...parseRunFilters(req), automationId: a.id, cursor: req.query.cursor, limit: req.query.limit };
        const { runs, nextCursor } = await automationStore.listRunsForUser(userId, filters);
        res.json({ runs, nextCursor });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Cross-automation recent runs for the current user. Powers the unified
 * activity view in the studio's empty-pane state so users can spot
 * failures across all of their automations without drilling in one by
 * one. Always scoped to the requesting user — no admin-wide endpoint.
 */
router.get('/_runs/recent', async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Cursor-paginated + filterable. `limit` kept for back-compat (old
        // callers read `runs`); `nextCursor` is additive.
        const filters = { ...parseRunFilters(req), cursor: req.query.cursor, limit: req.query.limit || 50 };
        const { runs, nextCursor } = await automationStore.listRunsForUser(userId, filters);
        res.json({ runs, nextCursor });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * §9 Activity dashboard — facet counts for the filter chips.
 *
 * Returns counts grouped by status, automation, trigger kind, and error
 * class, restricted to the last `range` hours (default 24, max 720 = 30
 * days). Indexed SQL via getRunFacetsForUser. Scoped by the same date /
 * automation / kind "context" as the list, but NOT by the status/trigger
 * filters themselves, so the chips show the full breakdown you can switch to.
 */
router.get('/_runs/facets', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const range = Math.min(Math.max(parseInt(req.query.range, 10) || 24, 1), 720);
        const sinceTs = new Date(Date.now() - range * 3600 * 1000).toISOString();
        const base = parseRunFilters(req);
        const facets = await automationStore.getRunFacetsForUser(userId, {
            sinceTs, automationId: base.automationId, kind: base.kind, mode: base.mode,
        });
        res.json({ facets, rangeHours: range });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * §9 SSE stream of run lifecycle events for the CURRENT USER. Subscribes to
 * runEventBus (which the runner now emits to) and pushes events as they fire,
 * dropping any event whose `userId` isn't the subscriber's. An optional
 * `?automationId=` further scopes the stream to one automation/Step surface.
 *
 * Consumed via fetch streaming (authFetch), so the normal X-Session-Token /
 * cookie auth applies — no query-string token needed.
 */
router.get('/_runs/stream', async (req, res) => {
    try {
        const me = req.session.user.id;
        const scopeAutomationId = req.query.automationId ? String(req.query.automationId) : null;
        const { onAny } = require('../../core/runEventBus');
        res.set({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.flushHeaders?.();
        const unsubscribe = onAny((event) => {
            // Per-user scoping — never leak another user's run activity.
            if (event.userId && event.userId !== me) return;
            if (scopeAutomationId && event.automationId && event.automationId !== scopeAutomationId) return;
            res.write(`data: ${JSON.stringify(event)}\n\n`);
        });
        const heartbeat = setInterval(() => {
            res.write(': keepalive\n\n');
        }, 25_000);
        req.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Templates routes were moved to the top of this file (just before `/:id`)
// to avoid Express matching `/:id` first against the literal "templates".


module.exports = router;
