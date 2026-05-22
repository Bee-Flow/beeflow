/**
 * Webpage Snapshot Service — capture an immutable, sanitized copy of a
 * webpage for external/public sharing.
 *
 * The published snapshot is intentionally NOT the same artifact the internal
 * preview iframe renders. The internal preview is wrapped at runtime with
 * window.beeflowAI / .beeflowAutomations / .beeflowIntegrations / .beeflowDB
 * bridges (acts-as-author calls to the platform) — those must never reach an
 * external viewer. We solve this by:
 *
 *   1. Reading the raw stored HTML/CSS/JS from the owner's RustFS prefix
 *   2. Running the HTML through DOMPurify with a strict allowlist
 *      (no scripts, no event handlers, no javascript:/data: script URLs,
 *      no iframes/objects/embeds, no meta refresh)
 *   3. Writing the sanitized trio to the share's snapshot prefix
 *      (`webpage-public-shares/{share_id}/...`) so it survives owner
 *      deletion or transfer
 *
 * JS is NOT included in the snapshot. The public viewer renders the snapshot
 * inside an iframe with `sandbox="allow-forms"` (no allow-scripts) — running
 * the page's JS would be both blocked at render time AND a meaningful
 * security regression if we ever loosened the sandbox later. Strip it now.
 *
 * Extra files (multi-file projects): text files (HTML/CSS/SVG) are sanitized
 * and copied; binary files (images, fonts) are copied as-is.
 */

const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

const webpageStore = require('../stores/webpageStore');
const publicShareStore = require('../stores/webpagePublicShareStore');
const storageStore = require('../stores/storageStore');

// Single shared DOMPurify instance — jsdom window is expensive to create.
const _window = new JSDOM('<!doctype html><html><body></body></html>').window;
const DOMPurify = createDOMPurify(_window);

const SANITIZE_HTML_CONFIG = {
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'meta', 'form'],
    FORBID_ATTR: ['style' /* allowed via SAFE_FOR_TEMPLATES off */],
    // Allow inline style — pages often rely on it heavily — but block the rest.
    ALLOWED_ATTR: undefined,
    ADD_TAGS: [],
    ADD_ATTR: ['target', 'rel'],
    // Strip on* handlers (default), javascript:/vbscript: URLs (default),
    // and anything that could re-enable scripting.
    KEEP_CONTENT: true,
};

// We re-enable style because banning inline styles would break almost every
// page. DOMPurify already strips dangerous CSS expressions.
delete SANITIZE_HTML_CONFIG.FORBID_ATTR;

const SANITIZE_SVG_CONFIG = {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
};

function sanitizeHtml(html) {
    if (!html) return '';
    const clean = DOMPurify.sanitize(String(html), SANITIZE_HTML_CONFIG);
    return harden(clean);
}

function sanitizeSvg(svg) {
    if (!svg) return '';
    return DOMPurify.sanitize(String(svg), SANITIZE_SVG_CONFIG);
}

/**
 * Belt-and-braces post-pass on sanitized HTML. DOMPurify already handles
 * these, but a single regex sweep adds a cheap second line of defence in
 * case a future config change accidentally loosens the policy.
 */
