/**
 * Webpage thumbnail generator.
 *
 * Renders the user's webpage (index.html + style.css + script.js) in a
 * headless Chromium, screenshots it at 1280×800, downscales to 640×400 JPEG
 * via sharp, and stores the thumbnail in RustFS under
 *   users/{userId}/webpages/{webpageId}/thumbnail.png
 * The DB row stores the sha + size for cache-busting on the list endpoint.
 *
 * scheduleThumbnail() is a debounced fire-and-forget — a burst of html+css+js
 * writes during one chat turn coalesces into a single screenshot ~2 s after
 * the last write. Errors are logged and swallowed so a render failure never
 * breaks the chat (the card just falls back to the emoji tile).
 */

const crypto = require('crypto');
const webpageStore = require('../stores/webpageStore');

const DEBOUNCE_MS = 2000;
const RENDER_TIMEOUT_MS = 15000;
const VIEWPORT = { width: 1280, height: 800 };
const THUMB_DIMS = { width: 640, height: 400 };

// webpageId → { timeout, lastUserId }. When a new schedule arrives we replace
// the pending timer so only one render fires per debounce window.
const pending = new Map();

function composeDoc(html, css, js) {
    const safeHtml = typeof html === 'string' ? html : '';
    const safeCss = typeof css === 'string' ? css : '';
    const safeJs = typeof js === 'string' ? js : '';
    // If the user wrote a full HTML document, inject CSS/JS into it; otherwise
    // wrap their fragment with a minimal scaffold. Matches the frontend
    // composer's intent (composeWebpageDocument.js) without pulling it in.
    const hasHtmlTag = /<html[\s>]/i.test(safeHtml);
    const styleTag = safeCss ? `<style>\n${safeCss}\n</style>` : '';
    const scriptTag = safeJs ? `<script>\n${safeJs}\n<\/script>` : '';
    if (hasHtmlTag) {
        // Inject before </head> or </body>; otherwise append.
        let doc = safeHtml;
        if (/<\/head>/i.test(doc)) {
            doc = doc.replace(/<\/head>/i, `${styleTag}\n</head>`);
        } else {
            doc = `${styleTag}\n${doc}`;
        }
        if (/<\/body>/i.test(doc)) {
            doc = doc.replace(/<\/body>/i, `${scriptTag}\n</body>`);
        } else {
            doc = `${doc}\n${scriptTag}`;
        }
        return doc;
    }
    return `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${styleTag}
</head><body>
${safeHtml}
${scriptTag}
</body></html>`;
}

async function renderThumbnail({ userId, webpageId }) {
    const wp = await webpageStore.getWebpage(webpageId, userId).catch(() => null);
    if (!wp) return; // page was deleted before the render fired
    const slots = await webpageStore.readAllSlots(userId, webpageId);
    if (!slots.html && !slots.css && !slots.js) {
        // Nothing to render yet — clear any stale thumbnail metadata so the
        // card falls back to the emoji tile.
        await webpageStore.updateWebpageMetadata(webpageId, userId, { thumbnailSha: '', thumbnailSize: 0 });
        return;
    }

    const doc = composeDoc(slots.html, slots.css, slots.js);

    let browser = null;
    try {
        const { chromium } = require('playwright');
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        const context = await browser.newContext({
            viewport: VIEWPORT,
            deviceScaleFactor: 1,
            // Run with a clean origin — the iframe sandbox in the editor uses
            // about:blank-equivalent isolation, so do the same here.
            javaScriptEnabled: true,
        });
        const page = await context.newPage();
        // Cap navigation + JS so a broken page can't hang the worker forever.
        page.setDefaultTimeout(RENDER_TIMEOUT_MS);
        await page.setContent(doc, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });
        // A short settle window for late JS (animations, font load) without
        // burning seconds when nothing is happening.
        await page.waitForTimeout(700);

        const fullShot = await page.screenshot({ type: 'png', fullPage: false });

        let resized = fullShot;
        try {
            const sharp = require('sharp');
            resized = await sharp(fullShot)
                .resize({ width: THUMB_DIMS.width, height: THUMB_DIMS.height, fit: 'cover', position: 'top' })
                .jpeg({ quality: 78 })
                .toBuffer();
        } catch (sharpErr) {
            // No sharp available — store the raw PNG. Bigger but still works.
            console.warn('[Thumbnail] sharp resize skipped:', sharpErr.message);
        }

        const sha = crypto.createHash('sha256').update(resized).digest('hex');
        await webpageStore.writeThumbnail(userId, webpageId, resized);
        await webpageStore.updateWebpageMetadata(webpageId, userId, {
            thumbnailSha: sha,
            thumbnailSize: resized.length,
        });
        console.log(`[Thumbnail] rendered ${webpageId} (${resized.length} bytes, sha ${sha.slice(0, 8)})`);
    } catch (err) {
        console.warn(`[Thumbnail] render failed for ${webpageId}: ${err.message}`);
    } finally {
        try { if (browser) await browser.close(); } catch (_) { /* ignore */ }
    }
}

/**
 * Debounced fire-and-forget — caller doesn't await. Subsequent calls within
 * the debounce window replace the pending timer so only one render runs per
 * burst.
 */
function scheduleThumbnail({ userId, webpageId, delayMs = DEBOUNCE_MS }) {
    if (!userId || !webpageId) return;
    const existing = pending.get(webpageId);
    if (existing) clearTimeout(existing.timeout);
    const timeout = setTimeout(() => {
        pending.delete(webpageId);
        renderThumbnail({ userId, webpageId }).catch(err => {
            console.warn(`[Thumbnail] renderThumbnail rejected for ${webpageId}: ${err.message}`);
        });
    }, delayMs);
    pending.set(webpageId, { timeout, lastUserId: userId });
}

module.exports = {
    scheduleThumbnail,
    renderThumbnail,
};
