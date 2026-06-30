/**
 * Unit tests for the capabilityRegistry org-scoped custom-integration
 * projection (AI Integration Builder).
 *
 * The cross-org leak barrier under test: per-org 'custom:<uuid>' descriptors
 * must NEVER appear in the global listCapabilities()/listByKind() enumeration,
 * and one org's listing must never contain another org's rows. The store is
 * mocked through require.cache (same style as stores/orgCustomIntegrationStore
 * .test.js / auth/orgFeatureToggles.test.js) so no Postgres is touched.
 *
 * Run: node core/capabilityRegistry.customIntegrations.test.js
 */

const assert = require('assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

// ── Mock ../db before anything loads (betaFeatures requires it) ──────
const dbPath = require.resolve('../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
};
require.cache[dbPath].loaded = true;

// ── Mock the custom-integration store BEFORE requiring the registry ──
const DEFAULT_ORG_SENTINEL = '__default_org__';
const ORG_A_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const ORG_B_ID = '22222222-bbbb-4bbb-8bbb-222222222222';
const ROWS = {
    orgA: [{
        id: ORG_A_ID, orgId: 'orgA', slug: 'abcd1234efg', kind: 'rest',
        name: 'Invoices API', description: 'Org A invoice lookups', status: 'active',
    }],
    orgB: [{
        id: ORG_B_ID, orgId: 'orgB', slug: 'zzzz9999aab', kind: 'mcp_remote',
        name: 'Org B Remote MCP', description: '', status: 'active',
    }],
};
let storeCalls = 0;
let storeShouldThrow = false;
const storePath = require.resolve('../stores/orgCustomIntegrationStore');
require.cache[storePath] = new Module(storePath);
require.cache[storePath].exports = {
    DEFAULT_ORG_SENTINEL,
    resolveOrgId: (raw) => (raw && String(raw).trim()) || DEFAULT_ORG_SENTINEL,
    listActiveForOrg: async (orgId) => {
        storeCalls++;
        if (storeShouldThrow) throw new Error('db down');
        return (ROWS[orgId] || []).map(r => ({ ...r }));
    },
};
require.cache[storePath].loaded = true;

const registry = require('./capabilityRegistry');

let passed = 0;
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
}

function customIdsIn(list) {
    return list.map(c => c.id).filter(id => String(id).startsWith('custom:'));
}

