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

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
    if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

function getOrigin(req) {
    return `${req.protocol}://${req.get('host')}`;
}

// ── GET /status — Check if Stripe is configured and enabled ──────────────────

router.get('/status', requireAuth, async (req, res) => {
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

router.get('/plans', requireAuth, async (req, res) => {
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

router.post('/checkout', requireAuth, async (req, res) => {
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

        const origin = req.body.origin || getOrigin(req);

        if (isConsumer) {
            // ── Consumer Checkout ──
            const existingSub = await userStore.getConsumerSubscription(user.id);
            const stripeCustomerId = existingSub?.stripe_customer_id || null;

            const successUrl = `${origin}/app/settings?tab=consumer_license&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
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

            const successUrl = `${origin}/app/settings?tab=license&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
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

router.post('/portal', requireAuth, async (req, res) => {
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

    console.log(`[Stripe Webhook] Received event: ${event.type} (${event.id})`);

    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutCompleted(event.data.object);
                break;

            case 'customer.subscription.updated':
                await handleSubscriptionUpdated(event.data.object);
                break;

            case 'customer.subscription.deleted':
                await handleSubscriptionDeleted(event.data.object);
                break;

            case 'invoice.paid':
                await handleInvoicePaid(event.data.object);
                break;

            case 'invoice.payment_failed':
                await handleInvoicePaymentFailed(event.data.object);
                break;

            default:
                console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
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
        } else {
            console.error(`[Stripe Webhook] ✗ Failed to assign consumer subscription to user ${userId}`);
        }
    } else {
        const orgId = session.metadata?.beeflow_org_id || session.client_reference_id;
        if (!orgId) {
            console.error('[Stripe Webhook] checkout.session.completed (org) missing org ID');
            return;
        }
        console.log(`[Stripe Webhook] Org checkout completed for org ${orgId}, plan ${planId}`);
        const success = await userStore.setOrgSubscription(orgId, subData);
        if (success) {
            await userStore.logSubscriptionAudit('assign_subscription', 'organization', orgId, 'stripe_webhook', null, { plan_id: planId, stripe_subscription_id: session.subscription, payment_status: 'paid' });
            console.log(`[Stripe Webhook] ✓ Subscription assigned to org ${orgId}`);
        } else {
            console.error(`[Stripe Webhook] ✗ Failed to assign subscription to org ${orgId}`);
        }
    }
}

/**
 * customer.subscription.updated — Plan change, trial ending, status change
 */
async function handleSubscriptionUpdated(subscription) {
    const subscriberType = getSubscriberType(subscription.metadata);

    const statusMap = {
        active: 'active',
        past_due: 'active', // Keep active but flag payment status
        trialing: 'active',
        paused: 'suspended',
        incomplete: 'active',
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

    // If plan changed, try to find the matching BeeFlow plan
    const priceId = subscription.items?.data?.[0]?.price?.id;
    if (priceId) {
        const allPlans = await userStore.getAllPlans();
        const matchingPlan = allPlans.find(p => p.stripe_price_id === priceId);
        if (matchingPlan) {
            updateData.plan_id = matchingPlan.id;
        }
    }

    // Trial end date
    if (subscription.trial_end) {
        updateData.trial_end_date = new Date(subscription.trial_end * 1000).toISOString();
    }

    if (subscriberType === 'consumer') {
        const userId = subscription.metadata?.beeflow_user_id;
        if (!userId) {
            console.warn('[Stripe Webhook] subscription.updated (consumer) missing beeflow_user_id');
            return;
        }
        await userStore.setConsumerSubscription(userId, updateData);
        await userStore.logSubscriptionAudit('update_subscription', 'consumer', userId, 'stripe_webhook', null, { stripe_status: subscription.status, beeflow_status: updateData.status });
        console.log(`[Stripe Webhook] Consumer subscription updated for user ${userId}: ${subscription.status} → ${updateData.status}`);
    } else {
        const orgId = subscription.metadata?.beeflow_org_id;
        if (!orgId) {
            console.warn('[Stripe Webhook] subscription.updated (org) missing beeflow_org_id');
            return;
        }
        await userStore.setOrgSubscription(orgId, updateData);
        await userStore.logSubscriptionAudit('update_subscription', 'organization', orgId, 'stripe_webhook', null, { stripe_status: subscription.status, beeflow_status: updateData.status });
        console.log(`[Stripe Webhook] Subscription updated for org ${orgId}: ${subscription.status} → ${updateData.status}`);
    }
}

/**
 * customer.subscription.deleted — Subscription cancelled or expired
 */
async function handleSubscriptionDeleted(subscription) {
    const subscriberType = getSubscriberType(subscription.metadata);

    if (subscriberType === 'consumer') {
        const userId = subscription.metadata?.beeflow_user_id;
        if (userId) {
            await handleSubscriptionDeletedForConsumer(userId, subscription);
        } else {
            // Fallback: search consumer_subscriptions by stripe_subscription_id
            const allSubs = await userStore.getAllConsumerSubscriptions();
            const match = allSubs.find(s => s.stripe_subscription_id === subscription.id);
            if (match) {
                await handleSubscriptionDeletedForConsumer(match.user_id, subscription);
            } else {
                console.warn('[Stripe Webhook] subscription.deleted (consumer) — could not find matching user');
            }
        }
    } else {
        const orgId = subscription.metadata?.beeflow_org_id;
        if (orgId) {
            await handleSubscriptionDeletedForOrg(orgId, subscription);
        } else {
            // Fallback: search org_subscriptions by stripe_subscription_id
            const allSubs = await userStore.getAllOrgSubscriptions();
            const match = allSubs.find(s => s.stripe_subscription_id === subscription.id);
            if (match) {
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
 * invoice.paid — Payment succeeded
 */
async function handleInvoicePaid(invoice) {
    const subId = invoice.subscription;
    if (!subId) return;

    // Check org subscriptions first, then consumer
    const allOrgSubs = await userStore.getAllOrgSubscriptions();
    const orgMatch = allOrgSubs.find(s => s.stripe_subscription_id === subId);
    if (orgMatch) {
        await userStore.setOrgSubscription(orgMatch.organization_id, { status: 'active', payment_status: 'paid' });
        console.log(`[Stripe Webhook] Invoice paid for org ${orgMatch.organization_id}`);
        return;
    }

    const allConsumerSubs = await userStore.getAllConsumerSubscriptions();
    const consumerMatch = allConsumerSubs.find(s => s.stripe_subscription_id === subId);
    if (consumerMatch) {
        await userStore.setConsumerSubscription(consumerMatch.user_id, { status: 'active', payment_status: 'paid' });
        console.log(`[Stripe Webhook] Invoice paid for consumer ${consumerMatch.user_id}`);
    }
}

/**
 * invoice.payment_failed — Payment failed
 */
async function handleInvoicePaymentFailed(invoice) {
    const subId = invoice.subscription;
    if (!subId) return;

    // Check org subscriptions first, then consumer
    const allOrgSubs = await userStore.getAllOrgSubscriptions();
    const orgMatch = allOrgSubs.find(s => s.stripe_subscription_id === subId);
    if (orgMatch) {
        await userStore.setOrgSubscription(orgMatch.organization_id, { payment_status: 'failed' });
        await userStore.logSubscriptionAudit('update_subscription', 'organization', orgMatch.organization_id, 'stripe_webhook', null, { payment_status: 'failed', invoice_id: invoice.id });
        console.log(`[Stripe Webhook] Payment failed for org ${orgMatch.organization_id}`);
        return;
    }

    const allConsumerSubs = await userStore.getAllConsumerSubscriptions();
    const consumerMatch = allConsumerSubs.find(s => s.stripe_subscription_id === subId);
    if (consumerMatch) {
        await userStore.setConsumerSubscription(consumerMatch.user_id, { payment_status: 'failed' });
        await userStore.logSubscriptionAudit('update_subscription', 'consumer', consumerMatch.user_id, 'stripe_webhook', null, { payment_status: 'failed', invoice_id: invoice.id });
        console.log(`[Stripe Webhook] Payment failed for consumer ${consumerMatch.user_id}`);
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
router.get('/promo-codes', requireAdmin, async (req, res) => {
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
router.post('/promo-codes', requireAdmin, async (req, res) => {
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
router.put('/promo-codes/:id/deactivate', requireAdmin, async (req, res) => {
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
router.put('/promo-codes/:id/activate', requireAdmin, async (req, res) => {
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

