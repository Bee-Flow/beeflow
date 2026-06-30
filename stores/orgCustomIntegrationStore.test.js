/**
 * Unit tests for orgCustomIntegrationStore — pure helpers only (slug
 * generation + row shaping; db mocked so requiring the store never touches
 * Postgres, DB methods are exercised via integration).
 * Run: node stores/orgCustomIntegrationStore.test.js
 */

const assert = require('assert');
const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = 'test-master-key-for-unit-tests-32chars!!';
process.env.INTEGRATION_CONNECTIONS_BACKFILL = '0'; // no boot timer in tests

// ── Mock ../db before the store loads ───────────────────────────────
const mockDb = {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
};
const dbPath = require.resolve('../db');
require.cache[dbPath] = new Module(dbPath);
require.cache[dbPath].exports = mockDb;
require.cache[dbPath].loaded = true;

const store = require('./orgCustomIntegrationStore');
const { SLUG_RE, SLUG_LENGTH } = store._internals;

let passed = 0;
function sync(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
function test(name, fn) { return fn().then(() => { passed++; console.log(`  ✓ ${name}`); }); }

console.log('orgCustomIntegrationStore');

// ── generateSlug ────────────────────────────────────────────────────
sync('generateSlug default matches ^[a-z0-9]{4,16}$ at the chosen length', () => {
    for (let i = 0; i < 500; i++) {
        const slug = store.generateSlug();
        assert.strictEqual(slug.length, SLUG_LENGTH, `length must be ${SLUG_LENGTH}, got '${slug}'`);
        assert.ok(SLUG_RE.test(slug), `slug '${slug}' must match ${SLUG_RE}`);
    }
});

sync('generateSlug never emits underscores or uppercase (parsing invariant)', () => {
    // cint_<slug>_<toolName> parsing relies on the slug containing NO '_'.
    for (let i = 0; i < 500; i++) {
        const slug = store.generateSlug();
        assert.ok(!/[^a-z0-9]/.test(slug), `slug '${slug}' has chars outside [a-z0-9]`);
    }
});

sync('generateSlug honors explicit lengths within 4..16', () => {
    for (const len of [4, 8, 10, 12, 16]) {
        const slug = store.generateSlug(len);
        assert.strictEqual(slug.length, len);
        assert.ok(SLUG_RE.test(slug), `slug '${slug}' must match ${SLUG_RE}`);
    }
});

sync('generateSlug clamps out-of-range / bogus lengths into 4..16', () => {
    assert.strictEqual(store.generateSlug(1).length, 4);
    assert.strictEqual(store.generateSlug(99).length, 16);
    assert.strictEqual(store.generateSlug(0).length, SLUG_LENGTH);   // falsy → default
    assert.strictEqual(store.generateSlug(NaN).length, SLUG_LENGTH); // bogus → default
    assert.strictEqual(store.generateSlug(11.9).length, 11);         // floored
});

sync('generateSlug has no realistic collisions across 2000 draws', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) seen.add(store.generateSlug());
    assert.strictEqual(seen.size, 2000, 'expected 2000 distinct slugs');
});

// ── shapeIntegration ────────────────────────────────────────────────
sync('shapeIntegration maps a full row to camelCase', () => {
    const now = new Date('2026-06-10T12:00:00Z');
    const shaped = store.shapeIntegration({
        id: 'i1', org_id: 'orgA', slug: 'abc123def45', kind: 'rest',
        name: 'Invoices API', description: 'desc', status: 'active',
        definition: { specVersion: 1 }, definition_version: 3,
        activated_definition: { specVersion: 1, frozen: true }, activated_version: 2,
        tools_cache: [{ name: 'list_invoices' }],
        allow_writes: true, lend_mode: 'org',
        builder_session: { messages: [] }, last_validation: { ok: true },
        created_by: 'u1', activated_by: 'u2', activated_at: now,
        created_at: now, updated_at: now,
    });
    assert.strictEqual(shaped.id, 'i1');
    assert.strictEqual(shaped.orgId, 'orgA');
    assert.strictEqual(shaped.slug, 'abc123def45');
    assert.strictEqual(shaped.kind, 'rest');
    assert.strictEqual(shaped.status, 'active');
    assert.deepStrictEqual(shaped.definition, { specVersion: 1 });
    assert.strictEqual(shaped.definitionVersion, 3);
    assert.deepStrictEqual(shaped.activatedDefinition, { specVersion: 1, frozen: true });
    assert.strictEqual(shaped.activatedVersion, 2);
    assert.deepStrictEqual(shaped.toolsCache, [{ name: 'list_invoices' }]);
    assert.strictEqual(shaped.allowWrites, true);
    assert.strictEqual(shaped.lendMode, 'org');
    assert.deepStrictEqual(shaped.lastValidation, { ok: true });
    assert.strictEqual(shaped.createdBy, 'u1');
    assert.strictEqual(shaped.activatedBy, 'u2');
    // builder_session stays out of the shaped row (large; builder-only)
    assert.strictEqual('builderSession' in shaped, false);
});

