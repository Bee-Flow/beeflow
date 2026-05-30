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
    // Override via STRIPE_API_VERSION when validating a new Stripe API
    // version against staging before rolling it out everywhere.
    const apiVersion = process.env.STRIPE_API_VERSION || '2024-12-18.acacia';
    _client = new Stripe(key, {
        apiVersion,
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
 * Ensure the global PAYG Billing Meter exists. Used by every pay-as-you-go
 * Price as their `recurring.meter` reference. Idempotent — looks up the
 * cached ID from configStore first; if missing or stripe returns
 * `resource_missing`, creates a fresh one and caches both the meter id and
 * its event name so the runtime hot path (usageStore.logUsage) can post
 * meter events without an extra Stripe round-trip.
 */
async function ensurePaygMeter() {
    const stripe = await getClient();
    const cachedId = await configStore.getConfig('stripe_payg_meter_id');
    if (cachedId) {
        try { return await stripe.billing.meters.retrieve(cachedId); }
        catch (err) {
            if (err.code !== 'resource_missing') throw err;
            // fall through to recreate
        }
    }
    const meter = await stripe.billing.meters.create({
        display_name: 'BeeFlow PAYG usage',
        event_name: 'beeflow_payg_usage',
        default_aggregation: { formula: 'sum' },
        customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' },
        value_settings: { event_payload_key: 'value' },
    });
    await configStore.setConfig('stripe_payg_meter_id', meter.id);
    await configStore.setConfig('stripe_payg_meter_event_name', meter.event_name);
    return meter;
}

/**
 * Sync a PAYG (metered) plan to Stripe — parallel to syncPlanToStripe.
 * Creates / updates the Product, ensures the global meter, then creates a
 * metered Price priced at 1 micro-unit of the plan's currency per meter
 * unit. The caller (subscriptions.js) persists meterId / meterEventName
 * onto the plan row alongside stripe_product_id / stripe_price_id.
 */
async function syncPaygPlanToStripe(plan) {
    const stripe = await getClient();

    const productData = {
        name: plan.name,
        description: plan.description || `BeeFlow ${plan.name} Plan (Pay-as-you-go)`,
        metadata: {
            beeflow_plan_id: plan.id,
            beeflow_billing_model: 'metered',
            beeflow_markup_percent: String(plan.markup_percent ?? 0),
        },
    };

    let product;
    if (plan.stripe_product_id) {
        try {
            product = await stripe.products.update(plan.stripe_product_id, productData);
        } catch (err) {
            if (err.code === 'resource_missing') product = await stripe.products.create(productData);
            else throw err;
        }
    } else {
        product = await stripe.products.create(productData);
    }

    const meter = await ensurePaygMeter();

    const priceData = {
        product: product.id,
        currency: (plan.currency || 'eur').toLowerCase(),
        billing_scheme: 'per_unit',
        // 1 micro-unit of currency per meter unit. logUsage reports
        // marked-up cost * 1_000_000, so 1.00 EUR worth of usage = 1_000_000
        // meter units = 1.00 EUR billed.
        unit_amount_decimal: '0.000001',
        recurring: {
            interval: plan.billing_interval === 'yearly' ? 'year' : 'month',
            usage_type: 'metered',
            meter: meter.id,
        },
        metadata: { beeflow_plan_id: plan.id, beeflow_billing_model: 'metered' },
    };

    const taxEnabled = await configStore.getConfig('stripe_tax_enabled');
    if (taxEnabled) priceData.tax_behavior = 'exclusive';

    const price = await stripe.prices.create(priceData);

    // Archive the previous metered price if it differs.
    if (plan.stripe_price_id && plan.stripe_price_id !== price.id) {
        try { await stripe.prices.update(plan.stripe_price_id, { active: false }); }
        catch { /* already archived */ }
    }
    await stripe.products.update(product.id, { default_price: price.id });

    return { productId: product.id, priceId: price.id, meterId: meter.id, meterEventName: meter.event_name };
}

/**
 * Push a usage event to the PAYG meter. Called fire-and-forget from
 * usageStore.logUsage after each AI call.
 *
 * `amountMicroUnits` is the marked-up cost expressed in micro-units of the
 * plan's currency (cost * 1_000_000, rounded). `identifier` is the
 * ai_usage_log row id — Stripe uses it for 24h idempotency so accidental
 * double-fires don't double-bill.
 */
async function reportPaygUsage({ stripeCustomerId, amountMicroUnits, identifier, eventName }) {
    const stripe = await getClient();
    return stripe.billing.meterEvents.create({
        event_name: eventName,
        identifier,
        timestamp: Math.floor(Date.now() / 1000),
        payload: {
            stripe_customer_id: stripeCustomerId,
            value: String(amountMicroUnits),
        },
    });
}

/**
 * Create a Stripe Checkout Session for a plan.
 * Supports both organization and consumer subscriptions.
 * 
 * @param {object} options
 * @param {object} options.plan - BeeFlow plan object
 * @param {string} [options.orgId] - Organization ID (org checkout)
 * @param {string} [options.orgName] - Organization name (org checkout)
 * @param {string} [options.userId] - User ID (consumer checkout)
 * @param {string} [options.subscriberType] - 'organization' or 'consumer'
 * @param {string} options.userEmail - User email for pre-fill
 * @param {string} options.successUrl - Redirect URL on success
 * @param {string} options.cancelUrl - Redirect URL on cancel
 * @param {string} [options.stripeCustomerId] - Existing Stripe customer ID
 * @returns {object} Stripe Checkout Session
 */
// EU country code → Stripe tax_id `type` enum. The list covers every member
// state. Other types (gb_vat, ch_vat, etc.) are inferred similarly when we
// add support for those jurisdictions.
const EU_VAT_COUNTRIES = new Set([
    'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'GR', 'ES', 'FI',
    'FR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT',
    'RO', 'SE', 'SI', 'SK',
]);

/**
 * Normalise a user-entered VAT id and resolve the Stripe tax_id type that
 * matches it. Returns {type, value} on success, null when the value is
 * empty or doesn't look like a supported VAT id. Strips spaces and
 * separators, uppercases, and validates the country prefix.
 */
function resolveStripeTaxId(rawVat) {
    if (!rawVat || typeof rawVat !== 'string') return null;
    const cleaned = rawVat.replace(/[\s\-_.]/g, '').toUpperCase();
    if (cleaned.length < 4) return null;
    const country = cleaned.slice(0, 2);
    const body = cleaned.slice(2);
    if (!/^[A-Z0-9+*]{2,15}$/.test(body)) return null;
    if (EU_VAT_COUNTRIES.has(country)) return { type: 'eu_vat', value: cleaned };
    if (country === 'GB') return { type: 'gb_vat', value: cleaned };
    if (country === 'CH') return { type: 'ch_vat', value: cleaned };
    if (country === 'NO') return { type: 'no_vat', value: cleaned };
    return null;
}

// Anchor every new subscription's billing cycle to the 1st of next month
// (UTC). Stripe automatically pro-rates the partial period from "now" to
// the anchor, so the first invoice reflects only the days actually used —
// and every org/consumer renews on the same calendar day regardless of
// when they signed up.
function computeBillingCycleAnchor() {
    const now = new Date();
    return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
}

async function createCheckoutSession({ plan, orgId, orgName, userId, subscriberType = 'organization', userEmail, successUrl, cancelUrl, stripeCustomerId }) {
    const stripe = await getClient();

    if (!plan.stripe_price_id) {
        throw new Error('Plan has not been synced to Stripe yet. Ask your administrator to sync the plan.');
    }

    const isConsumer = subscriberType === 'consumer';

    // Build metadata based on subscriber type
    const metadata = {
        beeflow_plan_id: plan.id,
        beeflow_subscriber_type: subscriberType,
    };
    if (isConsumer) {
        metadata.beeflow_user_id = userId;
    } else {
        metadata.beeflow_org_id = orgId;
    }

    // Per-seat org plans bill `quantity = active seat count` so Stripe
    // pro-rates as the org grows or shrinks. Consumer plans always
    // bill quantity=1 (they have a single user by definition).
    let quantity = 1;
    if (plan.per_seat && !isConsumer && orgId) {
        try {
            const userStore = require('../stores/userStore');
            quantity = Math.max(1, await userStore.getActiveSeatCount(orgId));
        } catch (e) {
            console.warn('[Stripe] per-seat checkout: seat count lookup failed, defaulting to 1:', e.message);
        }
    }

    const sessionParams = {
        mode: 'subscription',
        line_items: [{ price: plan.stripe_price_id, quantity }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: isConsumer ? userId : orgId,
        metadata,
        subscription_data: { metadata },
    };

    // For org checkouts, pre-attach the org's stored VAT to a Stripe customer
    // so Stripe Tax can apply reverse charge (EU B2B) without making the
    // org-admin re-enter the number during checkout. We only build/upgrade
    // a customer when the VAT is parseable; otherwise we fall back to the
    // existing email/customer flow and Stripe will collect the VAT inline.
    let effectiveCustomerId = stripeCustomerId || null;
    if (!isConsumer && orgId) {
        try {
            const userStore = require('../stores/userStore');
            const org = await userStore.getOrganization(orgId);

            // Resolve ONE Stripe customer per org so repeated checkout attempts
            // (e.g. before the first one activates) don't mint duplicate
            // customers. Order: stored id → search by metadata.beeflow_org_id →
            // create. The result is persisted immediately so the next attempt
            // reuses it without depending on the (eventually-consistent) search
            // index or the activation webhook.
            if (!effectiveCustomerId) {
                try {
                    const found = await stripe.customers.search({
                        query: `metadata['beeflow_org_id']:'${orgId}'`,
                        limit: 1,
                    });
                    if (found?.data?.[0]?.id) effectiveCustomerId = found.data[0].id;
                } catch (e) {
                    // Search API unavailable or index lag — fall through to create.
                }
            }
            if (!effectiveCustomerId) {
                const created = await stripe.customers.create({
                    name: orgName || org?.name || undefined,
                    email: userEmail || org?.email || undefined,
                    metadata: { beeflow_org_id: orgId },
                });
                effectiveCustomerId = created.id;
            }
            if (effectiveCustomerId) {
                try { await userStore.setOrgSubscription(orgId, { stripe_customer_id: effectiveCustomerId }); }
                catch (e) { /* non-fatal — webhook will also persist it */ }
            }

            // Attach the org's VAT id (idempotent) so Stripe Tax can apply EU
            // reverse charge without the admin re-entering it. Non-fatal: the
            // checkout still proceeds and inline tax_id_collection covers it.
            const taxId = org ? resolveStripeTaxId(org.vat) : null;
            if (taxId && effectiveCustomerId) {
                try {
                    const existing = await stripe.customers.listTaxIds(effectiveCustomerId, { limit: 25 });
                    const already = (existing?.data || []).some(t => t.value === taxId.value && t.type === taxId.type);
                    if (!already) await stripe.customers.createTaxId(effectiveCustomerId, taxId);
                } catch (e) {
                    console.warn(`[Stripe] attaching VAT for org ${orgId} failed: ${e.message}`);
                }
            }
        } catch (e) {
            console.warn(`[Stripe] org customer resolution skipped: ${e.message}`);
        }
    }

    // Re-use existing customer (possibly just created above with VAT) or
    // pre-fill email so Stripe creates one at checkout time.
    if (effectiveCustomerId) {
        sessionParams.customer = effectiveCustomerId;
    } else {
        sessionParams.customer_email = userEmail;
    }

    // Apply trial period if plan has trial days
    if (plan.trial_days && plan.trial_days > 0) {
        sessionParams.subscription_data.trial_period_days = plan.trial_days;
    } else {
        // Anchor the billing cycle to a stable monthly date (1st of next
        // month UTC) so every paying subscription renews on the same day.
        // Stripe rejects billing_cycle_anchor together with
        // trial_period_days (the trial end IS the implicit anchor), so we
        // only set it when there's no trial. `create_prorations` makes
        // Stripe issue a partial-period charge between "now" and the
        // anchor — relevant for per-seat plans entering mid-cycle.
        sessionParams.subscription_data.billing_cycle_anchor = computeBillingCycleAnchor();
        sessionParams.subscription_data.proration_behavior = 'create_prorations';
    }

    // Tax collection
    const taxEnabled = await configStore.getConfig('stripe_tax_enabled');
    if (taxEnabled) {
        sessionParams.automatic_tax = { enabled: true };
        // Collect billing address so Stripe can calculate tax
        sessionParams.billing_address_collection = 'required';
        // Allow B2B customers to enter VAT numbers (covers customers we
        // didn't pre-attach a VAT for above).
        sessionParams.tax_id_collection = { enabled: true };
    }

    // Allow promo codes
    sessionParams.allow_promotion_codes = true;

    return stripe.checkout.sessions.create(sessionParams);
}

/**
 * Create a Stripe Subscription directly with a trial period, without
 * collecting a payment method up front. Used by the admin "Start Trial"
 * flow so trials can be granted to an org/user without making them
 * complete a Checkout first.
 *
 * If no payment method is added before the trial ends, Stripe will
 * auto-cancel the subscription (`missing_payment_method: 'cancel'`).
 *
 * @param {object} options
 * @param {object} options.plan - BeeFlow plan (must have stripe_price_id)
 * @param {'organization'|'consumer'} options.subscriberType
 * @param {string} options.subscriberId - org id or user id
 * @param {string} [options.orgName] - used as customer.name when org
 * @param {string} [options.userEmail] - used as customer.email
 * @param {string} [options.stripeCustomerId] - reuse if already exists
 * @param {number} options.trialDays
 * @returns {{ stripeCustomerId: string, stripeSubscriptionId: string, trialEnd: string|null, status: string }}
 */
async function createTrialSubscription({ plan, subscriberType, subscriberId, orgName, userEmail, stripeCustomerId, trialDays }) {
    const stripe = await getClient();

    if (!plan.stripe_price_id) {
        throw new Error('Plan has not been synced to Stripe yet. Sync the plan before starting a trial.');
    }
    if (!trialDays || trialDays <= 0) {
        throw new Error('Plan has no trial_days configured.');
    }

    const metadata = {
        beeflow_plan_id: plan.id,
        beeflow_subscriber_type: subscriberType,
    };
    if (subscriberType === 'consumer') metadata.beeflow_user_id = subscriberId;
    else metadata.beeflow_org_id = subscriberId;

    let customerId = stripeCustomerId || null;
    if (!customerId) {
        const customer = await stripe.customers.create({
            email: userEmail || undefined,
            name: orgName || undefined,
            metadata,
        });
        customerId = customer.id;
    }

    const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: plan.stripe_price_id }],
        trial_period_days: trialDays,
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata,
    });

    return {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id,
        trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
        status: subscription.status,
    };
}

