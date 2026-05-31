/**
 * Unit tests for license/index.js
 *
 * Mocks the store module so no DB is required. Tests focus on tier
 * resolution, the Community fallback, the activation orchestration, and
 * the legacy `pro` → `enterprise` normalisation.
 *
 * Run: node license/index.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');

// ── Generate key for verify.js ──────────────────────────────────────────
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
process.env.LICENSE_PUBLIC_KEY = publicKey;

// ── In-memory store mock ────────────────────────────────────────────────
const fakeStore = {
    _orgs: {},
    _users: {},
    _server: null,
    async getActiveLicenseForOrg(orgId) { return this._orgs[orgId] || null; },
    async getActiveLicenseForUser(userId) { return this._users[userId] || null; },
    async getActiveLicenseForServer() {
        // Mirror the production query: only return when refreshStatus is not
        // expired/revoked (test scenarios deactivate via flag mutation).
        if (!this._server) return null;
        if (this._server.refreshStatus === 'expired' || this._server.refreshStatus === 'revoked') return null;
        return this._server;
    },
    async getActiveLicensesForOrgs(orgIds = []) {
        const out = [];
        for (const id of orgIds) if (this._orgs[id]) out.push(this._orgs[id]);
        return out;
    },
    async upsertLicense(args) {
        const lic = {
            id: args.licenseId,
            organizationId: args.organizationId,
            userId: args.userId,
            scope: args.scope,
            rawToken: args.rawToken,
            tier: args.tier,
            issuer: args.issuer,
            issuedAt: args.issuedAt,
            expiresAt: args.expiresAt,
            billingInterval: args.billingInterval,
            refreshStatus: 'pending',
            metadata: args.metadata || {},
        };
        if (args.scope === 'organization') this._orgs[args.organizationId] = lic;
        else if (args.scope === 'consumer') this._users[args.userId] = lic;
        else if (args.scope === 'server') this._server = lic;
        return lic;
    },
    async deactivateLicense(licenseId) {
        for (const o of Object.values(this._orgs)) if (o && o.id === licenseId) o.refreshStatus = 'expired';
        for (const u of Object.values(this._users)) if (u && u.id === licenseId) u.refreshStatus = 'expired';
        if (this._server && this._server.id === licenseId) this._server.refreshStatus = 'expired';
        return true;
    },
    async logLicenseAudit() { /* noop */ },
};

// In-memory userStore mock — only the methods the subscription-fallback code
// touches need to be present.
const fakeUserStore = {
    _orgSubs: {},
    _consumerSubs: {},
    async getOrgSubscription(orgId) { return this._orgSubs[orgId] || null; },
    async getConsumerSubscription(userId) { return this._consumerSubs[userId] || null; },
};

