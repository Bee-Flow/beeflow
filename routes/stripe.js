/**
 * Stripe API Routes — Checkout, Portal, Webhooks, and public plan listing
 * 
 * POST /api/stripe/checkout   — Create Stripe Checkout session (authenticated)
 * POST /api/stripe/portal     — Create Stripe Customer Portal session (authenticated)
 * POST /api/stripe/webhook    — Handle Stripe webhook events (no auth, signature verified)
 * GET  /api/stripe/plans      — List public plans with prices (authenticated)
 * GET  /api/stripe/status     — Check Stripe configuration status (authenticated)
 */

const express = require('express');
const stripeService = require('../services/stripeService');
const userStore = require('../stores/userStore');
const usageStore = require('../stores/usageStore');

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

router.get('/plans', requireAuth, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.json([]);

        const allPlans = await userStore.getAllPlans();
        const publicPlans = allPlans
            .filter(p => p.is_public && p.price > 0 && p.name !== '__consumer_default__')
            .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
            .map(p => ({
                id: p.id,
                name: p.name,
                description: p.description,
                price: p.price,
                currency: p.currency || 'eur',
                billing_interval: p.billing_interval || 'monthly',
                trial_days: p.trial_days || 0,
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

router.post('/checkout', requireAuth, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe payments are not enabled' });

        const { planId } = req.body;
        if (!planId) return res.status(400).json({ error: 'planId is required' });

        const user = req.session.user;
        const orgId = user?.organizationId || user?.orgId;
        if (!orgId) return res.status(400).json({ error: 'You must belong to an organization to subscribe' });

        // Get the plan
        const plan = await userStore.getPlan(planId);
        if (!plan) return res.status(404).json({ error: 'Plan not found' });
        if (!plan.stripe_price_id) {
            return res.status(400).json({ error: 'This plan has not been configured for payment yet. Contact your administrator.' });
        }

        // Check if org already has an active Stripe subscription
        const existingSub = await userStore.getOrgSubscription(orgId);
        const stripeCustomerId = existingSub?.stripe_customer_id || null;

        // Build return URLs
        const origin = req.body.origin || getOrigin(req);
        const successUrl = `${origin}/app/settings?tab=license&checkout=success&session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${origin}/app/settings?tab=license&checkout=cancelled`;

        // Get org name for Stripe metadata
        const orgs = await userStore.listOrganizations();
        const org = orgs.find(o => o.id === orgId);

        const session = await stripeService.createCheckoutSession({
            plan,
            orgId,
            orgName: org?.name || 'Organization',
            userEmail: user.email,
            successUrl,
            cancelUrl,
            stripeCustomerId,
        });

        res.json({ url: session.url, sessionId: session.id });
    } catch (err) {
        console.error('[Stripe] Checkout error:', err);
        res.status(500).json({ error: err.message || 'Failed to create checkout session' });
    }
});

// ── POST /portal — Create a Stripe Customer Portal Session ───────────────────

router.post('/portal', requireAuth, async (req, res) => {
    try {
        const enabled = await stripeService.isEnabled();
        if (!enabled) return res.status(400).json({ error: 'Stripe payments are not enabled' });

        const user = req.session.user;
        const orgId = user?.organizationId || user?.orgId;
        if (!orgId) return res.status(400).json({ error: 'No organization found' });

        const sub = await userStore.getOrgSubscription(orgId);
        if (!sub?.stripe_customer_id) {
            return res.status(400).json({ error: 'No billing account found. Subscribe to a plan first.' });
        }

        const origin = req.body.origin || getOrigin(req);
        const returnUrl = `${origin}/app/settings?tab=license`;

        const session = await stripeService.createPortalSession(sub.stripe_customer_id, returnUrl);
        res.json({ url: session.url });
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
 * checkout.session.completed — User finished paying
 * Assigns the subscription to the org in BeeFlow.
 */
async function handleCheckoutCompleted(session) {
    const orgId = session.metadata?.beeflow_org_id || session.client_reference_id;
    const planId = session.metadata?.beeflow_plan_id;

    if (!orgId) {
        console.error('[Stripe Webhook] checkout.session.completed missing org ID');
        return;
    }

    console.log(`[Stripe Webhook] Checkout completed for org ${orgId}, plan ${planId}`);

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

    const success = await userStore.setOrgSubscription(orgId, subData);
    if (success) {
        // Audit log
        await userStore.addAuditLog({
            action: 'assign_subscription',
            target_type: 'organization',
            target_id: orgId,
            changed_by: 'stripe_webhook',
            new_values: { plan_id: planId, stripe_subscription_id: session.subscription, payment_status: 'paid' },
        });
        console.log(`[Stripe Webhook] ✓ Subscription assigned to org ${orgId}`);
    } else {
        console.error(`[Stripe Webhook] ✗ Failed to assign subscription to org ${orgId}`);
    }
}

/**
 * customer.subscription.updated — Plan change, trial ending, status change
 */
async function handleSubscriptionUpdated(subscription) {
    const orgId = subscription.metadata?.beeflow_org_id;
    if (!orgId) {
        console.warn('[Stripe Webhook] subscription.updated missing beeflow_org_id metadata');
        return;
    }

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

    const success = await userStore.setOrgSubscription(orgId, updateData);

    await userStore.addAuditLog({
        action: 'update_subscription',
        target_type: 'organization',
        target_id: orgId,
        changed_by: 'stripe_webhook',
        new_values: { stripe_status: subscription.status, beeflow_status: updateData.status },
    });

    console.log(`[Stripe Webhook] Subscription updated for org ${orgId}: ${subscription.status} → ${updateData.status}`);
}

/**
 * customer.subscription.deleted — Subscription cancelled or expired
 */
async function handleSubscriptionDeleted(subscription) {
    const orgId = subscription.metadata?.beeflow_org_id;
    if (!orgId) {
        // Try to find org by stripe_subscription_id
        const allSubs = await userStore.getAllOrgSubscriptions();
        const match = allSubs.find(s => s.stripe_subscription_id === subscription.id);
        if (match) {
            await handleSubscriptionDeletedForOrg(match.organization_id, subscription);
        } else {
            console.warn('[Stripe Webhook] subscription.deleted — could not find matching org');
        }
        return;
    }
    await handleSubscriptionDeletedForOrg(orgId, subscription);
}

async function handleSubscriptionDeletedForOrg(orgId, subscription) {
    await userStore.setOrgSubscription(orgId, {
        status: 'cancelled',
        payment_status: 'cancelled',
    });

    await userStore.addAuditLog({
        action: 'update_subscription',
        target_type: 'organization',
        target_id: orgId,
        changed_by: 'stripe_webhook',
        new_values: { status: 'cancelled', reason: 'stripe_subscription_deleted' },
    });

    console.log(`[Stripe Webhook] Subscription cancelled for org ${orgId}`);
}

/**
 * invoice.paid — Payment succeeded
 */
async function handleInvoicePaid(invoice) {
    const subId = invoice.subscription;
    if (!subId) return;

    const allSubs = await userStore.getAllOrgSubscriptions();
    const match = allSubs.find(s => s.stripe_subscription_id === subId);
    if (!match) return;

    await userStore.setOrgSubscription(match.organization_id, {
        status: 'active',
        payment_status: 'paid',
    });

    console.log(`[Stripe Webhook] Invoice paid for org ${match.organization_id}`);
}

/**
 * invoice.payment_failed — Payment failed
 */
async function handleInvoicePaymentFailed(invoice) {
    const subId = invoice.subscription;
    if (!subId) return;

    const allSubs = await userStore.getAllOrgSubscriptions();
    const match = allSubs.find(s => s.stripe_subscription_id === subId);
    if (!match) return;

    await userStore.setOrgSubscription(match.organization_id, {
        payment_status: 'failed',
    });

    await userStore.addAuditLog({
        action: 'update_subscription',
        target_type: 'organization',
        target_id: match.organization_id,
        changed_by: 'stripe_webhook',
        new_values: { payment_status: 'failed', invoice_id: invoice.id },
    });

    console.log(`[Stripe Webhook] Payment failed for org ${match.organization_id}`);
}


module.exports = router;
