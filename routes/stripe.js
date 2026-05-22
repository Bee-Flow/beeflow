/**
 * Stripe API Routes — Checkout, Portal, Webhooks, and public plan listing
 * 
 * Supports both Organization and Consumer (individual) subscriptions.
 * 
 * POST /api/stripe/checkout   — Create Stripe Checkout session (authenticated)
 * POST /api/stripe/portal     — Create Stripe Customer Portal session (authenticated)
 * POST /api/stripe/webhook    — Handle Stripe webhook events (no auth, signature verified)
 * GET  /api/stripe/plans      — List public plans with prices (authenticated, ?type=organization|consumer)
 * GET  /api/stripe/status     — Check Stripe configuration status (authenticated)
 */

const express = require('express');
const stripeService = require('../services/stripeService');
const userStore = require('../stores/userStore');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

const router = express.Router();

// Per-user throttle on Stripe-touching routes — a misbehaving (or hostile)
// authenticated client can otherwise burn through our Stripe API budget and
// rack up metered-API costs. Webhook is intentionally exempt: it's Stripe IP-
// pinned and signature-verified, and Stripe needs to retry without backoff.
const stripeUserLimiter = perUserRateLimit({ windowMs: 60_000, max: 10 });

// IP-level limiter to defend against credential-spray / session-rotation
// attacks that would slip past the per-user limit. 30 req/min/IP is roughly
// 3× the per-user cap so legitimate office NAT traffic isn't blocked.
const stripeIpLimiter = perUserRateLimit({
    windowMs: 60_000,
    max: 30,
    keyFn: (req) => `ip:${req.ip || 'unknown'}`,
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

// Stripe-backed flows are cloud-only — self-hosted customers pay via license
// keys. Apply this in front of every user-facing route (status, plans,
// checkout, portal). The webhook stays open: it's signature-verified by
// Stripe itself and won't fire on a self-hosted install that isn't wired up.
function requireCloud(req, res, next) {
    if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted') {
        return res.status(404).json({ error: 'not_available_in_self_hosted', message: 'Stripe checkout is a Bee Flow Cloud feature. Self-hosted installs use license keys.' });
    }
    next();
}

function getOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

// ── GET /status — Check if Stripe is configured and enabled ──────────────────

router.get('/status', requireCloud, requireAuth, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        const testMode = enabled ? await stripeService.isTestMode() : false;
        res.json({ enabled, testMode });
    } catch (err) {
        res.json({ enabled: false, testMode: false });
    }
});

// ── GET /plans — List public plans with pricing info ─────────────────────────
// Accepts ?type=organization|consumer (default: organization)

router.get('/plans', requireCloud, requireAuth, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.json([]);

        const requestedType = req.query.type || 'organization';
        const allPlans = await userStore.getAllPlans();
        const publicPlans = allPlans
            .filter(p => p.is_public && p.price > 0 && p.plan_type === requestedType)
            .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
            .map(p => ({
                id: p.id,
                name: p.name,
                description: p.description,
                price: p.price,
                currency: p.currency || 'eur',
                billing_interval: p.billing_interval || 'monthly',
                trial_days: p.trial_days || 0,
                plan_type: p.plan_type,
                max_messages_per_month: p.max_messages_per_month,
                max_tokens_per_month: p.max_tokens_per_month,
                max_cost_per_month: p.max_cost_per_month,
                max_users: p.max_users,
                max_agents: p.max_agents,
                max_knowledge_sources: p.max_knowledge_sources,
                allowed_features: p.allowed_features,
                has_stripe_price: !!p.stripe_price_id,
            }));

        res.json(publicPlans);
    } catch (err) {
        console.error('[Stripe] Failed to list plans:', err);
        res.status(500).json({ error: 'Failed to load plans' });
    }
});

// ── POST /checkout — Create a Stripe Checkout Session ────────────────────────
// Supports both organization and consumer checkouts

router.post('/checkout', requireCloud, stripeIpLimiter, requireAuth, stripeUserLimiter, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe payments are not enabled' });

        const { planId } = req.body;
        if (!planId) return res.status(400).json({ error: 'planId is required' });

        const user = req.session.user;
        const orgId = user?.organizationId || user?.orgId;
        const isConsumer = !!user?.isConsumerAccount || !orgId;

        // Get the plan
        const plan = await userStore.getPlan(planId);
        if (!plan) return res.status(404).json({ error: 'Plan not found' });
        if (!plan.stripe_price_id) {
            return res.status(400).json({ error: 'This plan has not been configured for payment yet. Contact your administrator.' });
        }

        // Verify plan type matches user context
        if (isConsumer && plan.plan_type !== 'consumer') {
            return res.status(400).json({ error: 'This plan is for organizations only' });
        }
        if (!isConsumer && plan.plan_type !== 'organization') {
            return res.status(400).json({ error: 'This plan is for individual accounts only' });
        }

        // Optional per-org plan whitelist. Super-admin sets a JSON array of
        // plan IDs in configStore under `org_<orgId>_allowed_plans`. Anything
        // not in the list is refused at checkout time. Empty/missing list =
        // unrestricted (today's behaviour). Stored in config (not a new
        // column) so no schema migration is required.
        if (!isConsumer && orgId) {
            try {
                const configStore = require('../stores/configStore');
                const raw = await configStore.getConfig(`org_${orgId}_allowed_plans`);
                let allowed = null;
                if (raw) {
                    try { allowed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { allowed = null; }
                }
                if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(planId)) {
                    return res.status(403).json({
                        error: 'plan_not_available_for_org',
                        message: 'This plan is not available for your organisation. Contact your administrator.',
                    });
                }
            } catch (e) {
                console.warn('[Stripe] allowed-plans lookup failed:', e.message);
                // fail-open so a configStore blip doesn't block checkout
            }
        }

        const origin = req.body.origin || getOrigin(req);
        // Optional caller-supplied success URL (wizard uses this to land the
        // admin on the License & Usage panel with a wizard-complete banner).
        // Any '{CHECKOUT_SESSION_ID}' placeholder in the caller URL is
        // preserved — Stripe substitutes the real session id on redirect.
        const customSuccessUrl = typeof req.body.successUrl === 'string' && req.body.successUrl.startsWith(origin)
            ? req.body.successUrl
            : null;

        if (isConsumer) {
            // ── Consumer Checkout ──
            const existingSub = await userStore.getConsumerSubscription(user.id);
            const stripeCustomerId = existingSub?.stripe_customer_id || null;

            const successUrl = customSuccessUrl || `${origin}/app/settings?tab=consumer_license&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
            const cancelUrl = `${origin}/app/settings?tab=consumer_license&checkout=cancelled`;

            const session = await stripeService.createCheckoutSession({
                plan,
                orgId: null,
                orgName: null,
                userId: user.id,
                subscriberType: 'consumer',
                userEmail: user.email,
                successUrl,
                cancelUrl,
                stripeCustomerId,
            });

            res.json({ url: session.url, sessionId: session.id });
        } else {
            // ── Organization Checkout ──
            const existingSub = await userStore.getOrgSubscription(orgId);
            const stripeCustomerId = existingSub?.stripe_customer_id || null;

            const successUrl = customSuccessUrl || `${origin}/app/settings?tab=license&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
            const cancelUrl = `${origin}/app/settings?tab=license&checkout=cancelled`;

            const orgs = await userStore.getAllOrganizations();
            const org = orgs.find(o => o.id === orgId);

            const session = await stripeService.createCheckoutSession({
                plan,
                orgId,
                orgName: org?.name || 'Organization',
                userId: null,
                subscriberType: 'organization',
                userEmail: user.email,
                successUrl,
                cancelUrl,
                stripeCustomerId,
            });

            res.json({ url: session.url, sessionId: session.id });
        }
    } catch (err) {
        console.error('[Stripe] Checkout error:', err);
        res.status(500).json({ error: err.message || 'Failed to create checkout session' });
    }
});

