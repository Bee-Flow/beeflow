/**
 * Unit tests — cloud beta-feature resolution (subscription is LEADING).
 *
 * On cloud (serverLicenseGovernsOrgs() === false) there is no enterprise tier
 * floor and no org-admin opt-in: a beta in the org's SUBSCRIPTION allow-list
 * (the plan's allowed_beta_features) is enabled for the whole org, full stop.
 * The org-admin "active subset" (org_enabled_beta_features) is non-load-bearing
 * here. This complements core/betaFeatures.test.js which pins the SELF-HOSTED
 * tier-floor + opt-in behaviour.
 *
 * Run: node core/betaFeatures.cloud.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

const licensePath = path.resolve(__dirname, '..', 'license');
const userStorePath = path.resolve(__dirname, '..', 'stores', 'userStore');
const dbPath = path.resolve(__dirname, '..', 'db');

let mockUser = { id: 'u1', organizationId: 'org1', role: 'member', groups: '[]' };
let mockPlanBeta = ['webpages'];      // plan.allowed_beta_features (null = unrestricted)
let mockOrgActiveFeatures = [];        // org-admin active subset — must be IGNORED on cloud

const tiersStub = require('../license/tiers');

const licenseStub = {
    tiers: tiersStub,
    // Cloud: server-wide licence does NOT govern per-org billing.
    serverLicenseGovernsOrgs() { return false; },
    getServerLicenseVersion() { return 0; },
    COMMUNITY_FALLBACK: 'community',
    async resolveTier() { return 'community'; }, // Free plan → community; must not matter on cloud
};

const userStoreStub = {
    async getUser() { return mockUser; },
    async getAllGroups() { return []; },
    async getOrgEnabledBetaFeatures() { return mockOrgActiveFeatures; },
    async getOrgSubscription(orgId) { return { plan_id: 'plan1', organization_id: orgId }; },
    async getPlan() { return { id: 'plan1', allowed_beta_features: mockPlanBeta }; },
};

const dbStub = {
    async exec() { return null; },
    async getOne() { return { beta_features: '[]' }; },
    async run() { return null; },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (resolved === licensePath + '.js' || resolved === licensePath + '/index.js') return licenseStub;
        if (resolved === userStorePath + '.js' || resolved === userStorePath + '/index.js') return userStoreStub;
        if (resolved === dbPath + '.js' || resolved === dbPath + '/index.js') return dbStub;
    } catch (_) { /* fall through */ }
    return originalLoad(request, parent, isMain);
};

const beta = require('./betaFeatures');

function reset() {
    mockUser = { id: 'u1', organizationId: 'org1', role: 'member', groups: '[]' };
    mockPlanBeta = ['webpages'];
    mockOrgActiveFeatures = [];
}

(async () => {
    // 1. Plan grants webpages, org-admin never opted in (active=[]) → still on.
    reset();
    let features = await beta.getUserBetaFeatures('u1', { user: mockUser });
    assert.ok(features.includes('webpages'),
        'cloud: a plan-granted beta is on even with an empty org active subset');
    assert.strictEqual(await beta.userHasBetaFeature('u1', 'webpages'), true,
        'cloud: userHasBetaFeature true for a plan-granted beta');

    // 2. orgHasBetaFeature (background path) agrees.
    reset();
    assert.strictEqual(await beta.orgHasBetaFeature('org1', 'webpages'), true,
        'cloud: orgHasBetaFeature true for a plan-granted beta, active subset ignored');

    // 3. Unrestricted plan (null) → every registry beta is on.
    reset();
    mockPlanBeta = null;
    features = await beta.getUserBetaFeatures('u1', { user: mockUser });
    assert.strictEqual(features.length, beta.BETA_FEATURES.length,
        'cloud: a null (unrestricted) plan grants every beta in the registry');

    // 4. Downgrade — plan no longer lists webpages → revoked live, no re-seed.
    reset();
    mockPlanBeta = [];                       // plan grants nothing
    mockOrgActiveFeatures = ['webpages'];    // stale org opt-in must NOT keep it alive
    features = await beta.getUserBetaFeatures('u1', { user: mockUser });
    assert.ok(!features.includes('webpages'),
        'cloud: a beta dropped from the plan is revoked even if still in the stale active subset');
    assert.strictEqual(await beta.orgHasBetaFeature('org1', 'webpages'), false,
        'cloud: orgHasBetaFeature false once the plan drops the beta');

    // 5. Super-admin still bypasses everything.
    reset();
    mockPlanBeta = [];
    features = await beta.getUserBetaFeatures('u1', { isAdmin: true, user: mockUser });
    assert.strictEqual(features.length, beta.BETA_FEATURES.length,
        'cloud: super-admin receives every beta regardless of plan');

    console.log('✓ core/betaFeatures.cloud.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ core/betaFeatures.cloud.test.js failed:', err);
    process.exit(1);
});
