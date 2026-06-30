// §WS5 #4 — public inbound trigger surface (webhook + provider event pushes),
// extracted verbatim from routes/automation.js. Mounted BEFORE the auth chain.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const configStore = require('../../stores/configStore');
const triggerBus = require('../../automation/triggerBus');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');

// ── PUBLIC routes (defined first; auth comes after) ────

// Rate limits for the unauthenticated trigger surface. Limiters are registered
// BEFORE the body-parsing middleware so floods don't pay the JSON-parse cost.
// In-memory sliding windows (perUserRateLimit) — fine single-instance; `trust
// proxy` is configured in index.js so req.ip is the real client IP.
const AUTOMATION_WEBHOOK_RPM_PER_SLUG = parseInt(process.env.AUTOMATION_WEBHOOK_RPM_PER_SLUG, 10) || 120;
const AUTOMATION_WEBHOOK_RPM_PER_IP = parseInt(process.env.AUTOMATION_WEBHOOK_RPM_PER_IP, 10) || 300;
const AUTOMATION_EVENTS_RPM_PER_IP = parseInt(process.env.AUTOMATION_EVENTS_RPM_PER_IP, 10) || 600;

const webhookSlugLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: AUTOMATION_WEBHOOK_RPM_PER_SLUG,
    keyFn: (req) => `whslug:${req.params.slug}`,
});
const webhookIpLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: AUTOMATION_WEBHOOK_RPM_PER_IP,
    keyFn: (req) => `whip:${req.ip || 'unknown'}`,
});
// Shared across the /events/* provider push endpoints. 600/min/IP is
// deliberately generous: MS Graph's validationToken handshake must never 429
// (Graph drops the subscription if it does), and providers publish from small
// shared IP pools where one busy tenant would otherwise starve the rest.
const eventsLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: AUTOMATION_EVENTS_RPM_PER_IP,
    keyFn: (req) => `evt:${req.ip || 'unknown'}`,
});

// Webhook trigger — signed inbound URL.
router.post('/webhook/:slug', webhookIpLimiter, webhookSlugLimiter, express.json({ limit: '256kb' }), async (req, res) => {
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
        const runner = require('../../core/automationRunner');
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
//
// SECURITY: this endpoint is NOT cryptographically authenticated (Pub/Sub OIDC
// token verification is not yet wired — it needs google-auth-library + the push
// service-account audience). It is, however, no longer exploitable for a
// cross-tenant trigger: we have no emailAddress→userId mapping, so userId is
// always null, and triggerBus.dispatchEvent FAILS CLOSED for user-scoped
// providers (gmail) when userId is null — it refuses to fan out. The result is
// that this route can be flooded (rate-limited) but cannot trigger any tenant's
// automation. To actually deliver Gmail push events, two things must land
// together: (1) OIDC JWT verification here, and (2) an emailAddress→userId
// resolution so dispatch is scoped to the one owning subscriber.
router.post('/events/gmail', eventsLimiter, express.json({ limit: '128kb' }), async (req, res) => {
    try {
        const data = req.body?.message?.data;
        if (!data) return res.status(204).end();
        let decoded = {};
        try { decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8')); } catch {}
        // userId intentionally null until an emailAddress→userId mapping + OIDC
        // verification exist; dispatchEvent drops null-userId gmail events.
        await triggerBus.dispatchEvent({ provider: 'gmail', event: 'mail.new', payload: decoded, userId: null });
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
    const userStore = require('../../stores/userStore');
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

router.post('/events/nextcloud', eventsLimiter, captureRawNc, async (req, res) => {
    const org = await verifyNcConnectorSig(req);
    if (!org) return res.status(401).json({ error: 'Invalid or missing signature' });

    const { event, ncUid, payload } = req.body || {};
    if (!event) return res.status(400).json({ error: 'Missing event' });

    try {
        // Resolve the Bee Flow user from the NC uid via the user store —
        // the same mapping `ncUserGroupSync` maintains. If the uid hasn't
        // been provisioned yet, the event can't reach an automation; ack
        // so the connector doesn't retry.
        const userStore = require('../../stores/userStore');
        const user = ncUid
            ? await userStore.getUserByNcUid(org.id, ncUid).catch(() => null)
            : null;

        await triggerBus.dispatchEvent({
            provider: 'nextcloud',
            event,
            payload: payload || {},
            userId: user?.id || null,
            // Carry the org so background side-effects (e.g. Talk recording
            // auto-ingest) can resolve org-scoped settings even when the
            // ncUid → Bee Flow user mapping failed (bot/federated actor).
            orgId: org.id,
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
router.post('/events/msgraph', eventsLimiter, express.json({ limit: '128kb' }), async (req, res) => {
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
//
// SECURITY: the HMAC is verified over the RAW request bytes (what GitHub
// actually signs) — never over a re-serialised JSON.stringify(req.body), which
// can diverge from the bytes GitHub hashed and silently reject valid payloads.
// NOTE (follow-up, see audit WS1.2): the secret `automation_github_webhook_secret`
// is currently a single GLOBAL value, so a leak forges GitHub triggers for every
// org. Scoping it per-org requires a per-org GitHub App installation→org mapping
// (derive the org from the installation id / repo in the payload) — a separate
// feature that also changes the webhook URL users register in GitHub.
const captureRawJson = (limit) => express.json({
    limit,
    verify: (req, _res, buf) => { req.rawBody = buf; },
});
router.post('/events/github', eventsLimiter, captureRawJson('256kb'), async (req, res) => {
    try {
        const sig = req.get('X-Hub-Signature-256') || '';
        const event = req.get('X-GitHub-Event') || 'unknown';
        const secret = await configStore.getConfig('automation_github_webhook_secret');
        if (!secret) return res.status(503).json({ error: 'GitHub webhooks not configured' });
        const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}), 'utf8');
        const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
        const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
        if (!ok) return res.status(401).json({ error: 'Bad signature' });
        await triggerBus.dispatchEvent({ provider: 'github', event, payload: req.body || {} });
        return res.status(202).end();
    } catch (e) {
        console.error('[automation/events/github] error:', e.message);
        res.status(500).end();
    }
});

module.exports = router;
