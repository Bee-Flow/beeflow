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
            await triggerBus.dispatchEvent({
                provider: 'msgraph',
                event: n.changeType ? `${n.resource?.split('/')[0]}.${n.changeType}` : 'change',
                payload: n,
            });
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

        const apps = TOOL_REGISTRY.map(entry => {
            const tools = loadTools(entry);
            const actions = tools.map(t => {
                const name = t?.function?.name;
                if (!name) return null;
                return {
                    name,
                    label: name.replace(/_/g, ' '),
                    description: t.function?.description || '',
                    inputSchema: t.function?.parameters || null,
                    outputSchema: getOutputSchema(name),
                    sideEffect: isSideEffect(name),
                };
            }).filter(Boolean);
            const available = actions.some(a => userToolNames.has(a.name));
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
            needsFirstRunConfirm: !!summary.hasSideEffects,
        };
        if (a.triggerType === 'schedule' && a.scheduleCron) {
            updates.nextRunAt = cron.nextRunAt(a.scheduleCron, a.scheduleTz || 'Europe/Amsterdam', Date.now());
        }
        const u = await automationStore.updateAutomation(a.id, updates, userId);
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
        const u = await automationStore.updateAutomation(a.id, { isActive: false }, userId);
        res.json({ automation: u });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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

        const runPromise = runner.executeAutomation(a, {
            triggerKind: 'manual',
            triggerPayload: req.body?.triggerPayload || null,
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
