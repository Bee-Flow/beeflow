/**
 * Unit tests for integrationConnectionStore — legacy-key parsing + the central
 * resolveConnectionForRun decision logic (db mocked; SQL not exercised, the JS
 * control flow is). Run: node stores/integrationConnectionStore.test.js
 */

const assert = require('assert');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-unit-tests-32chars!!';
process.env.INTEGRATION_CONNECTIONS_BACKFILL = '0'; // no boot timer in tests

// ── Mock ../db before the store loads ───────────────────────────────
const mockState = { own: null, grant: null, lastGrantParams: null };
const mockDb = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    getOne: async (sql, params) => {
        if (sql.includes('connection_grants')) { mockState.lastGrantParams = params; return mockState.grant; }
        if (sql.includes('is_default = TRUE')) return mockState.own;
        return null;
    },
};
const dbPath = require.resolve('../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = mockDb;
require.cache[dbPath].loaded = true;

const store = require('./integrationConnectionStore');

let passed = 0;
function test(name, fn) { return fn().then(() => { passed++; console.log(`  ✓ ${name}`); }); }
function sync(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log('integrationConnectionStore');

// ── parseLegacyKey ──────────────────────────────────────────────────
sync('parseLegacyKey maps single-field providers', () => {
    assert.deepStrictEqual(store.parseLegacyKey('fireflies_api_key_user_u1'),
        { provider: 'fireflies', field: 'api_key', kind: 'api_key', userId: 'u1' });
    assert.deepStrictEqual(store.parseLegacyKey('github_token_user_abc'),
        { provider: 'github', field: 'token', kind: 'api_key', userId: 'abc' });
    assert.deepStrictEqual(store.parseLegacyKey('gamma_api_key_user_x'),
        { provider: 'gamma', field: 'api_key', kind: 'api_key', userId: 'x' });
});

sync('parseLegacyKey maps multi-field (basic) providers', () => {
    assert.strictEqual(store.parseLegacyKey('youtrack_url_user_u1').field, 'url');
    assert.strictEqual(store.parseLegacyKey('youtrack_token_user_u1').field, 'token');
    assert.strictEqual(store.parseLegacyKey('youtrack_url_user_u1').provider, 'youtrack');
    assert.strictEqual(store.parseLegacyKey('signrequest_subdomain_user_u1').field, 'subdomain');
});

sync('parseLegacyKey handles userIds containing underscores', () => {
    // lastIndexOf('_user_') means the userId may itself contain underscores.
    const p = store.parseLegacyKey('fireflies_api_key_user_org_5_user_99');
    assert.strictEqual(p.provider, 'fireflies');
    assert.strictEqual(p.userId, 'org_5_user_99');
});

sync('parseLegacyKey rejects non-managed / malformed keys', () => {
    assert.strictEqual(store.parseLegacyKey('n8n_api_key_org_o1'), null);
    assert.strictEqual(store.parseLegacyKey('google_api_key'), null);
    assert.strictEqual(store.parseLegacyKey('fireflies_api_key_user_'), null);
    assert.strictEqual(store.parseLegacyKey('random_string'), null);
    assert.strictEqual(store.parseLegacyKey(null), null);
});

sync('PROVIDER_LEGACY_FIELDS reverse map groups multi-field providers', () => {
    const yt = store._internals.PROVIDER_LEGACY_FIELDS.youtrack.map(f => f.field).sort();
    assert.deepStrictEqual(yt, ['token', 'url']);
    assert.strictEqual(store._internals.PROVIDER_LEGACY_FIELDS.fireflies.length, 1);
});

// ── resolveConnectionForRun truth table ─────────────────────────────
async function run() {
    await test('own active connection → mode own (BYO satisfied)', async () => {
        mockState.own = { id: 'c1', label: 'Mine', status: 'active' };
        mockState.grant = null;
        const r = await store.resolveConnectionForRun({ runningUserId: 'u1', runningUserOrgId: 'orgA', provider: 'slack' });
        assert.strictEqual(r.mode, 'own');
        assert.strictEqual(r.available, true);
        assert.strictEqual(r.effectiveUserId, 'u1');
        assert.strictEqual(r.connectionId, 'c1');
        assert.strictEqual(r.grantId, null);
    });

    await test('own present but not active → falls through to grant', async () => {
        mockState.own = { id: 'c1', label: 'Mine', status: 'needs_reauth' };
        mockState.grant = { connection_id: 'c9', connection_label: 'Owner', owner_user_id: 'owner1', org_id: 'orgA', grant_id: 'g1' };
        const r = await store.resolveConnectionForRun({ runningUserId: 'u1', runningUserOrgId: 'orgA', provider: 'slack' });
        assert.strictEqual(r.mode, 'delegated');
        assert.strictEqual(r.effectiveUserId, 'owner1');
        assert.strictEqual(r.connectionId, 'c9');
        assert.strictEqual(r.grantId, 'g1');
    });

    await test('no own + lend grant → delegated to owner', async () => {
        mockState.own = null;
        mockState.grant = { connection_id: 'c9', connection_label: 'Owner Slack', owner_user_id: 'owner1', org_id: 'orgA', grant_id: 'g1' };
        const r = await store.resolveConnectionForRun({ runningUserId: 'u2', runningUserOrgId: 'orgA', runningUserGroups: ['gx'], provider: 'slack' });
        assert.strictEqual(r.mode, 'delegated');
        assert.strictEqual(r.available, true);
        assert.strictEqual(r.effectiveUserId, 'owner1');
        assert.strictEqual(r.effectiveOrgId, 'orgA');
        assert.strictEqual(r.connectionLabel, 'Owner Slack');
    });

    await test('no own + no grant → byo_required (no silent failure)', async () => {
        mockState.own = null;
        mockState.grant = null;
        const r = await store.resolveConnectionForRun({ runningUserId: 'u3', runningUserOrgId: 'orgA', provider: 'github' });
        assert.strictEqual(r.mode, 'byo_required');
        assert.strictEqual(r.available, false);
        assert.strictEqual(r.reason, 'byo_missing');
        assert.strictEqual(r.effectiveUserId, 'u3');
    });

    await test('grant query is filtered by the running user org (isolation guard param)', async () => {
        mockState.own = null;
        mockState.grant = null;
        await store.resolveConnectionForRun({ runningUserId: 'u4', runningUserOrgId: 'orgB', runningUserGroups: ['g1', 'g2'], provider: 'slack', resourceType: 'agent', resourceId: 'a1' });
        // params: [provider, orgId, runningUserId, groups, resourceType, resourceId, ownerUserId]
        assert.strictEqual(mockState.lastGrantParams[1], 'orgB', 'org id must be bound as the isolation guard');
        assert.deepStrictEqual(mockState.lastGrantParams[3], ['g1', 'g2']);
        assert.strictEqual(mockState.lastGrantParams[4], 'agent');
        assert.strictEqual(mockState.lastGrantParams[5], 'a1');
    });

    await test('empty org funnels through the sentinel for the resolver', async () => {
        mockState.own = null; mockState.grant = null;
        const r = await store.resolveConnectionForRun({ runningUserId: 'u5', runningUserOrgId: '', provider: 'slack' });
        assert.strictEqual(r.effectiveOrgId, store.DEFAULT_ORG_SENTINEL);
        assert.strictEqual(mockState.lastGrantParams[1], store.DEFAULT_ORG_SENTINEL);
    });

    console.log(`\nintegrationConnectionStore: ${passed} passed\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
