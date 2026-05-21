/**
 * Integration smoke — Playwright Tests beta gating.
 *
 * Exercises the same primed-cache pattern as communityEnforcement.test.js:
 *   - community tier MUST 403 with `feature_locked` and required: 'enterprise'
 *   - legacy `pro` tier MUST behave identically to enterprise (license alias)
 *   - enterprise tier passes the licence gate (the beta opt-in step is
 *     tested separately in core/betaFeatures.test.js)
 *
 * Run:
 *   node server/license/playwrightTests.test.js
 */

const assert = require('assert');
const { requireFeature } = require('./middleware');
const license = require('./index');

const FEATURE = 'playwright_tests';
const RESOLUTION_TTL_MS = 60_000;

function buildReq({ tier, userId = 'u1' }) {
    const cached = {
        expiresAt: Date.now() + RESOLUTION_TTL_MS,
        value: { tier, orgIds: [], userTier: tier, orgTiers: {}, spread: null },
    };
    const ver = license.getServerLicenseVersion();
    return {
        session: {
            isAuthenticated: true,
            user: { id: userId, organizationId: null },
            [`_lic:${userId}:v${ver}`]: cached,
        },
    };
}

function buildRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

async function runGate(tier) {
    const gate = requireFeature(FEATURE);
    const req = buildReq({ tier });
    const res = buildRes();
    let calledNext = false;
    await gate(req, res, () => { calledNext = true; });
    return { res, calledNext };
}

(async () => {
    {
        const { res, calledNext } = await runGate('community');
        assert.strictEqual(calledNext, false, 'community MUST NOT reach handler');
        assert.strictEqual(res.statusCode, 403);
        assert.strictEqual(res.body?.error, 'feature_locked');
        assert.strictEqual(res.body?.feature, FEATURE);
        assert.strictEqual(res.body?.required, 'enterprise');
        assert.ok(typeof res.body?.upgrade_url === 'string' && res.body.upgrade_url.length > 0);
    }
    {
        const { res, calledNext } = await runGate('enterprise');
        assert.strictEqual(calledNext, true, 'enterprise MUST reach handler');
        assert.strictEqual(res.statusCode, null);
    }
    {
        const { res, calledNext } = await runGate('pro');
        assert.strictEqual(calledNext, true, 'legacy pro MUST inherit enterprise');
        assert.strictEqual(res.statusCode, null);
    }

    console.log('✓ server/license/playwrightTests.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ playwrightTests.test.js failed:', err);
    process.exit(1);
});