/**
 * Create a Stripe Customer Portal session for billing management.
 * 
 * @param {string} stripeCustomerId - Stripe customer ID
 * @param {string} returnUrl - URL to return to after portal
 * @returns {object} Portal session with url
 */
/**
 * Synchronous lookup of a Stripe Checkout Session, expanding subscription +
 * customer so the caller can render post-checkout state without waiting
 * for the webhook. Used by GET /api/stripe/sessions/:id.
 */
async function retrieveCheckoutSession(sessionId) {
    const stripe = await getClient();
    return stripe.checkout.sessions.retrieve(sessionId, {
        expand: ['subscription', 'customer'],
    });
}

async function createPortalSession(stripeCustomerId, returnUrl) {
    const stripe = await getClient();
    return stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
    });
}

/**
 * For per-seat plans, push the org's current active seat count to Stripe so
 * the next invoice bills the right number of seats. Best-effort and silent:
 * if Stripe is disabled, the plan isn't per-seat, or no subscription exists,
 * this is a no-op. The subscription.updated webhook will echo the new
 * quantity back into stripe_seat_quantity on the local row.
 *
 * Call this after any local action that changes the user count (invite,
 * delete, suspend, NC group sync). Don't await it inside the user-creation
 * transaction — kick it off after commit so a Stripe outage can never block
 * a user being created.
 */
