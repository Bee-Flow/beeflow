/**
 * Unit tests — beta-feature tier short-circuit.
 *
 * Beta features are an enterprise+ benefit. On community tier every beta
 * opt-in must silently deny (returns `[]` from getUserBetaFeatures, `false`
 * from orgHasBetaFeature, structured `feature_locked` 403 from the
 * requireBetaFeature middleware). Super-admins continue to bypass.
 *
 * We mock just enough of `../license` and `../stores/userStore` to exercise
 * the tier logic without standing up Postgres. The module cache is primed
 * BEFORE requiring `./betaFeatures` because its lazy `_licenseModule()`
 * helper resolves the licence module via require() the first time it's
 * called.
 *
 * Run: node core/betaFeatures.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

// ── Mock injection ──────────────────────────────────────────────────────
//
// Override `require` for the two module IDs betaFeatures.js loads at
// runtime. We can't use jest mocks (no jest in this suite) so we hook
// Module._load directly — same approach the rest of the server-side unit
// tests take. Resolved paths are absolute so a `require('../license')`
// from inside core/betaFeatures.js maps to the same key.
const licensePath = path.resolve(__dirname, '..', 'license');
const userStorePath = path.resolve(__dirname, '..', 'stores', 'userStore');

let mockTier = 'community';
let mockResolveThrows = false;
let mockUser = { id: 'u1', organizationId: 'org1', role: 'member', groups: '[]' };
let mockOrgBetaFeatures = []; // super-admin allow-list
let mockOrgActiveFeatures = []; // org-admin active subset
let mockAllGroups = [];

const tiersStub = require('../license/tiers');

const licenseStub = {
    tiers: tiersStub,
    // This suite exercises the SELF-HOSTED tier-floor path — "beta features are
    // an enterprise+ benefit" only applies where a server-wide licence governs
    // every org. On cloud (serverLicenseGovernsOrgs() === false) beta access is
    // decided purely by the org subscription/allow-list and the floor is not
    // applied, so the stub asserts the self-hosted behaviour explicitly.
    serverLicenseGovernsOrgs() { return true; },
    COMMUNITY_FALLBACK: 'community',
    async resolveTier({ organizationId, userId } = {}) {
        if (mockResolveThrows) throw new Error('simulated tier lookup failure');
        return mockTier;
    },
};

const userStoreStub = {
    async getUser(id) { return mockUser; },
    async getAllGroups() { return mockAllGroups; },
    async getOrgEnabledBetaFeatures(orgId) { return mockOrgActiveFeatures; },
};

// Hook Module._load. Only intercept the two IDs we need to swap; everything
// else falls through to the real resolver.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (resolved === licensePath + '.js' || resolved === licensePath + '/index.js') return licenseStub;
        if (resolved === userStorePath + '.js' || resolved === userStorePath + '/index.js') return userStoreStub;
    } catch (_) { /* ignore resolution errors, fall through */ }
    return originalLoad(request, parent, isMain);
};

// Also override the DB module so requiring betaFeatures doesn't touch
// Postgres at module load (it lazily requires `../db` but exec/run/getOne
// can be called from ensureColumn / getOrgBetaFeatures).
const dbPath = path.resolve(__dirname, '..', 'db');
const dbStub = {
    async exec(_q) { return null; },
    async getOne(_q, _p) {
        return { beta_features: JSON.stringify(mockOrgBetaFeatures) };
    },
    async run(_q, _p) { return null; },
};
const originalLoad2 = Module._load;
Module._load = function patchedLoad2(request, parent, isMain) {
    try {
        const resolved = Module._resolveFilename(request, parent, isMain);
        if (resolved === dbPath + '.js' || resolved === dbPath + '/index.js') return dbStub;
    } catch (_) { /* ignore */ }
    return originalLoad2(request, parent, isMain);
};

const beta = require('./betaFeatures');

// ── Fixtures ────────────────────────────────────────────────────────────
function resetMocks() {
    mockTier = 'community';
    mockResolveThrows = false;
    mockUser = { id: 'u1', organizationId: 'org1', role: 'member', groups: '[]' };
    mockOrgBetaFeatures = [];
    mockOrgActiveFeatures = [];
    mockAllGroups = [];
}