function harden(html) {
    return String(html)
        // Drop any <script>…</script> blocks that slipped through (shouldn't).
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        // Strip on*= event handlers wherever they appear.
        .replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '')
        .replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '')
        .replace(/\s+on[a-z]+\s*=\s*[^\s>]+/gi, '')
        // Block javascript:/vbscript: URLs in href/src.
        .replace(/((?:href|src)\s*=\s*["']?)\s*javascript:[^"' >]*/gi, '$1about:blank')
        .replace(/((?:href|src)\s*=\s*["']?)\s*vbscript:[^"' >]*/gi, '$1about:blank');
}

/**
 * CSS sanitization. DOMPurify doesn't process raw stylesheets, so we run a
 * narrow regex sweep to remove the patterns that can exfiltrate or escape:
 *   • @import          — can pull external CSS that itself contains exfil
 *   • url(javascript:) — IE-legacy, but trivially cheap to block
 *   • expression()     — same
 * Modern CSS isn't capable of script execution on its own, so we leave the
 * rest alone (font URLs, web fonts, etc. are fine).
 */
function sanitizeCss(css) {
    if (!css) return '';
    return String(css)
        .replace(/@import[^;]*;?/gi, '')
        .replace(/expression\s*\(([^)]*)\)/gi, '/* expr-blocked */')
        .replace(/url\s*\(\s*['"]?\s*javascript:[^)]*\)/gi, 'url(about:blank)')
        .replace(/url\s*\(\s*['"]?\s*vbscript:[^)]*\)/gi, 'url(about:blank)');
}

const TEXT_LIKE_MIMES = ['text/html', 'image/svg', 'text/css'];
function shouldSanitizeExtra(mime) {
    if (!mime) return false;
    return TEXT_LIKE_MIMES.some(p => mime.startsWith(p));
}

/**
 * Sanitize a single text extra-file by mime. Plain text/markdown/json pass
 * through unchanged — they're served by the viewer to inspect, not execute.
 */
function sanitizeExtra(content, mime) {
    if (!shouldSanitizeExtra(mime)) return content;
    if (mime.startsWith('text/html')) return sanitizeHtml(content);
    if (mime.startsWith('image/svg')) return sanitizeSvg(content);
    if (mime.startsWith('text/css')) return sanitizeCss(content);
    return content;
}

/**
 * Build and store a snapshot for an existing share row.
 *
 * Reads the live HTML/CSS (plus extras) from the owner's prefix, sanitizes,
 * and writes to webpage-public-shares/{shareId}/.... Returns a small summary
 * of what was captured.
 *
 * @param {object} args
 * @param {string} args.shareId
 * @param {string} args.webpageId
 * @param {string} args.ownerId — webpage owner (NOT the publisher; the bytes
 *                                live under the owner's RustFS prefix).
 * @param {boolean} [args.includeExtraFiles=true]
 */
async function writeSnapshot({ shareId, webpageId, ownerId, includeExtraFiles = true }) {
    if (!storageStore.isAvailable()) {
        throw new Error('RustFS not configured — cannot snapshot webpage for public share');
    }
    const { html, css /* js omitted by design */ } = await webpageStore.readAllSlots(ownerId, webpageId);

    const cleanHtml = sanitizeHtml(html);
    const cleanCss = sanitizeCss(css);

    const htmlBuf = Buffer.from(cleanHtml, 'utf8');
    const cssBuf = Buffer.from(cleanCss, 'utf8');

    await storageStore.uploadFile(
        publicShareStore.snapshotKey(shareId, 'html'),
        htmlBuf,
        'text/html; charset=utf-8'
    );
    if (cssBuf.length > 0) {
        await storageStore.uploadFile(
            publicShareStore.snapshotKey(shareId, 'css'),
            cssBuf,
            'text/css; charset=utf-8'
        );
    }

    const captured = { html: htmlBuf.length, css: cssBuf.length, extras: 0 };

    if (includeExtraFiles) {
        const extras = await webpageStore.listExtraFiles(webpageId);
        for (const meta of extras) {
            const buf = await readExtraBytes(ownerId, webpageId, meta.path);
            if (!buf) continue;
            const out = meta.isText && shouldSanitizeExtra(meta.mimeType)
                ? Buffer.from(sanitizeExtra(buf.toString('utf8'), meta.mimeType), 'utf8')
                : buf;
            await storageStore.uploadFile(
                publicShareStore.snapshotExtraKey(shareId, meta.path),
                out,
                meta.mimeType
            );
            captured.extras += 1;
        }
    }

    return captured;
}

async function readExtraBytes(ownerId, webpageId, path) {
    // webpageStore doesn't export the raw RustFS read for extras directly,
    // so use readExtraFile and pluck `bytes`. Returns null when missing.
    const res = await webpageStore.readExtraFile({ webpageId, userId: ownerId, path });
    if (!res) return null;
    return res.bytes || null;
}

/**
 * Read a snapshot slot back. Returns '' when the slot wasn't written (e.g.
 * the page had no CSS). The viewer route uses this to compose the response.
 */
async function readSnapshotSlot(shareId, slot) {
    if (!storageStore.isAvailable()) return '';
    try {
        const { stream } = await storageStore.streamFile(publicShareStore.snapshotKey(shareId, slot));
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return '';
        throw err;
    }
}

async function readSnapshotExtra(shareId, path) {
    if (!storageStore.isAvailable()) return null;
    try {
        const { stream, contentType } = await storageStore.streamFile(publicShareStore.snapshotExtraKey(shareId, path));
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return { bytes: Buffer.concat(chunks), contentType: contentType || 'application/octet-stream' };
    } catch (err) {
        if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
        throw err;
    }
}

module.exports = {
    writeSnapshot,
    readSnapshotSlot,
    readSnapshotExtra,
    sanitizeHtml,
    sanitizeCss,
    sanitizeSvg,
};