async function syncSeatQuantityForOrg(orgId) {
    if (!orgId) return;
    if (!(await isEnabled())) return;
    const userStore = require('../stores/userStore');
    const sub = await userStore.getOrgSubscription(orgId);
    if (!sub?.stripe_subscription_id) return;
    const plan = sub.plan_id ? await userStore.getPlan(sub.plan_id) : null;
    if (!plan?.per_seat) return;

    const stripe = await getClient();
    const quantity = Math.max(1, await userStore.getActiveSeatCount(orgId));

    try {
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        const item = stripeSub.items?.data?.[0];
        if (!item) {
            console.warn(`[Stripe] syncSeatQuantityForOrg org=${orgId} sub has no items`);
            return;
        }
        if (item.quantity === quantity) return; // already in sync
        await stripe.subscriptions.update(sub.stripe_subscription_id, {
            items: [{ id: item.id, quantity }],
            proration_behavior: 'create_prorations',
        });
        console.log(`[Stripe] seat quantity sync org=${orgId} ${item.quantity} → ${quantity}`);
    } catch (e) {
        console.warn(`[Stripe] syncSeatQuantityForOrg org=${orgId} failed: ${e.message}`);
    }
}

/**
 * Switch a subscription to a new price in-place. Used by the upgrade flow —
 * does NOT create a new checkout session. Pro-rates with `always_invoice` so
 * the customer is charged the partial-period difference immediately. The
 * existing billing_cycle_anchor is preserved so the next renewal lands on
 * the same day of month. `payment_behavior: error_if_incomplete` makes
 * Stripe reject the update outright if the proration invoice can't be
 * collected — better a clean 402 than a half-applied plan change.
 */
