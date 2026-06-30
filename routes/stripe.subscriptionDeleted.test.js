/**
 * BFSF-226 — Stripe `customer.subscription.deleted` org decision.
 *
 * The webhook now downgrades NEVER-PAID orgs to the capped Free plan instead of
 * cancelling them; orgs that have actually paid (payment_status === 'paid') keep
 * the `cancelled` state. We drive the REAL Express router (POST /webhook) with a
 * stubbed req/res — no HTTP listener, no DB — exactly like
 * routes/automation.ratelimit.test.js.
 *
 * The webhook only depends on two module-level requires: ../services/stripeService
 * (constructWebhookEvent → crafted event) and ../stores/userStore (recordStripe-
 * EventProcessed for dedup, getAll*Subscriptions for metadata verification, plus
 * the spies we assert on). The /webhook route carries no auth/cloud/limiter
 * middleware, so the only seam we must satisfy is dedup + metadata verification:
 *   - recordStripeEventProcessed → true  (first delivery, not a replay)
 *   - getAll{Org,Consumer}Subscriptions → []  ⇒ findSubscriptionTargetBySubId
 *     returns null ⇒ verifyMetadataMatchesLocal returns { ok: true }.
 *
 * Run: cd server && node --test routes/stripe.subscriptionDeleted.test.js
 */

const assert = require('assert');
const { test } = require('node:test');

// ── Spy state, reset per test ───────────────────────────────────────────────
let orgSubFixture = null;        // what getOrgSubscription returns
const downgradeCalls = [];       // downgradeOrgToFreePlan(orgId, opts)
const setOrgCalls = [];          // setOrgSubscription(orgId, data)
const auditCalls = [];           // logSubscriptionAudit(action, ...)

function resetSpies() {
    orgSubFixture = null;
    downgradeCalls.length = 0;
    setOrgCalls.length = 0;
    auditCalls.length = 0;
}

// ── Stub module-level deps of routes/stripe.js (require-cache trick) ─────────
function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../services/stripeService', {
    // The webhook calls this with (req.body, signature). We ignore both and
    // hand back whatever the current test queued via `nextEvent`.
    constructWebhookEvent: async () => nextEvent,
    getClient: async () => { throw new Error('getClient should not be called on subscription.deleted'); },
});

stub('../stores/userStore', {
    // Dedup gate: returning true means "first delivery", so the handler runs.
    recordStripeEventProcessed: async () => true,
    // Metadata verification: empty arrays ⇒ no local target by sub-id ⇒ ok:true.
    getAllOrgSubscriptions: async () => [],
    getAllConsumerSubscriptions: async () => [],
    // Decision inputs + spies.
    getOrgSubscription: async () => orgSubFixture,
    downgradeOrgToFreePlan: async (orgId, opts) => { downgradeCalls.push({ orgId, opts }); return { id: 'sub', plan_id: 'free-plan' }; },
    setOrgSubscription: async (orgId, data) => { setOrgCalls.push({ orgId, data }); return true; },
    logSubscriptionAudit: async (action, targetType, targetId, changedBy, oldV, newV) => { auditCalls.push({ action, targetType, targetId, changedBy, newV }); },
});

let nextEvent = null; // set per test before dispatch()

const router = require('./stripe');

// ── Dispatch harness (mirrors automation.ratelimit.test.js) ─────────────────
function dispatch({ headers = {}, body = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST',
            url: '/webhook',
            ip: '203.0.113.9',
            headers,
            body,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            headers: {},
            body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            getHeader(k) { return this.headers[String(k).toLowerCase()]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error('fell through router: POST /webhook')));
    });
}

function deletedEvent(orgMetadataSub) {
    return {
        id: `evt_${Math.random().toString(36).slice(2)}`,
        type: 'customer.subscription.deleted',
        data: { object: orgMetadataSub },
    };
}

