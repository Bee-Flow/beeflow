/**
 * Unit tests — server-wide licence override.
 *
 * A super-admin can activate ONE licence row with scope='server' that
 * overrides every per-org and per-user tier resolution on this install.
 * These tests pin down the override contract:
 *
 *   - getTierForOrg('any')  → server tier when present, org row otherwise
 *   - getTierForUser('any') → server tier when present, user row otherwise
 *   - getBestTierForOrgs([...]) → server tier wins outright
 *   - getLicenseStatus({...}) → carries `serverOverride: true` and the
 *                                server licence in the `license` field
 *   - bumpServerLicenseVersion() flips the version counter that the
 *     resolution-cache key in license/middleware.js weaves in
 *   - Legacy `tier: 'pro'` server-scope row normalises to enterprise
 *
 * We mock the store via Module._resolveFilename + require.cache, mirroring
 * the pattern already used in index.test.js.
 *
 * Run: node server/license/serverScope.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

const fakeStore = {
    _server: null,
    _orgs: {},
    _users: {},
    async getActiveLicenseForOrg(orgId) { return this._orgs[orgId] || null; },
    async getActiveLicenseForUser(userId) { return this._users[userId] || null; },
    async getActiveLicenseForServer() {
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
            refreshStatus: 'active',
            metadata: args.metadata || {},
        };
        if (args.scope === 'organization') this._orgs[args.organizationId] = lic;
        else if (args.scope === 'consumer') this._users[args.userId] = lic;
        else if (args.scope === 'server') this._server = lic;
        return lic;
    },
    async deactivateLicense(licenseId) {
        if (this._server && this._server.id === licenseId) {
            this._server.refreshStatus = 'expired';
        }
        return true;
    },
    async logLicenseAudit() { /* noop */ },
};

const fakeUserStore = {
    async getOrgSubscription() { return null; },
    async getConsumerSubscription() { return null; },
};