function buildRes() {
    return {
        statusCode: null,
        body: null,
        headers: {},
        set(name, val) { this.headers[name] = val; return this; },
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

(async () => {
    // ── getUserBetaFeatures ─────────────────────────────────────────────

    // Community tier → only the n8n-style free-builder GA features
    // (automations + agent_routines), even when the org has *enterprise* betas
    // both allowed and active. The free-builder set is derived from the
    // registry + the licence tier (GA betas whose licenceFeature is in the
    // Community tier), so it ignores the org allow-list below the floor.
    resetMocks();
    mockTier = 'community';
    mockOrgBetaFeatures = ['meeting_notes', 'voice_chat'];
    mockOrgActiveFeatures = ['meeting_notes', 'voice_chat'];
    let features = await beta.getUserBetaFeatures('u1', { user: mockUser });
    assert.deepStrictEqual(features.sort(), ['agent_routines', 'automations'],
        'community must yield exactly the free-builder GA features (n8n-style)');
    assert.ok(!features.includes('meeting_notes') && !features.includes('voice_chat'),
        'community must NOT yield enterprise betas even when org-allowed/active');

    // Enterprise tier → returns the intersection.
    resetMocks();
    mockTier = 'enterprise';
    mockOrgBetaFeatures = ['meeting_notes', 'voice_chat'];
    mockOrgActiveFeatures = ['meeting_notes'];
    features = await beta.getUserBetaFeatures('u1', { user: mockUser });
    assert.deepStrictEqual(features.sort(), ['meeting_notes'], 'enterprise returns intersection');

    // Super-admin via session.isAdmin → bypasses tier entirely.
    resetMocks();
    mockTier = 'community';
    features = await beta.getUserBetaFeatures('u1', { isAdmin: true, user: mockUser });
    assert.ok(features.length === beta.BETA_FEATURES.length,
        'super-admin must receive every beta feature regardless of tier');

    // Legacy `pro` tier resolves to enterprise → user sees their features.
    resetMocks();
    mockTier = 'pro';
    mockOrgBetaFeatures = ['webpages'];
    mockOrgActiveFeatures = ['webpages'];
    features = await beta.getUserBetaFeatures('u1', { user: mockUser });
    assert.deepStrictEqual(features.sort(), ['webpages'], 'legacy pro must still get beta features');

    // tierHint short-circuits the resolve.
    resetMocks();
    mockTier = 'enterprise'; // would allow, but...
    mockResolveThrows = true; // resolve would throw — hint must save us
    mockOrgBetaFeatures = ['voice_chat'];
    mockOrgActiveFeatures = ['voice_chat'];
    features = await beta.getUserBetaFeatures('u1', { user: mockUser }, { tierHint: 'enterprise' });
    assert.deepStrictEqual(features.sort(), ['voice_chat'],
        'tierHint must bypass resolveTier; no throw expected');

    // ── orgHasBetaFeature ────────────────────────────────────────────────

    // Community → false even when both lists include it.
    resetMocks();
    mockTier = 'community';
    mockOrgBetaFeatures = ['webpages'];
    mockOrgActiveFeatures = ['webpages'];
    assert.strictEqual(await beta.orgHasBetaFeature('org1', 'webpages'), false,
        'orgHasBetaFeature must return false on community');

    // Enterprise + allow + active → true.
    resetMocks();
    mockTier = 'enterprise';
    mockOrgBetaFeatures = ['webpages'];
    mockOrgActiveFeatures = ['webpages'];
    assert.strictEqual(await beta.orgHasBetaFeature('org1', 'webpages'), true,
        'orgHasBetaFeature must return true when tier+allow+active align');

    // Background callers fail quiet on tier-resolve failure.
    resetMocks();
    mockResolveThrows = true;
    assert.strictEqual(await beta.orgHasBetaFeature('org1', 'webpages'), false,
        'orgHasBetaFeature must fail-quiet (return false) on resolve error');

    // ── requireBetaFeature middleware ────────────────────────────────────

    // Community session → structured feature_locked body with reason.
    resetMocks();
    mockTier = 'community';
    mockOrgBetaFeatures = ['meeting_notes'];
    mockOrgActiveFeatures = ['meeting_notes'];
    {
        const req = { session: { user: { id: 'u1', organizationId: 'org1' } } };
        const res = buildRes();
        let nextCalled = false;
        await beta.requireBetaFeature('meeting_notes')(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false, 'community must NOT pass beta middleware');
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.body?.error, 'feature_locked');
        assert.strictEqual(res.body?.feature, 'meeting_notes');
        assert.strictEqual(res.body?.reason, 'beta_requires_enterprise');
        assert.strictEqual(res.body?.required, 'enterprise');
        assert.ok(typeof res.body?.upgrade_url === 'string' && res.body.upgrade_url.length > 0,
            'upgrade_url must be present');
    }

    // Enterprise session with org-admin opt-in → next() called.
    resetMocks();
    mockTier = 'enterprise';
    mockOrgBetaFeatures = ['meeting_notes'];
    mockOrgActiveFeatures = ['meeting_notes'];
    {
        const req = { session: { user: { id: 'u1', organizationId: 'org1' } } };
        const res = buildRes();
        let nextCalled = false;
        await beta.requireBetaFeature('meeting_notes')(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true, 'enterprise must reach handler');
        assert.strictEqual(res.statusCode, null);
    }

    // Enterprise session WITHOUT org-admin opt-in → old-style 403 (not the
    // feature_locked tier message), so the UI can route to "ask your org
    // admin" rather than "upgrade your plan".
    resetMocks();
    mockTier = 'enterprise';
    mockOrgBetaFeatures = []; // not even allowed
    mockOrgActiveFeatures = [];
    {
        const req = { session: { user: { id: 'u1', organizationId: 'org1' } } };
        const res = buildRes();
        let nextCalled = false;
        await beta.requireBetaFeature('meeting_notes')(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res.statusCode, 403);
        assert.notStrictEqual(res.body?.error, 'feature_locked',
            'enterprise-with-no-org-opt-in must NOT be reported as a tier problem');
        assert.match(res.body?.error || '', /not enabled for your organization/,
            'should return the org-admin-help message');
    }

    console.log('✓ core/betaFeatures.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ core/betaFeatures.test.js failed:', err);
    process.exit(1);
});
