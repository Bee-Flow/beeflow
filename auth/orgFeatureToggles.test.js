/**
 * Unit test for the org-admin "active" subset intersection rule.
 *
 * The active set returned to runtime gates must be the intersection of:
 *   - super-admin allow-list (organizations.beta_features / .enabledIntegrations)
 *   - org-admin active list  (organizations.org_enabled_*)
 *
 * Stale entries in the active list must NOT grant access to revoked items.
 *
 * Run: node auth/orgFeatureToggles.test.js
 */

const assert = require('assert');

function intersect(allowed, active) {
    const set = new Set(allowed);
    return active.filter(id => set.has(id));
}

// Mirror of the org-resolution rule used by /auth/me/active-features in
// server/auth/adminRoutes.js (resolveActiveFeaturesContext). Kept here as a
// pure function so we can unit-test the contract without spinning up Express.
//
//   userOrgIds === null         → super admin: first existing org or null
//   userOrgIds is non-empty Set → first member
//   userOrgIds is empty Set     → null
function resolvePrimaryOrg(userOrgIds, allOrgs) {
    if (userOrgIds === null) {
        return Array.isArray(allOrgs) && allOrgs.length > 0 ? allOrgs[0].id : null;
    }
    if (userOrgIds instanceof Set && userOrgIds.size > 0) {
        return Array.from(userOrgIds)[0];
    }
    return null;
}

async function run() {
    let passed = 0, failed = 0;
    function t(name, fn) {
        try { fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
    }

    console.log('\n🧪 Org Feature Toggles — intersection rule\n');

    t('drops items in active that are not in allowed', () => {
        const r = intersect(['a', 'b', 'c'], ['b', 'c', 'd', 'e']);
        assert.deepStrictEqual(r.sort(), ['b', 'c']);
    });

    t('keeps only the overlap when allowed shrinks', () => {
        // Super admin revokes "a"; org admin's active still lists it.
        const r = intersect(['b', 'c'], ['a', 'b']);
        assert.deepStrictEqual(r, ['b']);
    });

    t('empty active = nothing active', () => {
        const r = intersect(['a', 'b'], []);
        assert.deepStrictEqual(r, []);
    });

    t('empty allowed = nothing active even if active is non-empty', () => {
        const r = intersect([], ['a', 'b']);
        assert.deepStrictEqual(r, []);
    });

    t('exact match returns the full set', () => {
        const r = intersect(['a', 'b', 'c'], ['a', 'b', 'c']);
        assert.deepStrictEqual(r.sort(), ['a', 'b', 'c']);
    });

    console.log('\n🧪 Org resolution rule — /auth/me/active-features\n');

    t('super admin (null) picks first existing org', () => {
        const r = resolvePrimaryOrg(null, [{ id: 'orgA' }, { id: 'orgB' }]);
        assert.strictEqual(r, 'orgA');
    });

    t('super admin (null) with no orgs returns null', () => {
        const r = resolvePrimaryOrg(null, []);
        assert.strictEqual(r, null);
    });

    t('regular user with one org returns it', () => {
        const r = resolvePrimaryOrg(new Set(['orgX']), [{ id: 'orgA' }, { id: 'orgX' }]);
        assert.strictEqual(r, 'orgX');
    });

    t('regular user with multiple orgs returns the first', () => {
        const r = resolvePrimaryOrg(new Set(['orgA', 'orgB']), []);
        // Set iteration order = insertion order, so 'orgA' is first.
        assert.strictEqual(r, 'orgA');
    });

    t('user with no orgs (empty Set) returns null even when orgs exist', () => {
        const r = resolvePrimaryOrg(new Set(), [{ id: 'orgA' }]);
        assert.strictEqual(r, null);
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run();
