/**
 * Integration smoke — community-tier feature gating.
 *
 * Mounts the `requireFeature(name)` middleware against a fake handler and
 * asserts that every Studio-class feature promoted in the tier tightening
 * (voice_chat, webpages, automations, meeting_notes, ticket_assistant,
 * component_designer, notebooks) returns the documented `feature_locked`
 * 403 body on a community session and reaches the handler on an
 * enterprise session.
 *
 * The licence-middleware cache (`req.session._lic:<userId>`) is primed
 * directly so we don't have to stand up the DB.
 *
 * Run: node server/license/communityEnforcement.test.js
 */

const assert = require('assert');
const { requireFeature } = require('./middleware');
const license = require('./index');

const FEATURES = [
    'voice_chat',
    'webpages',
    'meeting_notes',
    'ticket_assistant',
    'component_designer',
    'notebooks',
    'projects',
    'pii_tokenize',
    'web_search_guard',
    'advanced_usage_monitoring',
    'playwright_tests',
    // n8n-style free builder: `automations` + `agent_routines` are NOT here —
    // they moved to the Community core (building is free). The paid boundary is
    // org-wide automation SHARING (`automation_sharing`, below) and team
    // workspaces (`projects`, above), which must still 403 on community.
    'automation_sharing',
    // Enforcement pass: every other enterprise feature must 403 on community
    // too. mcp_marketplace moved out of community (it's an enterprise beta);
    // sso_saml gates Google/Microsoft/SAML (Nextcloud OAuth stays community);
    // guardrails_dlp / audit_log_export / swarm / advanced_analytics /
    // custom_themes are enterprise capabilities with server gates.
    'mcp_marketplace',
    'sso_saml',
    'guardrails_dlp',
    'audit_log_export',
    'swarm',
    'advanced_analytics',
    'custom_themes',
];

const RESOLUTION_TTL_MS = 60_000;