// ── POST /portal — Create a Stripe Customer Portal Session ───────────────────
// Supports both organization and consumer users

// ── GET /sessions/:id — Synchronous checkout session lookup ──────────────────
// Mitigates the post-checkout race: the success page can load before the
// `checkout.session.completed` webhook fires, in which case
// /api/subscriptions/orgs/:orgId still returns the old plan. The frontend
// polls this endpoint with the session_id from the URL and surfaces an
// in-flight indicator until `subscription_status === 'active'` or
// `subscription_status === 'trialing'`. Querying Stripe directly gives us a
// synchronous answer the webhook doesn't.
router.get('/sessions/:id', requireCloud, requireAuth, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe payments are not enabled' });

        const session = await stripeService.retrieveCheckoutSession(req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });

        // Authorize: the session must belong to the caller (same org or
        // same consumer user). Leak guard for shared sessions.
        const callerId = req.session.user?.id;
        const callerOrgId = req.session.user?.organizationId || req.session.user?.orgId;
        const sessOrg = session.metadata?.beeflow_org_id || null;
        const sessUser = session.metadata?.beeflow_user_id || null;
        const isAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
        if (!isAdmin) {
            if (sessOrg && sessOrg !== callerOrgId) return res.status(403).json({ error: 'Not your session' });
            if (sessUser && sessUser !== callerId) return res.status(403).json({ error: 'Not your session' });
        }

        // Echo back just what the UI needs to drive its polling state.
        res.json({
            id: session.id,
            status: session.status, // 'open' | 'complete' | 'expired'
            payment_status: session.payment_status,
            subscription: typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id || null),
            subscription_status: session.subscription?.status || null,
            customer: typeof session.customer === 'string' ? session.customer : (session.customer?.id || null),
            metadata: session.metadata || {},
        });
    } catch (err) {
        console.error('[Stripe] session lookup error:', err);
        res.status(500).json({ error: err.message || 'Failed to fetch session' });
    }
});

router.post('/portal', requireCloud, stripeIpLimiter, requireAuth, stripeUserLimiter, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe payments are not enabled' });

        const user = req.session.user;
        const orgId = user?.organizationId || user?.orgId;
        const isConsumer = !!user?.isConsumerAccount || !orgId;

        let stripeCustomerId;
        const origin = req.body.origin || getOrigin(req);

        if (isConsumer) {
            const sub = await userStore.getConsumerSubscription(user.id);
            stripeCustomerId = sub?.stripe_customer_id;
            if (!stripeCustomerId) {
                return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
            }
            const returnUrl = `${origin}/app/settings?tab=consumer_license`;
            const session = await stripeService.createPortalSession(stripeCustomerId, returnUrl);
            return res.json({ url: session.url });
        } else {
            const sub = await userStore.getOrgSubscription(orgId);
            stripeCustomerId = sub?.stripe_customer_id;
            if (!stripeCustomerId) {
                return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
            }
            const returnUrl = `${origin}/app/settings?tab=license`;
            const session = await stripeService.createPortalSession(stripeCustomerId, returnUrl);
            return res.json({ url: session.url });
        }
    } catch (err) {
        console.error('[Stripe] Portal error:', err);
        res.status(500).json({ error: err.message || 'Failed to create portal session' });
    }
});

// ── POST /webhook — Handle Stripe Webhook Events ─────────────────────────────
// NOTE: This route needs raw body — handled by mounting express.raw() in index.js

router.post('/webhook', async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature) return res.status(400).send('Missing stripe-signature header');

    let event;
    try {
        event = await stripeService.constructWebhookEvent(req.body, signature);
    } catch (err) {
        console.error('[Stripe Webhook] Signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency: Stripe retries on 5xx/timeout, so we record event.id and
    // skip duplicates. Insert wins → first delivery, conflict → already
    // processed. We always return 200 so Stripe stops retrying.
    const firstTime = await userStore.recordStripeEventProcessed(event.id, event.type);
    if (!firstTime) {
        console.log(`[Stripe Webhook] stripe.webhook.duplicate event_id=${event.id} type=${event.type}`);
        return res.json({ received: true, duplicate: true });
    }

    console.log(`[Stripe Webhook] event_id=${event.id} type=${event.type}`);

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object);
                break;

            // Admin-initiated trials (stripeService.createTrialSubscription) and
            // Stripe-dashboard/API direct creates emit `created`, not `updated`.
            // Route through the same handler so the local row reconciles.
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;

            case 'customer.subscription.trial_will_end':
                await handleTrialWillEnd(event.data.object);
                break;

            case 'invoice.paid':
                await handleInvoicePaid(event.data.object);
                break;

            case 'invoice.payment_failed':
                await handleInvoicePaymentFailed(event.data.object);
                break;

            case 'charge.refunded':
                await handleChargeRefunded(event.data.object);
                break;

            case 'charge.dispute.created':
                await handleChargeDisputeCreated(event.data.object);
                break;

            case 'customer.deleted':
                await handleCustomerDeleted(event.data.object);
                break;

            // Customer VAT/tax ID changes — keep `organizations.vat` in sync
            // with whatever the customer has in Stripe Tax. The org admin
            // can edit VAT via the Stripe Customer Portal; without this
            // handler the local row drifts and the EU reverse-charge logic
            // in createCheckoutSession would re-attach the stale value.
            case 'customer.tax_id.created':
            case 'customer.tax_id.updated':
            case 'customer.tax_id.deleted':
                await handleCustomerTaxIdChange(event.data.object, event.type);
                break;
            case 'customer.updated':
                await handleCustomerUpdated(event.data.object);
                break;

            // Payment-method save attempts from the Customer Portal. Stripe
            // emits these when a user clicks "Add card" outside of a
            // checkout. Without handlers, a declined card on save shows the
            // user a success page but the next invoice fails. Audit both;
            // email only on failure (claimNotification dedupes replays).
            case 'setup_intent.setup_failed':
                await handleSetupIntentFailed(event.data.object);
                break;
            case 'setup_intent.succeeded':
                await handleSetupIntentSucceeded(event.data.object);
                break;

            default:
                console.log(`[Stripe Webhook] stripe.webhook.unhandled type=${event.type} event_id=${event.id}`);
        }
    } catch (err) {
        console.error(`[Stripe Webhook] Error handling ${event.type}:`, err);
        // Return 200 anyway — Stripe will retry on 5xx and we don't want loops
    }

    res.json({ received: true });
});


// ═══════════════════════════════════════════
//  Webhook Event Handlers
// ═══════════════════════════════════════════

/**
 * Determine if a Stripe subscription/session is consumer or organization
 * by reading metadata.beeflow_subscriber_type.
 */
function getSubscriberType(metadata) {
    return metadata?.beeflow_subscriber_type === 'consumer' ? 'consumer' : 'organization';
}

/**
 * Cross-tenant safety check: when a webhook for a stripe_subscription_id
 * arrives, verify that the metadata-claimed subscriber matches the
 * subscriber actually recorded against that subscription locally. If the
 * local row exists but is owned by a *different* org/user, we refuse to
 * touch it and audit the mismatch.
 *
 * Returns `{ ok: true }` when the IDs match or no local row exists yet
 * (first-touch insert is fine). Returns `{ ok: false, reason, localTarget }`
 * when there is a divergence — caller should audit and bail.
 */
async function verifyMetadataMatchesLocal(subscription, claimedSubscriberType, claimedSubscriberId) {
    if (!subscription?.id) return { ok: true };
    const localTarget = await findSubscriptionTargetBySubId(subscription.id);
    if (!localTarget) return { ok: true };
    const sameScope = (localTarget.scope === 'organization' && claimedSubscriberType === 'organization')
        || (localTarget.scope === 'consumer' && claimedSubscriberType === 'consumer');
    if (sameScope && localTarget.id === claimedSubscriberId) return { ok: true };
    return { ok: false, reason: 'mismatch', localTarget };
}

