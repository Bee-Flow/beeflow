/**
 * Stripe Service — Centralized Stripe SDK wrapper
 * 
 * Lazy-initializes the Stripe client from encrypted config,
 * provides helpers for checkout, portal, product sync, and webhook verification.
 */

const configStore = require('../stores/configStore');

let _client = null;
let _lastKeyHash = null;

/**
 * Get or create a Stripe client instance.
 * Re-creates if the secret key has changed since last call.
 */
async function getClient() {
    const key = await configStore.getSecret('stripe_secret_key');
    if (!key) throw new Error('Stripe secret key not configured');

    // Simple hash to detect key changes without storing the key in memory
    const keyHash = Buffer.from(key).toString('base64').slice(0, 16);
    if (_client && _lastKeyHash === keyHash) return _client;

    const Stripe = require('stripe');
    _client = new Stripe(key, {
        apiVersion: '2024-12-18.acacia',
        appInfo: { name: 'BeeFlow', version: '1.0.0' },
    });
    _lastKeyHash = keyHash;
    return _client;
}

/**
 * Check if Stripe is enabled in the admin config.
 */
async function isEnabled() {
    try {
        const enabled = await configStore.getConfig('stripe_enabled');
        if (!enabled) return false;
        const key = await configStore.getSecret('stripe_secret_key');
        return !!key;
    } catch {
        return false;
    }
}

/**
 * Detect whether the configured key is a test mode key.
 */
async function isTestMode() {
    try {
        const key = await configStore.getSecret('stripe_secret_key');
        return key?.startsWith('sk_test_') || false;
    } catch {
        return false;
    }
}

/**
 * Sync a BeeFlow subscription plan to Stripe as a Product + Price.
 * Creates new or updates existing based on stripe_product_id.
 * 
 * @param {object} plan - The plan object from userStore.getPlan()
 * @returns {{ productId: string, priceId: string }}
 */
async function syncPlanToStripe(plan) {
    const stripe = await getClient();

    const productData = {
        name: plan.name,
        description: plan.description || `BeeFlow ${plan.name} Plan`,
        metadata: {
            beeflow_plan_id: plan.id,
            max_messages: String(plan.max_messages_per_month ?? -1),
            max_users: String(plan.max_users ?? -1),
            max_agents: String(plan.max_agents ?? -1),
        },
    };

    let product;
    if (plan.stripe_product_id) {
        // Update existing product
        try {
            product = await stripe.products.update(plan.stripe_product_id, productData);
        } catch (err) {
            if (err.code === 'resource_missing') {
                // Product was deleted in Stripe — create new
                product = await stripe.products.create(productData);
            } else {
                throw err;
            }
        }
    } else {
        product = await stripe.products.create(productData);
    }

    // Create new price (Stripe prices are immutable — always create new, archive old)
    const priceData = {
        product: product.id,
        currency: (plan.currency || 'eur').toLowerCase(),
        unit_amount: Math.round((plan.price || 0) * 100), // Convert to cents
        recurring: {
            interval: plan.billing_interval === 'yearly' ? 'year' : 'month',
        },
        metadata: { beeflow_plan_id: plan.id },
    };

    // Check for tax behavior
    const taxEnabled = await configStore.getConfig('stripe_tax_enabled');
    if (taxEnabled) {
        priceData.tax_behavior = 'exclusive';
    }

    const price = await stripe.prices.create(priceData);

    // Archive old price if it was different
    if (plan.stripe_price_id && plan.stripe_price_id !== price.id) {
        try {
            await stripe.prices.update(plan.stripe_price_id, { active: false });
        } catch {
            // Old price may already be archived — ignore
        }
    }

    // Set the new price as the product's default
    await stripe.products.update(product.id, { default_price: price.id });

    return { productId: product.id, priceId: price.id };
}

/**
 * Create a Stripe Checkout Session for a plan.
 * 
 * @param {object} options
 * @param {object} options.plan - BeeFlow plan object
 * @param {string} options.orgId - Organization ID
 * @param {string} options.orgName - Organization name
 * @param {string} options.userEmail - User email for pre-fill
 * @param {string} options.successUrl - Redirect URL on success
 * @param {string} options.cancelUrl - Redirect URL on cancel
 * @param {string} [options.stripeCustomerId] - Existing Stripe customer ID
 * @returns {object} Stripe Checkout Session
 */
async function createCheckoutSession({ plan, orgId, orgName, userEmail, successUrl, cancelUrl, stripeCustomerId }) {
    const stripe = await getClient();

    if (!plan.stripe_price_id) {
        throw new Error('Plan has not been synced to Stripe yet. Ask your administrator to sync the plan.');
    }

    const sessionParams = {
        mode: 'subscription',
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: orgId,
        metadata: {
            beeflow_org_id: orgId,
            beeflow_plan_id: plan.id,
        },
        subscription_data: {
            metadata: {
                beeflow_org_id: orgId,
                beeflow_plan_id: plan.id,
            },
        },
    };

    // Re-use existing customer or pre-fill email
    if (stripeCustomerId) {
        sessionParams.customer = stripeCustomerId;
    } else {
        sessionParams.customer_email = userEmail;
    }

    // Apply trial period if plan has trial days
    if (plan.trial_days && plan.trial_days > 0) {
        sessionParams.subscription_data.trial_period_days = plan.trial_days;
    }

    // Tax collection
    const taxEnabled = await configStore.getConfig('stripe_tax_enabled');
    if (taxEnabled) {
        sessionParams.automatic_tax = { enabled: true };
    }

    // Allow promo codes
    sessionParams.allow_promotion_codes = true;

    return stripe.checkout.sessions.create(sessionParams);
}

/**
 * Create a Stripe Customer Portal session for billing management.
 * 
 * @param {string} stripeCustomerId - Stripe customer ID
 * @param {string} returnUrl - URL to return to after portal
 * @returns {object} Portal session with url
 */
async function createPortalSession(stripeCustomerId, returnUrl) {
    const stripe = await getClient();
    return stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
    });
}

/**
 * Construct and verify a Stripe webhook event.
 * 
 * @param {Buffer} rawBody - Raw request body
 * @param {string} signature - Stripe-Signature header
 * @returns {object} Verified Stripe event
 */
async function constructWebhookEvent(rawBody, signature) {
    const stripe = await getClient();
    const secret = await configStore.getSecret('stripe_webhook_secret');
    if (!secret) throw new Error('Webhook signing secret not configured');
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

module.exports = {
    getClient,
    isEnabled,
    isTestMode,
    syncPlanToStripe,
    createCheckoutSession,
    createPortalSession,
    constructWebhookEvent,
};
