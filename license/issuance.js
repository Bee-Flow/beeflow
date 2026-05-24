/**
 * License Issuance — Outbound callout to license.beeflow.nl
 *
 * Called from the Stripe webhook (checkout.session.completed) to ask the
 * Beeflow license server to mint a signed JWT for the freshly-paid
 * subscription. The token is then stored locally and the user is notified
 * (currently: console + audit log; email integration is out of scope here).
 *
 * The license server is responsible for:
 *   - validating the Stripe subscription against its own records
 *   - signing a JWT with the Beeflow private key
 *   - returning { token, license_id } in the response body
 *
 * Failures are non-fatal — the Stripe subscription is already recorded, so
 * the user can manually paste the key from a follow-up email if this
 * callout fails.
 */

const fetch = require('node-fetch');
const license = require('./index');

const ISSUE_URL = process.env.LICENSE_ISSUE_URL || 'https://license.beeflow.nl/v1/issue';
const ISSUE_API_KEY = process.env.LICENSE_ISSUE_API_KEY || '';
const ISSUE_TIMEOUT_MS = parseInt(process.env.LICENSE_ISSUE_TIMEOUT_MS || '15000', 10);

/**
 * Request a license JWT for a Stripe checkout that just completed.
 *
 * @param {Object} args
 * @param {'organization' | 'consumer'} args.scope
 * @param {string} [args.organizationId]
 * @param {string} [args.userId]
 * @param {string} args.planId        - internal Beeflow plan id (or stripe price id)
 * @param {string} args.tier          - 'enterprise' | 'full' (community is free, no key). Legacy 'pro' is also accepted and minted as enterprise.
 * @param {string} args.stripeCustomerId
 * @param {string} args.stripeSubscriptionId
 * @returns {Promise<{ token: string, licenseId: string } | null>}
 */
async function issueLicenseFromCheckout(args) {
    if (!ISSUE_URL) return null;
    if (!args.tier || args.tier === 'community') return null;

    const payload = {
        scope: args.scope,
        organization_id: args.organizationId || null,
        user_id: args.userId || null,
        plan_id: args.planId || null,
        tier: args.tier,
        stripe_customer_id: args.stripeCustomerId || null,
        stripe_subscription_id: args.stripeSubscriptionId || null,
    };

    let resp, body;
    try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), ISSUE_TIMEOUT_MS);
        try {
            resp = await fetch(ISSUE_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    ...(ISSUE_API_KEY ? { 'X-API-Key': ISSUE_API_KEY } : {}),
                },
                body: JSON.stringify(payload),
                signal: ctrl.signal,
            });
        } finally {
            clearTimeout(timeout);
        }
        body = await resp.json().catch(() => ({}));
    } catch (e) {
        console.error('[License Issuance] callout failed:', e.message);
        const err = new Error(`callout_failed: ${e.message}`);
        err.code = 'callout_failed';
        throw err;
    }

    if (!resp.ok || !body.token || !body.license_id) {
        console.error('[License Issuance] license server returned error', resp.status, body);
        const err = new Error(`license_server_error: status=${resp.status}`);
        err.code = 'license_server_error';
        err.httpStatus = resp.status;
        err.responseBody = body;
        throw err;
    }

    // Activate locally so the user gets immediate access without manual paste.
    try {
        await license.activateLicense({
            token: body.token,
            organizationId: args.scope === 'organization' ? args.organizationId : null,
            userId: args.scope === 'consumer' ? args.userId : null,
            activatedBy: 'stripe_webhook',
        });
        console.log(`[License Issuance] ✓ Activated license ${body.license_id} for ${args.scope}=${args.organizationId || args.userId}`);
    } catch (e) {
        console.error('[License Issuance] verifyToken/activateLicense failed:', e.message);
        const err = new Error(`activation_failed: ${e.message}`);
        err.code = 'activation_failed';
        err.licenseId = body.license_id;
        throw err;
    }

    return { token: body.token, licenseId: body.license_id };
}

/**
 * Map an internal plan name to the tier it grants. Used by the Stripe
 * webhook to know what tier to ask the license server for. Customise if
 * you have plan_type variants.
 */
function tierFromPlanName(planName) {
    if (!planName) return null;
    const n = String(planName).toLowerCase();
    if (n.includes('enterprise')) return 'enterprise';
    if (n.includes('pro')) return 'pro';
    if (n.includes('community') || n === '__consumer_default__') return 'community';
    return null;
}

module.exports = { issueLicenseFromCheckout, tierFromPlanName };