/**
 * checkout.session.completed — User finished paying
 * Routes to either org or consumer subscription storage.
 */
async function handleCheckoutCompleted(session) {
    const subscriberType = getSubscriberType(session.metadata);
    const planId = session.metadata?.beeflow_plan_id;

    const subData = {
        plan_id: planId || null,
        status: 'active',
        stripe_customer_id: session.customer,
        stripe_subscription_id: session.subscription,
        payment_status: 'paid',
        billing_cycle_start: new Date().toISOString(),
    };

    // If the subscription has a trial, mark it
    if (session.subscription) {
        try {
            const stripe = await stripeService.getClient();
            const stripeSub = await stripe.subscriptions.retrieve(session.subscription);
            if (stripeSub.trial_end) {
                subData.trial_end_date = new Date(stripeSub.trial_end * 1000).toISOString();
                if (stripeSub.status === 'trialing') {
                    subData.payment_status = 'trialing';
                }
            }
        } catch (err) {
            console.warn('[Stripe Webhook] Could not retrieve subscription details:', err.message);
        }
    }

    if (subscriberType === 'consumer') {
        const userId = session.metadata?.beeflow_user_id;
        if (!userId) {
            console.error('[Stripe Webhook] checkout.session.completed (consumer) missing user ID');
            return;
        }
        console.log(`[Stripe Webhook] Consumer checkout completed for user ${userId}, plan ${planId}`);
        const success = await userStore.setConsumerSubscription(userId, subData);
        if (success) {
            await userStore.logSubscriptionAudit('assign_subscription', 'consumer', userId, 'stripe_webhook', null, { plan_id: planId, stripe_subscription_id: session.subscription, payment_status: 'paid' });
            console.log(`[Stripe Webhook] ✓ Consumer subscription assigned to user ${userId}`);
            await issueLicenseFromPlan({ scope: 'consumer', userId, planId, session });
        } else {
            console.error(`[Stripe Webhook] ✗ Failed to assign consumer subscription to user ${userId}`);
        }
    } else {
        const metaOrgId = session.metadata?.beeflow_org_id || null;
        const refOrgId = session.client_reference_id || null;
        // Defence in depth: if both signals are present and disagree, refuse
        // to assign the subscription. A mismatched metadata.beeflow_org_id
        // could indicate a tampered checkout (e.g. crafted Stripe session
        // with a different org's id) — better to fail loudly + audit.
        if (metaOrgId && refOrgId && metaOrgId !== refOrgId) {
            console.error(`[Stripe Webhook] stripe.checkout.metadata_mismatch ref=${refOrgId} meta=${metaOrgId} session_id=${session.id}`);
            await userStore.logSubscriptionAudit('checkout_metadata_mismatch', 'organization', metaOrgId, 'stripe_webhook', null, { client_reference_id: refOrgId, metadata_org_id: metaOrgId, session_id: session.id });
            return;
        }
        const orgId = metaOrgId || refOrgId;
        if (!orgId) {
            console.error('[Stripe Webhook] checkout.session.completed (org) missing org ID');
            return;
        }
        console.log(`[Stripe Webhook] Org checkout completed for org ${orgId}, plan ${planId}`);
        const success = await userStore.setOrgSubscription(orgId, subData);
        if (success) {
            await userStore.logSubscriptionAudit('assign_subscription', 'organization', orgId, 'stripe_webhook', null, { plan_id: planId, stripe_subscription_id: session.subscription, payment_status: 'paid' });
            console.log(`[Stripe Webhook] ✓ Subscription assigned to org ${orgId}`);
            await issueLicenseFromPlan({ scope: 'organization', organizationId: orgId, planId, session });
        } else {
            console.error(`[Stripe Webhook] ✗ Failed to assign subscription to org ${orgId}`);
        }
    }
}

/**
 * Resolve plan → tier and call the Beeflow license server to mint a JWT.
 * Failures are non-fatal for the webhook (Stripe sub is already saved) but
 * write a `license_issuance_failed` audit row so admins see the gap. Happy
 * path writes `license_issuance_succeeded`. Both rows target the org/user
 * so the audit log naturally groups them with the subscription.
 */
async function issueLicenseFromPlan({ scope, organizationId, userId, planId, session }) {
    const targetType = scope === 'organization' ? 'organization' : 'consumer';
    const targetId = scope === 'organization' ? organizationId : userId;
    try {
        const { issueLicenseFromCheckout, tierFromPlanName } = require('../license/issuance');
        let tier = null;
        if (planId) {
            const plan = await userStore.getPlan(planId);
            tier = tierFromPlanName(plan?.name) || tierFromPlanName(plan?.description);
        }
        if (!tier) {
            console.log('[Stripe Webhook] No tier could be derived from plan; skipping license issuance');
            // Not a failure — community tier and unknown-tier plans are
            // intentionally license-less. Don't audit either way.
            return;
        }
        const result = await issueLicenseFromCheckout({
            scope,
            organizationId,
            userId,
            planId,
            tier,
            stripeCustomerId: session.customer,
            stripeSubscriptionId: session.subscription,
        });
        await userStore.logSubscriptionAudit(
            'license_issuance_succeeded', targetType, targetId, 'stripe_webhook', null,
            { plan_id: planId, tier, stripe_subscription_id: session?.subscription, license_id: result?.licenseId || null }
        );
    } catch (e) {
        console.error('[Stripe Webhook] license issuance error:', e.message);
        try {
            await userStore.logSubscriptionAudit(
                'license_issuance_failed', targetType, targetId, 'stripe_webhook', null,
                { plan_id: planId, error_code: e.code || null, error: String(e.message || e).slice(0, 500), stripe_subscription_id: session?.subscription }
            );
        } catch (auditErr) {
            console.error('[Stripe Webhook] failed to audit license issuance failure:', auditErr.message);
        }
    }
}

/**
 * customer.subscription.updated — Plan change, trial ending, status change
 */
