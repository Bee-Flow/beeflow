/**
 * Knowledge Base Authorization Policy Tests (BFSF-214)
 *
 * Covers the two pure policy predicates on the KB store:
 *   - canUserManageKB(kb, userId, orgIds, hasManagePermission)  [new]
 *   - canUserAccessKB(kb, userId, orgIds, userGroups)           [regression lock]
 *
 * Manage policy: settings may be updated by the owner, super admins, and
 * same-org manage_knowledge holders regardless of publish state. Read
 * policy: draft/group-restricted content is visible to the owner, super
 * admins, and same-org org_admins (opts.isOrgAdmin); regular members still
 * need publish + group membership — locked here so reads can't silently widen.
 *
 * Run: node stores/knowledgeBases.authz.test.js
 */

const assert = require('assert');

process.env.NODE_ENV = 'test';

// ── Mock ../db so requiring the store is side-effect free ─────────
const mockDb = {
    run: async () => undefined,
    getOne: async () => null,
    getAll: async () => [],
    exec: async () => undefined,
    getClient: async () => null,
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../db') return 'mock-db';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-db'] = { id: 'mock-db', exports: mockDb };

const kbStore = require('./knowledgeBases');

// ── Fixtures ──────────────────────────────────────────────────────
const draftA = { id: 'kb-draft', tenant_id: 'alice', organization_id: 'orgA', is_published: false, shared_groups: '[]' };
const publishedA = { id: 'kb-pub', tenant_id: 'alice', organization_id: 'orgA', is_published: true, shared_groups: '[]' };
const publishedGroupA = { id: 'kb-grp', tenant_id: 'alice', organization_id: 'orgA', is_published: true, shared_groups: '["group-A1"]' };
const personalDraft = { id: 'kb-personal', tenant_id: 'alice', organization_id: null, is_published: false, shared_groups: '[]' };

const orgASet = new Set(['orgA']);
const orgBSet = new Set(['orgB']);

// ── Test scaffold ─────────────────────────────────────────────────
async function run() {
    let passed = 0, failed = 0;
    async function t(name, fn) {
        try { await fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
    }

    console.log('\n🔐 KB Authorization Policy Tests (BFSF-214)\n');

    // ── canUserManageKB ─────────────────────────────────────────
    console.log('--- canUserManageKB ---');

    await t('owner on own draft → true', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'alice', orgASet, false), true);
    });

    await t('owner on own published → true', async () => {
        assert.strictEqual(kbStore.canUserManageKB(publishedA, 'alice', orgASet, false), true);
    });

    await t('super admin (orgIds === null) on foreign draft → true', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'root', null, false), true);
    });

    await t('same-org user with manage perm on foreign DRAFT → true (the BFSF-214 case)', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'bob', orgASet, true), true);
    });

    await t('same-org user with manage perm on foreign published+group-restricted → true', async () => {
        assert.strictEqual(kbStore.canUserManageKB(publishedGroupA, 'bob', orgASet, true), true);
    });

    await t('same-org user without manage perm → false', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'bob', orgASet, false), false);
        assert.strictEqual(kbStore.canUserManageKB(publishedA, 'bob', orgASet, false), false);
    });

    await t('cross-org user with manage perm → false', async () => {
        assert.strictEqual(kbStore.canUserManageKB(draftA, 'eve', orgBSet, true), false);
        assert.strictEqual(kbStore.canUserManageKB(publishedA, 'eve', orgBSet, true), false);
    });

    await t("foreign personal KB (organization_id null) with manage perm → false", async () => {
        assert.strictEqual(kbStore.canUserManageKB(personalDraft, 'bob', orgASet, true), false);
    });

    await t('kb = null → false', async () => {
        assert.strictEqual(kbStore.canUserManageKB(null, 'alice', orgASet, true), false);
    });

    // ── canUserAccessKB regression lock (read policy untouched) ─
    console.log('--- canUserAccessKB (read policy lock) ---');

    await t('non-owner same-org user on draft → false (drafts stay hidden)', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'bob', orgASet, []), false);
    });

    await t('non-owner same-org user on published, no group restriction → true', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(publishedA, 'bob', orgASet, []), true);
    });

    await t('non-owner on published group-restricted KB → only with group membership', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(publishedGroupA, 'bob', orgASet, ['group-A1']), true);
        assert.strictEqual(kbStore.canUserAccessKB(publishedGroupA, 'bob', orgASet, []), false);
    });

    await t('cross-org user on published KB → false', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(publishedA, 'eve', orgBSet, []), false);
    });

    await t('owner and super admin still read drafts', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'alice', orgASet, []), true);
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'root', null, []), true);
    });

    // ── canUserAccessKB org-admin read access ───────────────────
    console.log('--- canUserAccessKB (org admin sees all org KBs) ---');

    await t('org admin sees foreign org DRAFT → true', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'bob', orgASet, [], { isOrgAdmin: true }), true);
    });

    await t('org admin sees foreign group-restricted KB without group membership → true', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(publishedGroupA, 'bob', orgASet, [], { isOrgAdmin: true }), true);
    });

    await t('org admin does NOT see a KB outside their org → false', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'eve', orgBSet, [], { isOrgAdmin: true }), false);
    });

    await t("org admin does NOT see a member's personal (no-org) KB → false", async () => {
        assert.strictEqual(kbStore.canUserAccessKB(personalDraft, 'bob', orgASet, [], { isOrgAdmin: true }), false);
    });

    await t('isOrgAdmin:false behaves exactly like before (drafts hidden) → false', async () => {
        assert.strictEqual(kbStore.canUserAccessKB(draftA, 'bob', orgASet, [], { isOrgAdmin: false }), false);
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