// Intercept require() inside server/license/ to swap store + userStore.
// Same mechanism as in index.test.js — keeps the tests hermetic.
const origResolve = Module._resolveFilename;
const LICENSE_DIR = path.sep + path.join('license');
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(LICENSE_DIR + path.sep)) {
        if (request === './store') return path.join(__dirname, '__fake_store_server__.js');
        if (request === '../stores/userStore') return path.join(__dirname, '__fake_user_store_server__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
require.cache[path.join(__dirname, '__fake_store_server__.js')] = {
    id: path.join(__dirname, '__fake_store_server__.js'),
    filename: path.join(__dirname, '__fake_store_server__.js'),
    loaded: true,
    exports: fakeStore,
};
require.cache[path.join(__dirname, '__fake_user_store_server__.js')] = {
    id: path.join(__dirname, '__fake_user_store_server__.js'),
    filename: path.join(__dirname, '__fake_user_store_server__.js'),
    loaded: true,
    exports: fakeUserStore,
};

// Bypass the memoisation TTL — tests flip _server state in the same
// process and need the resolver to see the change immediately.
process.env.LICENSE_SERVER_TIER_CACHE_TTL_MS = '0';

const license = require('./index');

function activeServerRow(tier) {
    return {
        id: 'srv-lic-' + tier,
        organizationId: null,
        userId: null,
        scope: 'server',
        tier,
        issuer: 'beeflow.admin.console',
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
        billingInterval: 'yearly',
        refreshStatus: 'active',
        metadata: {},
    };
}

function activeOrgRow(orgId, tier) {
    return {
        id: 'org-lic-' + orgId,
        organizationId: orgId,
        userId: null,
        scope: 'organization',
        tier,
        issuer: 'license.beeflow.nl',
        issuedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
        billingInterval: 'yearly',
        refreshStatus: 'active',
        metadata: {},
    };
}

function reset() {
    fakeStore._server = null;
    fakeStore._orgs = {};
    fakeStore._users = {};
    license.bumpServerLicenseVersion(); // also clears _serverTierCache
}

(async () => {
    // ── No server licence: org row wins ─────────────────────────────────
    reset();
    fakeStore._orgs['org_acme'] = activeOrgRow('org_acme', 'enterprise');
    assert.strictEqual(await license.getServerLicenseTier(), 'community',
        'no server row → server tier is community');
    assert.strictEqual(await license.getTierForOrg('org_acme'), 'enterprise',
        'no server row → org tier returned as-is');

    // ── Server licence overrides every per-org row ──────────────────────
    reset();
    fakeStore._server = activeServerRow('enterprise');
    fakeStore._orgs['org_no_lic'] = null; // no per-org row
    assert.strictEqual(await license.getServerLicenseTier(), 'enterprise');
    assert.strictEqual(await license.getTierForOrg('org_no_lic'), 'enterprise',
        'org with no row inherits server tier');
    assert.strictEqual(await license.getTierForOrg('org_never_seen'), 'enterprise',
        'unknown org inherits server tier');
    assert.strictEqual(await license.getTierForUser('any_user'), 'enterprise',
        'arbitrary user inherits server tier');
    assert.strictEqual(await license.getBestTierForOrgs(['a', 'b']), 'enterprise',
        'getBestTierForOrgs short-circuits to server tier');

    // ── Server licence overrides a HIGHER per-org row too (override is
    //    authoritative, per user-confirmed semantics — server wins). ───
    reset();
    fakeStore._server = activeServerRow('enterprise');
    fakeStore._orgs['org_with_full'] = activeOrgRow('org_with_full', 'full');
    assert.strictEqual(await license.getTierForOrg('org_with_full'), 'enterprise',
        'server tier overrides higher per-org tier (user-confirmed semantics)');

    // ── Status carries serverOverride: true + the server licence ───────
    reset();
    fakeStore._server = activeServerRow('enterprise');
    const status = await license.getLicenseStatus({ organizationId: 'org_anything' });
    assert.strictEqual(status.tier, 'enterprise');
    assert.strictEqual(status.scope, 'server');
    assert.strictEqual(status.source, 'license_key');
    assert.strictEqual(status.serverOverride, true);
    assert.ok(status.license, 'server licence shape included');
    assert.strictEqual(status.license.scope, 'server');
    assert.strictEqual(status.subscription, null);

    // ── Expired/revoked server row falls through to per-org row ────────
    reset();
    fakeStore._server = activeServerRow('enterprise');
    fakeStore._server.refreshStatus = 'expired';
    fakeStore._orgs['org_acme'] = activeOrgRow('org_acme', 'community');
    assert.strictEqual(await license.getServerLicenseTier(), 'community',
        'expired server row resolves to community');
    assert.strictEqual(await license.getTierForOrg('org_acme'), 'community',
        'expired server row → per-org row is consulted');

    // ── Past-expiry server row also falls through ──────────────────────
    reset();
    fakeStore._server = activeServerRow('enterprise');
    fakeStore._server.expiresAt = new Date(Date.now() - 1000).toISOString();
    assert.strictEqual(await license.getServerLicenseTier(), 'community',
        'past-expiry server row resolves to community');

    // ── Legacy `tier: 'pro'` server-scope row normalises to enterprise ─
    reset();
    fakeStore._server = activeServerRow('pro');
    assert.strictEqual(await license.getServerLicenseTier(), 'enterprise',
        'legacy pro server tier normalises to enterprise');
    const proStatus = await license.getLicenseStatus({ organizationId: 'org_x' });
    assert.strictEqual(proStatus.tier, 'enterprise');
    assert.strictEqual(proStatus.serverOverride, true);

    // ── Version counter bumps on activate-equivalent state changes ────
    reset();
    const v0 = license.getServerLicenseVersion();
    license.bumpServerLicenseVersion();
    const v1 = license.getServerLicenseVersion();
    assert.strictEqual(v1, v0 + 1, 'bump increments by 1');

    // ── deactivateLicenseForScope({scope:'server'}) bumps version ─────
    reset();
    fakeStore._server = activeServerRow('enterprise');
    const beforeBump = license.getServerLicenseVersion();
    const ok = await license.deactivateLicenseForScope({ scope: 'server' });
    assert.strictEqual(ok, true, 'deactivate returns true when a row was deactivated');
    assert.strictEqual(license.getServerLicenseVersion(), beforeBump + 1,
        'deactivating a server row bumps the version counter');
    assert.strictEqual(await license.getServerLicenseTier(), 'community',
        'after deactivate the server tier resolves to community');

    // ── deactivate with no server row → returns false, no bump ─────────
    reset();
    const v2 = license.getServerLicenseVersion();
    const okNothing = await license.deactivateLicenseForScope({ scope: 'server' });
    assert.strictEqual(okNothing, false);
    assert.strictEqual(license.getServerLicenseVersion(), v2,
        'no-op deactivate must NOT bump the version counter');

    console.log('✓ license/serverScope.test.js — all assertions passed');
})().catch(err => {
    console.error('✗ license/serverScope.test.js failed:', err);
    process.exit(1);
});