// Intercept require('./store') and require('../stores/userStore') from any
// file inside server/license/ — store.js requires userStore at the top level
// for its license-keys JOINs, and index.js lazy-requires it for the
// subscription fallback. Both must hit the fake.
const origResolve = Module._resolveFilename;
const LICENSE_DIR = path.sep + path.join('license');
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(LICENSE_DIR + path.sep)) {
        if (request === './store') return path.join(__dirname, '__fake_store__.js');
        if (request === '../stores/userStore') return path.join(__dirname, '__fake_user_store__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
require.cache[path.join(__dirname, '__fake_store__.js')] = {
    id: path.join(__dirname, '__fake_store__.js'),
    filename: path.join(__dirname, '__fake_store__.js'),
    loaded: true,
    exports: fakeStore,
};
require.cache[path.join(__dirname, '__fake_user_store__.js')] = {
    id: path.join(__dirname, '__fake_user_store__.js'),
    filename: path.join(__dirname, '__fake_user_store__.js'),
    loaded: true,
    exports: fakeUserStore,
};

const license = require('./index');

// ── Helper: sign a JWT for tests ────────────────────────────────────────
function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function sign(payload, headerOverrides = {}) {
    const header = { alg: 'RS256', typ: 'JWT', ...headerOverrides };
    const encH = b64url(JSON.stringify(header));
    const encP = b64url(JSON.stringify(payload));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${encH}.${encP}`), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    return `${encH}.${encP}.${b64url(sig)}`;
}

const now = Math.floor(Date.now() / 1000);

// ── Default state: no license = community ───────────────────────────────
(async () => {
    const tier1 = await license.getTierForOrg('org_unknown');
    assert.strictEqual(tier1, 'community');

    const tier2 = await license.getTierForUser('user_unknown');
    assert.strictEqual(tier2, 'community');

    const tier3 = await license.getTierForOrg(null);
    assert.strictEqual(tier3, 'community');

    const status = await license.getLicenseStatus({ organizationId: 'org_unknown' });
    assert.strictEqual(status.tier, 'community');
    assert.strictEqual(status.source, 'default');
    assert.strictEqual(status.license, null);
    assert.ok(status.features.includes('chat_basic'));
    assert.ok(status.features.includes('skills'), 'community keeps skills');
    // n8n-style free builder: automations + agent_routines are Community features
    // (building is free). The paid line is collaboration: automation_sharing +
    // projects stay enterprise.
    assert.ok(status.features.includes('agent_routines'), 'agent_routines is a Community free-builder feature (n8n-style)');
    assert.ok(status.features.includes('automations'), 'automations is a Community free-builder feature (n8n-style)');
    assert.ok(!status.features.includes('automation_sharing'), 'automation sharing is enterprise (collaboration is paid)');
    assert.ok(!status.features.includes('voice_chat'), 'voice_chat was promoted to enterprise');
    assert.ok(!status.features.includes('notebooks'), 'notebooks is enterprise');
    assert.ok(!status.features.includes('projects'), 'projects (team workspaces) was promoted to enterprise (second wave)');
    assert.ok(!status.features.includes('pii_tokenize'), 'pii_tokenize is enterprise (second wave)');
    assert.ok(!status.features.includes('web_search_guard'), 'web_search_guard is enterprise (second wave)');
    assert.ok(!status.features.includes('advanced_usage_monitoring'), 'advanced_usage_monitoring is enterprise (second wave)');
    assert.strictEqual(status.limits.max_users, -1, 'community is uncapped');

    // ── Activate a legacy Pro license → resolves as enterprise ─────────
    const proToken = sign({
        iss: 'license.beeflow.nl',
        sub: 'org_acme',
        tier: 'pro',
        license_id: 'lic_pro_acme',
        iat: now,
        exp: now + 30 * 86400,
        billing_interval: 'monthly',
        features: ['automations', 'voice_chat'],
        max_seats: 25,
    });
    const activated = await license.activateLicense({
        token: proToken,
        organizationId: 'org_acme',
        activatedBy: 'user_admin',
    });
    assert.strictEqual(activated.tier, 'enterprise', 'legacy pro tier must be normalised on the public shape');
    assert.strictEqual(activated.id, 'lic_pro_acme');
    assert.ok(!('rawToken' in activated), 'public license shape must hide rawToken');

    // ── Tier resolves to enterprise (legacy pro normalised) ────────────
    assert.strictEqual(await license.getTierForOrg('org_acme'), 'enterprise');
    assert.strictEqual(await license.hasFeature('org_acme', 'automations'), true);
    assert.strictEqual(await license.hasFeature('org_acme', 'sso_saml'), true, 'enterprise unlocks compliance features');
    assert.strictEqual(await license.hasFeature('org_acme', 'white_label'), false);
    assert.strictEqual(await license.hasTier('org_acme', 'enterprise'), true);
    assert.strictEqual(await license.hasTier('org_acme', 'community'), true);
    assert.strictEqual(await license.hasTier('org_acme', 'full'), false);

    const proStatus = await license.getLicenseStatus({ organizationId: 'org_acme' });
    assert.strictEqual(proStatus.tier, 'enterprise');
    assert.strictEqual(proStatus.source, 'license_key');
    assert.strictEqual(proStatus.license.id, 'lic_pro_acme');
    assert.strictEqual(proStatus.license.tier, 'enterprise', 'license shape exposes normalised tier');
    assert.ok(proStatus.features.includes('automations'));
    assert.ok(proStatus.features.includes('sso_saml'));

    // ── Bogus token rejection ───────────────────────────────────────────
    let threw = false;
    try {
        await license.activateLicense({ token: 'garbage', organizationId: 'org_x' });
    } catch (e) {
        threw = true;
        assert.ok(e.code, 'error should carry a code');
    }
    assert.strictEqual(threw, true, 'invalid token should throw');

    // ── Expired license row → community fallback ───────────────────────
    fakeStore._orgs['org_acme'].refreshStatus = 'expired';
    assert.strictEqual(await license.getTierForOrg('org_acme'), 'community');

    // ── Revoked license row → community fallback ───────────────────────
    fakeStore._orgs['org_acme'].refreshStatus = 'revoked';
    assert.strictEqual(await license.getTierForOrg('org_acme'), 'community');

    // ── License row with past expiresAt → community fallback ───────────
    fakeStore._orgs['org_acme'].refreshStatus = 'active';
    fakeStore._orgs['org_acme'].expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.strictEqual(await license.getTierForOrg('org_acme'), 'community');

    // ── Higher of org/user tiers wins ──────────────────────────────────
    fakeStore._orgs['org_mixed'] = {
        id: 'lic_mixed_org', tier: 'community', refreshStatus: 'active',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    fakeStore._users['user_in_mixed'] = {
        id: 'lic_mixed_user', tier: 'enterprise', refreshStatus: 'active',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    const resolved = await license.resolveTier({
        organizationId: 'org_mixed',
        userId: 'user_in_mixed',
    });
    assert.strictEqual(resolved, 'enterprise');

    // ── Stripe subscription with legacy plan_tier 'pro' → normalised ──
    fakeUserStore._orgSubs['org_saas_pro'] = {
        plan_id: 'plan_pro_eu',
        plan_name: 'Pro',
        plan_tier: 'pro',
        status: 'active',
        payment_status: 'paid',
    };
    assert.strictEqual(await license.getTierForOrg('org_saas_pro'), 'enterprise');
    const saasStatus = await license.getLicenseStatus({ organizationId: 'org_saas_pro' });
    assert.strictEqual(saasStatus.tier, 'enterprise');
    assert.strictEqual(saasStatus.source, 'stripe_subscription');
    assert.strictEqual(saasStatus.license, null);
    assert.ok(saasStatus.subscription, 'subscription shape should be present');
    assert.strictEqual(saasStatus.subscription.tier, 'enterprise', 'subscription shape exposes normalised tier');
    assert.strictEqual(saasStatus.subscription.status, 'active');

    // ── Cancelled subscription falls back to community ─────────────────
    fakeUserStore._orgSubs['org_saas_cancelled'] = {
        plan_id: 'plan_pro_eu',
        plan_name: 'Pro',
        plan_tier: 'pro',
        status: 'cancelled',
        payment_status: 'paid',
    };
    assert.strictEqual(await license.getTierForOrg('org_saas_cancelled'), 'community');

    // ── Trialing subscription within trial window grants tier ──────────
    fakeUserStore._orgSubs['org_saas_trial_active'] = {
        plan_id: 'plan_ent_eu',
        plan_name: 'Enterprise',
        plan_tier: 'enterprise',
        status: 'trialing',
        payment_status: 'trialing',
        trial_end_date: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    assert.strictEqual(await license.getTierForOrg('org_saas_trial_active'), 'enterprise');

    // ── Trialing past trial_end with no payment → community ────────────
    fakeUserStore._orgSubs['org_saas_trial_expired'] = {
        plan_id: 'plan_ent_eu',
        plan_name: 'Enterprise',
        plan_tier: 'enterprise',
        status: 'trialing',
        payment_status: 'none',
        trial_end_date: new Date(Date.now() - 86400000).toISOString(),
    };
    assert.strictEqual(await license.getTierForOrg('org_saas_trial_expired'), 'community');

    // ── License row beats subscription on same org ─────────────────────
    fakeStore._orgs['org_both'] = {
        id: 'lic_both_org', tier: 'enterprise', refreshStatus: 'active',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    fakeUserStore._orgSubs['org_both'] = {
        plan_id: 'plan_pro_eu', plan_name: 'Pro', plan_tier: 'pro',
        status: 'active', payment_status: 'paid',
    };
    // license_keys row exists (enterprise) → it wins over subscription
    assert.strictEqual(await license.getTierForOrg('org_both'), 'enterprise');
    const bothStatus = await license.getLicenseStatus({ organizationId: 'org_both' });
    assert.strictEqual(bothStatus.source, 'license_key');

    // ── Plan-name parsing fallback when plan_tier is missing ───────────
    fakeUserStore._orgSubs['org_legacy_plan'] = {
        plan_id: 'plan_legacy', plan_name: 'Bee Flow Pro Monthly', plan_tier: null,
        status: 'active', payment_status: 'paid',
    };
    // tierFromPlanName parses "Pro" → 'pro', which normalises to 'enterprise'.
    assert.strictEqual(await license.getTierForOrg('org_legacy_plan'), 'enterprise');

    // ── Consumer subscription fallback ─────────────────────────────────
    fakeUserStore._consumerSubs['user_saas_consumer'] = {
        plan_id: 'plan_pro_consumer',
        plan_name: 'Pro Consumer',
        plan_tier: 'pro',
        status: 'active',
        payment_status: 'paid',
    };
    assert.strictEqual(await license.getTierForUser('user_saas_consumer'), 'enterprise');

    // ── getBestTierForOrgs picks up sub-derived tiers ──────────────────
    fakeUserStore._orgSubs['org_in_set_a'] = {
        plan_id: 'plan_pro_eu', plan_name: 'Pro', plan_tier: 'pro',
        status: 'active', payment_status: 'paid',
    };
    const bestForOrgs = await license.getBestTierForOrgs(['org_unknown', 'org_in_set_a']);
    assert.strictEqual(bestForOrgs, 'enterprise');

    // ── resolveTierFromSubscription helper edge cases ──────────────────
    assert.strictEqual(license.resolveTierFromSubscription(null), null);
    assert.strictEqual(license.resolveTierFromSubscription({ status: 'suspended', plan_tier: 'pro' }), null);
    assert.strictEqual(license.resolveTierFromSubscription({ status: 'past_due', plan_tier: 'pro' }), null);
    assert.strictEqual(license.resolveTierFromSubscription({ status: 'active', plan_tier: 'bogus' }), null);
    assert.strictEqual(
        license.resolveTierFromSubscription({ status: 'active', plan_tier: 'pro', payment_status: 'paid' }),
        'enterprise',
        'active pro subscription normalises to enterprise',
    );

    // ── getMaxSeatsForOrg reads from license metadata ──────────────────
    fakeStore._orgs['org_seatcapped'] = {
        id: 'lic_seatcapped', tier: 'enterprise', refreshStatus: 'active',
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        metadata: { max_seats: 10 },
    };
    assert.strictEqual(await license.getMaxSeatsForOrg('org_seatcapped'), 10);
    assert.strictEqual(await license.getMaxSeatsForOrg('org_unknown'), null);
    // Expired license → no seat cap
    fakeStore._orgs['org_seatcapped'].refreshStatus = 'expired';
    assert.strictEqual(await license.getMaxSeatsForOrg('org_seatcapped'), null);

    console.log('✓ license/index.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ license/index.test.js FAILED:', err);
    process.exit(1);
});
