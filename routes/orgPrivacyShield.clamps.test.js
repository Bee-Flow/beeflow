/**
 * Route-level tests — tier-driven clamps in orgPrivacyShield.
 *
 * Covers the soft enforcement added alongside the second-wave Community
 * tightening:
 *
 *   - On community tier the PUT handler clamps piiDetectionAction → 'block'
 *     (gate: pii_tokenize) and forces webSearchGuardEnabled → false +
 *     webSearchGuardPiiCategories → [] (gate: web_search_guard). Response
 *     carries `clamped_fields` so the UI can surface the demotion.
 *   - On enterprise tier the same payload is persisted verbatim.
 *   - GET reflects the clamps too — a pre-clamp stored config that lingers
 *     in the DB does NOT leak through to a community read.
 *
 * The licence module is swapped via Module._resolveFilename so the test
 * stays hermetic. The configStore is also stubbed (in-memory).
 *
 * Run: node server/routes/orgPrivacyShield.clamps.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');
const http = require('http');

// ── In-memory mocks ────────────────────────────────────────────────────
let mockTier = 'community';
const storeBlobs = {};

const tiersStub = require('../license/tiers'); // real tier-feature map
const licenseStub = {
    tiers: tiersStub,
    async resolveTier({ organizationId, userId } = {}) {
        return mockTier;
    },
};

const configStoreStub = {
    async getConfig(key) {
        return storeBlobs[key] !== undefined ? storeBlobs[key] : null;
    },
    async setConfig(key, value) {
        storeBlobs[key] = value;
        return true;
    },
};

const userStoreStub = {
    async getUser(id) {
        // Privacy-shield admin gate uses orgRole + group membership; we
        // pretend the test user is an org_admin so PUT passes.
        return { id, organizationId: 'org_test', orgRole: 'org_admin', groups: '[]' };
    },
    async getAllGroups() { return []; },
};

const authStub = {
    SystemRoles: { SUPER_ADMIN: 'admin' },
    OrgRoles: {},
    Permissions: {},
    isOrgAdminRole: (role) => role === 'org_admin',
    async hasPermission() { return false; },
    async resolveUserOrgIds(req) {
        const orgId = req?.session?.user?.organizationId;
        return orgId ? new Set([orgId]) : new Set();
    },
};

const ROUTES_DIR = path.sep + path.join('routes');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(ROUTES_DIR + path.sep)) {
        if (request === '../license') return path.join(__dirname, '__stub_lic_clamps__.js');
        if (request === '../stores/configStore') return path.join(__dirname, '__stub_cfg_clamps__.js');
        if (request === '../stores/userStore') return path.join(__dirname, '__stub_us_clamps__.js');
        if (request === '../auth') return path.join(__dirname, '__stub_auth_clamps__.js');
        // Block the in-handler require('../core/dlp/customTerms') — best
        // effort module; stub a no-op.
        if (request === '../core/dlp/customTerms') return path.join(__dirname, '__stub_customterms_clamps__.js');
        if (request === '../core/orgShield') return path.join(__dirname, '__stub_orgshield_clamps__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
const stubExports = {
    '__stub_lic_clamps__.js': licenseStub,
    '__stub_cfg_clamps__.js': configStoreStub,
    '__stub_us_clamps__.js': userStoreStub,
    '__stub_auth_clamps__.js': authStub,
    '__stub_customterms_clamps__.js': { invalidate() { /* noop */ } },
    '__stub_orgshield_clamps__.js': { async resolveOrgShield() { return null; } },
};
for (const [fname, exp] of Object.entries(stubExports)) {
    const full = path.join(__dirname, fname);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exp };
}

// ── Boot express + router ──────────────────────────────────────────────
const express = require('express');
const router = require('./orgPrivacyShield');
const app = express();
app.use(express.json());
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/org-privacy-shield', router);
const server = app.listen(0);

