// §WS5 #4 — automation CRUD + templates + import + activate/deactivate,
// extracted verbatim from routes/automation.js. syncAppEventSubscription co-located.
const express = require('express');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const cron = require('../../automation/cron');
const { validateDefinition } = require('../../automation/validate');
const { summariseDefinition } = require('../../automation/summarise');
const { getDeliverableEvents } = require('../../automation/deliverableEvents');
const { TOOL_REGISTRY, loadTools } = require('../../automation/toolRegistry');
const triggerBus = require('../../automation/triggerBus');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { buildExport, sanitizeImport, rekeyDefinition } = require('../../automation/portability');

router.get('/', async (req, res) => {
    try {
        const list = await automationStore.getAutomationsForUser(req.session.user.id);
        res.json({ automations: list });
    } catch (e) {
        console.error('[automation list] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Create automation (default isDraft=true; finalise via PUT or activate).
router.post('/', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { title, description, definition, triggerType = 'manual', scheduleCron = null, scheduleTz = 'Europe/Amsterdam', createdFromChatId = null } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
        if (!definition || typeof definition !== 'object') return res.status(400).json({ error: 'definition is required' });
        const v = validateDefinition(definition);
        if (!v.ok) return res.status(400).json({ error: 'Invalid definition', details: v.errors });
        let nextRunAt = null;
        if (triggerType === 'schedule' && scheduleCron) {
            try { nextRunAt = cron.nextRunAt(scheduleCron, scheduleTz, Date.now()); }
            catch (e) { return res.status(400).json({ error: `Bad cron: ${e.message}` }); }
        }
        const a = await automationStore.createAutomation({
            userId, title: title.trim(), description: description || '',
            definition, triggerType, scheduleCron, scheduleTz, nextRunAt, createdFromChatId,
        });
        res.json({ automation: a });
    } catch (e) {
        console.error('[automation create] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Templates routes MUST come before `/:id` — otherwise Express matches
// `/:id` for the literal string 'templates' and returns 404 from
// automationStore.getAutomation('templates').
router.get('/templates', (req, res) => {
    try {
        const { listTemplates, CATEGORIES } = require('../../automation/templates');
        res.json({ templates: listTemplates(), categories: CATEGORIES });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/templates/:id', (req, res) => {
    try {
        const { getTemplate } = require('../../automation/templates');
        const tmpl = getTemplate(req.params.id);
        if (!tmpl) return res.status(404).json({ error: 'Template not found' });
        res.json({ template: tmpl });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Import a portability envelope (produced by GET /:id/export, or a bare
 * `{ automation }` body) as a NEW inactive draft owned by the caller.
 *
 * Like /templates, this MUST be registered before `/:id` — route order is
 * what keeps Express from treating the literal "import" as an automation id.
 *
 * Flow: sanitizeImport (allowlist + format/schemaVersion gate) →
 * validateDefinition hard-fail → second, catalog-aware validation pass
 * (built exactly like /:id/activate builds it) whose findings are
 * NON-BLOCKING here — the draft lands inactive, and activate re-checks
 * hard — → rekeyDefinition (fresh step ids per graph) → createAutomation
 * (which already forces is_active=FALSE, is_draft=TRUE).
 *
 * Rate-limited per user: imports validate against the full tool catalog and
 * write a row, so 10/min is plenty for legitimate use and starves bulk abuse.
 */
const importLimiter = perUserRateLimit({ windowMs: 60_000, max: 10 });
router.post('/import', importLimiter, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { automation: incoming, errors: importErrors } = sanitizeImport(req.body);
        if (!incoming || importErrors.length > 0) {
            return res.status(400).json({ error: 'Invalid import file', details: importErrors });
        }

        const v = validateDefinition(incoming.definition);
        if (!v.ok) return res.status(400).json({ error: 'Invalid definition', details: v.errors });

        // Catalog-aware pass — same construction as the activate route
        // (permission-based, fail-open). Because the catalog-free pass above
        // already succeeded, everything this pass flags is a tool-availability /
        // required-param / deliverability finding: surfaced as warnings so the
        // user knows which integrations they still need to connect.
        let warnings = v.warnings || [];
        try {
            const { getUserPermittedApps } = require('../../core/integrationTools');
            const permitted = await getUserPermittedApps({ userId, session: req.session, isAdmin: !!req.session?.isAdmin });
            const availableTools = new Set();
            const toolRequiredParams = {};
            for (const entry of TOOL_REGISTRY) {
                const permittedApp = permitted.has(entry.app);
                for (const t of loadTools(entry)) {
                    const name = t?.function?.name;
                    if (!name) continue;
                    if (permittedApp) availableTools.add(name);
                    const rq = t?.function?.parameters?.required;
                    if (Array.isArray(rq)) toolRequiredParams[name] = rq;
                }
            }
            const v2 = validateDefinition(incoming.definition, {
                availableTools, toolRequiredParams, deliverableEvents: getDeliverableEvents(),
            });
            warnings = [...(v2.errors || []), ...(v2.warnings || [])];
        } catch (e) {
            console.warn('[automation/import] tool catalog build failed; importing without tool warnings:', e.message);
        }

        // Fresh step ids per graph (root + each inline layer) so importing
        // the same file twice never collides and crafted ids can't alias
        // existing drafts' replay data.
        const { definition } = rekeyDefinition(incoming.definition);

        // Best-effort schedule arming — a bad cron in the file shouldn't
        // block the import (the draft is inactive); activate recomputes.
        let nextRunAt = null;
        if (incoming.triggerType === 'schedule' && incoming.scheduleCron) {
            try { nextRunAt = cron.nextRunAt(incoming.scheduleCron, incoming.scheduleTz || 'Europe/Amsterdam', Date.now()); }
            catch (e) {
                warnings = [...warnings, { code: 'import.bad_cron', severity: 'warning', path: 'scheduleCron', message: `Schedule "${incoming.scheduleCron}" did not parse (${e.message}).`, hint: 'Fix the cron expression in Settings before activating.' }];
            }
        }

        const a = await automationStore.createAutomation({
            userId,
            title: incoming.title,
            description: incoming.description,
            definition,
            triggerType: incoming.triggerType,
            scheduleCron: incoming.scheduleCron,
            scheduleTz: incoming.scheduleTz || 'Europe/Amsterdam',
            nextRunAt,
        });
        res.json({ automation: a, warnings });
    } catch (e) {
        console.error('[automation/import] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
        res.json({ automation: a, summary: summariseDefinition(a.definition || {}).summary });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// §WS4.3 — the export route was documented and buildExport imported, but the
// handler was never registered (dead import). Implement it with the same
// ownership guard as the rest of the file so a user can download a sanitized,
// portable envelope of their own automation (matching POST /import).
router.get('/:id/export', async (req, res) => {
    try {
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
        const { envelope, warnings } = buildExport(a);
        res.json({ envelope, warnings });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const existing = await automationStore.getAutomation(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        const updates = {};
        const fields = ['title', 'description', 'definition', 'isDraft', 'triggerType', 'scheduleCron', 'scheduleTz'];
        for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];

        if (updates.definition) {
            const v = validateDefinition(updates.definition);
            if (!v.ok) return res.status(400).json({ error: 'Invalid definition', details: v.errors });
            // Recompute nextRunAt if schedule is the active trigger.
            const triggerType = updates.triggerType || existing.triggerType;
            const scheduleCron = updates.scheduleCron !== undefined ? updates.scheduleCron : existing.scheduleCron;
            const scheduleTz = updates.scheduleTz || existing.scheduleTz;
            if (triggerType === 'schedule' && scheduleCron) {
                try { updates.nextRunAt = cron.nextRunAt(scheduleCron, scheduleTz, Date.now()); }
                catch (e) { return res.status(400).json({ error: `Bad cron: ${e.message}` }); }
            }
        }

        const updated = await automationStore.updateAutomation(req.params.id, updates, userId);
        res.json({ automation: updated });
    } catch (e) {
        console.error('[automation update] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });
        const ok = await automationStore.deleteAutomation(req.params.id);
        res.json({ success: ok });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/:id/activate', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        // Build the user's permitted-tool catalog so activation rejects unknown
        // tools (typos, unpermitted integrations) and missing/empty required
        // inputs — instead of letting a broken routine go live and fail silently
        // on first fire. Permission-based (matches the builder palette, not
        // credential-gated); fail-open if the lookup errors.
        let availableTools = null;
        let toolRequiredParams = null;
        try {
            const { getUserPermittedApps } = require('../../core/integrationTools');
            const permitted = await getUserPermittedApps({ userId, session: req.session, isAdmin: !!req.session?.isAdmin });
            availableTools = new Set();
            toolRequiredParams = {};
            for (const entry of TOOL_REGISTRY) {
                const permittedApp = permitted.has(entry.app);
                for (const t of loadTools(entry)) {
                    const name = t?.function?.name;
                    if (!name) continue;
                    if (permittedApp) availableTools.add(name);
                    const rq = t?.function?.parameters?.required;
                    if (Array.isArray(rq)) toolRequiredParams[name] = rq;
                }
            }
        } catch (e) {
            console.warn('[automation/activate] tool catalog build failed; activating without tool checks:', e.message);
            availableTools = null; toolRequiredParams = null;
        }
        // Deliverability = poller-backed NC events only (the SaaS poll tick fires
        // these with no connector dependency). Push-only events (Deck/Talk/share/
        // calendar mutations) need the Bee Flow ExApp connector push pipeline,
        // which is pending live validation — so they get a NON-BLOCKING warning
        // ("requires Bee Flow ExApp connector — pending validation"). This is a
        // UI honesty signal only; it does not change subscription delivery.
        const deliverableEvents = getDeliverableEvents();
        const v = validateDefinition(a.definition || {}, { availableTools, toolRequiredParams, deliverableEvents });
        if (!v.ok) return res.status(400).json({ error: 'Invalid definition', details: v.errors });
        // Warnings are non-blocking but reported to the client.
        const summary = summariseDefinition(a.definition || {});
        const updates = {
            isActive: true,
            isDraft: false,
            // First-run confirmation gate removed — activation runs live
            // immediately. The dry-run during build still gives the user a
            // preview before they activate.
            needsFirstRunConfirm: false,
        };
        if (a.triggerType === 'schedule' && a.scheduleCron) {
            updates.nextRunAt = cron.nextRunAt(a.scheduleCron, a.scheduleTz || 'Europe/Amsterdam', Date.now());
        }
        const u = await automationStore.updateAutomation(a.id, updates, userId);

        // App-event triggers need a row in automation_event_subscriptions
        // before the poller / inbound-event handler will see them. Without
        // this the LLM happily declares `kind:'app_event',appProvider:'gmail'`
        // but no email ever fires the automation. Done idempotently — we
        // delete-then-create so re-activating after a definition change
        // refreshes the filter / cursor.
        await syncAppEventSubscription(a.id, userId, a.definition);

        // Immediate Gmail check on activate: if the trigger is mail.new,
        // pull the most recent matching email and dispatch it once. Without
        // this the user has to wait for the next genuinely-new email to see
        // the automation fire — confusing on activate. Run async so the
        // HTTP response stays snappy.
        const trig = a.definition?.trigger;
        if (trig?.kind === 'app_event'
            && trig?.appEvent?.provider === 'gmail'
            && trig?.appEvent?.event === 'mail.new') {
            (async () => {
                try {
                    const triggerBus = require('../../automation/triggerBus');
                    const latest = await triggerBus.fetchLatestGmailMatch(userId, trig.appEvent.filter || null);
                    if (latest) {
                        await triggerBus.dispatchEvent({
                            provider: 'gmail',
                            event: 'mail.new',
                            payload: latest,
                            userId,
                        });
                    }
                } catch (e) {
                    console.warn(`[automation/activate] immediate Gmail dispatch failed for ${a.id}: ${e.message}`);
                }
            })();
        }

        res.json({ automation: u, warnings: v.warnings || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/:id/deactivate', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        // Revoke remote subscriptions BEFORE deleting the local rows. If we
        // delete first we lose the externalRef and leak orphan subscriptions
        // at MS Graph that keep firing into the void until they expire.
        try {
            const existing = await automationStore.getSubscriptionsForAutomation(a.id);
            const msgraphSubs = existing.filter(s => s.provider === 'msgraph' && s.externalRef);
            if (msgraphSubs.length > 0) {
                const session = await triggerBus.loadSession(userId).catch(() => null);
                for (const sub of msgraphSubs) {
                    await triggerBus.revokeSubscription(sub, session);
                }
            }
        } catch (e) {
            console.warn(`[automation/deactivate] revoke pass failed for ${a.id}: ${e.message}`);
        }

        await automationStore.deleteSubscriptionsForAutomation(a.id);
        const u = await automationStore.updateAutomation(a.id, { isActive: false }, userId);
        res.json({ automation: u });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Reconcile app_event subscriptions for one automation. Reads the trigger
 * from the persisted definition (not the row's `triggerType`/`scheduleCron`
 * shorthand fields) so a single source of truth covers provider, event,
 * and filter.
 *
 * Today only Gmail mail.new is supported end-to-end; other providers
 * (google-calendar / msgraph / github) have polling/webhook handlers but
 * we keep this helper provider-agnostic so adding them later is one
 * dispatch table change.
 */
async function syncAppEventSubscription(automationId, userId, def) {
    // Revoke any existing remote subscriptions BEFORE wiping the rows so we
    // don't leak orphaned MS Graph subscriptions when the user changes the
    // trigger.
    try {
        const existing = await automationStore.getSubscriptionsForAutomation(automationId);
        const msgraphSubs = existing.filter(s => s.provider === 'msgraph' && s.externalRef);
        if (msgraphSubs.length > 0) {
            const session = await triggerBus.loadSession(userId).catch(() => null);
            for (const sub of msgraphSubs) {
                await triggerBus.revokeSubscription(sub, session);
            }
        }
    } catch (e) {
        console.warn(`[automation/syncAppEventSubscription] revoke pass failed for ${automationId}: ${e.message}`);
    }
    await automationStore.deleteSubscriptionsForAutomation(automationId);

    const trig = def?.trigger;
    if (!trig || trig.kind !== 'app_event') return;
    const provider = trig.appEvent?.provider;
    const event = trig.appEvent?.event;
    if (!provider || !event) return;

    // Mode resolution:
    //   - Gmail: polling (Pub/Sub push at /events/gmail exists but we don't
    //     auto-provision the watch yet).
    //   - MS Graph: webhook when PUBLIC_BASE_URL is set; falls back to
    //     polling-mode otherwise (which has no handler today, so the user
    //     gets a deactivated trigger — acceptable on local/dev installs).
    //   - GitHub: webhook (handled by /events/github inbound route).
    //   - Nextcloud: webhook when the user is connector-bound (the ExApp
    //     event-bridge pushes to /events/nextcloud); polling otherwise. The
    //     polling tick still runs as crash-recovery backstop when
    //     last_push_at goes stale.
    //   - Others: polling.
    let mode;
    if (provider === 'msgraph') {
        mode = triggerBus.getPublicBaseUrl() ? 'webhook' : 'polling';
    } else if (provider === 'github') {
        mode = 'webhook';
    } else if (provider === 'nextcloud') {
        // Per-event, not per-user. Events with a triggerBus poller MUST be
        // 'polling' regardless of hosting — otherwise calendar.event.upcoming /
        // file.new / activity.new never fire. Push-only events (share/deck/talk/
        // calendar mutations) are 'webhook' for connector-bound users (the ExApp
        // event-bridge delivers them) and 'polling' otherwise (no producer — the
        // poll tick simply no-ops, no handler error).
        //
        // (Fixes the prior `u?.ncUid` check: getUser returns the raw column
        // `nc_uid`, so ncUid was always undefined and every NC sub fell to
        // polling — which happened to be the only thing that worked.)
        const NC_POLLER_EVENTS = new Set([
            'file.new', 'file.changed', 'share.received',
            'activity.new', 'notification.new', 'calendar.event.upcoming',
        ]);
        if (NC_POLLER_EVENTS.has(event)) {
            mode = 'polling';
        } else {
            let isConnector = false;
            try {
                const userStore = require('../../stores/userStore');
                const u = await userStore.getUser(userId).catch(() => null);
                isConnector = u?.provider === 'nextcloud_connector';
            } catch { /* default below */ }
            mode = isConnector ? 'webhook' : 'polling';
        }
    } else {
        mode = 'polling';
    }

    const sub = await automationStore.createSubscription({
        automationId,
        userId,
        provider,
        eventType: event,
        mode,
        filter: trig.appEvent?.filter || null,
    });

    // For MS Graph webhook subscriptions, register at MS Graph itself and
    // store the externalRef so the renewal pass can refresh and the
    // notification handler can validate clientState.
    if (provider === 'msgraph' && mode === 'webhook') {
        try {
            const session = await triggerBus.loadSession(userId).catch(() => null);
            const result = await triggerBus.provisionSubscription(sub, session);
            if (result) {
                await automationStore.updateSubscription(sub.id, {
                    externalRef: result.externalRef,
                    expiresAt: result.expiresAt,
                    clientState: result.clientState,
                });
            } else {
                // Provisioning failed — leave the row in the DB so the user
                // sees the trigger but warn so the diagnose endpoint can
                // surface it.
                console.warn(`[automation/syncAppEventSubscription] MS Graph provisioning failed for sub ${sub.id}; trigger will not fire until re-activated`);
            }
        } catch (e) {
            console.warn(`[automation/syncAppEventSubscription] MS Graph provisioning threw for sub ${sub.id}: ${e.message}`);
        }
    }
}


module.exports = router;