async function handleSubscriptionUpdated(subscription) {
    const subscriberType = getSubscriberType(subscription.metadata);

    // past_due no longer collapses to 'active' — customers behind on payments
    // surface as past_due so dunning + cron suspension can take effect.
    const statusMap = {
        active: 'active',
        past_due: 'past_due',
        trialing: 'trialing',
        paused: 'paused',
        incomplete: 'incomplete',
        incomplete_expired: 'cancelled',
        canceled: 'cancelled',
        unpaid: 'suspended',
    };

    const paymentStatusMap = {
        active: 'paid',
        past_due: 'past_due',
        trialing: 'trialing',
        paused: 'paused',
        incomplete: 'pending',
        incomplete_expired: 'failed',
        canceled: 'cancelled',
        unpaid: 'failed',
    };

    const updateData = {
        status: statusMap[subscription.status] || 'active',
        payment_status: paymentStatusMap[subscription.status] || subscription.status,
        stripe_subscription_id: subscription.id,
    };

    // Mirror Stripe's billed seat quantity so getEffectiveLimits can
    // multiply per-seat caps by the same number the customer is paying for.
    // Consumer subs always bill quantity=1 so this is a no-op for them.
    const billedQuantity = subscription.items?.data?.[0]?.quantity;
    if (typeof billedQuantity === 'number' && billedQuantity > 0) {
        updateData.stripe_seat_quantity = billedQuantity;
    }

    // Mirror Stripe's current billing-period start so the internal usage
    // window (getBillingPeriod in userStore) lines up with the date the
    // customer is actually invoiced for. After a checkout that set
    // billing_cycle_anchor, this is the anchor; after a plan change it is
    // the new period start. Falling back to billing_cycle_anchor covers
    // pre-renewal subs where current_period_start has not yet advanced.
    const periodStart = subscription.current_period_start
        || subscription.billing_cycle_anchor
        || null;
    if (periodStart) {
        updateData.billing_cycle_start = new Date(periodStart * 1000).toISOString();
    }

    // If plan changed, try to find the matching BeeFlow plan. Unmatched
    // Stripe price ids are logged + audited rather than silently nulled —
    // otherwise an unknown price leaves the local subscription orphaned.
    // Two-tier lookup:
    //   1. exact `stripe_price_id` match (cheapest, most common)
    //   2. fallback by `stripe_product_id` + same recurring.interval — covers
    //      the case where an admin re-created the price (rotated) but the
    //      underlying product is the same. Cheaper than rejecting the
    //      webhook outright.
    // If neither matches we DO NOT touch updateData.plan_id, so the
    // existing local plan_id is preserved (setOrgSubscription only writes
    // fields that are !== undefined). Audit + console warn surface it.
    const priceObj = subscription.items?.data?.[0]?.price || null;
    const priceId = priceObj?.id;
    const productId = priceObj?.product;
    const priceInterval = priceObj?.recurring?.interval || null;
    let planUnmatched = false;
    if (priceId) {
        const allPlans = await userStore.getAllPlans();
        let matchingPlan = allPlans.find(p => p.stripe_price_id === priceId);
        if (!matchingPlan && productId) {
            // Fallback: same product + same interval. If multiple match we
            // can't safely guess — leave unmatched and alert.
            const productMatches = allPlans.filter(p =>
                p.stripe_product_id === productId &&
                (!priceInterval || p.billing_interval === priceInterval)
            );
            if (productMatches.length === 1) {
                matchingPlan = productMatches[0];
                console.warn(`[Stripe Webhook] plan resolved via product_id fallback: price=${priceId} product=${productId} interval=${priceInterval} → plan=${matchingPlan.id}`);
            }
        }
        if (matchingPlan) {
            updateData.plan_id = matchingPlan.id;
        } else {
            planUnmatched = true;
        }
    }

    // Trial end date
    if (subscription.trial_end) {
        updateData.trial_end_date = new Date(subscription.trial_end * 1000).toISOString();
    }

    // Mirror the cancel-at-period-end flag and the scheduled cancel + current
    // period-end timestamps so the UI can render a "cancels on …" banner
    // without re-querying Stripe. These fields are informational; the actual
    // cancellation still flows through subscription.deleted later.
    updateData.cancel_at_period_end = !!subscription.cancel_at_period_end;
    updateData.cancel_at = subscription.cancel_at
        ? new Date(subscription.cancel_at * 1000).toISOString()
        : null;
    updateData.current_period_end = subscription.current_period_end
        ? new Date(subscription.current_period_end * 1000).toISOString()
        : null;

    if (subscriberType === 'consumer') {
        const userId = subscription.metadata?.beeflow_user_id;
        if (!userId) {
            console.warn('[Stripe Webhook] subscription.updated (consumer) missing beeflow_user_id');
            return;
        }
        const check = await verifyMetadataMatchesLocal(subscription, 'consumer', userId);
        if (!check.ok) {
            console.error(`[Stripe Webhook] stripe.webhook.metadata_mismatch event=subscription.updated sub_id=${subscription.id} meta_user=${userId} local_${check.localTarget.scope}=${check.localTarget.id}`);
            await userStore.logSubscriptionAudit('webhook_metadata_mismatch', 'consumer', userId, 'stripe_webhook', null, { event: 'subscription.updated', sub_id: subscription.id, claimed: userId, local_scope: check.localTarget.scope, local_id: check.localTarget.id });
            return;
        }
        // Atomic: override decision + write happen under a row-level lock so
        // two concurrent webhooks for the same subscription serialise.
        const strippedUpdate = stripOverriddenFields(updateData);
        const result = await userStore.setConsumerSubscriptionRespectingOverride(userId, updateData, strippedUpdate);
        const applied = result.applied === 'stripped' ? strippedUpdate : updateData;
        await userStore.logSubscriptionAudit('update_subscription', 'consumer', userId, 'stripe_webhook', null, { stripe_status: subscription.status, beeflow_status: applied.status, override_respected: result.overrideActive });
        if (result.overrideActive) {
            console.log(`[Stripe Webhook] stripe.webhook.override_respected scope=consumer user=${userId} stripe_status=${subscription.status}`);
            await userStore.logSubscriptionAudit('manual_override_respected', 'consumer', userId, 'stripe_webhook', null, { stripe_status: subscription.status });
        }
        if (planUnmatched) {
            console.warn(`[Stripe Webhook] stripe.plan.unmatched scope=consumer user=${userId} price_id=${priceId} sub_id=${subscription.id}`);
            await userStore.logSubscriptionAudit('plan_unmatched', 'consumer', userId, 'stripe_webhook', null, { price_id: priceId, sub_id: subscription.id });
        }
        console.log(`[Stripe Webhook] Consumer subscription updated for user ${userId}: ${subscription.status} → ${applied.status || '(unchanged)'}`);
    } else {
        const orgId = subscription.metadata?.beeflow_org_id;
        if (!orgId) {
            console.warn('[Stripe Webhook] subscription.updated (org) missing beeflow_org_id');
            return;
        }
        const check = await verifyMetadataMatchesLocal(subscription, 'organization', orgId);
        if (!check.ok) {
            console.error(`[Stripe Webhook] stripe.webhook.metadata_mismatch event=subscription.updated sub_id=${subscription.id} meta_org=${orgId} local_${check.localTarget.scope}=${check.localTarget.id}`);
            await userStore.logSubscriptionAudit('webhook_metadata_mismatch', 'organization', orgId, 'stripe_webhook', null, { event: 'subscription.updated', sub_id: subscription.id, claimed: orgId, local_scope: check.localTarget.scope, local_id: check.localTarget.id });
            return;
        }
        const strippedUpdate = stripOverriddenFields(updateData);
        const result = await userStore.setOrgSubscriptionRespectingOverride(orgId, updateData, strippedUpdate);
        const applied = result.applied === 'stripped' ? strippedUpdate : updateData;
        await userStore.logSubscriptionAudit('update_subscription', 'organization', orgId, 'stripe_webhook', null, { stripe_status: subscription.status, beeflow_status: applied.status, override_respected: result.overrideActive });
        if (result.overrideActive) {
            console.log(`[Stripe Webhook] stripe.webhook.override_respected scope=org org=${orgId} stripe_status=${subscription.status}`);
            await userStore.logSubscriptionAudit('manual_override_respected', 'organization', orgId, 'stripe_webhook', null, { stripe_status: subscription.status });
        }
        if (planUnmatched) {
            console.warn(`[Stripe Webhook] stripe.plan.unmatched scope=org org=${orgId} price_id=${priceId} sub_id=${subscription.id}`);
            await userStore.logSubscriptionAudit('plan_unmatched', 'organization', orgId, 'stripe_webhook', null, { price_id: priceId, sub_id: subscription.id });
        }
        console.log(`[Stripe Webhook] Subscription updated for org ${orgId}: ${subscription.status} → ${applied.status || '(unchanged)'}`);
    }
}

// When a manual override is active, the webhook still writes Stripe-side
// metadata (subscription_id, trial_end_date) but **must not** touch the
// admin-controlled fields. Returns a shallow copy with status/plan_id/
// payment_status stripped.
function stripOverriddenFields(updateData) {
    const out = { ...updateData };
    delete out.status;
    delete out.plan_id;
    delete out.payment_status;
    return out;
}

/**
 * customer.tax_id.created / updated / deleted — keep the org's stored VAT in
 * sync with what the customer maintains in the Stripe portal. Matching is by
 * stripe_customer_id → organization. Consumers don't have a VAT field so
 * they're skipped. Failures are audit-logged but never surface as 5xx (we
 * always 200 the webhook).
 */
