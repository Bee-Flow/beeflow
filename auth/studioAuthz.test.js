/**
 * Studio Authorization Helper Tests
 *
 * Covers the two helpers that gate studio create/publish endpoints:
 *   - assertUserCanUseOrg(req, orgId)
 *   - validateSharedGroupsForOrg(orgId, sharedGroupIds)
 *
 * Run: node auth/studioAuthz.test.js
 */

const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';

// ── Mock userStore ────────────────────────────────────────────────
const users = {};
const groups = [];

const mockUserStore = {
    getUser: async (id) => users[id] || null,
    getAllGroups: async () => groups,
    getAllRoles: async () => [],
};

const Module = require('module');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === '../stores/userStore') return 'mock-userStore';
    return originalResolve.call(this, request, parent, ...rest);
};
require.cache['mock-userStore'] = { id: 'mock-userStore', exports: mockUserStore };

const permissions = require('./permissions');

// ── Test scaffold ─────────────────────────────────────────────────
async function run() {
    let passed = 0, failed = 0;
    async function t(name, fn) {
        try { await fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
    }

    function reqFor(userId) {
        return { session: { user: users[userId], isAuthenticated: true, isAdmin: users[userId]?.role === 'admin' } };
    }

    // ── Seed two orgs, three users ───────────────────────────────
    users['superadmin'] = { id: 'superadmin', role: 'admin', orgRole: '', organizationId: '', groups: [] };
    users['alice']     = { id: 'alice',     role: 'user',  orgRole: 'org_admin', organizationId: 'orgA', groups: [] };
    users['bob']       = { id: 'bob',       role: 'user',  orgRole: 'member',    organizationId: 'orgB', groups: [] };
    users['carol']     = { id: 'carol',     role: 'user',  orgRole: 'member',    organizationId: '',     groups: ['group-A1', 'group-B1'] };

    groups.length = 0;
    groups.push({ id: 'group-A1', name: 'A1', organizationId: 'orgA', permissions: [], roles: [] });
    groups.push({ id: 'group-A2', name: 'A2', organizationId: 'orgA', permissions: [], roles: [] });
    groups.push({ id: 'group-B1', name: 'B1', organizationId: 'orgB', permissions: [], roles: [] });

    console.log('\n🔐 Studio Authorization Helper Tests\n');

    // ── assertUserCanUseOrg ─────────────────────────────────────
    console.log('--- assertUserCanUseOrg ---');

    await t('returns user primary org when orgId omitted', async () => {
        const orgId = await permissions.assertUserCanUseOrg(reqFor('alice'), undefined);
        assert.strictEqual(orgId, 'orgA');
    });

    await t('returns explicit orgId when user belongs to it', async () => {
        const orgId = await permissions.assertUserCanUseOrg(reqFor('alice'), 'orgA');
        assert.strictEqual(orgId, 'orgA');
    });

    await t('rejects when user does not belong to the requested org', async () => {
        await assert.rejects(
            () => permissions.assertUserCanUseOrg(reqFor('alice'), 'orgB'),
            (err) => err.status === 403
        );
    });

    await t('rejects when user has no organisation at all', async () => {
        users['orphan'] = { id: 'orphan', role: 'user', orgRole: '', organizationId: '', groups: [] };
        await assert.rejects(
            () => permissions.assertUserCanUseOrg(reqFor('orphan'), undefined),
            (err) => err.status === 403
        );
    });

    await t('super admin bypasses membership check', async () => {
        const orgId = await permissions.assertUserCanUseOrg(reqFor('superadmin'), 'orgB');
        assert.strictEqual(orgId, 'orgB');
    });

    await t('resolves group-based org membership', async () => {
        // Carol is in group-A1 (orgA) and group-B1 (orgB)
        const orgIdA = await permissions.assertUserCanUseOrg(reqFor('carol'), 'orgA');
        assert.strictEqual(orgIdA, 'orgA');
        const orgIdB = await permissions.assertUserCanUseOrg(reqFor('carol'), 'orgB');
        assert.strictEqual(orgIdB, 'orgB');
    });

    // ── validateSharedGroupsForOrg ──────────────────────────────
    console.log('--- validateSharedGroupsForOrg ---');

    await t('undefined returns undefined (preserve-as-is signal)', async () => {
        const r = await permissions.validateSharedGroupsForOrg('orgA', undefined);
        assert.strictEqual(r, undefined);
    });

    await t('null returns undefined (preserve-as-is signal)', async () => {
        const r = await permissions.validateSharedGroupsForOrg('orgA', null);
        assert.strictEqual(r, undefined);
    });

    await t('empty array returns empty array', async () => {
        const r = await permissions.validateSharedGroupsForOrg('orgA', []);
        assert.deepStrictEqual(r, []);
    });

    await t('rejects non-array', async () => {
        await assert.rejects(
            () => permissions.validateSharedGroupsForOrg('orgA', 'not-an-array'),
            (err) => err.status === 400
        );
    });

    await t('accepts groups that belong to the org', async () => {
        const r = await permissions.validateSharedGroupsForOrg('orgA', ['group-A1', 'group-A2']);
        assert.deepStrictEqual([...r].sort(), ['group-A1', 'group-A2']);
    });

    await t('rejects groups from a different org', async () => {
        await assert.rejects(
            () => permissions.validateSharedGroupsForOrg('orgA', ['group-A1', 'group-B1']),
            (err) => err.status === 400 && /group-B1/.test(err.message)
        );
    });

    await t('rejects non-existent group ids', async () => {
        await assert.rejects(
            () => permissions.validateSharedGroupsForOrg('orgA', ['group-A1', 'group-ghost']),
            (err) => err.status === 400 && /group-ghost/.test(err.message)
        );
    });

    await t('rejects when orgId is null/empty', async () => {
        await assert.rejects(
            () => permissions.validateSharedGroupsForOrg(null, ['group-A1']),
            (err) => err.status === 400
        );
    });

    await t('dedupes duplicate ids', async () => {
        const r = await permissions.validateSharedGroupsForOrg('orgA', ['group-A1', 'group-A1', 'group-A2']);
        assert.deepStrictEqual([...r].sort(), ['group-A1', 'group-A2']);
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run().catch(e => { console.error(e); process.exit(1); });
