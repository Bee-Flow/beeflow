/**
 * Unit tests — runtime admin overrides flow through the dynamic registry.
 *
 * legalStore is mocked (Module._load hook) so we can simulate admin overrides
 * without configStore/Postgres. documentRegistry + legalDocs stay real.
 *
 * Run: node legal/legalOverride.test.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

const legalStorePath = path.resolve(__dirname, 'legalStore');

let overrides = {}; // docId -> { version?, requiresConsent?, scope?, markdownEn? }
const legalStoreStub = {
    isLoaded: () => true,
    getMetaOverride: (docId) => {
        const o = overrides[docId];
        if (!o) return null;
        const { markdownEn, ...meta } = o; // eslint-disable-line no-unused-vars
        return Object.keys(meta).length ? meta : null;
    },
    getEnglishOverride: (docId) => (overrides[docId] && overrides[docId].markdownEn) || null,
    getOptionalOverride: () => null,
    refresh: async () => {},
};

const origLoad = Module._load;
Module._load = function (request, parent) {
    let resolved = request;
    try { resolved = Module._resolveFilename(request, parent); } catch { /* keep */ }
    if (resolved === legalStorePath || resolved === `${legalStorePath}.js`) return legalStoreStub;
    return origLoad.apply(this, arguments);
};

const reg = require('./documentRegistry');

(async () => {
    // Baseline (no overrides) — code defaults.
    assert.strictEqual(reg.currentVersionMap().terms, 1, 'baseline terms v1');
    assert.deepStrictEqual(reg.requiredDocsFor('org_admin').map(d => d.docId),
        ['terms', 'privacy', 'dpa', 'aup'], 'baseline org_admin set');

    // Admin bumps the terms version → re-consent triggers for v1 acceptances.
    overrides.terms = { version: 2 };
    assert.strictEqual(reg.currentVersionMap().terms, 2, 'override bumps terms to v2');
    assert.deepStrictEqual(
        reg.staleDocsFor({ terms: 1, privacy: 1, dpa: 1, aup: 1 }, 'org_admin').map(d => d.docId),
        ['terms'], 'a v1 acceptance is now stale after the bump');
    assert.strictEqual(
        reg.staleDocsFor({ terms: 2, privacy: 1, dpa: 1, aup: 1 }, 'org_admin').length, 0,
        'accepting v2 clears it');

    // Admin makes an informational doc consent-bound at runtime.
    overrides['cookie-statement'] = { requiresConsent: true, scope: 'both' };
    assert.ok(reg.requiredDocsFor('consumer').some(d => d.docId === 'cookie-statement'),
        'admin can turn a doc into a consent-bound document');

    // Editing the English content changes the evidence hash.
    const sha1 = reg.sha256For('terms');
    overrides.terms = { version: 2, markdownEn: '# Edited terms\n\nNew body.\n' };
    const sha2 = reg.sha256For('terms');
    assert.match(sha2 || '', /^[0-9a-f]{64}$/, 'effective sha256 is valid');
    assert.notStrictEqual(sha1, sha2, 'editing the English content changes the ledger hash');

    // Optional-consent catalog default.
    assert.ok(reg.optionalConsents().some(c => c.id === 'marketing'), 'marketing optional consent present');
    assert.strictEqual(reg.getOptionalConsent('marketing').category, 'marketing');

    Module._load = origLoad;
    console.log('✓ legal/legalOverride.test.js — all assertions passed');
})().catch(err => { Module._load = origLoad; console.error('✗ legal/legalOverride.test.js failed:', err); process.exit(1); });