async function handleCustomerTaxIdChange(taxIdObj, eventType) {
    try {
        const customerId = taxIdObj?.customer;
        if (!customerId) return;
        const { getAll } = require('../db');
        const subs = await getAll(
            `SELECT organization_id FROM organization_subscriptions WHERE stripe_customer_id = $1`,
            [customerId]
        );
        if (!subs?.length) {
            console.log(`[Stripe Webhook] tax_id.${eventType.split('.').pop()} for unknown customer=${customerId}`);
            return;
        }
        const orgId = subs[0].organization_id;
        // For deletions clear the VAT; for create/update prefer the new value.
        const value = eventType === 'customer.tax_id.deleted' ? '' : (taxIdObj.value || '');
        await require('../stores/userStore').updateOrganization(orgId, { vat: value });
        await userStore.logSubscriptionAudit(
            'tax_id_synced',
            'organization',
            orgId,
            'stripe_webhook',
            null,
            { event: eventType, customer: customerId, type: taxIdObj.type, value }
        );
        console.log(`[Stripe Webhook] tax_id synced org=${orgId} type=${taxIdObj.type} value=${value || '(cleared)'}`);
    } catch (e) {
        console.warn('[Stripe Webhook] handleCustomerTaxIdChange error:', e.message);
    }
}

/**
 * customer.updated — Stripe customers carry name, email, address, tax_exempt.
 * Today we only need to mirror address changes that affect tax calculation:
 * specifically, sync `organizations.email` when the billing email is changed
 * via the customer portal. Light touch — most fields stay Stripe-owned.
 */
async function handleCustomerUpdated(customer) {
    try {
        const { getAll } = require('../db');
        const subs = await getAll(
            `SELECT organization_id FROM organization_subscriptions WHERE stripe_customer_id = $1`,
            [customer.id]
        );
        if (!subs?.length) return;
        const orgId = subs[0].organization_id;
        const updates = {};
        if (customer.email) updates.email = customer.email;
        if (Object.keys(updates).length === 0) return;
        await require('../stores/userStore').updateOrganization(orgId, updates);
        await userStore.logSubscriptionAudit(
            'customer_synced',
            'organization',
            orgId,
            'stripe_webhook',
            null,
            { customer: customer.id, fields: Object.keys(updates) }
        );
    } catch (e) {
        console.warn('[Stripe Webhook] handleCustomerUpdated error:', e.message);
    }
}

/**
 * setup_intent.setup_failed — Customer tried to save a new payment method
 * (typically from the Customer Portal) and the card was declined or
 * abandoned mid-3DS. Audit the failure and email the customer so they
 * don't only find out at the next invoice. claimNotification deduplicates
 * webhook replays.
 */
async function handleSetupIntentFailed(setupIntent) {
    try {
        const customerId = setupIntent.customer;
        if (!customerId) return;
        const target = await findSubscriptionTargetByCustomerId(customerId);
        if (!target) {
            console.log(`[Stripe Webhook] setup_intent.failed for unknown customer=${customerId}`);
            return;
        }
        const targetType = target.scope === 'organization' ? 'organization' : 'consumer';
        await userStore.logSubscriptionAudit(
            'setup_intent_failed',
            targetType,
            target.id,
            'stripe_webhook',
            null,
            { setup_intent_id: setupIntent.id, last_setup_error: setupIntent.last_setup_error?.message || null },
        );

        // One email per setup_intent id (so 3DS retries and webhook replays
        // don't double-send).
        const claimed = await userStore.claimNotification(targetType, target.id, `setup_intent_failed:${setupIntent.id}`, null, { setup_intent_id: setupIntent.id });
        if (!claimed) return;

        let recipientEmail = null;
        let displayName = null;
        let orgName = null;
        if (target.scope === 'consumer') {
            const u = await userStore.getUser(target.id).catch(() => null);
            recipientEmail = u?.email || null;
            displayName = u?.displayName || u?.username || null;
        } else {
            const org = await userStore.getOrganization(target.id).catch(() => null);
            orgName = org?.name || null;
            recipientEmail = org?.email || null;
        }
        if (!recipientEmail) return;

        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.ai'}`;
        let portalUrl = `${clientHost}/settings/billing`;
        try {
            const portal = await stripeService.createPortalSession(customerId, portalUrl);
            if (portal?.url) portalUrl = portal.url;
        } catch (_) { /* fall back */ }

        const { sendPaymentFailedEmail } = require('../utils/emailService');
        await sendPaymentFailedEmail({
            email: recipientEmail,
            displayName,
            orgName,
            portalUrl,
            attemptCount: 0,
        }).catch(e => console.warn('[Stripe Webhook] setup_intent_failed email failed:', e.message));
    } catch (e) {
        console.warn('[Stripe Webhook] handleSetupIntentFailed error:', e.message);
    }
}

/**
 * setup_intent.succeeded — Card saved successfully. Audit only; no email
 * (Stripe sends its own confirmation if the customer opts in).
 */
async function handleSetupIntentSucceeded(setupIntent) {
    try {
        const customerId = setupIntent.customer;
        if (!customerId) return;
        const target = await findSubscriptionTargetByCustomerId(customerId);
        if (!target) return;
        await userStore.logSubscriptionAudit(
            'setup_intent_succeeded',
            target.scope === 'organization' ? 'organization' : 'consumer',
            target.id,
            'stripe_webhook',
            null,
            { setup_intent_id: setupIntent.id, payment_method: setupIntent.payment_method || null },
        );
    } catch (e) {
        console.warn('[Stripe Webhook] handleSetupIntentSucceeded error:', e.message);
    }
}

/**
 * customer.subscription.trial_will_end — Stripe pings ~3 days before the trial
 * ends. Persist an audit row, then send the customer a "trial ending" email
 * with a portal link to add a payment method. The send is gated by
 * `notifications_sent` so re-delivered webhooks don't double-send.
 */
async function handleTrialWillEnd(subscription) {
    const subscriberType = getSubscriberType(subscription.metadata);
    const trialEndIso = subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null;
    if (subscriberType === 'consumer') {
        const userId = subscription.metadata?.beeflow_user_id;
        if (!userId) return;
        await userStore.logSubscriptionAudit('trial_will_end', 'consumer', userId, 'stripe_webhook', null, { trial_end: trialEndIso, sub_id: subscription.id });
        console.log(`[Stripe Webhook] stripe.trial.will_end scope=consumer user=${userId} trial_end=${trialEndIso}`);
        await _sendTrialEndingEmailOnce({ scope: 'consumer', userId, subscription, trialEndIso });
    } else {
        const orgId = subscription.metadata?.beeflow_org_id;
        if (!orgId) return;
        await userStore.logSubscriptionAudit('trial_will_end', 'organization', orgId, 'stripe_webhook', null, { trial_end: trialEndIso, sub_id: subscription.id });
        console.log(`[Stripe Webhook] stripe.trial.will_end scope=org org=${orgId} trial_end=${trialEndIso}`);
        await _sendTrialEndingEmailOnce({ scope: 'org', orgId, subscription, trialEndIso });
    }
}

