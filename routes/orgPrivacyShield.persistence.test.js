/**
 * Route-level tests — Privacy Shield settings PERSISTENCE round-trip.
 *
 * Regression for the "settings don't save correctly" bug: the GET handler used
 * to resurrect `piiDetectionCategories` from the global `ai` blob whenever the
 * org's saved list was empty/narrow, so deselecting categories (the "None"
 * button) never stuck. The fix only seeds from the global blob when the org has
 * NO stored shield row at all.
 *
 * Tier is forced to enterprise so tier-clamps don't interfere (clamps have their
 * own test: orgPrivacyShield.clamps.test.js).
 *
 * Run: node server/routes/orgPrivacyShield.persistence.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');
const http = require('http');

// ── In-memory mocks ────────────────────────────────────────────────────
let mockTier = 'enterprise';
const storeBlobs = {};

const tiersStub = require('../license/tiers');
const licenseStub = {
    tiers: tiersStub,
    async resolveTier() { return mockTier; },
};
const configStoreStub = {
    async getConfig(key) { return storeBlobs[key] !== undefined ? storeBlobs[key] : null; },
    async setConfig(key, value) { storeBlobs[key] = value; return true; },
};
const userStoreStub = {
    async getUser(id) { return { id, organizationId: 'org_test', orgRole: 'org_admin', groups: '[]' }; },
    async getAllGroups() { return []; },
};
const authStub = {
    SystemRoles: { SUPER_ADMIN: 'admin' }, OrgRoles: {}, Permissions: {},
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
        if (request === '../license') return path.join(__dirname, '__stub_lic_persist__.js');
        if (request === '../stores/configStore') return path.join(__dirname, '__stub_cfg_persist__.js');
        if (request === '../stores/userStore') return path.join(__dirname, '__stub_us_persist__.js');
        if (request === '../auth') return path.join(__dirname, '__stub_auth_persist__.js');
        if (request === '../core/dlp/customTerms') return path.join(__dirname, '__stub_ct_persist__.js');
        if (request === '../core/orgShield') return path.join(__dirname, '__stub_os_persist__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
const stubExports = {
    '__stub_lic_persist__.js': licenseStub,
    '__stub_cfg_persist__.js': configStoreStub,
    '__stub_us_persist__.js': userStoreStub,
    '__stub_auth_persist__.js': authStub,
    '__stub_ct_persist__.js': { invalidate() {} },
    '__stub_os_persist__.js': { async resolveOrgShield() { return null; } },
};
for (const [fname, exp] of Object.entries(stubExports)) {
    const full = path.join(__dirname, fname);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exp };
}

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

const ORG_ID = 'org_test';
const STORE_KEY = `org_privacy_shield_${ORG_ID}`;
const SESSION = { isAuthenticated: true, user: { id: 'u_orgadmin', organizationId: ORG_ID, orgRole: 'org_admin' } };

function fullPayload(overrides = {}) {
    return {
        enabled: true, collectionIds: [], scope: { userInput: true, agentOutput: true }, action: 'delete',
        euModeEnabled: false, webSearchGuardEnabled: false, disableSearchOnUpload: false,
        piiDetectionCategories: [], piiDetectionConfidenceThreshold: 0.7, piiDetectionAction: 'block',
        webSearchGuardPiiCategories: [], monitorIntegrations: false,
        dlpEnabled: false, dlpScope: 'external', dlpMode: 'ask', dlpFailureMode: 'fail_closed',
        dlpAllowlistedHosts: [], customSensitiveTerms: [], showRawPayload: false, ...overrides,
    };
}

(async () => {
    try {
        currentSession = SESSION;
        // Global AI blob has categories — the GET must NOT leak these over a saved org row.
        storeBlobs['ai'] = { piiDetectionCategories: ['Person', 'Email', 'PhoneNumber'], piiDetectionConfidenceThreshold: 0.9, piiDetectionAction: 'block' };

        // ── 1. Brand-new org (no stored row) → seeds from global blob ──
        delete storeBlobs[STORE_KEY];
        const getNew = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.strictEqual(getNew.status, 200);
        assert.deepStrictEqual(getNew.body.piiDetectionCategories, ['Person', 'Email', 'PhoneNumber'],
            'an org that never saved should seed categories from the global blob');

        // ── 2. Saved EMPTY categories must stay empty on reload (A1 bug) ──
        const putEmpty = await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: fullPayload({ piiDetectionCategories: [] }),
        });
        assert.strictEqual(putEmpty.status, 200);
        const getEmpty = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.deepStrictEqual(getEmpty.body.piiDetectionCategories, [],
            'a deliberately-saved empty category list must NOT be resurrected from the global blob');

        // ── 3. Narrowed selection round-trips verbatim ──
        const narrowed = ['Person', 'MedicalCondition'];
        await request('PUT', `/api/org-privacy-shield/${ORG_ID}`, {
            body: fullPayload({ piiDetectionCategories: narrowed, piiDetectionConfidenceThreshold: 0.5, piiDetectionAction: 'tokenize' }),
        });
        const getNarrow = await request('GET', `/api/org-privacy-shield/${ORG_ID}`);
        assert.deepStrictEqual(getNarrow.body.piiDetectionCategories, narrowed,
            'a saved narrowed selection must round-trip verbatim');
        assert.strictEqual(getNarrow.body.piiDetectionConfidenceThreshold, 0.5, 'threshold round-trips');
        assert.strictEqual(getNarrow.body.piiDetectionAction, 'tokenize', 'enterprise action round-trips');
        assert.strictEqual(getNarrow.body.enabled, true, 'enabled round-trips');

        console.log('✓ routes/orgPrivacyShield.persistence.test.js — all assertions passed');
    } finally {
        server.close();
    }
})().catch(err => {
    console.error('✗ routes/orgPrivacyShield.persistence.test.js failed:', err);
    server.close();
    process.exit(1);
});
