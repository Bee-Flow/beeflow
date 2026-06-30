/**
 * Legal Store — runtime overrides for the legal documents.
 *
 * The code defaults (server/i18n/defaults/legalDocs.js, disk markdown + static
 * meta) are the SEED. This store lets a platform admin override a document's
 * English content, version, lastUpdated, requiresConsent flag and scope at
 * runtime (no deploy), and manage the optional-consent catalog (marketing).
 *
 * Overrides live in configStore; an in-memory cache makes them available to the
 * SYNCHRONOUS consent functions (documentRegistry / consentGuards). The cache is
 * refreshed at server startup and after every admin write. Before the first
 * refresh, isLoaded() is false and the registry falls back to the code defaults
 * — always safe.
 *
 * Storage (configStore):
 *   legal_doc_overrides       → { [docId]: { version, lastUpdated, requiresConsent, scope, markdownEn? } }
 *   legal_optional_consents   → [ { id, version, category, enabled, labelKey } ]
 *
 * This module deliberately does NOT require legalDocs at load time (the merge is
 * done in legalDocs, which requires this) — keeping the dependency one-way.
 */

const configStore = require('../stores/configStore');

const OVERRIDES_KEY = 'legal_doc_overrides';
const OPTIONAL_KEY = 'legal_optional_consents';

let _cache = { overrides: {}, optional: null, loaded: false };

/**
 * Load all overrides from configStore into the in-memory cache.
 * Call at startup and after every admin write.
 */
async function refresh() {
    try {
        const overrides = await configStore.getConfig(OVERRIDES_KEY);
        const optional = await configStore.getConfig(OPTIONAL_KEY);
        _cache = {
            overrides: (overrides && typeof overrides === 'object') ? overrides : {},
            optional: Array.isArray(optional) ? optional : null,
            loaded: true,
        };
    } catch (err) {
        console.warn('[LegalStore] refresh failed:', err.message);
        _cache.loaded = true; // fall back to defaults rather than blocking
    }
    return _cache;
}

function isLoaded() {
    return _cache.loaded;
}

/** Meta override for a doc (version/lastUpdated/requiresConsent/scope), or null. */
function getMetaOverride(docId) {
    const o = _cache.overrides[docId];
    if (!o) return null;
    const { markdownEn, ...meta } = o; // eslint-disable-line no-unused-vars
    return Object.keys(meta).length ? meta : null;
}

/** English markdown override for a doc, or null. */
function getEnglishOverride(docId) {
    const o = _cache.overrides[docId];
    return (o && typeof o.markdownEn === 'string' && o.markdownEn.trim()) ? o.markdownEn : null;
}

/** The optional-consent catalog override (array) or null. */
function getOptionalOverride() {
    return _cache.optional;
}

/** True if a doc has any admin override stored. */
function hasOverride(docId) {
    return !!_cache.overrides[docId];
}

// ── Admin writers ────────────────────────────────────────────────

/**
 * Merge a patch into a doc's override and refresh the cache.
 * patch may contain: markdownEn, version, lastUpdated, requiresConsent, scope.
 */
async function setDocOverride(docId, patch) {
    const all = (await configStore.getConfig(OVERRIDES_KEY)) || {};
    all[docId] = { ...(all[docId] || {}), ...patch };
    await configStore.setConfig(OVERRIDES_KEY, all);
    await refresh();
    return all[docId];
}

/** Remove a doc's override entirely (revert to code default). */
async function clearDocOverride(docId) {
    const all = (await configStore.getConfig(OVERRIDES_KEY)) || {};
    delete all[docId];
    await configStore.setConfig(OVERRIDES_KEY, all);
    await refresh();
}

/** Replace the optional-consent catalog. */
async function setOptionalConsents(list) {
    await configStore.setConfig(OPTIONAL_KEY, Array.isArray(list) ? list : []);
    await refresh();
    return list;
}

module.exports = {
    refresh,
    isLoaded,
    getMetaOverride,
    getEnglishOverride,
    getOptionalOverride,
    hasOverride,
    setDocOverride,
    clearDocOverride,
    setOptionalConsents,
};