// Idempotent send of the trial-ending email. Claims the notification slot
// FIRST and only sends if the claim succeeded; that way a webhook redelivery
// after a partial failure doesn't re-spam the customer. Failures are
// swallowed: a missing email or a transient SMTP error must not 5xx Stripe.
async function _sendTrialEndingEmailOnce({ scope, orgId, userId, subscription, trialEndIso }) {
    try {
        const targetType = scope === 'consumer' ? 'consumer' : 'organization';
        const targetId = scope === 'consumer' ? userId : orgId;
        const claimed = await userStore.claimNotification(
            targetType, targetId, 'trial_will_end',
            null, { sub_id: subscription.id, trial_end: trialEndIso }
        );
        if (!claimed) return; // already sent for this subscription

        // Resolve recipient and display name.
        let recipientEmail = null;
        let displayName = null;
        let orgName = null;
        if (scope === 'consumer') {
            try {
                const u = await userStore.getUser(userId);
                recipientEmail = u?.email || null;
                displayName = u?.displayName || u?.username || null;
            } catch (_) {}
        } else {
            // Org: prefer the org-admin who initiated checkout (metadata) or
            // the first org_admin user; fall back to the org's billing email.
            try {
                const org = await userStore.getOrganization(orgId);
                orgName = org?.name || null;
                recipientEmail = org?.email || null;
                const { getAll } = require('../db');
                const admins = await getAll(
                    `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) AND email IS NOT NULL AND email <> '' LIMIT 5`,
                    [orgId],
                );
                const adminEmails = (admins || []).map(a => a.email).filter(Boolean);
                if (adminEmails.length > 0) recipientEmail = adminEmails[0];
            } catch (_) {}
        }
        if (!recipientEmail) {
            console.warn(`[Stripe Webhook] trial_will_end: no recipient email found for ${targetType}=${targetId}`);
            return;
        }

        // Build a portal URL the customer can click directly. If Stripe is
        // misconfigured the helper will throw — swallow it and fall back to a
        // plain link to the billing dashboard.
        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.ai'}`;
        let portalUrl = `${clientHost}/settings/billing`;
        try {
            if (subscription.customer) {
                const portal = await stripeService.createPortalSession(subscription.customer, portalUrl);
                if (portal?.url) portalUrl = portal.url;
            }
        } catch (e) {
            console.warn(`[Stripe Webhook] portal session for trial_will_end failed: ${e.message}`);
        }

        const { sendTrialEndingEmail } = require('../utils/emailService');
        const result = await sendTrialEndingEmail({
            email: recipientEmail,
            displayName,
            orgName,
            trialEndIso,
            portalUrl,
        });
        if (!result?.success) {
            console.warn(`[Stripe Webhook] trial_will_end email send failed: ${result?.error || 'unknown'}`);
        }
    } catch (e) {
        console.warn('[Stripe Webhook] _sendTrialEndingEmailOnce error:', e.message);
    }
}

/**
 * charge.refunded — flip the subscription's payment_status to 'refunded'.
 * Match by stripe_subscription_id on the charge's invoice → subscription
 * link, falling back to stripe_customer_id.
 */
async function handleChargeRefunded(charge) {
    const subId = charge.invoice ? null : charge.subscription || null;
    // charge.invoice is the typical path; resolve via stripe_subscription_id
    // on the invoice. If we have no link, fall back to the customer.
    let target = null;
    if (subId) {
        target = await findSubscriptionTargetBySubId(subId);
    }
    if (!target && charge.customer) {
        target = await userStore.findSubscriptionByStripeCustomerId(charge.customer);
    }
    if (!target) {
        console.warn(`[Stripe Webhook] charge.refunded could not locate subscription charge_id=${charge.id}`);
        return;
    }
    const payload = { payment_status: 'refunded' };
    if (target.scope === 'organization') {
        await userStore.setOrgSubscription(target.id, payload);
        await userStore.logSubscriptionAudit('refund_processed', 'organization', target.id, 'stripe_webhook', null, { charge_id: charge.id, amount_refunded: charge.amount_refunded });
        console.log(`[Stripe Webhook] stripe.refund.processed scope=org org=${target.id} amount=${charge.amount_refunded}`);
    } else {
        await userStore.setConsumerSubscription(target.id, payload);
        await userStore.logSubscriptionAudit('refund_processed', 'consumer', target.id, 'stripe_webhook', null, { charge_id: charge.id, amount_refunded: charge.amount_refunded });
        console.log(`[Stripe Webhook] stripe.refund.processed scope=consumer user=${target.id} amount=${charge.amount_refunded}`);
    }
}

/**
 * charge.dispute.created — a chargeback was opened. Suspend the subscription
 * defensively; restoration requires manual intervention after the dispute
 * resolves.
 */
async function handleChargeDisputeCreated(dispute) {
    let target = null;
    if (dispute.charge) {
        try {
            const stripe = await stripeService.getClient();
            const charge = await stripe.charges.retrieve(dispute.charge);
            if (charge.customer) {
                target = await userStore.findSubscriptionByStripeCustomerId(charge.customer);
            }
        } catch (e) {
            console.warn('[Stripe Webhook] dispute charge retrieve failed:', e.message);
        }
    }
    if (!target && dispute.customer) {
        target = await userStore.findSubscriptionByStripeCustomerId(dispute.customer);
    }
    if (!target) {
        console.warn(`[Stripe Webhook] charge.dispute.created could not locate subscription dispute_id=${dispute.id}`);
        return;
    }
    const payload = { status: 'suspended', payment_status: 'disputed' };
    if (target.scope === 'organization') {
        await userStore.setOrgSubscription(target.id, payload);
        await userStore.logSubscriptionAudit('dispute_opened', 'organization', target.id, 'stripe_webhook', null, { dispute_id: dispute.id, reason: dispute.reason, amount: dispute.amount });
        console.log(`[Stripe Webhook] stripe.dispute.opened scope=org org=${target.id} dispute_id=${dispute.id} reason=${dispute.reason}`);
    } else {
        await userStore.setConsumerSubscription(target.id, payload);
        await userStore.logSubscriptionAudit('dispute_opened', 'consumer', target.id, 'stripe_webhook', null, { dispute_id: dispute.id, reason: dispute.reason, amount: dispute.amount });
        console.log(`[Stripe Webhook] stripe.dispute.opened scope=consumer user=${target.id} dispute_id=${dispute.id} reason=${dispute.reason}`);
    }
}

/**
 * customer.deleted — Stripe customer was removed (rare; usually triggered
 * manually by an admin). Null the local stripe_customer_id so the next
 * checkout creates a fresh customer instead of failing on an invalid id.
 */
async function handleCustomerDeleted(customer) {
    const target = await userStore.findSubscriptionByStripeCustomerId(customer.id);
    if (!target) return;
    if (target.scope === 'organization') {
        await userStore.clearStripeCustomerIdForOrg(target.id);
        await userStore.logSubscriptionAudit('stripe_customer_deleted', 'organization', target.id, 'stripe_webhook', null, { stripe_customer_id: customer.id });
        console.log(`[Stripe Webhook] stripe.customer.deleted scope=org org=${target.id} customer_id=${customer.id}`);
    } else {
        await userStore.clearStripeCustomerIdForConsumer(target.id);
        await userStore.logSubscriptionAudit('stripe_customer_deleted', 'consumer', target.id, 'stripe_webhook', null, { stripe_customer_id: customer.id });
        console.log(`[Stripe Webhook] stripe.customer.deleted scope=consumer user=${target.id} customer_id=${customer.id}`);
    }
}

async function findSubscriptionTargetBySubId(stripeSubscriptionId) {
    if (!stripeSubscriptionId) return null;
    const orgs = await userStore.getAllOrgSubscriptions();
    const orgMatch = orgs.find(s => s.stripe_subscription_id === stripeSubscriptionId);
    if (orgMatch) return { scope: 'organization', id: orgMatch.organization_id };
    const consumers = await userStore.getAllConsumerSubscriptions();
    const consumerMatch = consumers.find(s => s.stripe_subscription_id === stripeSubscriptionId);
    if (consumerMatch) return { scope: 'consumer', id: consumerMatch.user_id };
    return null;
}

async function findSubscriptionTargetByCustomerId(stripeCustomerId) {
    if (!stripeCustomerId) return null;
    const orgs = await userStore.getAllOrgSubscriptions();
    const orgMatch = orgs.find(s => s.stripe_customer_id === stripeCustomerId);
    if (orgMatch) return { scope: 'organization', id: orgMatch.organization_id };
    const consumers = await userStore.getAllConsumerSubscriptions();
    const consumerMatch = consumers.find(s => s.stripe_customer_id === stripeCustomerId);
    if (consumerMatch) return { scope: 'consumer', id: consumerMatch.user_id };
    return null;
}

/**
 * customer.subscription.deleted — Subscription cancelled or expired
 */
