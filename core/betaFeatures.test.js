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

// The beta helpers are now THIN WRAPPERS that delegate to the unified resolver
// (server/core/entitlements.js). The resolution math itself is covered by
// core/entitlements.test.js; here we monkeypatch the resolver's two entry points
// so we can assert (a) the wrappers delegate with the right capId/context, and
// (b) orphan ids without a registry row still take the legacy allow-list path.
// `ent.registry` is left as the REAL registry so getCapability() drives the
// registry-vs-orphan branch exactly as in production.
const ent = require('./entitlements');
let mockHasCapability = async () => false;
let requireCapabilityCalls = [];
ent.hasCapability = async (capId, ctx) => mockHasCapability(capId, ctx);
ent.requireCapability = (capId) => {
    requireCapabilityCalls.push(capId);
    return async (req, res, next) => {
        const ok = await mockHasCapability(capId, {
            userId: req.session?.user?.id,
            orgId: req.session?.user?.organizationId,
            session: req.session,
            req,
        });
        if (ok) return next();
        // requireCapability's real deny vocabulary (feature_locked vs
        // feature_disabled) is asserted in entitlements.test.js; the sentinel
        // just needs a deny path for the delegation assertions below.
        return res.status(403).json({ error: 'feature_disabled', feature: capId });
    };
};

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

    // Community tier → only the GA features whose licence feature is in the
    // Community tier (the n8n-style free builder — automations + agent_routines —
    // plus the Learning Center, also free Community core), even when the org has
    // *enterprise* betas both allowed and active. The set is derived from the
    // registry + the licence tier, so it ignores the org allow-list below the floor.
    resetMocks();
    mockTier = 'community';
    mockOrgBetaFeatures = ['meeting_notes', 'voice_chat'];
    mockOrgActiveFeatures = ['meeting_notes', 'voice_chat'];
    let features = await beta.getUserBetaFeatures('u1', { user: mockUser });
    assert.deepStrictEqual(features.sort(), ['agent_routines', 'automations', 'learning_center'],
        'community must yield exactly the Community GA features');
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

    // ── userHasBetaFeature / orgHasBetaFeature — delegation to the resolver ──
    // Registry-backed ids resolve through ent.hasCapability (the single source of
    // truth, tested in entitlements.test.js). Here we assert the wrappers forward
    // the right capId/context and return the resolver's verdict verbatim.
    resetMocks();
    let seen = [];
    mockHasCapability = async (capId, ctx) => { seen.push({ capId, ctx }); return capId === 'webpages'; };
    assert.strictEqual(await beta.userHasBetaFeature('u1', 'webpages', { user: { id: 'u1', organizationId: 'org1' } }), true,
        'userHasBetaFeature delegates: webpages → resolver true');
    assert.strictEqual(await beta.userHasBetaFeature('u1', 'voice_chat', { user: { id: 'u1', organizationId: 'org1' } }), false,
        'userHasBetaFeature delegates: voice_chat → resolver false');
    assert.ok(seen.some(s => s.capId === 'webpages' && s.ctx.userId === 'u1' && s.ctx.orgId === 'org1'),
        'userHasBetaFeature passes userId + session-derived orgId to the resolver');

    resetMocks();
    seen = [];
    mockHasCapability = async (capId, ctx) => { seen.push({ capId, ctx }); return capId === 'webpages'; };
    assert.strictEqual(await beta.orgHasBetaFeature('org1', 'webpages'), true,
        'orgHasBetaFeature delegates: webpages → resolver true');
    assert.strictEqual(await beta.orgHasBetaFeature('org1', 'swarm'), false,
        'orgHasBetaFeature delegates: swarm → resolver false');
    assert.ok(seen.some(s => s.capId === 'webpages' && s.ctx.orgId === 'org1'),
        'orgHasBetaFeature passes orgId to the resolver');

    // Background user-based lookup (null session) resolves the user's primary org
    // so the org grant layer is populated (mirrors the legacy org sweep).
    resetMocks();
    seen = [];
    mockUser = { id: 'u1', organizationId: 'org9', role: 'member', groups: '[]' };
    mockHasCapability = async (capId, ctx) => { seen.push(ctx); return true; };
    await beta.userHasBetaFeature('u1', 'webpages', null);
    assert.strictEqual(seen[0]?.orgId, 'org9',
        'null-session userHasBetaFeature resolves the user primary org for the resolver');

    // ── Orphan id (no registry row, e.g. 'templates') keeps the legacy allow-
    //    list path — the resolver can't express it, so getUserBetaFeatures owns it.
    resetMocks();
    mockTier = 'enterprise';
    mockOrgBetaFeatures = ['templates'];
    mockOrgActiveFeatures = ['templates'];
    mockHasCapability = async () => { throw new Error('resolver must NOT be consulted for orphan ids'); };
    assert.strictEqual(await beta.userHasBetaFeature('u1', 'templates', { user: mockUser }), true,
        'orphan templates uses the legacy allow-list membership (resolver not consulted)');
    resetMocks();
    mockTier = 'enterprise';
    mockOrgBetaFeatures = [];
    mockOrgActiveFeatures = [];
    assert.strictEqual(await beta.userHasBetaFeature('u1', 'templates', { user: mockUser }), false,
        'orphan templates false when not in the org allow-list');

    // ── requireBetaFeature — delegation + orphan fallback ────────────────────
    // Registry id → returns the unified requireCapability gate.
    resetMocks();
    requireCapabilityCalls = [];
    mockHasCapability = async (capId) => capId === 'meeting_notes';
    {
        const gate = beta.requireBetaFeature('meeting_notes');
        assert.ok(requireCapabilityCalls.includes('meeting_notes'),
            'requireBetaFeature(registry id) delegates to requireCapability');
        const req = { session: { user: { id: 'u1', organizationId: 'org1' } } };
        const res = buildRes();
        let nextCalled = false;
        await gate(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, true, 'granted capability reaches the handler');
    }
    // Denied → the unified gate responds (no legacy prose string).
    resetMocks();
    mockHasCapability = async () => false;
    {
        const gate = beta.requireBetaFeature('meeting_notes');
        const req = { session: { user: { id: 'u1', organizationId: 'org1' } } };
        const res = buildRes();
        let nextCalled = false;
        await gate(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false, 'denied capability blocks the handler');
        assert.strictEqual(res.statusCode, 403);
    }
    // Orphan id → legacy middleware (membership-based next / prose 403).
    resetMocks();
    mockTier = 'enterprise';
    mockOrgBetaFeatures = [];
    mockOrgActiveFeatures = [];
    {
        const req = { session: { user: { id: 'u1', organizationId: 'org1' } } };
        const res = buildRes();
        let nextCalled = false;
        await beta.requireBetaFeature('templates')(req, res, () => { nextCalled = true; });
        assert.strictEqual(nextCalled, false, 'orphan templates not in allow-list → blocked');
        assert.strictEqual(res.statusCode, 403);
        assert.match(res.body?.error || '', /not enabled for your organization/,
            'orphan fallback keeps the legacy ask-your-admin message');
    }

    console.log('✓ core/betaFeatures.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ core/betaFeatures.test.js failed:', err);
    process.exit(1);
});