sync('shapeIntegration parses JSONB delivered as strings (mcpStore convention)', () => {
    const shaped = store.shapeIntegration({
        id: 'i2', org_id: 'orgA', slug: 'zzzz9999aa', kind: 'mcp_remote',
        name: 'Remote MCP', status: 'draft',
        definition: '{"specVersion":1,"mcp":{"url":"https://x"}}',
        definition_version: 1,
        tools_cache: '[{"name":"search"}]',
        last_validation: '{"ok":false}',
        created_by: 'u1', created_at: 'now', updated_at: 'now',
    });
    assert.deepStrictEqual(shaped.definition, { specVersion: 1, mcp: { url: 'https://x' } });
    assert.deepStrictEqual(shaped.toolsCache, [{ name: 'search' }]);
    assert.deepStrictEqual(shaped.lastValidation, { ok: false });
});

sync('shapeIntegration applies safe defaults for nullable / malformed fields', () => {
    const shaped = store.shapeIntegration({
        id: 'i3', org_id: 'orgA', slug: 'aaaa1111', kind: 'rest',
        name: 'Bare', status: 'draft',
        definition: 'not-json', definition_version: 1,
        activated_definition: null, activated_version: null,
        tools_cache: null, allow_writes: null, lend_mode: null,
        last_validation: null, description: null,
        created_by: 'u1', activated_by: null, activated_at: null,
        created_at: 'now', updated_at: 'now',
    });
    assert.deepStrictEqual(shaped.definition, {});       // malformed JSON → {}
    assert.strictEqual(shaped.activatedDefinition, null);
    assert.strictEqual(shaped.activatedVersion, null);
    assert.deepStrictEqual(shaped.toolsCache, []);
    assert.strictEqual(shaped.allowWrites, false);        // non-true → false
    assert.strictEqual(shaped.lendMode, null);
    assert.strictEqual(shaped.lastValidation, null);
    assert.strictEqual(shaped.description, null);
    assert.strictEqual(shaped.activatedBy, null);
});

sync('shapeIntegration returns null for a missing row', () => {
    assert.strictEqual(store.shapeIntegration(null), null);
    assert.strictEqual(store.shapeIntegration(undefined), null);
});

// ── resolveOrgId funnel (re-exported from integrationConnectionStore) ─
sync('resolveOrgId funnels empty orgs through the shared sentinel', () => {
    assert.strictEqual(store.resolveOrgId(''), store.DEFAULT_ORG_SENTINEL);
    assert.strictEqual(store.resolveOrgId(null), store.DEFAULT_ORG_SENTINEL);
    assert.strictEqual(store.resolveOrgId('  '), store.DEFAULT_ORG_SENTINEL);
    assert.strictEqual(store.resolveOrgId('orgA'), 'orgA');
});

// ── input validation (rejected before any DB call) ──────────────────
async function run() {
    await test('createIntegration rejects unknown kind', async () => {
        await assert.rejects(
            () => store.createIntegration({ orgId: 'orgA', name: 'X', kind: 'graphql', createdBy: 'u1' }),
            /invalid kind/
        );
    });

    await test('createIntegration requires name and createdBy', async () => {
        await assert.rejects(() => store.createIntegration({ orgId: 'orgA', kind: 'rest', createdBy: 'u1' }), /requires name/);
        await assert.rejects(() => store.createIntegration({ orgId: 'orgA', name: 'X', kind: 'rest' }), /requires name, createdBy/);
    });

    await test('saveDefinition requires userId', async () => {
        await assert.rejects(() => store.saveDefinition('i1', { specVersion: 1 }), /requires userId/);
    });

    await test('activate rejects invalid lendMode', async () => {
        await assert.rejects(() => store.activate('i1', { lendMode: 'everyone', userId: 'u1' }), /invalid lendMode/);
    });

    await test('setStatus rejects unknown statuses', async () => {
        await assert.rejects(() => store.setStatus('i1', 'archived'), /invalid status/);
    });

    console.log(`\norgCustomIntegrationStore: ${passed} passed\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
