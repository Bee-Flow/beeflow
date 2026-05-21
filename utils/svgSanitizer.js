/**
 * SVG Sanitizer — strips scripts, event handlers, and external references
 * from user-uploaded SVGs so they're safe to serve inline.
 *
 * Used by the CMS asset upload path (logos in the "Trusted by teams"
 * block). The historical default was to reject SVG outright because the
 * asset endpoint serves files inline with their stored Content-Type, and
 * a hostile SVG would run under our origin. With sanitization we can
 * accept SVG, store the cleaned bytes, and flag the object as sanitized
 * so the asset endpoint serves it inline (with a strong CSP) instead of
 * force-downloading it.
 *
 * Defenses applied:
 *   - DOMPurify with svg + svgFilters profiles (drops <script>,
 *     <foreignObject>, event handlers, etc).
 *   - Explicit FORBID_TAGS / FORBID_ATTR for the high-risk surface.
 *   - href / xlink:href values are forced to be document-local (#fragment)
 *     so the SVG cannot fetch external resources, leak referer, or be
 *     used for SSRF-via-browser.
 */

const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

const SVG_ROOT_RE = /<svg[\s>]/i;

let purifyInstance = null;

function getPurify() {
    if (purifyInstance) return purifyInstance;
    const window = new JSDOM('').window;
    const purify = createDOMPurify(window);

    // Block <a href="javascript:…"> and external image references.
    // The afterSanitizeAttributes hook is the supported way to enforce
    // a URL allowlist on attributes DOMPurify already decided to keep.
    purify.addHook('afterSanitizeAttributes', (node) => {
        if (!node.hasAttribute) return;
        for (const attr of ['href', 'xlink:href']) {
            if (node.hasAttribute(attr)) {
                const val = (node.getAttribute(attr) || '').trim();
                // Allow only same-document fragment refs (e.g. <use href="#gradient">).
                if (!val.startsWith('#')) node.removeAttribute(attr);
            }
        }
    });

    purifyInstance = purify;
    return purify;
}

/**
 * Sanitize an SVG buffer.
 * @param {Buffer|string} input - raw SVG bytes (or string)
 * @returns {Buffer|null} sanitized SVG, or null if input wasn't a valid SVG
 */
function sanitizeSvg(input) {
    if (!input) return null;
    const raw = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
    if (!SVG_ROOT_RE.test(raw)) return null;

    const purify = getPurify();
    const clean = purify.sanitize(raw, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['script', 'foreignObject'],
        FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
    });

    if (!clean || !SVG_ROOT_RE.test(clean)) return null;
    return Buffer.from(clean, 'utf8');
}

module.exports = { sanitizeSvg };
