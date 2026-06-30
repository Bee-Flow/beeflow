/**
 * BFSF-226 — userStore subscription downgrade-to-Free logic.
 *
 * Covers the two NEW exports:
 *   - getDefaultOrgPlanId()      — default-plan lookup + cheapest-plan fallback
 *   - downgradeOrgToFreePlan()   — resolves Free plan, rewrites the org sub to
 *                                  the capped plan with the dead Stripe/trial
 *                                  bookkeeping cleared, or no-ops if there is no
 *                                  default plan.
 *
 * No real DB: ../db is stubbed via the require-cache trick (same pattern as
 * routes/automation.ratelimit.test.js and auth/encryption.test.js) so initDB's
 * migration statements no-op and getOne returns SQL-aware fixtures. We capture
 * every db.run() call so we can assert on the SQL/params written through
 * setOrgSubscription.
 *
 * Run: cd server && node --test stores/userStore.downgradeToFree.test.js
 */

const assert = require('assert');

// ── Mutable test fixtures shared with the db stub ───────────────────────────
// runCalls   — every db.run(sql, params) the code under test issues.
// getOneImpl — swappable handler so each test can shape the SELECT results.
const runCalls = [];
let getOneImpl = () => null;
const defaultRunImpl = async (sql, params) => { runCalls.push({ sql, params }); return { rowCount: 1 }; };
let runImpl = defaultRunImpl; // swappable so a test can simulate a DB write failure

function resetCapture() {
    runCalls.length = 0;
    getOneImpl = () => null;
    runImpl = defaultRunImpl;
}

// ── Stub every module-level / lazily-required dependency of userStore ────────
function stub(path, exports) {
    const filename = require.resolve(path);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../db', {
    pool: {},
    run: async (sql, params) => runImpl(sql, params),
    getOne: async (sql, params) => getOneImpl(sql, params),
    getAll: async () => [],
    exec: async () => {},          // initDB() migration → no-op
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    getRedis: () => null,
    redisHealthy: () => false,
    disconnectRedis: async () => {},
    getPoolStats: () => ({}),
});

// applyPlanToOrg / invalidatePaygCache are best-effort side effects — make them
// inert spies so the function under test can call them without a real impl.
const applyPlanCalls = [];
stub('../services/planEntitlements', {
    applyPlanToOrg: async (orgId, planId, opts) => { applyPlanCalls.push({ orgId, planId, opts }); },
});
stub('./usageStore', {
    invalidatePaygCache: () => {},
});
stub('./configStore', {
    getConfig: async () => null,
    getSecret: async () => null,
});

const userStore = require('./userStore');

// ── Helpers ─────────────────────────────────────────────────────────────────
const sqlOf = (c) => String(c.sql).replace(/\s+/g, ' ').trim();
// The org_subscriptions write (INSERT or UPDATE) issued by setOrgSubscription.
const orgSubWrites = () => runCalls.filter(c =>
    /organization_subscriptions/i.test(c.sql) && /(INSERT|UPDATE)/i.test(c.sql));
const auditWrites = () => runCalls.filter(c => /subscription_audit_log/i.test(c.sql));

const { test } = require('node:test');

// ═══════════════════════════════════════════════════════════════════════════
// getDefaultOrgPlanId
// ═══════════════════════════════════════════════════════════════════════════

test('getDefaultOrgPlanId returns the operator-designated default org plan', async () => {
    resetCapture();
    let sawFallback = false;
    getOneImpl = (sql) => {
        if (/is_default = TRUE/i.test(sql)) return { id: 'free-plan' };
        // The cheapest-plan fallback must NOT be consulted when a default exists.
        if (/ORDER BY price ASC NULLS LAST/i.test(sql)) sawFallback = true;
        return null;
    };
    const id = await userStore.getDefaultOrgPlanId();
    assert.strictEqual(id, 'free-plan');
    assert.strictEqual(sawFallback, false, 'fallback query short-circuited when a default exists');
});

test('getDefaultOrgPlanId falls back to the cheapest org plan when no default', async () => {
    resetCapture();
    let sawFallback = false;
    getOneImpl = (sql) => {
        if (/is_default = TRUE/i.test(sql)) return null;          // no default seeded
        if (/ORDER BY price ASC NULLS LAST/i.test(sql)) {          // cheapest-first
            sawFallback = true;
            return { id: 'cheapest-plan' };
        }
        return null;
    };
    const id = await userStore.getDefaultOrgPlanId();
    assert.strictEqual(id, 'cheapest-plan');
    assert.ok(sawFallback, 'cheapest-plan fallback query was executed');
});

