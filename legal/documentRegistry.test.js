/**
 * Unit tests — consent document registry.
 *
 * Pure module (reads the in-repo legal markdown for hashing); no DB needed.
 * Run: node legal/documentRegistry.test.js
 */

const assert = require('assert');
const reg = require('./documentRegistry');

(async () => {
    // ── requiredDocsFor scoping ──────────────────────────────────────────
    assert.deepStrictEqual(
        reg.requiredDocsFor('org_admin').map(d => d.docId),
        ['terms', 'privacy', 'dpa', 'aup'],
        'org_admin accepts terms+privacy+dpa+aup');
    assert.deepStrictEqual(
        reg.requiredDocsFor('org_member').map(d => d.docId),
        ['terms', 'privacy', 'aup'],
        'org_member (Authorised User) does NOT accept the DPA');
    assert.deepStrictEqual(
        reg.requiredDocsFor('consumer').map(d => d.docId),
        ['terms', 'privacy', 'aup'],
        'consumer does NOT accept the DPA');

    // ── normalizeAccountType mapping ─────────────────────────────────────
    assert.strictEqual(reg.normalizeAccountType('new'), 'org_admin');
    assert.strictEqual(reg.normalizeAccountType('existing'), 'org_member');
    assert.strictEqual(reg.normalizeAccountType('invite'), 'org_member');
    assert.strictEqual(reg.normalizeAccountType('consumer'), 'consumer');
    assert.strictEqual(reg.normalizeAccountType('org'), 'org_admin', 'legacy org → org_admin');
    assert.strictEqual(reg.normalizeAccountType(undefined, { hasOrg: true, isOrgAdmin: true }), 'org_admin');
    assert.strictEqual(reg.normalizeAccountType(undefined, { hasOrg: true }), 'org_member');
    assert.strictEqual(reg.normalizeAccountType(undefined), 'consumer');

    // ── versions are positive integers (monotonic-bump invariant) ────────
    const vmap = reg.currentVersionMap();
    for (const [docId, v] of Object.entries(vmap)) {
        assert.ok(Number.isInteger(v) && v >= 1, `${docId} version is a positive integer`);
    }

    // ── staleness detection ──────────────────────────────────────────────
    assert.strictEqual(reg.isStale(vmap, 'org_admin'), false, 'matching versions → not stale');
    assert.strictEqual(reg.isStale({}, 'org_admin'), true, 'empty summary → stale');
    const behind = { ...vmap, terms: vmap.terms - 1 };
    assert.deepStrictEqual(
        reg.staleDocsFor(behind, 'org_admin').map(d => d.docId),
        ['terms'],
        'only the document the user is behind on is stale');
    // A bumped DPA does not affect an org_member (they never accept it).
    const bumpedDpa = { ...vmap, dpa: vmap.dpa - 1 };
    assert.strictEqual(reg.isStale(bumpedDpa, 'org_member'), false, 'DPA bump does not re-consent members');
    assert.strictEqual(reg.isStale(bumpedDpa, 'org_admin'), true, 'DPA bump re-consents the admin');

    // ── content hash ─────────────────────────────────────────────────────
    assert.match(reg.sha256For('terms'), /^[0-9a-f]{64}$/, 'sha256 is 64 hex chars');

    // ── withdrawal waiver ────────────────────────────────────────────────
    const w = reg.getWithdrawalWaiver();
    assert.strictEqual(w.docId, 'withdrawal_waiver');
    assert.ok(Number.isInteger(w.version) && w.scope === 'b2c');

    console.log('✓ legal/documentRegistry.test.js — all assertions passed');
})().catch(err => { console.error('✗ legal/documentRegistry.test.js failed:', err); process.exit(1); });