async function handleSubscriptionDeleted(subscription) {
    const subscriberType = getSubscriberType(subscription.metadata);

    if (subscriberType === 'consumer') {
        const userId = subscription.metadata?.beeflow_user_id;
        if (userId) {
            const check = await verifyMetadataMatchesLocal(subscription, 'consumer', userId);
            if (!check.ok) {
                console.error(`[Stripe Webhook] stripe.webhook.metadata_mismatch event=subscription.deleted sub_id=${subscription.id} meta_user=${userId} local_${check.localTarget.scope}=${check.localTarget.id}`);
                await userStore.logSubscriptionAudit('webhook_metadata_mismatch', 'consumer', userId, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, claimed: userId, local_scope: check.localTarget.scope, local_id: check.localTarget.id });
                return;
            }
            await handleSubscriptionDeletedForConsumer(userId, subscription);
        } else {
            // Fallback: search consumer_subscriptions by stripe_subscription_id.
            // Metadata is missing so we can't cross-check — audit before
            // touching the row so any later forensic review can spot it.
            const allSubs = await userStore.getAllConsumerSubscriptions();
            const match = allSubs.find(s => s.stripe_subscription_id === subscription.id);
            if (match) {
                await userStore.logSubscriptionAudit('webhook_metadata_missing', 'consumer', match.user_id, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, resolved_via: 'stripe_subscription_id_lookup' });
                await handleSubscriptionDeletedForConsumer(match.user_id, subscription);
            } else {
                console.warn('[Stripe Webhook] subscription.deleted (consumer) — could not find matching user');
            }
        }
    } else {
        const orgId = subscription.metadata?.beeflow_org_id;
        if (orgId) {
            const check = await verifyMetadataMatchesLocal(subscription, 'organization', orgId);
            if (!check.ok) {
                console.error(`[Stripe Webhook] stripe.webhook.metadata_mismatch event=subscription.deleted sub_id=${subscription.id} meta_org=${orgId} local_${check.localTarget.scope}=${check.localTarget.id}`);
                await userStore.logSubscriptionAudit('webhook_metadata_mismatch', 'organization', orgId, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, claimed: orgId, local_scope: check.localTarget.scope, local_id: check.localTarget.id });
                return;
            }
            await handleSubscriptionDeletedForOrg(orgId, subscription);
        } else {
            const allSubs = await userStore.getAllOrgSubscriptions();
            const match = allSubs.find(s => s.stripe_subscription_id === subscription.id);
            if (match) {
                await userStore.logSubscriptionAudit('webhook_metadata_missing', 'organization', match.organization_id, 'stripe_webhook', null, { event: 'subscription.deleted', sub_id: subscription.id, resolved_via: 'stripe_subscription_id_lookup' });
                await handleSubscriptionDeletedForOrg(match.organization_id, subscription);
            } else {
                console.warn('[Stripe Webhook] subscription.deleted (org) — could not find matching org');
            }
        }
    }
}

async function handleSubscriptionDeletedForOrg(orgId, subscription) {
    await userStore.setOrgSubscription(orgId, {
        status: 'cancelled',
        payment_status: 'cancelled',
    });
    await userStore.logSubscriptionAudit('update_subscription', 'organization', orgId, 'stripe_webhook', null, { status: 'cancelled', reason: 'stripe_subscription_deleted' });
    console.log(`[Stripe Webhook] Subscription cancelled for org ${orgId}`);
}

async function handleSubscriptionDeletedForConsumer(userId, subscription) {
    await userStore.setConsumerSubscription(userId, {
        status: 'cancelled',
        payment_status: 'cancelled',
    });
    await userStore.logSubscriptionAudit('update_subscription', 'consumer', userId, 'stripe_webhook', null, { status: 'cancelled', reason: 'stripe_subscription_deleted' });
    console.log(`[Stripe Webhook] Consumer subscription cancelled for user ${userId}`);
}

/**
 * invoice.paid — Payment succeeded. Resets the dunning counter so a
 * subsequent failure starts fresh, and flips back to active/paid.
 */
async function handleInvoicePaid(invoice) {
    const subId = invoice.subscription;
    if (!subId) return;
    const target = await findSubscriptionTargetBySubId(subId);
    if (!target) return;

    if (target.scope === 'organization') {
        await userStore.setOrgSubscription(target.id, { status: 'active', payment_status: 'paid' });
        await userStore.resetPaymentFailureForOrg(target.id);
        console.log(`[Stripe Webhook] stripe.invoice.paid scope=org org=${target.id}`);
    } else {
        await userStore.setConsumerSubscription(target.id, { status: 'active', payment_status: 'paid' });
        await userStore.resetPaymentFailureForConsumer(target.id);
        console.log(`[Stripe Webhook] stripe.invoice.paid scope=consumer user=${target.id}`);
    }
}

/**
 * invoice.payment_failed — Payment failed. Bump the dunning counter and
 * stamp past_due_since on the first failure. The dunning scheduler in
 * server/index.js sweeps past_due_since older than the grace window and
 * suspends — that's where the actual feature lockout happens.
 */
// Dunning cap. After this many failed retries, stop the per-attempt email
// stream, transition the sub to `manual_action_required`, and send a single
// "final dunning" email. Customer can re-trigger via portal. Stripe Smart
// Retries usually try at ~3, 5, 7, 14 days; capping at 4 keeps the email
// stream short of the typical "this account is dead" point.
const DUNNING_MAX_ATTEMPTS = 4;

async function handleInvoicePaymentFailed(invoice) {
    const subId = invoice.subscription;
    if (!subId) return;
    const target = await findSubscriptionTargetBySubId(subId);
    if (!target) return;

    let attempt = 0;
    if (target.scope === 'organization') {
        await userStore.setOrgSubscription(target.id, { status: 'past_due', payment_status: 'failed' });
        const updated = await userStore.recordPaymentFailureForOrg(target.id);
        attempt = updated?.payment_attempt_count ?? 0;
        await userStore.logSubscriptionAudit('payment_attempt_failed', 'organization', target.id, 'stripe_webhook', null, { attempt_count: attempt, invoice_id: invoice.id });
        console.log(`[Stripe Webhook] stripe.invoice.payment_failed scope=org org=${target.id} attempt=${attempt}`);
    } else {
        await userStore.setConsumerSubscription(target.id, { status: 'past_due', payment_status: 'failed' });
        const updated = await userStore.recordPaymentFailureForConsumer(target.id);
        attempt = updated?.payment_attempt_count ?? 0;
        await userStore.logSubscriptionAudit('payment_attempt_failed', 'consumer', target.id, 'stripe_webhook', null, { attempt_count: attempt, invoice_id: invoice.id });
        console.log(`[Stripe Webhook] stripe.invoice.payment_failed scope=consumer user=${target.id} attempt=${attempt}`);
    }

    // Reached the cap: transition to manual_action_required (silences future
    // per-attempt emails) and send the one final dunning email. The status
    // flip is idempotent — `claimNotification('payment_dunning_capped')`
    // ensures the final email is sent at most once.
    if (attempt >= DUNNING_MAX_ATTEMPTS) {
        try {
            if (target.scope === 'organization') {
                await userStore.setOrgSubscription(target.id, { status: 'manual_action_required' });
            } else {
                await userStore.setConsumerSubscription(target.id, { status: 'manual_action_required' });
            }
            await userStore.logSubscriptionAudit(
                'payment_dunning_capped',
                target.scope === 'organization' ? 'organization' : 'consumer',
                target.id,
                'stripe_webhook',
                null,
                { attempt_count: attempt, cap: DUNNING_MAX_ATTEMPTS },
            );
            await _sendFinalDunningEmailOnce({ target, customerId: invoice.customer || null });
        } catch (e) {
            console.warn('[Stripe Webhook] dunning-cap transition failed:', e.message);
        }
        return; // do NOT fire the per-attempt email once we've capped
    }

    // Fire-and-forget "payment failed" email, gated on the attempt counter
    // so each failure (Stripe Smart Retries: ~3, 5, 7 days) gets at most
    // one email — webhook redeliveries claim against the same key.
    await _sendPaymentFailedEmailOnce({
        target,
        attempt,
        customerId: invoice.customer || null,
    });
}

