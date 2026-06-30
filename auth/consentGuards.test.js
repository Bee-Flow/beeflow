/**
 * Unit tests — consent guards (validate / record / reconsent / waiver).
 *
 * userStore is mocked via a Module._load hook (same approach as
 * core/betaFeatures.test.js) so we exercise the gate logic without Postgres.
 * documentRegistry stays real (it reads the in-repo legal markdown).
 *
 * Run: node auth/consentGuards.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

const userStorePath = path.resolve(__dirname, '..', 'stores', 'userStore');

let ledger = [];
let summary = {};
const userStoreStub = new Proxy({
    recordConsentAcceptance: async (row) => { ledger.push(row); return 'ledger-id'; },
    getConsentSummary: async () => ({ ...summary }),
    setConsentSummary: async (_uid, map) => { summary = { ...map }; },
}, { get(target, prop) { return prop in target ? target[prop] : (async () => undefined); } });

const origLoad = Module._load;
Module._load = function (request, parent) {
    let resolved = request;
    try { resolved = Module._resolveFilename(request, parent); } catch { /* keep request */ }
    if (resolved === userStorePath || resolved === `${userStorePath}.js`) return userStoreStub;
    return origLoad.apply(this, arguments);
};

const cg = require('./consentGuards');
const reg = require('../legal/documentRegistry');

(async () => {
    // ── validateConsent ──────────────────────────────────────────────────
    assert.strictEqual(cg.validateConsent(null, 'consumer').ok, false, 'no consent → reject');
    assert.strictEqual(cg.validateConsent({ accepted: false }, 'consumer').code, 'CONSENT_REQUIRED',
        'pre-ticked/false → CONSENT_REQUIRED');
    assert.strictEqual(cg.validateConsent({}, 'org_admin').ok, false, 'absent accepted flag → reject');
    assert.strictEqual(cg.validateConsent({ accepted: true }, 'org_admin').ok, true,
        'explicit accepted:true (no claimed list) → ok');

    const vmap = reg.currentVersionMap();
    assert.strictEqual(
        cg.validateConsent({ accepted: true, acceptedDocs: [{ docId: 'terms', version: 0 }] }, 'consumer').code,
        'CONSENT_STALE', 'old claimed version → CONSENT_STALE');
    assert.strictEqual(
        cg.validateConsent({
            accepted: true,
            acceptedDocs: reg.requiredDocsFor('consumer').map(d => ({ docId: d.docId, version: vmap[d.docId] })),
        }, 'consumer').ok, true, 'all required docs at current version → ok');

    // ── recordConsent writes one row per required doc + refreshes summary ─
    ledger = []; summary = {};
    await cg.recordConsent({
        userId: 'u1', email: 'a@b.c', accountType: 'org_admin',
        req: { headers: { 'user-agent': 'jest' }, originalUrl: '/auth/signup' }, method: 'clickwrap',
    });
    assert.deepStrictEqual(ledger.map(r => r.docId).sort(), ['aup', 'dpa', 'privacy', 'terms'],
        'one ledger row per required org_admin document');
    assert.ok(ledger.every(r => r.method === 'clickwrap' && r.docVersion >= 1 && r.userAgent === 'jest'),
        'rows carry method, version and user-agent');
    assert.strictEqual(summary.dpa, vmap.dpa, 'summary cache updated for dpa');

    // ── needsReconsent ───────────────────────────────────────────────────
    summary = reg.currentVersionMap();
    assert.strictEqual((await cg.needsReconsent('u1', 'org_admin')).needsReconsent, false,
        'up-to-date summary → no reconsent');
    summary = { ...reg.currentVersionMap(), terms: 0 };
    const r = await cg.needsReconsent('u1', 'org_admin');
    assert.strictEqual(r.needsReconsent, true, 'behind on terms → reconsent');
    assert.deepStrictEqual(r.docs.map(d => d.docId), ['terms']);

    // ── waiver ───────────────────────────────────────────────────────────
    assert.strictEqual(cg.validateWaiver({}).code, 'WAIVER_REQUIRED', 'no waiver → reject');
    assert.strictEqual(cg.validateWaiver({ accepted: true }).ok, true, 'accepted waiver → ok');
    ledger = [];
    await cg.recordWaiver({ userId: 'u1', email: 'a@b.c', req: { headers: {}, originalUrl: '/api/stripe/checkout' } });
    assert.strictEqual(ledger.length, 1, 'one waiver ledger row');
    assert.strictEqual(ledger[0].docId, 'withdrawal_waiver');
    assert.strictEqual(ledger[0].method, 'checkout_waiver');

    // ── self-hosted: the consent system is disabled entirely ─────────────
    // Legal & Consent is Cloud-only; on self-hosted these guards no-op so signup
    // is never blocked, no ledger rows are written, and the re-consent gate never
    // fires. (The frontend hides the clickwrap / settings tab / admin tab too.)
    const prevMode = process.env.DEPLOYMENT_MODE;
    process.env.DEPLOYMENT_MODE = 'self-hosted';
    assert.strictEqual(cg.consentEnabled(), false, 'self-hosted → consent disabled');
    const sh = cg.validateConsent(null, 'consumer');
    assert.strictEqual(sh.ok, true, 'self-hosted → validateConsent ok despite missing consent');
    assert.deepStrictEqual(sh.docs, [], 'self-hosted → no required docs');
    ledger = []; summary = {};
    await cg.recordConsent({ userId: 'u1', email: 'a@b.c', accountType: 'org_admin', req: { headers: {} }, method: 'clickwrap' });
    assert.strictEqual(ledger.length, 0, 'self-hosted → recordConsent is a no-op');
    summary = { ...reg.currentVersionMap(), terms: 0 };
    assert.strictEqual((await cg.needsReconsent('u1', 'org_admin')).needsReconsent, false,
        'self-hosted → re-consent gate never triggers');
    process.env.DEPLOYMENT_MODE = 'private-cloud';
    assert.strictEqual(cg.consentEnabled(), false, 'private-cloud → consent disabled (back-compat)');
    if (prevMode === undefined) delete process.env.DEPLOYMENT_MODE; else process.env.DEPLOYMENT_MODE = prevMode;

    Module._load = origLoad;
    console.log('✓ auth/consentGuards.test.js — all assertions passed');
})().catch(err => { Module._load = origLoad; console.error('✗ auth/consentGuards.test.js failed:', err); process.exit(1); });
