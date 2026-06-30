/**
 * Unit tests for the default-org-plan migration (BFSF-226) — ensure-default
 * promotion/creation of the Free org plan plus the report-only census of
 * existing no-plan orgs. The pg layer is mocked via require.cache (mirrors
 * serverScope.test.js) with an in-memory plans/orgs/subs fixture, so no DB.
 *
 * Run: node --test server/migrations/default-org-plan-2026-06.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── In-memory fake of server/db.js ───────────────────────────────────────
// The migration destructures { run, getOne, getAll } at require time, so the
// fake delegates to a resettable `state` object shared across tests.
const state = { plans: [], orgs: [], subs: [], writes: [] };
const reset = () => { state.plans = []; state.orgs = []; state.subs = []; state.writes = []; };
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

const fakeDb = {
    async getOne(sql, params = []) {
        const q = norm(sql);
        if (q.includes('WHERE is_default = TRUE LIMIT 1')) {
            const row = state.plans.find(p => p.is_default === true);
            return row ? { id: row.id } : null;
        }
        if (q.includes("(name = 'Free' OR price = 0)")) {
            const candidates = state.plans
                .filter(p => (p.plan_type === 'organization' || p.plan_type == null)
                    && (p.name === 'Free' || p.price === 0))
                .sort((a, b) => ((b.name === 'Free') - (a.name === 'Free')) || (a.created_at - b.created_at));
            return candidates[0] ? { id: candidates[0].id } : null;
        }
        throw new Error('unexpected getOne: ' + q);
    },
    async getAll(sql) {
        const q = norm(sql);
        if (q.includes('LEFT JOIN organization_subscriptions')) {
            return state.orgs
                .filter(o => !state.subs.some(s => s.organization_id === o.id))
                .map(o => ({ id: o.id, name: o.name, nc_instance_id: o.nc_instance_id || null }));
        }
        throw new Error('unexpected getAll: ' + q);
    },
    async run(sql, params = []) {
        const q = norm(sql);
        state.writes.push(q);
        if (q.startsWith('UPDATE subscription_plans SET is_default = FALSE')) {
            let n = 0;
            for (const p of state.plans) if (p.is_default) { p.is_default = false; n++; }
            return { rowCount: n };
        }
        if (q.startsWith('UPDATE subscription_plans SET is_default = TRUE')) {
            const p = state.plans.find(x => x.id === params[0]);
            if (p) p.is_default = true;
            return { rowCount: p ? 1 : 0 };
        }
        if (q.startsWith('INSERT INTO subscription_plans')) {
            state.plans.push({
                id: params[0], name: 'Free', plan_type: 'organization', price: 0,
                is_default: true, is_public: false, created_at: Date.now(),
            });
            return { rowCount: 1 };
        }
        throw new Error('unexpected run: ' + q);
    },
};

const dbPath = path.join(__dirname, '..', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { up } = require('./default-org-plan-2026-06');

const defaults = () => state.plans.filter(p => p.is_default === true);

test.beforeEach(() => {
    reset();
    process.env.DEPLOYMENT_MODE = 'cloud';
});

test('no default, Free plan exists → promoted to the single default', async () => {
    state.plans.push(
        { id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: false, created_at: 1 },
        { id: 'paid-1', name: 'Bee Flow', plan_type: 'organization', price: 30, is_default: false, created_at: 2 },
    );
    await up();
    assert.equal(defaults().length, 1);
    assert.equal(defaults()[0].id, 'free-1');
});

test('no default, no Free plan → one is created as the default (Free, €0, org)', async () => {
    state.plans.push({ id: 'paid-1', name: 'Bee Flow', plan_type: 'organization', price: 30, is_default: false, created_at: 1 });
    await up();
    assert.equal(defaults().length, 1);
    const free = defaults()[0];
    assert.equal(free.name, 'Free');
    assert.equal(free.price, 0);
    assert.equal(free.plan_type, 'organization');
    assert.ok(state.writes.some(w => w.startsWith('INSERT INTO subscription_plans')));
});

test('re-run is a no-op once a default exists', async () => {
    state.plans.push({ id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: false, created_at: 1 });
    await up();
    const writesAfterFirst = state.writes.length;
    await up();
    assert.equal(state.writes.length, writesAfterFirst, 'second run must not write');
    assert.equal(defaults().length, 1);
    assert.equal(defaults()[0].id, 'free-1');
});

test('pre-existing default is never clobbered', async () => {
    state.plans.push(
        { id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: false, created_at: 1 },
        { id: 'paid-1', name: 'Bee Flow', plan_type: 'organization', price: 30, is_default: true, created_at: 2 },
    );
    await up();
    assert.equal(state.writes.length, 0, 'must not write when a default exists');
    assert.equal(defaults().length, 1);
    assert.equal(defaults()[0].id, 'paid-1');
});

test('census reports no-plan orgs but writes nothing to subscriptions', async () => {
    state.plans.push({ id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: true, created_at: 1 });
    state.orgs.push(
        { id: 'org-a', name: 'Has plan' },
        { id: 'org-b', name: 'No plan' },
    );
    state.subs.push({ organization_id: 'org-a' });
    const orphanCount = await up();
    assert.equal(orphanCount, 1, 'one org without a subscription row');
    assert.equal(state.writes.length, 0, 'census is report-only');
    assert.equal(state.subs.length, 1, 'no subscription rows created');
});

test('non-cloud deployment mode skips entirely', async () => {
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    state.plans.push({ id: 'free-1', name: 'Free', plan_type: 'organization', price: 0, is_default: false, created_at: 1 });
    const res = await up();
    assert.equal(res, null);
    assert.equal(state.writes.length, 0);
    assert.equal(defaults().length, 0);
});