async function updateSubscriptionPlan({ stripeSubscriptionId, newPriceId, quantity = 1 }) {
    const stripe = await getClient();
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const item = sub.items?.data?.[0];
    if (!item) throw new Error(`Stripe subscription ${stripeSubscriptionId} has no items`);
    return stripe.subscriptions.update(stripeSubscriptionId, {
        items: [{ id: item.id, price: newPriceId, quantity: Math.max(1, quantity) }],
        proration_behavior: 'always_invoice',
        billing_cycle_anchor: 'unchanged',
        payment_behavior: 'error_if_incomplete',
    });
}

/**
 * Schedule the subscription to cancel at the end of the current period.
 * Status stays 'active' (or 'trialing') until cancel_at; the
 * customer.subscription.updated webhook mirrors the flag locally.
 */
async function cancelSubscriptionAtPeriodEnd(stripeSubscriptionId) {
    const stripe = await getClient();
    return stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: true });
}

/**
 * Undo a scheduled cancel. Only valid while the subscription is still
 * 'active' / 'trialing' and the period hasn't elapsed.
 */
async function reactivateSubscription(stripeSubscriptionId) {
    const stripe = await getClient();
    return stripe.subscriptions.update(stripeSubscriptionId, { cancel_at_period_end: false });
}

/**
 * Preview the cost impact of switching a subscription to a new price *now*.
 * Drives the in-app change-plan modal so the customer sees the prorated
 * charge before confirming. Returns the net proration (new-plan charge minus
 * unused-time credit for the old plan) in MAJOR currency units. Non-proration
 * lines (next period's base fee) are excluded so the figure reflects only
 * "what you pay today". Stripe SDK v22 → invoices.createPreview.
 */
