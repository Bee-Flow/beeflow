/**
 * Legal Document Registry (i18n source of truth)
 *
 * Maps legal-document IDs to their metadata and English markdown source.
 * The English markdown on disk is authoritative; localized convenience
 * translations are stored separately (configStore key i18n_legal_{locale}_{docId})
 * and only served when their stored version matches the registry version below.
 *
 * This is the structural twin of promptDefaults.js — same load/cache shape — so
 * legal documents flow through the existing translation pipeline.
 *
 *   version      monotonic INTEGER, bumped ONLY on a material change. The bump is
 *                the single trigger for both re-translation (stale → serve English)
 *                and re-consent (consent ledger compares accepted version to this).
 *   lastUpdated  human-readable date, shown in the page header.
 *   route        the stable public URL the document is served at.
 *   sourceFile   markdown file under agent-hub/src/marketing/legal/.
 *
 * IMPORTANT: when you edit a sourceFile materially, bump its `version` here.
 */

const fs = require('fs');
const path = require('path');

// Canonical English markdown lives with the marketing legal pages so the
// frontend can also import them as ?raw for an offline fallback. That tree
// (agent-hub/) is OUTSIDE the server's Docker build context, so the server
// image ships a mirror under server/legal/docs (see scripts/sync-legal-docs.js).
// We resolve each file from the first candidate dir that contains it: the
// agent-hub source wins in local/monorepo runs (always fresh), the bundled
// mirror is used in the built server image.
const LEGAL_SOURCE_DIRS = [
    path.join(__dirname, '..', '..', '..', 'agent-hub', 'src', 'marketing', 'legal'),
    path.join(__dirname, '..', '..', 'legal', 'docs'),
];
// Back-compat export: the primary (canonical) dir.
const LEGAL_DIR = LEGAL_SOURCE_DIRS[0];

// requiresConsent → click-through consent doc (drives the registry + re-consent).
// scope → 'both' (everyone), 'b2b' (org admin / DPA controller only), 'b2c' (consumer).
// These are the SEED defaults; an admin can override version / content /
// requiresConsent / scope at runtime via legalStore.
const LEGAL_DOCS = {
    terms: {
        title: 'Terms of Service',
        version: 1,
        lastUpdated: '9 June 2026',
        route: '/terms',
        sourceFile: 'terms.md',
        requiresConsent: true,
        scope: 'both',
    },
    privacy: {
        title: 'Privacy Policy',
        version: 1,
        lastUpdated: '9 June 2026',
        route: '/privacy',
        sourceFile: 'privacy.md',
        requiresConsent: true,
        scope: 'both',
    },
    dpa: {
        title: 'Data Processing Agreement',
        version: 1,
        lastUpdated: '9 June 2026',
        route: '/legal/dpa',
        sourceFile: 'dpa.md',
        requiresConsent: true,
        scope: 'b2b',
    },
    aup: {
        title: 'Acceptable Use Policy',
        version: 1,
        lastUpdated: '9 June 2026',
        route: '/legal/aup',
        sourceFile: 'aup.md',
        requiresConsent: true,
        scope: 'both',
    },
    'cookie-statement': {
        title: 'Cookie Statement',
        version: 1,
        lastUpdated: '9 June 2026',
        route: '/legal/cookies',
        sourceFile: 'cookie-statement.md',
        requiresConsent: false,
        scope: 'both',
    },
    imprint: {
        title: 'Legal Notice',
        version: 1,
        lastUpdated: '9 June 2026',
        route: '/legal/imprint',
        sourceFile: 'imprint.md',
        requiresConsent: false,
        scope: 'both',
    },
    subprocessors: {
        title: 'Sub-processor List',
        version: 1,
        lastUpdated: '9 June 2026',
        route: '/legal/subprocessors',
        sourceFile: 'subprocessors.md',
        requiresConsent: false,
        scope: 'both',
    },
};

const LEGAL_DOC_IDS = Object.keys(LEGAL_DOCS);

// Maps a /legal/:segment URL segment to its docId (the route is /legal/cookies
// but the docId is cookie-statement).
const ROUTE_SEGMENT_TO_DOC_ID = {
    dpa: 'dpa',
    aup: 'aup',
    cookies: 'cookie-statement',
    imprint: 'imprint',
    subprocessors: 'subprocessors',
};

// ── Cache for loaded English source markdown ─────────────────────

let _sourceCache = null;

function _loadSources() {
    if (_sourceCache) return _sourceCache;
    const sources = {};
    for (const [docId, meta] of Object.entries(LEGAL_DOCS)) {
        let loaded = false;
        for (const dir of LEGAL_SOURCE_DIRS) {
            const filePath = path.join(dir, meta.sourceFile);
            try {
                if (fs.existsSync(filePath)) {
                    sources[docId] = fs.readFileSync(filePath, 'utf-8');
                    loaded = true;
                    break;
                }
            } catch (err) {
                console.warn(`[LegalDocs] Failed to load ${docId} from ${filePath}:`, err.message);
            }
        }
        if (!loaded) {
            console.warn(`[LegalDocs] Source not found for ${docId} (${meta.sourceFile}) in any of: ${LEGAL_SOURCE_DIRS.join(', ')}`);
        }
    }
    _sourceCache = sources;
    return sources;
}

/**
 * Read the raw English markdown for a doc (cached, synchronous).
 */
function getLegalSource(docId) {
    return _loadSources()[docId] || null;
}

/**
 * Get a doc's EFFECTIVE metadata + English markdown body — the code seed merged
 * with any runtime admin override (legalStore). Lazy-require legalStore to keep
 * the module dependency one-way (legalStore must not import this at load time).
 */
function getLegalDefault(docId) {
    const meta = LEGAL_DOCS[docId];
    if (!meta) return null;

    let metaOv = null;
    let enOv = null;
    try {
        const legalStore = require('../../legal/legalStore');
        if (legalStore.isLoaded()) {
            metaOv = legalStore.getMetaOverride(docId);
            enOv = legalStore.getEnglishOverride(docId);
        }
    } catch (_) { /* registry not wired yet → use code defaults */ }

    const effective = {
        title: meta.title,
        route: meta.route,
        version: (metaOv && metaOv.version != null) ? metaOv.version : meta.version,
        lastUpdated: (metaOv && metaOv.lastUpdated) ? metaOv.lastUpdated : meta.lastUpdated,
        requiresConsent: (metaOv && metaOv.requiresConsent != null) ? !!metaOv.requiresConsent : !!meta.requiresConsent,
        scope: (metaOv && metaOv.scope) ? metaOv.scope : (meta.scope || 'both'),
    };
    const markdown = enOv || getLegalSource(docId) || '';
    return { docId, ...effective, markdown, hasOverride: !!(metaOv || enOv) };
}

/**
 * Get all docs as { docId: { ...meta, markdown } }.
 */
function getAllLegalDefaults() {
    const out = {};
    for (const docId of LEGAL_DOC_IDS) out[docId] = getLegalDefault(docId);
    return out;
}

/**
 * Clear the source cache (e.g. after an admin edits a document at runtime).
 */
function clearLegalDefaultsCache() {
    _sourceCache = null;
}

module.exports = {
    LEGAL_DOCS,
    LEGAL_DOC_IDS,
    LEGAL_DIR,
    ROUTE_SEGMENT_TO_DOC_ID,
    getLegalSource,
    getLegalDefault,
    getAllLegalDefaults,
    clearLegalDefaultsCache,
};