function buildReq({ tier, userId = 'u1' }) {
    const cached = {
        expiresAt: Date.now() + RESOLUTION_TTL_MS,
        value: { tier, orgIds: [], userTier: tier, orgTiers: {}, spread: null },
    };
    // The licence-middleware cache key is versioned by the install-wide
    // server-licence counter so a server-wide activation invalidates every
    // session's cache. Match it here so the primed entry actually hits.
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

async function runGate(featureName, tier) {
    const gate = requireFeature(featureName);
    const req = buildReq({ tier });
    const res = buildRes();
    let calledNext = false;
    await gate(req, res, () => { calledNext = true; });
    return { res, calledNext };
}

(async () => {
    // ── Community tier: every promoted feature must 403 with the
    //    documented feature_locked body. ───────────────────────────────
    for (const feature of FEATURES) {
        const { res, calledNext } = await runGate(feature, 'community');
        assert.strictEqual(calledNext, false, `${feature}: community must NOT reach handler`);
        assert.strictEqual(res.statusCode, 403, `${feature}: expected 403, got ${res.statusCode}`);
        assert.strictEqual(res.body?.error, 'feature_locked', `${feature}: wrong error code`);
        assert.strictEqual(res.body?.feature, feature, `${feature}: body.feature must echo the gate`);
        assert.strictEqual(res.body?.required, 'enterprise', `${feature}: should require enterprise`);
        assert.ok(typeof res.body?.upgrade_url === 'string' && res.body.upgrade_url.length > 0,
            `${feature}: upgrade_url must be present so the frontend can route the CTA`);
    }

    // ── Enterprise tier: every promoted feature reaches the handler. ─
    for (const feature of FEATURES) {
        const { res, calledNext } = await runGate(feature, 'enterprise');
        assert.strictEqual(calledNext, true, `${feature}: enterprise must reach handler`);
        assert.strictEqual(res.statusCode, null, `${feature}: enterprise must not write a response`);
    }

    // ── Legacy `pro` tier: must behave identically to enterprise
    //    (LEGACY_TIER_ALIAS regression guard for paying Pro customers). ─
    for (const feature of FEATURES) {
        const { res, calledNext } = await runGate(feature, 'pro');
        assert.strictEqual(calledNext, true, `${feature}: legacy pro must inherit enterprise`);
        assert.strictEqual(res.statusCode, null, `${feature}: legacy pro must not 403`);
    }

    // ── Community keeps the core: chat_basic / skills / kb_unlimited
    //    / multi_user / nextcloud_basic / nextcloud_oauth must NOT fall behind
    //    the gate, and neither may the built-in integrations or the MCP
    //    marketplace — `integrations` + `mcp_marketplace` are Community
    //    capability markers, so requireFeature(...) must pass through on a
    //    community session. This is the regression guard that pins
    //    "Community keeps all integrations + MCP" and "NC App Store login
    //    works on Community" (nextcloud_oauth).
    //    `automations` + `agent_routines` are the n8n-style free builder —
    //    Community must keep them (building is free; sharing is paid).
    //    (projects, pii_tokenize, web_search_guard and advanced_usage_monitoring
    //    were promoted to Enterprise in earlier waves.)
    for (const feature of ['chat_basic', 'skills', 'kb_unlimited', 'multi_user', 'nextcloud_basic', 'nextcloud_oauth', 'integrations', 'automations', 'agent_routines']) {
        const { res, calledNext } = await runGate(feature, 'community');
        assert.strictEqual(calledNext, true, `${feature}: community must keep this`);
        assert.strictEqual(res.statusCode, null, `${feature}: community core must not 403`);
    }

    // ── And the inverse: the paid COLLABORATION boundary on top of the free
    //    builder must STILL be locked on community, so demoting the builder
    //    didn't widen the gate. `automation_sharing` (org-wide sharing of
    //    automations/routines) + `projects` (team workspaces) are the
    //    collaboration features that sit ABOVE the free personal builder. They
    //    must 403.
    for (const feature of ['automation_sharing', 'projects']) {
        const { res, calledNext } = await runGate(feature, 'community');
        assert.strictEqual(calledNext, false, `${feature}: collaboration must stay Enterprise on community`);
        assert.strictEqual(res.statusCode, 403, `${feature}: collaboration must 403 on community`);
    }

    // ── Server-licence version bump invalidates per-session cache ─────
    // A super-admin flipping a server-wide licence must immediately
    // re-tier every existing session. We simulate this by priming a
    // community-tier cache entry at version N, bumping the counter, and
    // asserting the NEW request at version N+1 misses the stale entry.
    // (The middleware will then resolve fresh — but the resolver has no
    // fake store here, so it falls through to community. The point is
    // simply: the same cache entry MUST NOT keep granting community
    // after a bump.)
    {
        const feature = 'voice_chat';
        const gate = requireFeature(feature);
        const userId = 'u_bump';

        const verBefore = license.getServerLicenseVersion();
        const reqPrimed = {
            session: {
                isAuthenticated: true,
                user: { id: userId, organizationId: null },
                [`_lic:${userId}:v${verBefore}`]: {
                    expiresAt: Date.now() + 60_000,
                    value: { tier: 'enterprise', orgIds: [], userTier: 'enterprise', orgTiers: {}, spread: null },
                },
            },
        };
        const res1 = buildRes();
        let next1 = false;
        await gate(reqPrimed, res1, () => { next1 = true; });
        assert.strictEqual(next1, true, 'before bump: primed enterprise cache wins → handler runs');

        // Flip the version. The same session object now points at a stale
        // key (v=verBefore) that the middleware will no longer read; the
        // versioned key it DOES read (v=verBefore+1) is absent → fresh
        // resolution → community fallback → 403.
        license.bumpServerLicenseVersion();
        const res2 = buildRes();
        let next2 = false;
        await gate(reqPrimed, res2, () => { next2 = true; });
        assert.strictEqual(next2, false, 'after bump: stale cache MUST NOT grant access');
        assert.strictEqual(res2.statusCode, 403,
            'after bump: gate must re-resolve and 403 on community fallback');
    }

    console.log('✓ license/communityEnforcement.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ license/communityEnforcement.test.js failed:', err);
    process.exit(1);
});