// A subscription object whose metadata claims org_1 (organization subscriber).
function orgSub(extra = {}) {
    return {
        id: 'sub_1',
        metadata: { beeflow_org_id: 'org_1' },
        ...extra,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// Never-paid org → downgrade to Free, NOT cancelled
// ═══════════════════════════════════════════════════════════════════════════

test('never-paid org subscription.deleted downgrades to Free (no cancel)', async () => {
    resetSpies();
    orgSubFixture = { organization_id: 'org_1', payment_status: 'trialing', status: 'trialing' };
    nextEvent = deletedEvent(orgSub());

    const res = await dispatch({ headers: { 'stripe-signature': 'sig_test' } });

    assert.strictEqual(res.statusCode, 200, 'webhook acks 200');
    assert.strictEqual(downgradeCalls.length, 1, 'downgradeOrgToFreePlan called once');
    assert.strictEqual(downgradeCalls[0].orgId, 'org_1', 'downgraded the right org');
    assert.strictEqual(downgradeCalls[0].opts.changedBy, 'stripe_webhook', 'audit attribution passed through');
    // The cancel path must NOT run for a never-paid org.
    const cancelWrites = setOrgCalls.filter(c => c.data?.status === 'cancelled');
    assert.strictEqual(cancelWrites.length, 0, 'setOrgSubscription NOT called with cancelled');
});

test('org with payment_status null/none also downgrades (never paid)', async () => {
    resetSpies();
    orgSubFixture = { organization_id: 'org_1', payment_status: null };
    nextEvent = deletedEvent(orgSub());

    await dispatch({ headers: { 'stripe-signature': 'sig_test' } });

    assert.strictEqual(downgradeCalls.length, 1, 'null payment_status counts as never-paid → downgrade');
    assert.strictEqual(setOrgCalls.filter(c => c.data?.status === 'cancelled').length, 0, 'no cancel write');
});

// ═══════════════════════════════════════════════════════════════════════════
// Previously-paid org → cancelled, NOT downgraded
// ═══════════════════════════════════════════════════════════════════════════

test('previously-paid org subscription.deleted is cancelled (no downgrade)', async () => {
    resetSpies();
    orgSubFixture = { organization_id: 'org_1', payment_status: 'paid', status: 'active' };
    nextEvent = deletedEvent(orgSub());

    const res = await dispatch({ headers: { 'stripe-signature': 'sig_test' } });

    assert.strictEqual(res.statusCode, 200, 'webhook acks 200');
    assert.strictEqual(downgradeCalls.length, 0, 'downgradeOrgToFreePlan NOT called for a paid org');
    const cancelWrites = setOrgCalls.filter(c => c.data?.status === 'cancelled');
    assert.strictEqual(cancelWrites.length, 1, 'setOrgSubscription called once with cancelled');
    assert.strictEqual(cancelWrites[0].orgId, 'org_1');
    assert.strictEqual(cancelWrites[0].data.payment_status, 'cancelled', 'payment_status set to cancelled');
    // And an audit row records the cancellation.
    assert.ok(
        auditCalls.some(a => a.action === 'update_subscription' && a.newV?.status === 'cancelled'),
        'cancellation audited'
    );
});

// ═══════════════════════════════════════════════════════════════════════════
// No Free plan to fall back to → never-paid org still ends cancelled
// ═══════════════════════════════════════════════════════════════════════════

test('never-paid org falls through to cancelled when no Free plan exists', async () => {
    resetSpies();
    orgSubFixture = { organization_id: 'org_1', payment_status: 'trialing' };
    nextEvent = deletedEvent(orgSub());
    // Simulate "no default plan": downgradeOrgToFreePlan resolves null.
    const us = require('../stores/userStore');
    const origDowngrade = us.downgradeOrgToFreePlan;
    us.downgradeOrgToFreePlan = async (orgId, opts) => { downgradeCalls.push({ orgId, opts }); return null; };
    try {
        await dispatch({ headers: { 'stripe-signature': 'sig_test' } });
    } finally {
        us.downgradeOrgToFreePlan = origDowngrade;
    }

    assert.strictEqual(downgradeCalls.length, 1, 'downgrade attempted first');
    const cancelWrites = setOrgCalls.filter(c => c.data?.status === 'cancelled');
    assert.strictEqual(cancelWrites.length, 1, 'falls through to cancelled when downgrade returns null');
});

// ═══════════════════════════════════════════════════════════════════════════
// Dedup gate: a replayed event short-circuits before any decision
// ═══════════════════════════════════════════════════════════════════════════

test('duplicate event is acked without touching the subscription', async () => {
    resetSpies();
    orgSubFixture = { organization_id: 'org_1', payment_status: 'trialing' };
    nextEvent = deletedEvent(orgSub());
    const us = require('../stores/userStore');
    const origRecord = us.recordStripeEventProcessed;
    us.recordStripeEventProcessed = async () => false; // already processed
    try {
        const res = await dispatch({ headers: { 'stripe-signature': 'sig_test' } });
        assert.strictEqual(res.statusCode, 200, 'duplicate still acks 200');
        assert.strictEqual(res.body?.duplicate, true, 'flagged as duplicate');
    } finally {
        us.recordStripeEventProcessed = origRecord;
    }
    assert.strictEqual(downgradeCalls.length, 0, 'no downgrade on a replay');
    assert.strictEqual(setOrgCalls.length, 0, 'no write on a replay');
});

// ═══════════════════════════════════════════════════════════════════════════
// Missing signature → 400 before any handler work
// ═══════════════════════════════════════════════════════════════════════════

test('missing stripe-signature header is rejected with 400', async () => {
    resetSpies();
    nextEvent = deletedEvent(orgSub());
    const res = await dispatch({ headers: {} });
    assert.strictEqual(res.statusCode, 400, 'no signature → 400');
    assert.strictEqual(downgradeCalls.length, 0, 'no decision made');
    assert.strictEqual(setOrgCalls.length, 0, 'no write made');
});