test('getDefaultOrgPlanId returns null when there are no org plans at all', async () => {
    resetCapture();
    getOneImpl = () => null; // neither default nor any org plan exists
    const id = await userStore.getDefaultOrgPlanId();
    assert.strictEqual(id, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// downgradeOrgToFreePlan — happy path
// ═══════════════════════════════════════════════════════════════════════════

test('downgradeOrgToFreePlan rewrites an existing org sub to the Free plan with dead fields cleared', async () => {
    resetCapture();
    applyPlanCalls.length = 0;
    getOneImpl = (sql) => {
        // Free-plan resolution.
        if (/is_default = TRUE/i.test(sql)) return { id: 'free-plan' };
        // getOrgSubscription (before + after) → an existing PAID-but-dead row so
        // setOrgSubscription takes the UPDATE branch and plan_id actually changes.
        if (/FROM organization_subscriptions/i.test(sql)) {
            return { id: 'sub-row', organization_id: 'org_1', plan_id: 'old-paid-plan', status: 'active' };
        }
        return null;
    };

    const result = await userStore.downgradeOrgToFreePlan('org_1', { changedBy: 'tester', reason: 'unit' });

    // The org subscription was written exactly once via setOrgSubscription.
    const writes = orgSubWrites();
    assert.strictEqual(writes.length, 1, `one org-sub write expected, got ${writes.length}`);
    const w = writes[0];
    assert.match(sqlOf(w), /UPDATE organization_subscriptions/i, 'took the UPDATE branch (existing row)');

    // plan_id = free plan, status = active, payment_status cleared to null.
    const cols = sqlOf(w).match(/"([a-z_]+)" = \$\d+/gi).map(s => s.replace(/"| = \$\d+/g, ''));
    const valueFor = (col) => w.params[cols.indexOf(col)];
    assert.ok(cols.includes('plan_id'), 'UPDATE sets plan_id');
    assert.strictEqual(valueFor('plan_id'), 'free-plan', 'plan_id → resolved Free plan id');
    assert.strictEqual(valueFor('status'), 'active', "status → 'active'");

    // Dead Stripe/trial/schedule bookkeeping is cleared to null/false.
    assert.strictEqual(valueFor('payment_status'), null, 'payment_status cleared');
    assert.strictEqual(valueFor('stripe_subscription_id'), null, 'stripe_subscription_id cleared');
    assert.strictEqual(valueFor('trial_end_date'), null, 'trial_end_date cleared');
    assert.strictEqual(valueFor('cancel_at_period_end'), false, 'cancel_at_period_end cleared');
    assert.strictEqual(valueFor('cancel_at'), null, 'cancel_at cleared');
    assert.strictEqual(valueFor('pending_plan_id'), null, 'pending_plan_id cleared');
    assert.strictEqual(valueFor('pending_plan_effective'), null, 'pending_plan_effective cleared');
    assert.strictEqual(valueFor('stripe_schedule_id'), null, 'stripe_schedule_id cleared');

    // stripe_customer_id is intentionally NOT touched (kept for later upgrade).
    assert.ok(!cols.includes('stripe_customer_id'), 'stripe_customer_id left untouched');

    // Side effects: re-provision Free-plan limits + an audit row.
    assert.strictEqual(applyPlanCalls.length, 1, 'applyPlanToOrg invoked once');
    assert.deepStrictEqual(
        { orgId: applyPlanCalls[0].orgId, planId: applyPlanCalls[0].planId },
        { orgId: 'org_1', planId: 'free-plan' }
    );
    const audits = auditWrites();
    assert.strictEqual(audits.length, 1, 'one audit row written');
    assert.strictEqual(audits[0].params[1], 'downgrade_to_free', "audit action is 'downgrade_to_free'");
    assert.strictEqual(audits[0].params[3], 'org_1', 'audit target id is the org');
    assert.strictEqual(audits[0].params[4], 'tester', 'audit records changedBy');

    // Returns the post-write subscription (truthy fixture row), not null.
    assert.ok(result, 'returns the resolved subscription');
});

test('downgradeOrgToFreePlan INSERTs the Free plan for an org that has no subscription row yet', async () => {
    resetCapture();
    applyPlanCalls.length = 0;
    getOneImpl = (sql) => {
        if (/is_default = TRUE/i.test(sql)) return { id: 'free-plan' };
        if (/FROM organization_subscriptions/i.test(sql)) return null; // no existing row
        return null;
    };

    await userStore.downgradeOrgToFreePlan('org_new');

    const writes = orgSubWrites();
    assert.strictEqual(writes.length, 1, 'one org-sub write expected');
    const w = writes[0];
    assert.match(sqlOf(w), /INSERT INTO organization_subscriptions/i, 'took the INSERT branch (no existing row)');
    // INSERT positional params: ($1 id, $2 organization_id, $3 plan_id, $4 status, ...)
    assert.strictEqual(w.params[2], 'free-plan', 'INSERT plan_id = Free plan');
    assert.strictEqual(w.params[3], 'active', "INSERT status = 'active'");
    assert.strictEqual(applyPlanCalls.length, 1, 'applyPlanToOrg invoked on INSERT path too');
});

// ═══════════════════════════════════════════════════════════════════════════
// downgradeOrgToFreePlan — no default plan exists
// ═══════════════════════════════════════════════════════════════════════════

test('downgradeOrgToFreePlan returns null and writes nothing when no default plan exists', async () => {
    resetCapture();
    applyPlanCalls.length = 0;
    // No default AND no fallback plan → getDefaultOrgPlanId() resolves null.
    getOneImpl = () => null;

    const result = await userStore.downgradeOrgToFreePlan('org_x');

    assert.strictEqual(result, null, 'returns null when there is no Free plan to land on');
    assert.strictEqual(orgSubWrites().length, 0, 'no INSERT/UPDATE to organization_subscriptions');
    assert.strictEqual(auditWrites().length, 0, 'no audit row written');
    assert.strictEqual(applyPlanCalls.length, 0, 'applyPlanToOrg NOT called');
});

// ═══════════════════════════════════════════════════════════════════════════
// downgradeOrgToFreePlan — manual-override hold + DB-failure guards (review fixes)
// ═══════════════════════════════════════════════════════════════════════════

test('downgradeOrgToFreePlan respects an active manual override: no write, returns the unchanged row', async () => {
    resetCapture();
    applyPlanCalls.length = 0;
    const future = new Date(Date.now() + 3600_000).toISOString();
    getOneImpl = (sql) => {
        if (/is_default = TRUE/i.test(sql)) return { id: 'free-plan' };
        if (/FROM organization_subscriptions/i.test(sql)) {
            // Admin pinned this org's subscription — must not be downgraded.
            return { id: 'sub-row', organization_id: 'org_pin', plan_id: 'paid-plan', status: 'active', manual_override_until: future };
        }
        return null;
    };

    const result = await userStore.downgradeOrgToFreePlan('org_pin', { changedBy: 'system', reason: 'trial_expired' });

    // Returns the unchanged row (truthy) so callers skip their fallback...
    assert.ok(result, 'returns the existing (unchanged) subscription');
    assert.strictEqual(result.plan_id, 'paid-plan', 'plan left untouched under manual override');
    // ...and nothing is written or re-provisioned.
    assert.strictEqual(orgSubWrites().length, 0, 'no INSERT/UPDATE under manual override');
    assert.strictEqual(auditWrites().length, 0, 'no audit row under manual override');
    assert.strictEqual(applyPlanCalls.length, 0, 'applyPlanToOrg NOT called under manual override');
});

test('downgradeOrgToFreePlan returns null (no phantom downgrade) when the DB write fails', async () => {
    resetCapture();
    applyPlanCalls.length = 0;
    getOneImpl = (sql) => {
        if (/is_default = TRUE/i.test(sql)) return { id: 'free-plan' };
        if (/FROM organization_subscriptions/i.test(sql)) {
            return { id: 'sub-row', organization_id: 'org_dbfail', plan_id: 'old-plan', status: 'active' };
        }
        return null;
    };
    // Make the org-sub write blow up so setOrgSubscription catches it → false.
    runImpl = async (sql, params) => {
        if (/organization_subscriptions/i.test(sql) && /(INSERT|UPDATE)/i.test(sql)) throw new Error('db down');
        runCalls.push({ sql, params });
        return { rowCount: 1 };
    };

    const result = await userStore.downgradeOrgToFreePlan('org_dbfail');

    assert.strictEqual(result, null, 'failed write surfaces as null so callers can fall back');
    assert.strictEqual(auditWrites().length, 0, 'no phantom downgrade_to_free audit on failure');
    assert.strictEqual(applyPlanCalls.length, 0, 'applyPlanToOrg NOT called after a failed write');
});
