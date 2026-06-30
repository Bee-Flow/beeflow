/**
 * On-demand webpage render + screenshot — powers the `webpage_screenshot` tool
 * so the builder AI can SEE the page it's building (react-mui or vanilla) and
 * collect runtime/console errors.
 *
 * Renders headless via the persistent bf-browser (browserProvider), reusing the
 * thumbnail generator's pattern. React/MUI is bundled server-side (reactBundle-
 * Server, the twin of the client preview) so the screenshot matches the live
 * preview. Platform data bridges are STUBBED (the headless browser can't reach
 * the API), so data-driven pages render their shell.
 */

const webpageStore = require('../stores/webpageStore');
const { resolveFramework } = require('../integrations/webpageFramework');
const { composeDoc } = require('../core/webpageThumbnailGenerator');
const { composeReactDoc, buildStubBridgeScript } = require('./reactBundleServer');
const { loadReactFiles } = require('./webpageReactFiles');

const VIEWPORTS = {
    desktop: { width: 1280, height: 800 },
    tablet: { width: 834, height: 1112 },
    mobile: { width: 390, height: 844 },
};
const RENDER_TIMEOUT_MS = 20000;
const MOUNT_WAIT_MS = 14000; // generous — cold esm.sh + the full MUI module graph is slow
const SETTLE_MS = 700;
const MAX_DIM = 1280;       // cap longest side before handing the PNG to the model
const MAX_FULLPAGE_H = 4000;
const MAX_DIAG_MSGS = 25;
// A local fake origin the doc is served from (real navigation → import maps +
// module scripts execute). https so esm.sh (https) isn't blocked as mixed content.
const PREVIEW_ORIGIN = 'https://webpage-preview.beeflow.local/';
const PREVIEW_URL = PREVIEW_ORIGIN;

function resolveViewport(viewport) {
    if (viewport && typeof viewport === 'object' && viewport.width && viewport.height) {
        return { width: viewport.width, height: viewport.height };
    }
    return VIEWPORTS[viewport] || VIEWPORTS.desktop;
}

/** Inject the stub bridges into a vanilla doc so beeflowDB/App calls don't crash. */
function injectStubBridges(doc) {
    const stub = buildStubBridgeScript();
    if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => `${m}\n${stub}`);
    return `${stub}\n${doc}`;
}

/**
 * Render + screenshot a webpage.
 * @returns {Promise<{ pngBuffer:Buffer|null, width:number, height:number, framework:string,
 *   consoleErrors:string[], pageErrors:string[], guardPanel:string|null, renderedEmpty:boolean,
 *   buildError:string|null, empty:boolean }>}
 */
