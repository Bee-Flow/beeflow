/**
 * Billing — read-only endpoints for any authenticated user.
 *
 * Distinct from /api/subscriptions/* (super-admin CRUD) and /api/stripe/*
 * (live Stripe lookup). This route returns the curated set of plans that
 * are public + enabled, formatted for the NC onboarding wizard and the
 * License & Usage upsell card. The wizard runs as an org-admin (not a
 * super-admin), so it can't hit /api/subscriptions/plans directly.
 */

const express = require('express');
const userStore = require('../stores/userStore');
const stripeService = require('../services/stripeService');
const { requireAuth } = require('../auth/permissions');

const router = express.Router();

router.get('/offered-plans', requireAuth, async (req, res) => {
    try {
        const all = await userStore.getAllPlans();
        const plans = all
            .filter(p => p.is_public && (p.plan_type || 'organization') === 'organization')
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
            .map(p => ({
                id: p.id,
                name: p.name,
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
            }));
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

module.exports = router;