async function previewPlanChange({ stripeSubscriptionId, newPriceId, quantity = 1 }) {
    const stripe = await getClient();
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const item = sub.items?.data?.[0];
    if (!item) throw new Error(`Stripe subscription ${stripeSubscriptionId} has no items`);
    const preview = await stripe.invoices.createPreview({
        subscription: stripeSubscriptionId,
        subscription_details: {
            items: [{ id: item.id, price: newPriceId, quantity: Math.max(1, quantity) }],
            proration_behavior: 'always_invoice',
        },
    });
    const prorationCents = (preview.lines?.data || [])
        .filter(l => l.proration)
        .reduce((sum, l) => sum + (l.amount || 0), 0);
    return {
        proration_amount: prorationCents / 100,
        currency: (preview.currency || item.price?.currency || 'eur').toUpperCase(),
    };
}

/**
 * Schedule a plan switch to take effect at the END of the current billing
 * period (used for downgrades — no mid-cycle refund/credit). Creates a Stripe
 * Subscription Schedule from the live subscription, keeps the current price as
 * phase 1 until period end, then starts the new price as phase 2.
 * end_behavior:'release' hands control back to a plain subscription once
 * phase 2 begins. Returns { scheduleId, effective }.
 */
async function scheduleDowngradeAtPeriodEnd({ stripeSubscriptionId, newPriceId, quantity = 1 }) {
    const stripe = await getClient();
    const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const item = sub.items?.data?.[0];
    if (!item) throw new Error(`Stripe subscription ${stripeSubscriptionId} has no items`);
    const qty = Math.max(1, quantity);

    // Reuse any schedule already governing this subscription; else create one.
    let scheduleId = sub.schedule;
    if (!scheduleId) {
        const created = await stripe.subscriptionSchedules.create({ from_subscription: stripeSubscriptionId });
        scheduleId = created.id;
    }
    const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    const currentPhase = schedule.phases?.[0];
    if (!currentPhase) throw new Error(`Schedule ${scheduleId} has no current phase`);
    const curItem = currentPhase.items?.[0] || {};
    const updated = await stripe.subscriptionSchedules.update(scheduleId, {
        end_behavior: 'release',
        phases: [
            {
                items: [{ price: curItem.price, quantity: curItem.quantity || qty }],
                start_date: currentPhase.start_date,
                end_date: currentPhase.end_date,
                proration_behavior: 'none',
            },
            {
                items: [{ price: newPriceId, quantity: qty }],
                proration_behavior: 'none',
            },
        ],
    });
    const effective = updated.phases?.[1]?.start_date || currentPhase.end_date || null;
    return { scheduleId, effective: effective ? new Date(effective * 1000).toISOString() : null };
}

