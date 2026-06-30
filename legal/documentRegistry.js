/**
 * Consent Document Registry
 *
 * The SINGLE source of truth for "which legal documents must be accepted, at
 * which version, by which account type". Imported by every consent gate — the
 * signup gate, the OAuth pending-signup gate, the re-consent gate and the
 * paid-checkout waiver — so they can never diverge.
 *
 * Document VERSIONS live in code (server/i18n/defaults/legalDocs.js), which makes
 * them deploy-versioned and immutable per release — exactly the "versioned text
 * that was presented and accepted" evidence the Dutch enforceability test
 * (BW 6:233/6:234) and GDPR accountability require. Bumping a version there both
 * invalidates stale translations AND triggers re-consent.
 *
 * sha256 is the hash of the exact published English markdown, computed lazily and
 * cached, so the consent ledger can store a content hash without trusting the
 * client to supply one.
 */

const crypto = require('crypto');
const legalDocs = require('../i18n/defaults/legalDocs');

// The consumer right-of-withdrawal waiver is a checkout-time acknowledgement,
// not a signup document. It is versioned independently of the markdown docs.
const WITHDRAWAL_WAIVER = {
    docId: 'withdrawal_waiver',
    version: 1,
    scope: 'b2c',
    urlPath: '/terms#consumers',
};

// ── Optional (freely opt-in/out) consents — e.g. marketing ───────
// These are NOT click-through signup gates; users grant/withdraw them at will.
// Seed catalog; an admin can enable/disable or edit it at runtime via legalStore.
const OPTIONAL_CONSENTS_DEFAULT = [
    { id: 'marketing', version: 1, category: 'marketing', enabled: true, labelKey: 'consent.marketing_label' },
];

function optionalConsents() {
    let ov = null;
    try {
        const legalStore = require('./legalStore');
        if (legalStore.isLoaded()) ov = legalStore.getOptionalOverride();
    } catch (_) { /* fall back to defaults */ }
    if (!Array.isArray(ov) || !ov.length) return OPTIONAL_CONSENTS_DEFAULT.map(c => ({ ...c }));
    const byId = {};
    for (const d of OPTIONAL_CONSENTS_DEFAULT) byId[d.id] = { ...d };
    for (const o of ov) { if (o && o.id) byId[o.id] = { ...(byId[o.id] || {}), ...o }; }
    // Coerce version to a positive integer (defends against hand-edited config —
    // the ledger's doc_version is NOT NULL INTEGER).
    return Object.values(byId).map(c => ({ ...c, version: Number(c.version) || 1 }));
}

function getOptionalConsent(id) {
    return optionalConsents().find(c => c.id === id) || null;
}

// ── Effective consent-bound documents (dynamic — reflects admin overrides) ─
// A document is consent-bound when its EFFECTIVE requiresConsent is true.
function _consentDocs() {
    const all = legalDocs.getAllLegalDefaults();
    return Object.values(all)
        .filter(d => d && d.requiresConsent)
        .map(d => ({ docId: d.docId, version: d.version, scope: d.scope || 'both', urlPath: d.route }));
}

// ── sha256 of the EFFECTIVE English markdown (override || disk) ───
// Computed fresh per call (low frequency — only on consent writes) so the ledger
// evidence always matches the exact text that was presented.
function sha256For(docId) {
    try {
        const def = legalDocs.getLegalDefault(docId);
        if (!def || !def.markdown) return null;
        return crypto.createHash('sha256').update(def.markdown, 'utf-8').digest('hex');
    } catch (err) {
        console.warn(`[ConsentRegistry] Could not hash ${docId}:`, err.message);
        return null;
    }
}

/**
 * Normalise a signup/account type into 'org_admin' | 'org_member' | 'consumer'.
 *   org_admin  — creates/administers the organisation (concludes the DPA)
 *   org_member — joins an existing org or accepts an invite (Authorised User)
 *   consumer   — personal account
 * Accepts the frontend signupType ('new'|'existing'|'consumer'|'invite') or an
 * already-resolved account type. Legacy 'org' maps to org_admin.
 */
function normalizeAccountType(accountType, { hasOrg = false, isOrgAdmin = false } = {}) {
    switch (accountType) {
        case 'consumer': return 'consumer';
        case 'org_admin':
        case 'new':
        case 'org': return 'org_admin';
        case 'org_member':
        case 'existing':
        case 'invite': return 'org_member';
        default:
            if (hasOrg) return isOrgAdmin ? 'org_admin' : 'org_member';
            return 'consumer';
    }
}

function _scopeMatches(scope, accountType) {
    if (scope === 'both') return true;
    if (scope === 'b2b') return accountType === 'org_admin';
    if (scope === 'b2c') return accountType === 'consumer';
    return false;
}

/**
 * The documents an account of the given type must accept at signup.
 * Returns [{ docId, version, urlPath }].
 */
function requiredDocsFor(accountType) {
    const t = normalizeAccountType(accountType);
    return _consentDocs()
        .filter(d => _scopeMatches(d.scope, t))
        .map(d => ({ docId: d.docId, version: d.version, urlPath: d.urlPath }));
}

/**
 * { docId: currentVersion } across all consent-bound documents.
 */
function currentVersionMap() {
    const map = {};
    for (const d of _consentDocs()) map[d.docId] = d.version;
    return map;
}

/**
 * Given a user's accepted-versions summary { docId: version }, return the
 * documents (for their account type) that are missing or out of date.
 * Returns [{ docId, version, urlPath }].
 */
function staleDocsFor(acceptedMap, accountType) {
    const accepted = acceptedMap && typeof acceptedMap === 'object' ? acceptedMap : {};
    return requiredDocsFor(accountType).filter(d => Number(accepted[d.docId]) !== Number(d.version));
}

/**
 * True if the user must (re)accept one or more documents.
 */
function isStale(acceptedMap, accountType) {
    return staleDocsFor(acceptedMap, accountType).length > 0;
}

/**
 * The current withdrawal-waiver descriptor (checkout, consumers only).
 */
function getWithdrawalWaiver() {
    return { ...WITHDRAWAL_WAIVER };
}

module.exports = {
    WITHDRAWAL_WAIVER,
    OPTIONAL_CONSENTS_DEFAULT,
    normalizeAccountType,
    requiredDocsFor,
    currentVersionMap,
    staleDocsFor,
    isStale,
    getWithdrawalWaiver,
    sha256For,
    optionalConsents,
    getOptionalConsent,
};
