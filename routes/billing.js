/**
 * Billing — read-only plan endpoints.
 *
 * Distinct from /api/subscriptions/* (super-admin CRUD) and /api/stripe/*
 * (live Stripe lookup). Two surfaces share the same projection:
 *
 *   GET /api/billing/offered-plans   — authenticated. Used by the NC
 *     onboarding wizard and the License & Usage upsell card. Org-admins
 *     run these flows and can't hit /api/subscriptions/plans (super-admin
 *     only), so they go through this route instead.
 *
 *   GET /api/billing/public-plans    — unauthenticated. Feeds the public
 *     /pricing page on beeflow.ai. Same filter as offered-plans (public
 *     organization plans), same field projection. No auth so Google's
 *     OAuth verifier and any visitor can read it.
 */

const express = require('express');
const userStore = require('../stores/userStore');
const stripeService = require('../services/stripeService');
const { requireAuth } = require('../auth/permissions');

const router = express.Router();

// Single source of truth for what fields each plan row exposes to the
// world. Keep this list strict — anything not mapped here is invisible
// to both the authenticated wizard and the public pricing page.
function toPublicPlan(p) {
    return {
        id: p.id,
        name: p.name,
        planType: p.plan_type || 'organization',
        tagline: p.tagline || null,
        description: p.description || '',
        price: p.price ?? null,
        currency: p.currency || 'EUR',
        billingInterval: p.billing_interval || 'monthly',
        trialDays: p.trial_days ?? 0,
        allowedFeatures: p.allowed_features || [],
        maxUsers: p.max_users ?? null,
        maxAgents: p.max_agents ?? null,
        maxMessagesPerMonth: p.max_messages_per_month ?? null,
        maxKnowledgeSources: p.max_knowledge_sources ?? null,
        isDefault: !!p.is_default,
        ncRecommended: !!p.nc_recommended,
        stripePriceId: p.stripe_price_id || null,
    };
}

// Lists every public plan, optionally narrowed by plan_type. Pass
// `{ types: ['organization'] }` for the in-app org-onboarding flow, or
// no options for the public pricing page (which shows both org and
// consumer plans).
async function listPublicPlans({ types } = {}) {
    const all = await userStore.getAllPlans();
    return all
        .filter(p => p.is_public)
        .filter(p => !types || types.includes(p.plan_type || 'organization'))
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map(toPublicPlan);
}

router.get('/offered-plans', requireAuth, async (req, res) => {
    try {
        // NC onboarding only sets up organisations, so this route stays
        // org-only to avoid surfacing consumer plans in the wizard.
        const plans = await listPublicPlans({ types: ['organization'] });
        // Stripe enablement is determined by configStore (the encrypted
        // secret store) — not env. stripeService.isEnabled() is the source
        // of truth that POST /api/stripe/checkout actually uses.
        const stripeEnabled = await stripeService.isEnabled().catch(() => false);
        res.json({ plans, stripeEnabled });
    } catch (e) {
        console.error('[Billing] offered-plans error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.get('/public-plans', async (req, res) => {
    try {
        // Public pricing page shows everything the admin has flagged
        // is_public — both organisation and consumer plans. The client
        // groups them by planType for display.
        const plans = await listPublicPlans();
        const stripeEnabled = await stripeService.isEnabled().catch(() => false);
        // Short cache so a traffic spike on /pricing doesn't pound the DB,
        // but still picks up an admin's publish-toggle change within a minute.
        res.set('Cache-Control', 'public, max-age=60');
        res.json({ plans, stripeEnabled });
    } catch (e) {
        console.error('[Billing] public-plans error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