async function _sendFinalDunningEmailOnce({ target, customerId }) {
    try {
        const targetType = target.scope === 'organization' ? 'organization' : 'consumer';
        const claimed = await userStore.claimNotification(targetType, target.id, 'payment_dunning_capped', null, { cap: DUNNING_MAX_ATTEMPTS });
        if (!claimed) return;

        let recipientEmail = null;
        let displayName = null;
        let orgName = null;
        if (target.scope === 'consumer') {
            const u = await userStore.getUser(target.id).catch(() => null);
            recipientEmail = u?.email || null;
            displayName = u?.displayName || u?.username || null;
        } else {
            const org = await userStore.getOrganization(target.id).catch(() => null);
            orgName = org?.name || null;
            recipientEmail = org?.email || null;
            try {
                const { getAll } = require('../db');
                const admins = await getAll(
                    `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) AND email IS NOT NULL AND email <> '' LIMIT 1`,
                    [target.id],
                );
                if (admins?.[0]?.email) recipientEmail = admins[0].email;
            } catch (_) { /* tolerate */ }
        }
        if (!recipientEmail) return;

        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.ai'}`;
        let portalUrl = `${clientHost}/settings/billing`;
        try {
            if (customerId) {
                const portal = await stripeService.createPortalSession(customerId, portalUrl);
                if (portal?.url) portalUrl = portal.url;
            }
        } catch (_) { /* fall back */ }

        const { sendSubscriptionSuspendedEmail } = require('../utils/emailService');
        await sendSubscriptionSuspendedEmail({
            email: recipientEmail,
            displayName,
            orgName,
            portalUrl,
            reason: 'payment_dunning_capped',
        }).catch(e => console.warn('[Stripe Webhook] final dunning email send failed:', e.message));
    } catch (e) {
        console.warn('[Stripe Webhook] _sendFinalDunningEmailOnce error:', e.message);
    }
}

async function _sendPaymentFailedEmailOnce({ target, attempt, customerId }) {
    try {
        const targetType = target.scope === 'organization' ? 'organization' : 'consumer';
        const kind = `payment_failed:attempt:${attempt}`;
        const claimed = await userStore.claimNotification(targetType, target.id, kind, null, { attempt });
        if (!claimed) return;

        // Resolve recipient + display name. Mirrors the trial-end helper but
        // tolerates a missing customer id (some failure modes don't include
        // it; we fall back to the org/user record).
        let recipientEmail = null;
        let displayName = null;
        let orgName = null;
        if (target.scope === 'consumer') {
            const u = await userStore.getUser(target.id).catch(() => null);
            recipientEmail = u?.email || null;
            displayName = u?.displayName || u?.username || null;
        } else {
            const org = await userStore.getOrganization(target.id).catch(() => null);
            orgName = org?.name || null;
            recipientEmail = org?.email || null;
            try {
                const { getAll } = require('../db');
                const admins = await getAll(
                    `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) AND email IS NOT NULL AND email <> '' LIMIT 5`,
                    [target.id],
                );
                const adminEmails = (admins || []).map(a => a.email).filter(Boolean);
                if (adminEmails.length > 0) recipientEmail = adminEmails[0];
            } catch (_) { /* tolerate */ }
        }
        if (!recipientEmail) return;

        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.ai'}`;
        let portalUrl = `${clientHost}/settings/billing`;
        try {
            if (customerId) {
                const portal = await stripeService.createPortalSession(customerId, portalUrl);
                if (portal?.url) portalUrl = portal.url;
            }
        } catch (_) { /* fall back to settings page */ }

        const { sendPaymentFailedEmail } = require('../utils/emailService');
        await sendPaymentFailedEmail({
            email: recipientEmail,
            displayName,
            orgName,
            portalUrl,
            attemptCount: attempt,
        }).catch(e => console.warn('[Stripe Webhook] payment_failed email send failed:', e.message));
    } catch (e) {
        console.warn('[Stripe Webhook] _sendPaymentFailedEmailOnce error:', e.message);
    }
}


// ═══════════════════════════════════════════
//  Promo Code Admin Routes
// ═══════════════════════════════════════════

const { hasPermission } = require('../auth/permissions');

async function requireAdmin(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
    // Check RBAC permissions
    const userId = req.session.user?.id;
    if (userId && await hasPermission(userId, 'all', req.session)) return next();
    return res.status(403).json({ error: 'Admin access required' });
}

// GET /api/stripe/promo-codes — List all promo codes
router.get('/promo-codes', requireCloud, stripeIpLimiter, requireAdmin, stripeUserLimiter, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe is not enabled' });

        const limit = Math.min(parseInt(req.query.limit) || 25, 100);
        const codes = await stripeService.listPromoCodes(limit);
        res.json(codes);
    } catch (err) {
        console.error('[Stripe] List promo codes error:', err);
        res.status(500).json({ error: err.message || 'Failed to list promo codes' });
    }
});

// POST /api/stripe/promo-codes — Create a new promo code
router.post('/promo-codes', requireCloud, stripeIpLimiter, requireAdmin, stripeUserLimiter, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe is not enabled' });

        const { code, discountType, discountValue, currency, duration, durationMonths, maxRedemptions, expiresAt, firstTimeOnly, minAmount, name } = req.body;

        if (!code || !code.trim()) {
            return res.status(400).json({ error: 'Promo code is required' });
        }
        if (!discountType || !['percent', 'fixed'].includes(discountType)) {
            return res.status(400).json({ error: 'discountType must be "percent" or "fixed"' });
        }
        if (!discountValue || discountValue <= 0) {
            return res.status(400).json({ error: 'discountValue must be a positive number' });
        }
        if (discountType === 'percent' && discountValue > 100) {
            return res.status(400).json({ error: 'Percentage discount cannot exceed 100%' });
        }

        const result = await stripeService.createPromoCode({
            code: code.trim(),
            discountType,
            discountValue,
            currency,
            duration,
            durationMonths,
            maxRedemptions,
            expiresAt,
            firstTimeOnly: !!firstTimeOnly,
            minAmount,
            name,
        });

        await userStore.logSubscriptionAudit('create_promo_code', 'promo', result.promoCodeId, req.session.user?.id, null, { code: result.code, discountType, discountValue });

        res.json(result);
    } catch (err) {
        console.error('[Stripe] Create promo code error:', err);
        // Stripe returns useful error messages for duplicate codes etc.
        const msg = err.raw?.message || err.message || 'Failed to create promo code';
        res.status(err.statusCode || 500).json({ error: msg });
    }
});

// PUT /api/stripe/promo-codes/:id/deactivate — Deactivate a promo code
router.put('/promo-codes/:id/deactivate', requireCloud, requireAdmin, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe is not enabled' });

        await stripeService.deactivatePromoCode(req.params.id);
        await userStore.logSubscriptionAudit('deactivate_promo_code', 'promo', req.params.id, req.session.user?.id, null, {});
        res.json({ success: true });
    } catch (err) {
        console.error('[Stripe] Deactivate promo code error:', err);
        res.status(500).json({ error: err.message || 'Failed to deactivate promo code' });
    }
});

// PUT /api/stripe/promo-codes/:id/activate — Re-activate a promo code
router.put('/promo-codes/:id/activate', requireCloud, requireAdmin, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe is not enabled' });

        await stripeService.activatePromoCode(req.params.id);
        await userStore.logSubscriptionAudit('activate_promo_code', 'promo', req.params.id, req.session.user?.id, null, {});
        res.json({ success: true });
    } catch (err) {
        console.error('[Stripe] Activate promo code error:', err);
        res.status(500).json({ error: err.message || 'Failed to activate promo code' });
    }
});


module.exports = router;