/**
 * Release a subscription schedule (undo a pending downgrade), returning the
 * subscription to a normal month-to-month state at its current price.
 * Idempotent: a missing/already-released schedule is a no-op.
 */
async function releaseSubscriptionSchedule(scheduleId) {
    if (!scheduleId) return null;
    const stripe = await getClient();
    try {
        return await stripe.subscriptionSchedules.release(scheduleId);
    } catch (e) {
        console.warn(`[Stripe] releaseSubscriptionSchedule ${scheduleId} failed: ${e.message}`);
        return null;
    }
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


// ═══════════════════════════════════════════
//  Promotion / Discount Codes
// ═══════════════════════════════════════════

/**
 * Create a Stripe Coupon + Promotion Code.
 * 
 * Stripe model: Coupon (defines the discount) → Promotion Code (user-facing code).
 * 
 * @param {object} options
 * @param {string} options.code - The promo code string (e.g. "LAUNCH20")
 * @param {string} options.discountType - 'percent' or 'fixed'
 * @param {number} options.discountValue - Percentage (1-100) or amount in cents
 * @param {string} [options.currency] - Required for fixed amount (e.g. 'eur')
 * @param {string} [options.duration] - 'once', 'repeating', 'forever' (default 'once')
 * @param {number} [options.durationMonths] - Required when duration is 'repeating'
 * @param {number} [options.maxRedemptions] - Max number of times the code can be used
 * @param {string} [options.expiresAt] - ISO date string for expiration
 * @param {boolean} [options.firstTimeOnly] - Only allow first-time customers
 * @param {number} [options.minAmount] - Minimum order amount in cents
 * @param {string} [options.name] - Internal name/description
 * @returns {{ couponId: string, promoCodeId: string, code: string }}
 */
async function createPromoCode(options) {
    const stripe = await getClient();

    // 1. Create the Coupon (defines the discount)
    const couponParams = {
        duration: options.duration || 'once',
        name: options.name || `Promo: ${options.code}`,
        metadata: { beeflow_promo: 'true' },
    };

    if (options.discountType === 'percent') {
        couponParams.percent_off = options.discountValue;
    } else {
        couponParams.amount_off = options.discountValue;
        couponParams.currency = (options.currency || 'eur').toLowerCase();
    }

    if (options.duration === 'repeating' && options.durationMonths) {
        couponParams.duration_in_months = options.durationMonths;
    }

    const coupon = await stripe.coupons.create(couponParams);

    // 2. Create the Promotion Code (user-facing code string)
    const promoParams = {
        coupon: coupon.id,
        code: options.code.toUpperCase().replace(/\s+/g, ''),
        metadata: { beeflow_promo: 'true' },
    };

    if (options.maxRedemptions) {
        promoParams.max_redemptions = options.maxRedemptions;
    }

    if (options.expiresAt) {
        promoParams.expires_at = Math.floor(new Date(options.expiresAt).getTime() / 1000);
    }

    if (options.firstTimeOnly) {
        promoParams.restrictions = { first_time_transaction: true };
    }

    if (options.minAmount) {
        promoParams.restrictions = {
            ...(promoParams.restrictions || {}),
            minimum_amount: options.minAmount,
            minimum_amount_currency: (options.currency || 'eur').toLowerCase(),
        };
    }

    const promoCode = await stripe.promotionCodes.create(promoParams);

    return {
        couponId: coupon.id,
        promoCodeId: promoCode.id,
        code: promoCode.code,
    };
}

/**
 * List all BeeFlow-created promotion codes from Stripe.
 * @param {number} [limit=25] - Max codes to return
 * @returns {Array} Promotion code objects
 */
async function listPromoCodes(limit = 25) {
    const stripe = await getClient();

    const result = await stripe.promotionCodes.list({
        limit,
        expand: ['data.coupon'],
    });

    return result.data.map(pc => ({
        id: pc.id,
        code: pc.code,
        active: pc.active,
        couponId: pc.coupon?.id,
        discountType: pc.coupon?.percent_off ? 'percent' : 'fixed',
        discountValue: pc.coupon?.percent_off || pc.coupon?.amount_off,
        currency: pc.coupon?.currency || 'eur',
        duration: pc.coupon?.duration,
        durationMonths: pc.coupon?.duration_in_months,
        maxRedemptions: pc.max_redemptions,
        timesRedeemed: pc.times_redeemed,
        expiresAt: pc.expires_at ? new Date(pc.expires_at * 1000).toISOString() : null,
        firstTimeOnly: pc.restrictions?.first_time_transaction || false,
        minAmount: pc.restrictions?.minimum_amount || null,
        name: pc.coupon?.name || '',
        created: new Date(pc.created * 1000).toISOString(),
    }));
}

/**
 * Deactivate a promotion code (cannot be deleted, only deactivated).
 * @param {string} promoCodeId - Stripe promotion code ID
 */
async function deactivatePromoCode(promoCodeId) {
    const stripe = await getClient();
    return stripe.promotionCodes.update(promoCodeId, { active: false });
}

/**
 * Re-activate a previously deactivated promotion code.
 * @param {string} promoCodeId - Stripe promotion code ID
 */
async function activatePromoCode(promoCodeId) {
    const stripe = await getClient();
    return stripe.promotionCodes.update(promoCodeId, { active: true });
}

module.exports = {
    getClient,
    isEnabled,
    isTestMode,
    syncPlanToStripe,
    ensurePaygMeter,
    syncPaygPlanToStripe,
    reportPaygUsage,
    createCheckoutSession,
    createTrialSubscription,
    createPortalSession,
    retrieveCheckoutSession,
    syncSeatQuantityForOrg,
    updateSubscriptionPlan,
    previewPlanChange,
    scheduleDowngradeAtPeriodEnd,
    releaseSubscriptionSchedule,
    cancelSubscriptionAtPeriodEnd,
    reactivateSubscription,
    constructWebhookEvent,
    createPromoCode,
    listPromoCodes,
    deactivatePromoCode,
    activatePromoCode,
};
