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

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed === 0 ? 0 : 1);
}

run();
