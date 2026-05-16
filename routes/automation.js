/**
 * Automation Routes — REST API for the conversational automation builder.
 *
 *   GET    /catalog                        list apps, actions, triggers, side-effects
 *   GET    /catalog/sample/:tool           sample output for builder hints
 *
 *   GET    /                               list user's automations
 *   POST   /                               create automation (draft or finalised)
 *   GET    /:id                            get one
 *   PUT    /:id                            update (bumps version when definition changes)
 *   DELETE /:id                            delete
 *   POST   /:id/activate                   set is_active and re-arm next_run_at
 *   POST   /:id/deactivate                 unset is_active
 *   POST   /:id/run                        manual run (live)
 *   POST   /:id/dry-run                    explicit dry-run on demand
 *   GET    /:id/runs                       list runs
 *   GET    /:id/versions                   list saved versions
 *   POST   /:id/webhook                    create a signed webhook URL
 *   GET    /:id/webhooks                   list webhooks for the automation
 *
 *   POST   /runs/:id/approve               first-run-confirm flow approve
 *   GET    /runs/:id                       run details
 *   GET    /runs/:id/steps                 per-step log
 *
 *   POST   /webhook/:slug                  PUBLIC inbound webhook (HMAC + nonce)
 *   POST   /events/gmail                   PUBLIC Gmail Pub/Sub push
 *   POST   /events/msgraph                 PUBLIC MS Graph notification (handles ?validationToken=)
 *   POST   /events/github                  PUBLIC GitHub webhook
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const automationStore = require('../stores/automationStore');
const configStore = require('../stores/configStore');
const cron = require('../automation/cron');
const { validateDefinition } = require('../automation/validate');
const { summariseDefinition } = require('../automation/summarise');
const { TOOL_REGISTRY, loadTools } = require('../automation/toolRegistry');
const { isSideEffect, READ_ONLY } = require('../automation/sideEffectMap');
const { getOutputSchema, synthesizeDryRunOutput } = require('../automation/outputSchemas');
const triggerBus = require('../automation/triggerBus');
const { resolveIntegration } = require('../core/integrationToolMap');

function requireAuth(req, res, next) {
    if (req.session?.user?.id) return next();
    res.status(401).json({ error: 'Not authenticated' });
}

// ── PUBLIC routes (defined first; auth comes after) ────

// Webhook trigger — signed inbound URL.
router.post('/webhook/:slug', express.json({ limit: '256kb' }), async (req, res) => {
    try {
        const slug = req.params.slug;
        const wh = await automationStore.getWebhook(slug);
        if (!wh) return res.status(404).json({ error: 'Unknown webhook' });

        const sigHeader = req.get('X-BeeFlow-Signature') || '';
        const nonce = req.get('X-BeeFlow-Nonce') || '';
        if (!sigHeader.startsWith('sha256=') || !nonce) return res.status(401).json({ error: 'Missing signature or nonce' });
        const expected = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(JSON.stringify(req.body || {})).digest('hex');
        // Constant-time compare
        const ok = sigHeader.length === expected.length && crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
        if (!ok) return res.status(401).json({ error: 'Bad signature' });

        const fresh = await automationStore.checkAndStoreNonce(`${slug}:${nonce}`);
        if (!fresh) return res.status(401).json({ error: 'Replayed nonce' });

        await automationStore.touchWebhook(slug);
        const automation = await automationStore.getAutomation(wh.automationId);
        if (!automation || !automation.isActive || automation.isDraft) {
            return res.status(409).json({ error: 'Automation is not active' });
        }
        // Async run; ack immediately.
        const runner = require('../core/automationRunner');
        setImmediate(async () => {
            try { await runner.executeAutomation(automation, { triggerKind: 'webhook', triggerPayload: req.body || {} }); }
            catch (e) { console.error('[automation/webhook] run error:', e.message); }
        });
        return res.status(202).json({ accepted: true, automationId: automation.id });
    } catch (e) {
        console.error('[automation/webhook] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Gmail Pub/Sub push — payload is base64-encoded JSON; we decode and dispatch.
router.post('/events/gmail', express.json({ limit: '128kb' }), async (req, res) => {
    try {
        const data = req.body?.message?.data;
        if (!data) return res.status(204).end();
        let decoded = {};
        try { decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8')); } catch {}
        const userId = decoded.emailAddress ? null : null; // we don't know userId without a mapping
        // Best-effort: dispatch by emailAddress matching subscriptions. Without a
        // mapping table, we just emit a generic event and let polling fill in.
        await triggerBus.dispatchEvent({ provider: 'gmail', event: 'mail.new', payload: decoded, userId });
        return res.status(204).end();
    } catch (e) {
        console.error('[automation/events/gmail] error:', e.message);
        res.status(500).end();
    }
});

// Nextcloud events forwarded by the connector (Phase 1 push pipeline).
//
// The connector subscribes to NC AppAPI events_listener for Files /
// Sharing / Calendar / Deck / Talk events; on receipt it signs the body
// with the tenant key and POSTs here. We verify the signature against
// the org's stored connector_tenant_key, map the connector's stable
// event name to a subscription, and dispatch through triggerBus.
//
// Auth model (mirrors /webhook/nc-user-sync exactly):
//   X-Beeflow-NC-Instance-Id  identifies the org
//   X-Beeflow-Sig             ts.hmac(tenantKey, "ts\nMETHOD\nurl\nbody")
//   ±5 min skew, constant-time compare.
//
// On success we mark `last_push_at` on the matching subscriptions so the
// poller can downgrade subs that haven't seen a push lately back into
// polling mode without losing events.
const captureRawNc = express.json({
    limit: '512kb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
});

async function verifyNcConnectorSig(req) {
    const instanceId = String(req.headers['x-beeflow-nc-instance-id'] || '');
    if (!instanceId) return null;
    const userStore = require('../stores/userStore');
    const org = await userStore.getOrganizationByNcInstanceId(instanceId).catch(() => null);
    if (!org) return null;
    const tenantKey = await configStore.getSecret(`connector_tenant_key_${org.id}`);
    if (!tenantKey) return null;

    const sigHeader = String(req.headers['x-beeflow-sig'] || '');
    const dot = sigHeader.indexOf('.');
    if (dot === -1) return null;
    const ts = parseInt(sigHeader.slice(0, dot), 10);
    const sig = sigHeader.slice(dot + 1);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return null;

    const message = `${ts}\n${req.method}\n${req.originalUrl}\n${req.rawBody || ''}`;
    const expected = crypto.createHmac('sha256', tenantKey).update(message).digest('hex');
    if (expected.length !== sig.length) return null;
    try {
        if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))) return null;
    } catch { return null; }
    return org;
}

router.post('/events/nextcloud', captureRawNc, async (req, res) => {
    const org = await verifyNcConnectorSig(req);
    if (!org) return res.status(401).json({ error: 'Invalid or missing signature' });

    const { event, ncUid, payload } = req.body || {};
    if (!event) return res.status(400).json({ error: 'Missing event' });

    try {
        // Resolve the Bee Flow user from the NC uid via the user store —
        // the same mapping `ncUserGroupSync` maintains. If the uid hasn't
        // been provisioned yet, the event can't reach an automation; ack
        // so the connector doesn't retry.
        const userStore = require('../stores/userStore');
        const user = ncUid
            ? await userStore.getUserByNcUid(org.id, ncUid).catch(() => null)
            : null;

        await triggerBus.dispatchEvent({
            provider: 'nextcloud',
            event,
            payload: payload || {},
            userId: user?.id || null,
        });
        // Stamp last_push_at on every nextcloud subscription this user
        // owns for this event so the polling-fallback detector knows the
        // push pipeline is healthy.
        if (user?.id) {
            try {
                const subs = await automationStore.getSubscriptionsForUserAndEvent(user.id, 'nextcloud', event);
                for (const sub of subs) {
                    await automationStore.updateSubscription(sub.id, { lastPushAt: new Date().toISOString() }).catch(() => {});
                }
            } catch (_) { /* best-effort */ }
        }
        return res.status(202).end();
    } catch (e) {
        console.error('[automation/events/nextcloud] dispatch error:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

// MS Graph notifications — handles validation handshake + notifications.
router.post('/events/msgraph', express.json({ limit: '128kb' }), async (req, res) => {
    if (req.query.validationToken) {
        // Required handshake: echo the token in plain text, status 200.
        res.set('Content-Type', 'text/plain');
        return res.status(200).send(String(req.query.validationToken));
    }
    try {
        const notifications = req.body?.value || [];
        for (const n of notifications) {
            // Validate clientState. Each notification carries the value the
            // subscription was created with; we look up the matching row and
            // reject mismatches so a leaked notificationUrl can't be used to
            // forge events on behalf of another tenant.
            //
            // We can't do this for every event upfront (subscriptions are
            // keyed by externalRef which only the provisioning step has), so
            // we fan out per-notification.
            try {
                const sub = n.subscriptionId
                    ? await automationStore.getSubscriptionByExternalRef('msgraph', n.subscriptionId).catch(() => null)
                    : null;
                if (sub && sub.clientState && sub.clientState !== n.clientState) {
                    console.warn(`[automation/events/msgraph] clientState mismatch for sub ${sub.id} — dropping`);
                    continue;
                }
                await triggerBus.dispatchEvent({
                    provider: 'msgraph',
                    event: n.changeType ? `${n.resource?.split('/')[0]}.${n.changeType}` : 'change',
                    payload: n,
                    userId: sub?.userId,
                });
            } catch (perItemErr) {
                console.warn('[automation/events/msgraph] dispatch item error:', perItemErr.message);
            }
        }
        return res.status(202).end();
    } catch (e) {
        console.error('[automation/events/msgraph] error:', e.message);
        res.status(500).end();
    }
});

// GitHub webhook — signature in X-Hub-Signature-256.
router.post('/events/github', express.json({ limit: '256kb' }), async (req, res) => {
    try {
        const sig = req.get('X-Hub-Signature-256') || '';
        const event = req.get('X-GitHub-Event') || 'unknown';
        const secret = await configStore.getConfig('automation_github_webhook_secret');
        if (!secret) return res.status(503).json({ error: 'GitHub webhooks not configured' });
        const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(JSON.stringify(req.body || {})).digest('hex');
        const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
        if (!ok) return res.status(401).json({ error: 'Bad signature' });
        await triggerBus.dispatchEvent({ provider: 'github', event, payload: req.body || {} });
        return res.status(202).end();
    } catch (e) {
        console.error('[automation/events/github] error:', e.message);
        res.status(500).end();
    }
});

// ── Authenticated routes ───────────────────────────────

router.use(requireAuth);

// All authenticated automation routes are gated behind the 'automations'
// beta feature. Admins toggle this per-organisation in the admin
// dashboard → Security → Beta. Super admins always have access.
const { requireBetaFeature } = require('../core/betaFeatures');
router.use(requireBetaFeature('automations'));

// Catalog — auto-introspect existing TOOLS arrays.
router.get('/catalog', async (req, res) => {
    try {
        const userId = req.session.user.id;
        // Gather available apps for the user (best effort: present everything,
        // mark `available: true` if integrationTools.js would expose it).
        const session = req.session;
        const { getIntegrationTools } = require('../core/integrationTools');
        let userToolNames = new Set();
        try {
            const result = await getIntegrationTools({ userId, session, isAdmin: !!req.session?.isAdmin });
            for (const t of (result.tools || [])) {
                if (t?.function?.name) userToolNames.add(t.function.name);
            }
        } catch (_) { /* user might not be fully set up */ }

        // Webpages aren't surfaced via getIntegrationTools (direct chat injects
        // them separately to avoid name collisions with its in-editor tools), so
        // check the beta gate directly to decide availability.
        let webpagesAvailable = false;
        try {
            const { userHasBetaFeature } = require('../core/betaFeatures');
            webpagesAvailable = await userHasBetaFeature(userId, 'webpages', req.session);
        } catch (_) { /* default false */ }

        const apps = TOOL_REGISTRY.map(entry => {
            const tools = loadTools(entry);
            const actions = tools.map(t => {
                const name = t?.function?.name;
                if (!name) return null;
                // Resolve the integration that owns this tool so the visual
                // builder can render the brand logo on each action chip /
                // node. Falls back to the app id when no prefix matches.
                const resolved = resolveIntegration(name) || null;
                return {
                    name,
                    label: name.replace(/_/g, ' '),
                    description: t.function?.description || '',
                    inputSchema: t.function?.parameters || null,
                    outputSchema: getOutputSchema(name),
                    sideEffect: isSideEffect(name),
                    integrationId: resolved?.integration || entry.app,
                    integrationLabel: resolved?.label || entry.label,
                };
            }).filter(Boolean);
            const available = entry.app === 'webpages'
                ? webpagesAvailable
                : actions.some(a => userToolNames.has(a.name));
            return { id: entry.app, label: entry.label, available, actions };
        });

        const codeFlagRaw = await configStore.getConfig('automation_code_step_enabled');
        const codeFlag = codeFlagRaw === true || codeFlagRaw === 'true';
        // If we got here, the requireBetaFeature middleware already approved
        // the user — so this user's org has the automations feature on.
        const automationsFlag = true;

        res.json({
            apps,
            stepTypes: ['trigger', 'integration_action', 'ai_step', 'condition', 'loop', ...(codeFlag ? ['code'] : []), 'notification'],
            triggers: [
                { kind: 'schedule', label: 'On a schedule' },
                { kind: 'manual', label: 'Run manually' },
                { kind: 'webhook', label: 'Webhook URL' },
                { kind: 'app_event', providers: ['gmail', 'google-calendar', 'msgraph', 'github'] },
            ],
            flags: { code: codeFlag, automations: automationsFlag },
        });
    } catch (e) {
        console.error('[automation/catalog] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.get('/catalog/sample/:tool', async (req, res) => {
    const tool = req.params.tool;
    const sample = synthesizeDryRunOutput(tool, {});
    res.json({ tool, sample });
});

// List automations
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
        const { listTemplates, CATEGORIES } = require('../automation/templates');
        res.json({ templates: listTemplates(), categories: CATEGORIES });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/templates/:id', (req, res) => {
    try {
        const { getTemplate } = require('../automation/templates');
        const tmpl = getTemplate(req.params.id);
        if (!tmpl) return res.status(404).json({ error: 'Template not found' });
        res.json({ template: tmpl });
    } catch (e) {
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
        const v = validateDefinition(a.definition || {});
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
                    const triggerBus = require('../automation/triggerBus');
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
        try {
            const userStore = require('../stores/userStore');
            const u = await userStore.getUser(userId).catch(() => null);
            mode = u?.ncUid ? 'webhook' : 'polling';
        } catch {
            mode = 'polling';
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

router.post('/:id/run', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const runner = require('../core/automationRunner');

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
        if (isGmailTrig && !triggerPayload) {
            const triggerBus = require('../automation/triggerBus');
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
            const triggerBus = require('../automation/triggerBus');
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
            const triggerBus = require('../automation/triggerBus');
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
        const runner = require('../core/automationRunner');
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
        const runner = require('../core/automationRunner');
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

router.get('/:id/runs', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const runs = await automationStore.getRunsForAutomation(a.id, { limit: 100 });
        res.json({ runs });
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
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const runs = await automationStore.getRecentRunsForUser(userId, { limit });
        res.json({ runs });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Templates routes were moved to the top of this file (just before `/:id`)
// to avoid Express matching `/:id` first against the literal "templates".

router.get('/:id/versions', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const versions = await automationStore.listVersions(a.id);
        res.json({ versions });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Read one version's full definition. Used by the version-history UI to
 * render a diff against the current row before the user commits a restore.
 * Listed metadata-only on /:id/versions; this endpoint loads the body.
 */
router.get('/:id/versions/:versionId', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const version = await automationStore.getVersion(req.params.versionId);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (version.automationId !== a.id) return res.status(400).json({ error: 'Version does not belong to this automation' });
        res.json({ version });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Restore a historical version. Loads the version row, validates the
 * historical definition (could fail if step types or tool names have been
 * removed since), then writes it back through the regular updateAutomation
 * path so a new version row gets stamped with this user as the author.
 */
router.post('/:id/versions/:versionId/restore', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const version = await automationStore.getVersion(req.params.versionId);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (version.automationId !== a.id) return res.status(400).json({ error: 'Version does not belong to this automation' });

        const v = validateDefinition(version.definition || {});
        if (!v.ok) return res.status(400).json({ error: 'Stored version no longer validates', details: v.errors });

        const updated = await automationStore.updateAutomation(a.id, { definition: version.definition }, userId);
        res.json({ automation: updated, restoredFromVersion: version.version });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/:id/webhook', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const wh = await automationStore.createWebhook(a.id);
        res.json({ webhook: wh, url: `/api/automation/webhook/${wh.id}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id/webhooks', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const list = await automationStore.getWebhooksForAutomation(a.id);
        res.json({ webhooks: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Rotate a webhook's HMAC secret. The slug (URL) stays the same; any caller
 * still using the old secret immediately receives 401. The new secret is
 * returned ONCE so the user can copy it before navigating away — we don't
 * store it in plaintext anywhere the UI can re-read.
 */
router.post('/:id/webhook/:slug/rotate', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const rotated = await automationStore.rotateWebhookSecret(req.params.slug, a.id);
        if (!rotated) return res.status(404).json({ error: 'Webhook not found' });
        res.json({ webhook: rotated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/:id/webhook/:slug', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const ok = await automationStore.deleteWebhook(req.params.slug, a.id);
        if (!ok) return res.status(404).json({ error: 'Webhook not found' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/runs/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const run = await automationStore.getRun(req.params.id);
        if (!run) return res.status(404).json({ error: 'Not found' });
        if (run.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        res.json({ run });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/runs/:id/steps', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const run = await automationStore.getRun(req.params.id);
        if (!run) return res.status(404).json({ error: 'Not found' });
        if (run.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const steps = await automationStore.getRunSteps(run.id);
        res.json({ steps });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Retry a previously failed run. Re-fires `executeAutomation` with the
 * original triggerKind+payload, links the new run to the old via
 * `parent_run_id` so the history shows the lineage. Manual user action;
 * synchronous wait capped at 60s to mirror /run.
 */
router.post('/:id/runs/:runId/retry', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const original = await automationStore.getRun(req.params.runId);
        if (!original) return res.status(404).json({ error: 'Run not found' });
        if (original.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        if (original.automationId !== a.id) return res.status(400).json({ error: 'Run does not belong to this automation' });

        const runner = require('../core/automationRunner');
        const RESPONSE_TIMEOUT_MS = 60_000;
        let timedOut = false;
        const guard = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, RESPONSE_TIMEOUT_MS));
        const runPromise = runner.executeAutomation(a, {
            triggerKind: original.triggerKind || 'manual',
            triggerPayload: original.triggerPayload || null,
            mode: 'live',
            parentRunId: original.id,
        }).catch(e => { console.error('[automation/retry] error:', e.message); return null; });

        const run = await Promise.race([runPromise, guard]);
        if (timedOut || !run) {
            return res.status(202).json({
                accepted: true,
                pending: true,
                message: 'Retry is still in progress. Check the run history shortly.',
            });
        }
        const steps = await automationStore.getRunSteps(run.id).catch(() => []);
        return res.status(200).json({ accepted: true, run, steps });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Approve / reject the step an awaiting_approval run is paused on.
 *
 * Body: { decision: 'approve' | 'reject', reason?: string }
 * Returns the new run row produced by resumeFromStep — note this is a
 * CHILD run, linked to the original via parent_run_id; the original row
 * stays in `awaiting_approval` so the lineage is intact.
 *
 * The user must own the automation (org-level approve-anyone-else's-run
 * is intentionally NOT supported here — that requires per-step ACLs).
 */
router.post('/runs/:runId/approve-step', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const original = await automationStore.getRun(req.params.runId);
        if (!original) return res.status(404).json({ error: 'Run not found' });
        if (original.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        if (original.status !== 'awaiting_approval') {
            return res.status(409).json({ error: `Run is in ${original.status} state, not awaiting_approval` });
        }
        if (!original.awaitingStepId) {
            return res.status(409).json({ error: 'Run has no recorded awaiting step' });
        }

        const decision = String(req.body?.decision || 'approve').toLowerCase();
        if (decision !== 'approve' && decision !== 'reject') {
            return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
        }

        if (decision === 'reject') {
            // Reject finalises the original run as 'error' with a clear
            // reason. We do NOT resume — the rest of the flow is dropped.
            await automationStore.updateRun(original.id, {
                status: 'error',
                error: `Approval rejected${req.body?.reason ? `: ${req.body.reason}` : ''}`,
                finishedAt: new Date().toISOString(),
                awaitingStepId: null,
                approvalToken: null,
            });
            return res.json({ accepted: true, decision: 'reject', run: await automationStore.getRun(original.id) });
        }

        // Approve → kick off resume. Synchronous wait capped at 60s like /run.
        const runner = require('../core/automationRunner');
        const RESPONSE_TIMEOUT_MS = 60_000;
        let timedOut = false;
        const guard = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, RESPONSE_TIMEOUT_MS));
        const resumePromise = runner.resumeFromStep(original.id, original.awaitingStepId, {
            decision: { approved: true, by: userId, reason: req.body?.reason || null, decidedAt: new Date().toISOString() },
            userId,
        }).catch(e => { console.error('[automation/approve-step] error:', e.message); return null; });

        // Mark the original run as resumed so the UI reflects state immediately
        // (the new child run carries the live execution).
        await automationStore.updateRun(original.id, {
            status: 'success',
            summary: `Resumed via approval — see child run ${(await automationStore.getRun(original.id))?.id || ''}`,
            awaitingStepId: null,
            approvalToken: null,
        }).catch(() => {});

        const newRun = await Promise.race([resumePromise, guard]);
        if (timedOut || !newRun) {
            return res.status(202).json({ accepted: true, pending: true, message: 'Resume started; check run history.' });
        }
        return res.json({ accepted: true, decision: 'approve', run: newRun });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Request cancellation of an in-flight run. Honoured at the next "between
 * steps" check on whichever runner pod is executing the run, so cancel
 * latency is bounded by step duration. Acknowledges immediately; the UI
 * polls run status to confirm the cancellation took effect.
 */
router.post('/runs/:runId/cancel', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const original = await automationStore.getRun(req.params.runId);
        if (!original) return res.status(404).json({ error: 'Not found' });
        if (original.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        if (!['queued', 'running'].includes(original.status)) {
            return res.status(409).json({ error: `Run is in ${original.status} state and cannot be cancelled` });
        }
        const runner = require('../core/automationRunner');
        const updated = await runner.requestCancel(original.id);
        return res.status(202).json({ accepted: true, run: updated || original });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/runs/:id/approve', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const run = await automationStore.getRun(req.params.id);
        if (!run) return res.status(404).json({ error: 'Not found' });
        if (run.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        if (run.status !== 'awaiting_confirm') return res.status(400).json({ error: 'Run is not awaiting confirmation' });
        const a = await automationStore.getAutomation(run.automationId);
        if (!a) return res.status(404).json({ error: 'Automation not found' });
        await automationStore.updateAutomation(a.id, { needsFirstRunConfirm: false }, userId);
        // Re-execute live (the original run remains in history as awaiting_confirm).
        const runner = require('../core/automationRunner');
        setImmediate(async () => {
            try { await runner.executeAutomation({ ...a, needsFirstRunConfirm: false }, { triggerKind: 'manual', mode: 'live', confirmFirstRun: true }); }
            catch (e) { console.error('[automation/runs/approve] error:', e.message); }
        });
        res.json({ accepted: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
