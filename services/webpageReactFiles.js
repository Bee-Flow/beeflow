/**
 * Shared helper: build the esbuild virtual-FS file map + binary asset map for a
 * react-mui webpage from its extra files.
 *
 * A react-mui project's whole app lives in extra files under `src/` (the three
 * primary slots index.html/style.css/script.js are ignored by the React
 * preview). Both the headless screenshot render (webpageRender.js) and the
 * public-share snapshot (webpageSnapshot.js) need the SAME file map to feed
 * reactBundleServer.composeReactDoc, so it lives here as one source of truth.
 *
 * `ownerId` is the webpage OWNER's id — extra-file bytes live under the owner's
 * RustFS prefix, never the caller's.
 */

const webpageStore = require('../stores/webpageStore');

async function loadReactFiles(webpageId, ownerId) {
    const files = {};
    const assetMap = {};
    const metas = await webpageStore.listExtraFiles(webpageId).catch(() => []);
    for (const meta of metas) {
        if (!meta || !meta.path) continue;
        const res = await webpageStore.readExtraFile({ webpageId, userId: ownerId, path: meta.path }).catch(() => null);
        if (!res) continue;
        if (meta.isText && typeof res.text === 'string') {
            files[meta.path] = { isText: true, content: res.text };
        } else if (res.bytes) {
            const dataUrl = `data:${meta.mimeType || 'application/octet-stream'};base64,${res.bytes.toString('base64')}`;
            files[meta.path] = { isText: false, dataUrl };
            assetMap[meta.path] = dataUrl;
        }
    }
    return { files, assetMap };
}

module.exports = { loadReactFiles };
