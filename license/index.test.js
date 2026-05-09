/**
 * Unit tests for license/index.js
 *
 * Mocks the store module so no DB is required. Tests focus on tier
 * resolution, the Community fallback, and the activation orchestration.
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
    async getActiveLicenseForOrg(orgId) { return this._orgs[orgId] || null; },
    async getActiveLicenseForUser(userId) { return this._users[userId] || null; },
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
        else this._users[args.userId] = lic;
        return lic;
    },
    async deactivateLicense(licenseId) {
        for (const o of Object.values(this._orgs)) if (o && o.id === licenseId) o.refreshStatus = 'expired';
        for (const u of Object.values(this._users)) if (u && u.id === licenseId) u.refreshStatus = 'expired';
        return true;
    },
    async logLicenseAudit() { /* noop */ },
};

// Intercept require('./store') from license/index.js
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (request === './store' && parent && parent.filename.endsWith(path.join('license', 'index.js'))) {
        return path.join(__dirname, '__fake_store__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
require.cache[path.join(__dirname, '__fake_store__.js')] = {
    id: path.join(__dirname, '__fake_store__.js'),
    filename: path.join(__dirname, '__fake_store__.js'),
    loaded: true,
    exports: fakeStore,
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
    assert.strictEqual(status.limits.max_users, 1);

    // ── Activate a Pro license ──────────────────────────────────────────
    const proToken = sign({
        iss: 'license.beeflow.ai',
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
    assert.strictEqual(activated.tier, 'pro');
    assert.strictEqual(activated.id, 'lic_pro_acme');
    assert.ok(!('rawToken' in activated), 'public license shape must hide rawToken');

    // ── Tier resolves to pro now ────────────────────────────────────────
    assert.strictEqual(await license.getTierForOrg('org_acme'), 'pro');
    assert.strictEqual(await license.hasFeature('org_acme', 'automations'), true);
    assert.strictEqual(await license.hasFeature('org_acme', 'guardrails_dlp'), false);
    assert.strictEqual(await license.hasTier('org_acme', 'pro'), true);
    assert.strictEqual(await license.hasTier('org_acme', 'enterprise'), false);
    assert.strictEqual(await license.hasTier('org_acme', 'community'), true);

    const proStatus = await license.getLicenseStatus({ organizationId: 'org_acme' });
    assert.strictEqual(proStatus.tier, 'pro');
    assert.strictEqual(proStatus.source, 'license_key');
    assert.strictEqual(proStatus.license.id, 'lic_pro_acme');
    assert.ok(proStatus.features.includes('automations'));

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
        id: 'lic_mixed_org', tier: 'pro', refreshStatus: 'active',
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

    console.log('✓ license/index.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ license/index.test.js FAILED:', err);
    process.exit(1);
});
