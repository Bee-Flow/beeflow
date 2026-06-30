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
 * JS is NOT included in the VANILLA snapshot. The public viewer renders the
 * snapshot inside an iframe with `sandbox="allow-scripts allow-forms"` (no
 * allow-same-origin) — the page's own JS is stripped at snapshot time so
 * allow-scripts only benefits whitelisted nested iframes (the Bee Flow chat
 * embed). Keeping the vanilla snapshot script-free means a future sandbox
 * tightening remains a no-op for stored pages.
 *
 * REACT-MUI pages are different: a React app renders nothing without JS, so we
 * bundle it server-side (reactBundleServer.composeReactDoc — the same artifact
 * the headless thumbnail render uses) into ONE self-contained document with
 * STUBBED bridges (no live DB/AI), store it in the `reactdoc` slot, and serve
 * it with a script-allowing CSP. The trust boundary is the no-same-origin
 * sandbox (executing JS can't reach beeflow.nl cookies/session), not DOMPurify.
 *
 * Extra files (multi-file projects, vanilla only): text files (HTML/CSS/SVG)
 * are sanitized and copied; binary files (images, fonts) are copied as-is. For
 * react-mui, assets are inlined as data: URLs inside the bundled doc.
 */

const { JSDOM } = require('jsdom');
const createDOMPurify = require('dompurify');

const webpageStore = require('../stores/webpageStore');
const publicShareStore = require('../stores/webpagePublicShareStore');
const storageStore = require('../stores/storageStore');
const { resolveFramework } = require('../integrations/webpageFramework');
const { composeReactDoc } = require('./reactBundleServer');
const { loadReactFiles } = require('./webpageReactFiles');

// Single shared DOMPurify instance — jsdom window is expensive to create.
const _window = new JSDOM('<!doctype html><html><body></body></html>').window;
const DOMPurify = createDOMPurify(_window);

// Iframe allowlist: only Bee Flow's own chat-embed pages may survive into a
// public snapshot. The host is derived from the same env var that the share
// URL builder uses, so deployments on white-label / self-hosted domains keep
// behaviour in lockstep. Trailing slash is normalised; path must be /chat/<id>
// with a conservative id charset.
function getEmbedAllowedHost() {
    const raw = process.env.PUBLIC_SHARE_BASE_URL
        || process.env.PUBLIC_APP_URL
        || 'https://beeflow.nl';
    try { return new URL(raw).origin; }
    catch { return 'https://beeflow.nl'; }
}
function isAllowedEmbedSrc(src) {
    if (typeof src !== 'string' || !src) return false;
    let u;
    try { u = new URL(src); }
    catch { return false; }
    if (u.origin !== getEmbedAllowedHost()) return false;
    return /^\/chat\/[A-Za-z0-9-]+\/?$/.test(u.pathname);
}

// Iframes whose `src` survives `isAllowedEmbedSrc` keep only this attribute
// set; everything else (sandbox/srcdoc/name/allow/onload/…) is stripped. We
// set the OUTER sandbox in publicViewer.js, so callers cannot escalate
// privileges by smuggling their own sandbox= here.
const IFRAME_ATTR_ALLOWLIST = new Set([
    'src', 'width', 'height', 'style', 'title', 'loading',
    'frameborder', 'scrolling', 'allowfullscreen',
]);

DOMPurify.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'iframe') return;
    const src = node.getAttribute && node.getAttribute('src');
    if (!isAllowedEmbedSrc(src)) {
        // Returning here is not enough — we have to remove the node ourselves
        // since DOMPurify doesn't know we want it gone. parentNode.removeChild
        // is the standard pattern in DOMPurify hooks.
        if (node.parentNode) node.parentNode.removeChild(node);
        return;
    }
    // Strip any attributes that aren't on the allowlist. Iterate over a
    // snapshot of names because we mutate the live NamedNodeMap.
    const attrs = Array.from(node.attributes || []);
    for (const a of attrs) {
        if (!IFRAME_ATTR_ALLOWLIST.has(a.name.toLowerCase())) {
            node.removeAttribute(a.name);
        }
    }
});

const SANITIZE_HTML_CONFIG = {
    USE_PROFILES: { html: true, svg: true },
    // `iframe` removed from FORBID_TAGS — the uponSanitizeElement hook above
    // gates it by src so only Bee Flow chat embeds pass through. Everything
    // else (script/object/embed/base/meta/form) stays banned.
    FORBID_TAGS: ['script', 'object', 'embed', 'base', 'meta', 'form'],
    FORBID_ATTR: ['style' /* allowed via SAFE_FOR_TEMPLATES off */],
    // Allow inline style — pages often rely on it heavily — but block the rest.
    ALLOWED_ATTR: undefined,
    ADD_TAGS: ['iframe'],
    ADD_ATTR: ['target', 'rel', 'allowfullscreen'],
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
 * Branches on the page's FRAMEWORK:
 *   • react-mui → bundle the React app server-side into a single self-contained
 *     document (reactBundleServer.composeReactDoc — inline module + esm.sh
 *     import map + STUBBED bridges) and store it in the `reactdoc` slot. The
 *     public viewer serves it with a script-allowing CSP inside the
 *     no-same-origin sandbox. Records snapshot_kind = 'react'.
 *   • vanilla → read the live HTML/CSS (plus extras) from the owner's prefix,
 *     sanitize with DOMPurify, and write the script-free trio. Records
 *     snapshot_kind = 'static'.
 *
 * Returns a small summary of what was captured.
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

    const wp = await webpageStore.getWebpageRaw(webpageId).catch(() => null);
    const framework = resolveFramework(wp);

    if (framework === 'react-mui') {
        return writeReactSnapshot({ shareId, webpageId, ownerId });
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

    await publicShareStore.setSnapshotKind(shareId, 'static');
    return captured;
}

/**
 * Snapshot a react-mui page: bundle it server-side into one self-contained
 * document and store it in the `reactdoc` slot. No DOMPurify — this is the
 * owner's OWN bundled code; isolation comes from the no-same-origin sandbox +
 * stubbed bridges (composeReactDoc) + the script-allowing CSP scoped to the
 * react `/content` response. Throws on a bundle failure so share creation can
 * surface it (and roll back) and the fire-and-forget re-snapshot can log it.
 */
async function writeReactSnapshot({ shareId, webpageId, ownerId }) {
    const { files, assetMap } = await loadReactFiles(webpageId, ownerId);
    const composed = await composeReactDoc({ files, assetMap });
    if (composed.buildError) {
        throw new Error('React bundle failed: ' + composed.buildError);
    }
    const docBuf = Buffer.from(composed.doc, 'utf8');
    await storageStore.uploadFile(
        publicShareStore.snapshotKey(shareId, 'reactdoc'),
        docBuf,
        'text/html; charset=utf-8'
    );
    await publicShareStore.setSnapshotKind(shareId, 'react');
    return { reactDoc: docBuf.length, html: 0, css: 0, extras: 0 };
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