async function captureWebpage({ webpageId, userId, viewport = 'desktop', fullPage = false }) {
    const wp = await webpageStore.getWebpage(webpageId, userId).catch(() => null);
    if (!wp) throw new Error('Webpage not found');
    const framework = resolveFramework(wp);
    const vp = resolveViewport(viewport);

    let doc;
    if (framework === 'react-mui') {
        const { files, assetMap } = await loadReactFiles(webpageId, userId);
        const hasEntry = Object.prototype.hasOwnProperty.call(files, 'src/main.jsx');
        if (!hasEntry && Object.keys(files).length === 0) {
            return emptyResult(framework, vp);
        }
        const composed = await composeReactDoc({ files, assetMap });
        if (composed.buildError) {
            return { ...emptyResult(framework, vp), buildError: composed.buildError, empty: false };
        }
        doc = composed.doc;
    } else {
        const slots = await webpageStore.readAllSlots(userId, webpageId);
        if (!slots.html && !slots.css && !slots.js) return emptyResult(framework, vp);
        doc = injectStubBridges(composeDoc(slots.html, slots.css, slots.js));
    }

    const browserProvider = require('./browserProvider');
    const consoleErrors = [];
    const pageErrors = [];

    const shot = await browserProvider.withContext(
        { viewport: vp, deviceScaleFactor: 1, javaScriptEnabled: true },
        async (context) => {
            const page = await context.newPage();
            page.setDefaultTimeout(RENDER_TIMEOUT_MS);
            page.on('console', (m) => {
                try {
                    const t = m.type();
                    if ((t === 'error' || t === 'warning') && consoleErrors.length < MAX_DIAG_MSGS) {
                        consoleErrors.push(`[${t}] ${m.text()}`.slice(0, 300));
                    }
                } catch (_) { /* ignore */ }
            });
            page.on('pageerror', (e) => {
                if (pageErrors.length < MAX_DIAG_MSGS) pageErrors.push(String(e && e.message || e).slice(0, 300));
            });

            // Serve the doc via a REAL navigation (route interception) instead of
            // page.setContent — `<script type="importmap">` + `<script type="module">`
            // are only honoured during normal document parsing. setContent injects
            // via document.write and the import map is ignored, so React/MUI never
            // load (0 network requests, blank #root). esm.sh (absolute https) passes
            // through untouched; only the page URL is fulfilled locally.
            await page.route((u) => u.href.startsWith(PREVIEW_ORIGIN), (route) => {
                if (route.request().url() === PREVIEW_URL) {
                    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: doc });
                }
                return route.fulfill({ status: 204, body: '' });
            });
            await page.goto(PREVIEW_URL, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS });

            if (framework === 'react-mui') {
                // Resolve as soon as EITHER the app mounts real content OR the
                // guard paints a crash panel. A genuinely-empty render (no crash,
                // no output) times out → we still screenshot the blank #root.
                // Swallowed so timing never throws.
                await page.waitForFunction(
                    () => {
                        const r = document.getElementById('root');
                        if (!r) return false;
                        if (r.querySelector('[data-beeflow-guard]')) return true; // crash panel shown
                        return r.children.length > 0;                              // real mount
                    },
                    { timeout: MOUNT_WAIT_MS, polling: 200 }
                ).catch(() => {});
            }
            await page.waitForTimeout(SETTLE_MS);

            let renderedEmpty = false;
            let guardPanel = null;
            if (framework === 'react-mui') {
                const info = await page.evaluate(() => {
                    const r = document.getElementById('root');
                    if (!r) return { childCount: 0, guardText: null };
                    const g = r.querySelector('[data-beeflow-guard]');
                    return { childCount: r.children.length, guardText: g ? (g.innerText || '').slice(0, 1500) : null };
                }).catch(() => ({ childCount: 1, guardText: null }));
                renderedEmpty = info.childCount === 0;
                guardPanel = info.guardText;
            }

            const png = await page.screenshot({ type: 'png', fullPage: !!fullPage });
            return { png, renderedEmpty, guardPanel };
        }
    );

    let pngBuffer = shot.png;
    let width = vp.width;
    let height = vp.height;
    try {
        const sharp = require('sharp');
        const meta = await sharp(pngBuffer).metadata();
        width = meta.width || width;
        height = meta.height || height;
        if (width > MAX_DIM || height > MAX_FULLPAGE_H) {
            pngBuffer = await sharp(pngBuffer)
                .resize({ width: MAX_DIM, height: MAX_FULLPAGE_H, fit: 'inside', withoutEnlargement: true })
                .png({ compressionLevel: 9 })
                .toBuffer();
            const m2 = await sharp(pngBuffer).metadata();
            width = m2.width || width;
            height = m2.height || height;
        }
    } catch (_) { /* sharp unavailable — keep raw PNG */ }

    return {
        pngBuffer,
        width,
        height,
        framework,
        consoleErrors,
        pageErrors,
        guardPanel: shot.guardPanel,
        renderedEmpty: shot.renderedEmpty,
        buildError: null,
        empty: false,
    };
}

function emptyResult(framework, vp) {
    return {
        pngBuffer: null, width: vp.width, height: vp.height, framework,
        consoleErrors: [], pageErrors: [], guardPanel: null, renderedEmpty: true,
        buildError: null, empty: true,
    };
}

module.exports = { captureWebpage, VIEWPORTS };
