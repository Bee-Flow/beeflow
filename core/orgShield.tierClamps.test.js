/**
 * Unit test for the runtime tier-clamp policy in orgShield.applyTierClampsToShield.
 *
 * Policy (after "honor Tokenize everywhere"): an explicitly-saved
 * `piiDetectionAction:'tokenize'` is NOT downgraded to 'block' on a tier that
 * lacks `pii_tokenize` — so the direct-chat attachment scan (and every other
 * resolveOrgShield consumer) tokenizes files instead of blocking them. The
 * Web Search Guard clamp is unchanged.
 *
 * The license module is mocked via require.cache injection so no DB/license is needed.
 *
 * Run: node server/core/orgShield.tierClamps.test.js
 */

const assert = require('assert');
const path = require('path');

process.env.NODE_ENV = 'test';

// Mock `../license` (resolved from server/core/orgShield.js) as community tier.
const licPath = require.resolve(path.join(__dirname, '..', 'license', 'index.js'));
const licStub = {
    resolveTier: async () => 'community',
    tiers: { tierHasFeature: () => false }, // community lacks pii_tokenize AND web_search_guard
};
require.cache[licPath] = { id: licPath, filename: licPath, loaded: true, exports: licStub };

delete require.cache[require.resolve('./orgShield')];
const { applyTierClampsToShield } = require('./orgShield');

(async () => {
    // Community tier + saved tokenize + web-search-guard on.
    const shield = {
        piiDetectionAction: 'tokenize',
        webSearchGuardEnabled: true,
        webSearchGuardPiiCategories: ['Email'],
        toolPiiPolicy: { external: { blockCategories: ['Email'] }, internal: { blockCategories: [] } },
    };
    await applyTierClampsToShield(shield, { organizationId: 'o1', userId: 'u1' });

    assert.strictEqual(shield.piiDetectionAction, 'tokenize',
        'tokenize must be HONORED on community (no downgrade to block)');
    assert.strictEqual(shield.webSearchGuardEnabled, false,
        'web search guard is still tier-clamped off');
    assert.deepStrictEqual(shield.webSearchGuardPiiCategories, [],
        'web search guard categories cleared');
    assert.deepStrictEqual(shield.toolPiiPolicy.external.blockCategories, [],
        'external tool PII policy cleared (shares the web_search_guard gate)');
    assert.deepStrictEqual(shield.toolPiiPolicy.internal.blockCategories, [],
        'internal tool PII policy left intact');

    console.log('✓ core/orgShield.tierClamps — tokenize honored, web-search-guard clamped');
})().catch(err => { console.error('✗ core/orgShield.tierClamps failed:', err); process.exit(1); });
