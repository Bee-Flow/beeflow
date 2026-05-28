/**
 * Route-level tests — server-wide licence activation/deactivation.
 *
 * Covers the new branches added to POST /api/license/activate and
 * DELETE /api/license/deactivate:
 *
 *   - scope='server' as super-admin → 200 + activated row (any deploy mode)
 *   - scope='server' as org-admin (not super) → 403 super_admin_required
 *   - scope='server' with community-tier token → 400 community_server_license_pointless
 *   - DELETE ?scope=server symmetric checks
 *
 * The licence module is swapped with a stub via Module._resolveFilename
 * so the test stays hermetic (no DB, no JWT crypto). The route file
 * itself is exercised end-to-end through express's stack.
 *
 * Run: node server/routes/license.serverScope.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');
const http = require('http');

// ── Mock the license module ────────────────────────────────────────────
let mockActivatedTier = 'enterprise';
let mockDeactivateOk = true;
let lastActivateArgs = null;
let lastDeactivateArgs = null;

const licenseStub = {
    COMMUNITY_FALLBACK: 'community',
    tiers: { normalizeTier: (t) => (t === 'pro' ? 'enterprise' : t) },
    async activateLicense(args) {
        lastActivateArgs = args;
        return {
            id: 'lic-test',
            tier: mockActivatedTier,
            issuer: 'beeflow.admin.console',
            scope: args.scope || 'organization',
            organizationId: args.organizationId,
            userId: args.userId,
            expiresAt: new Date(Date.now() + 365 * 86400000).toISOString(),
            billingInterval: 'yearly',
            metadata: {},
        };
    },
    async deactivateLicenseForScope(args) {
        lastDeactivateArgs = args;
        return mockDeactivateOk;
    },
    async getLicenseStatus() {
        return {
            tier: mockActivatedTier,
            source: 'license_key',
            scope: 'server',
            license: { id: 'lic-test', tier: mockActivatedTier, scope: 'server' },
            subscription: null,
            features: [],
            limits: {},
            serverOverride: true,
        };
    },
    store: {},
};

// Mock permissions: keep most behaviour, but stub the async helpers the
// route relies on so we don't need a DB.
const permissionsStub = {
    SystemRoles: { SUPER_ADMIN: 'admin' },
    OrgRoles: {},
    Permissions: { ADMIN_SUBSCRIPTIONS: 'admin_subscriptions' },
    isOrgAdminRole: (role) => role === 'org_admin',
    async hasPermission() { return false; },
    async resolveUserOrgIds() { return new Set(); },
};

const ROUTES_DIR = path.sep + path.join('routes');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(ROUTES_DIR + path.sep)) {
        if (request === '../license') return path.join(__dirname, '__stub_license__.js');
        if (request === '../auth/permissions') return path.join(__dirname, '__stub_permissions__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
require.cache[path.join(__dirname, '__stub_license__.js')] = {
    id: path.join(__dirname, '__stub_license__.js'),
    filename: path.join(__dirname, '__stub_license__.js'),
    loaded: true,
    exports: licenseStub,
};
require.cache[path.join(__dirname, '__stub_permissions__.js')] = {
    id: path.join(__dirname, '__stub_permissions__.js'),
    filename: path.join(__dirname, '__stub_permissions__.js'),
    loaded: true,
    exports: permissionsStub,
};

// ── Boot a minimal express app with the licence router mounted ─────────
const express = require('express');
const router = require('./license');

const app = express();
app.use(express.json());
// Inject a session before the router so its auth-gate (router.use)
// sees an authenticated request. Each test mutates `currentSession`
// before issuing the HTTP call.
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/license', router);

const server = app.listen(0);

function request(method, pathname, { body = null, query = '' } = {}) {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}${pathname}${query ? '?' + query : ''}`;
    return new Promise((resolve, reject) => {
        const req = http.request(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

const SUPER_ADMIN_SESSION = {
    isAuthenticated: true,
    isAdmin: true,
    user: { id: 'u_super', organizationId: null, role: 'admin' },
};
const ORG_ADMIN_SESSION = {
    isAuthenticated: true,
    isAdmin: false,
    user: { id: 'u_orgadmin', organizationId: 'org_acme', role: 'org_admin', orgRole: 'org_admin' },
};

(async () => {
    try {
        // ── POST /activate scope=server, super-admin → 200 ─────────────
        mockActivatedTier = 'enterprise';
        currentSession = SUPER_ADMIN_SESSION;
        lastActivateArgs = null;
        const okRes = await request('POST', '/api/license/activate', {
            body: { token: 'fake-token', scope: 'server' },
        });
        assert.strictEqual(okRes.status, 200, `expected 200, got ${okRes.status} body=${JSON.stringify(okRes.body)}`);
        assert.ok(okRes.body.activated, 'response carries activated row');
        assert.strictEqual(okRes.body.activated.tier, 'enterprise');
        assert.strictEqual(lastActivateArgs.scope, 'server',
            'activateLicense called with scope=server');
        assert.strictEqual(lastActivateArgs.organizationId, null);
        assert.strictEqual(lastActivateArgs.userId, null);

        // ── POST /activate scope=server on CLOUD → 200 (no deploy gate) ─
        process.env.DEPLOYMENT_MODE = 'cloud';
        currentSession = SUPER_ADMIN_SESSION;
        const cloudRes = await request('POST', '/api/license/activate', {
            body: { token: 'fake-token', scope: 'server' },
        });
        assert.strictEqual(cloudRes.status, 200,
            'server scope works regardless of deployment mode');
        assert.ok(cloudRes.body.activated, 'cloud activation carries activated row');

        // ── POST /activate scope=server as ORG-admin → 403 super-admin ─
        currentSession = ORG_ADMIN_SESSION;
        const orgAdminRes = await request('POST', '/api/license/activate', {
            body: { token: 'fake-token', scope: 'server' },
        });
        assert.strictEqual(orgAdminRes.status, 403);
        assert.strictEqual(orgAdminRes.body.error, 'super_admin_required');

        // ── POST /activate scope=server with community tier → 400 ──────
        currentSession = SUPER_ADMIN_SESSION;
        mockActivatedTier = 'community';
        lastDeactivateArgs = null;
        const communityRes = await request('POST', '/api/license/activate', {
            body: { token: 'fake-token', scope: 'server' },
        });
        assert.strictEqual(communityRes.status, 400);
        assert.strictEqual(communityRes.body.error, 'community_server_license_pointless');
        assert.deepStrictEqual(
            lastDeactivateArgs && { scope: lastDeactivateArgs.scope },
            { scope: 'server' },
            'route must roll back the just-created community server row');
        mockActivatedTier = 'enterprise'; // restore

        // ── DELETE ?scope=server, super-admin → 200 ───────────────────
        currentSession = SUPER_ADMIN_SESSION;
        lastDeactivateArgs = null;
        mockDeactivateOk = true;
        const delRes = await request('DELETE', '/api/license/deactivate', { query: 'scope=server' });
        assert.strictEqual(delRes.status, 200);
        assert.strictEqual(delRes.body.success, true);
        assert.strictEqual(lastDeactivateArgs.scope, 'server');

        // ── DELETE ?scope=server on CLOUD → 200 (no deploy gate) ───────
        process.env.DEPLOYMENT_MODE = 'cloud';
        currentSession = SUPER_ADMIN_SESSION;
        lastDeactivateArgs = null;
        mockDeactivateOk = true;
        const delCloudRes = await request('DELETE', '/api/license/deactivate', { query: 'scope=server' });
        assert.strictEqual(delCloudRes.status, 200);
        assert.strictEqual(delCloudRes.body.success, true);

        // ── DELETE ?scope=server as ORG-admin → 403 super-admin ───────
        currentSession = ORG_ADMIN_SESSION;
        const delOrgRes = await request('DELETE', '/api/license/deactivate', { query: 'scope=server' });
        assert.strictEqual(delOrgRes.status, 403);
        assert.strictEqual(delOrgRes.body.error, 'super_admin_required');

        // ── DELETE ?scope=server with no active row → 404 ──────────────
        currentSession = SUPER_ADMIN_SESSION;
        mockDeactivateOk = false;
        const delNoneRes = await request('DELETE', '/api/license/deactivate', { query: 'scope=server' });
        assert.strictEqual(delNoneRes.status, 404);
        mockDeactivateOk = true;

        // ── Unauthenticated → 401 (router-level guard, unchanged) ──────
        currentSession = null;
        const authRes = await request('POST', '/api/license/activate', {
            body: { token: 'fake-token', scope: 'server' },
        });
        assert.strictEqual(authRes.status, 401);

        console.log('✓ routes/license.serverScope.test.js — all assertions passed');
    } finally {
        server.close();
    }
})().catch(err => {
    console.error('✗ routes/license.serverScope.test.js failed:', err);
    server.close();
    process.exit(1);
});