function request(method, pathname, { body = null } = {}) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${port}${pathname}`, {
            method, headers: { 'Content-Type': 'application/json' },
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

const ORG_ADMIN_SESSION = {
    isAuthenticated: true,
    user: { id: 'u_orgadmin', organizationId: 'org_test', orgRole: 'org_admin' },
};
const ORG_ID = 'org_test';
const STORE_KEY = `org_privacy_shield_${ORG_ID}`;

function fullPayload(overrides = {}) {
    return {
        enabled: true,
        collectionIds: [],
        scope: { userInput: true, agentOutput: true },
        action: 'delete',
        euModeEnabled: false,
        webSearchGuardEnabled: false,
        disableSearchOnUpload: false,
        piiDetectionCategories: [],
        piiDetectionConfidenceThreshold: 0.7,
        piiDetectionAction: 'block',
        webSearchGuardPiiCategories: [],
        monitorIntegrations: false,
        dlpEnabled: false,
        dlpScope: 'external',
        dlpMode: 'ask',
        dlpFailureMode: 'fail_closed',
        dlpAllowlistedHosts: [],
        customSensitiveTerms: [],
        showRawPayload: false,
        ...overrides,
    };
}

(async () => {
    try {
        currentSession = ORG_ADMIN_SESSION;

        // ── Community PUT: tokenize is now HONORED (not clamped) ───────
        // Policy change: an explicitly-saved Tokenize is respected end-to-end
        // (the SPA gates SELECTING tokenize via canTokenizePii). The tier clamp
        // no longer downgrades piiDetectionAction → block.
        mockTier = 'community';
        delete storeBlobs[STORE_KEY];
        const putComTok = await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: fullPayload({ piiDetectionAction: 'tokenize' }),
        });
        assert.strictEqual(putComTok.status, 200);
        assert.strictEqual(putComTok.body.config.piiDetectionAction, 'tokenize',
            'community PUT must KEEP the saved tokenize action (no pii clamp)');
        assert.ok(!(putComTok.body.clamped_fields || []).includes('piiDetectionAction'),
            'piiDetectionAction must NOT be reported as clamped');
        // Stored row keeps the requested tokenize value
        assert.strictEqual(storeBlobs[STORE_KEY].piiDetectionAction, 'tokenize',
            'stored row keeps the saved tokenize value');

        // ── Community PUT: Web Search Guard is force-disabled ──────────
        mockTier = 'community';
        delete storeBlobs[STORE_KEY];
        const putComWSG = await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: fullPayload({ webSearchGuardEnabled: true, webSearchGuardPiiCategories: ['email', 'phone'] }),
        });
        assert.strictEqual(putComWSG.status, 200);
        assert.strictEqual(putComWSG.body.config.webSearchGuardEnabled, false,
            'community PUT must force webSearchGuardEnabled → false');
        assert.deepStrictEqual(putComWSG.body.config.webSearchGuardPiiCategories, [],
            'community PUT must clear webSearchGuardPiiCategories');
        assert.ok(putComWSG.body.clamped_fields.includes('webSearchGuardEnabled'));
        assert.ok(putComWSG.body.clamped_fields.includes('webSearchGuardPiiCategories'));

        // ── Enterprise PUT: tokenize is preserved ──────────────────────
        mockTier = 'enterprise';
        delete storeBlobs[STORE_KEY];
        const putEntTok = await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: fullPayload({ piiDetectionAction: 'tokenize', webSearchGuardEnabled: true, webSearchGuardPiiCategories: ['email'] }),
        });
        assert.strictEqual(putEntTok.status, 200);
        assert.strictEqual(putEntTok.body.config.piiDetectionAction, 'tokenize',
            'enterprise PUT preserves tokenize');
        assert.strictEqual(putEntTok.body.config.webSearchGuardEnabled, true,
            'enterprise PUT preserves Web Search Guard');
        assert.deepStrictEqual(putEntTok.body.config.webSearchGuardPiiCategories, ['email']);
        assert.strictEqual(putEntTok.body.clamped_fields, undefined,
            'no clamped_fields on enterprise');

        // ── Legacy pro tier → resolves to enterprise → preserves ───────
        mockTier = 'pro';
        delete storeBlobs[STORE_KEY];
        const putProTok = await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: fullPayload({ piiDetectionAction: 'tokenize' }),
        });
        assert.strictEqual(putProTok.body.config.piiDetectionAction, 'tokenize',
            'legacy pro inherits enterprise → tokenize preserved');

        // ── GET on community: tokenize is honored; only Web Search Guard clamps ─
        mockTier = 'community';
        storeBlobs[STORE_KEY] = fullPayload({
            piiDetectionAction: 'tokenize',
            webSearchGuardEnabled: true,
            webSearchGuardPiiCategories: ['email', 'phone'],
        });
        const getCom = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.strictEqual(getCom.status, 200);
        assert.strictEqual(getCom.body.piiDetectionAction, 'tokenize',
            'community GET must report the saved tokenize action (no pii clamp)');
        assert.strictEqual(getCom.body.webSearchGuardEnabled, false);
        assert.deepStrictEqual(getCom.body.webSearchGuardPiiCategories, []);
        assert.ok(Array.isArray(getCom.body.clamped_fields));
        assert.ok(!getCom.body.clamped_fields.includes('piiDetectionAction'),
            'piiDetectionAction must NOT be clamped on GET');
        assert.ok(getCom.body.clamped_fields.includes('webSearchGuardEnabled'),
            'Web Search Guard is still tier-clamped');
        // Underlying store row is untouched.
        assert.strictEqual(storeBlobs[STORE_KEY].piiDetectionAction, 'tokenize',
            'GET clamp must NOT mutate the underlying stored config');

        // ── GET on enterprise reads through verbatim ───────────────────
        mockTier = 'enterprise';
        const getEnt = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.strictEqual(getEnt.body.piiDetectionAction, 'tokenize');
        assert.strictEqual(getEnt.body.webSearchGuardEnabled, true);
        assert.strictEqual(getEnt.body.clamped_fields, undefined);

        console.log('✓ routes/orgPrivacyShield.clamps.test.js — all assertions passed');
    } finally {
        server.close();
    }
})().catch(err => {
    console.error('✗ routes/orgPrivacyShield.clamps.test.js failed:', err);
    server.close();
    process.exit(1);
});