(async () => {
    console.log('capabilityRegistry — custom-integration projection');

    // (a) global enumeration stays clean — BEFORE any org listing
    await test('listCapabilities() contains no custom: ids before any listing', async () => {
        assert.deepStrictEqual(customIdsIn(registry.listCapabilities()), []);
        assert.deepStrictEqual(customIdsIn(registry.listByKind('integration')), []);
    });

    // (b) org-scoped accessor returns exactly that org's descriptors
    let orgAList;
    await test("listCustomIntegrationCapabilities('orgA') returns exactly orgA's descriptor", async () => {
        orgAList = await registry.listCustomIntegrationCapabilities('orgA');
        assert.strictEqual(orgAList.length, 1);
        const d = orgAList[0];
        assert.strictEqual(d.id, `custom:${ORG_A_ID}`);
        assert.strictEqual(d.kind, 'integration');
        assert.strictEqual(d.name, 'Invoices API');
        assert.strictEqual(d.description, 'Org A invoice lookups');
        assert.strictEqual(d.category, registry.CUSTOM_INTEGRATION_CATEGORY);
        assert.strictEqual(d.licenseFeature, null);
        assert.strictEqual(d.lifecycle, 'stable');
        assert.strictEqual(d.defaultState, 'off');
        assert.strictEqual(d.userFacing, true);
        assert.strictEqual(d.groupTogglable, true);
        assert.strictEqual(d._custom, true);
        assert.strictEqual(d._customOrgId, 'orgA');
        assert.strictEqual(d._customSlug, 'abcd1234efg');
        assert.strictEqual(d._customKind, 'rest');
    });

    // (c) exact-id lookup resolves AFTER the listing warmed _customById
    await test("getCapability('custom:<orgA-id>') resolves to the real descriptor", async () => {
        const cap = registry.getCapability(`custom:${ORG_A_ID}`);
        assert.ok(cap, 'must resolve');
        assert.strictEqual(cap.kind, 'integration');
        assert.strictEqual(cap._custom, true);
        assert.strictEqual(cap.name, 'Invoices API');
        assert.strictEqual(cap._customOrgId, 'orgA');
        assert.strictEqual(cap.userFacing, true);
    });

    // (d) unknown uuid → synthetic, non-user-facing descriptor (never null)
    await test("getCapability('custom:unknown-uuid') returns the synthetic descriptor", async () => {
        const cap = registry.getCapability('custom:unknown-uuid');
        assert.ok(cap, 'must not be null');
        assert.strictEqual(cap.id, 'custom:unknown-uuid');
        assert.strictEqual(cap.kind, 'integration');
        assert.strictEqual(cap._custom, true);
        assert.strictEqual(cap.userFacing, false);
        assert.strictEqual(cap.name, 'Custom integration');
        assert.strictEqual(cap._customOrgId, null);
        assert.strictEqual(cap.category, registry.CUSTOM_INTEGRATION_CATEGORY);
    });

    // (e) TTL cache: second call within 15s serves the cache; invalidate re-reads
    await test('second listing within the TTL does not re-hit the store', async () => {
        const before = storeCalls;
        const again = await registry.listCustomIntegrationCapabilities('orgA');
        assert.strictEqual(storeCalls, before, 'store must not be hit again inside the TTL');
        assert.deepStrictEqual(again, orgAList, 'cached list is returned');
    });

    await test("invalidateCustomIntegrationCache('orgA') forces a store re-read", async () => {
        const before = storeCalls;
        registry.invalidateCustomIntegrationCache('orgA');
        await registry.listCustomIntegrationCapabilities('orgA');
        assert.strictEqual(storeCalls, before + 1, 'store must be re-hit after invalidation');
    });

    // (f) org isolation: orgB never shows up in orgA's list (and vice versa)
    await test("orgB's descriptors never appear in orgA's list", async () => {
        const a = await registry.listCustomIntegrationCapabilities('orgA');
        const b = await registry.listCustomIntegrationCapabilities('orgB');
        assert.strictEqual(b.length, 1);
        assert.strictEqual(b[0].id, `custom:${ORG_B_ID}`);
        assert.strictEqual(b[0]._customOrgId, 'orgB');
        assert.ok(!a.some(c => c.id === `custom:${ORG_B_ID}`), 'orgB id leaked into orgA list');
        assert.ok(!b.some(c => c.id === `custom:${ORG_A_ID}`), 'orgA id leaked into orgB list');
    });

    // (a, again) listings warmed both org caches — global enumeration STILL clean
    await test('listCapabilities() still contains no custom: ids after listings', async () => {
        assert.deepStrictEqual(customIdsIn(registry.listCapabilities()), []);
        assert.deepStrictEqual(customIdsIn(registry.listByKind('integration')), []);
    });

    // store failure → last cached list survives (fail-stale, never widen/crash)
    await test('store failure past the TTL serves the stale cached list', async () => {
        await registry.listCustomIntegrationCapabilities('orgA'); // warm
        const realNow = Date.now;
        Date.now = () => realNow() + 20_000; // jump past the 15s TTL
        storeShouldThrow = true;
        try {
            const a = await registry.listCustomIntegrationCapabilities('orgA');
            assert.strictEqual(a.length, 1, 'stale list must be served on store failure');
            assert.strictEqual(a[0].id, `custom:${ORG_A_ID}`);
        } finally {
            Date.now = realNow;
            storeShouldThrow = false;
        }
    });

    await test('cleared cache + failing store yields [] (never a throw)', async () => {
        registry.invalidateCustomIntegrationCache(); // null ⇒ clear ALL orgs
        storeShouldThrow = true;
        try {
            const a = await registry.listCustomIntegrationCapabilities('orgA');
            assert.deepStrictEqual(a, []);
        } finally {
            storeShouldThrow = false;
        }
    });

    console.log(`\n${passed} passed`);
})().catch((e) => {
    console.error('  ✗ FAILED:', e && e.stack || e);
    process.exit(1);
});
