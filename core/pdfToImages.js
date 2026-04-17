/**
 * PDF → PNG page images — last-resort fallback for scanned PDFs when
 * Azure Document Intelligence and Mistral OCR are both unavailable.
 *
 * Renders with pdfjs-dist's built-in page.render() against an off-screen
 * canvas from @napi-rs/canvas (prebuilt native Rust binary, no system deps).
 * If @napi-rs/canvas isn't installed, we return null — the caller should
 * degrade gracefully rather than crash.
 *
 * Cap at 20 pages because a single 100-page scanned manual rendered as
 * high-resolution images is a context-window and cost disaster. The
 * 'truncated' flag lets the caller warn the user.
 */

let _canvasMod = null;
let _canvasImportAttempted = false;

function loadCanvas() {
    if (_canvasMod) return _canvasMod;
    if (_canvasImportAttempted) return null;
    _canvasImportAttempted = true;
    try {
        _canvasMod = require('@napi-rs/canvas');
        return _canvasMod;
    } catch (err) {
        console.warn('[PdfToImages] @napi-rs/canvas is not installed — vision fallback for scanned PDFs disabled. To enable: `npm install @napi-rs/canvas` in server/.');
        return null;
    }
}

let _getDocument = null;
async function loadGetDocument() {
    if (_getDocument) return _getDocument;
    const mod = await Promise.race([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('pdfjs-dist import timed out after 10s')), 10000)),
    ]);
    _getDocument = mod.getDocument;
    return _getDocument;
}

/**
 * Render PDF pages to PNG images.
 *
 * @param {Buffer|Uint8Array} pdfBuffer
 * @param {object} [opts]
 * @param {number} [opts.maxPages=20] — hard cap on page count to avoid runaway cost/context
 * @param {number} [opts.scale=1.5]   — render scale; 1.5x at 72dpi ≈ 108 DPI, readable for OCR/vision
 * @param {string} [opts.filename]
 * @returns {Promise<{ images: Array<{ base64: string, mimeType: 'image/png' }>, totalPages: number, truncated: boolean } | null>}
 *          Returns null if canvas is unavailable or rendering fails outright.
 */
async function renderPdfPagesToImages(pdfBuffer, { maxPages = 20, scale = 1.5, filename = 'unknown' } = {}) {
    const canvasMod = loadCanvas();
    if (!canvasMod) return null;

    try {
        const getDocument = await loadGetDocument();
        const data = new Uint8Array(pdfBuffer);
        const doc = await getDocument({ data, useSystemFonts: true }).promise;

        const totalPages = doc.numPages;
        const pageCount = Math.min(totalPages, maxPages);
        const truncated = totalPages > maxPages;
        const images = [];

        for (let i = 1; i <= pageCount; i++) {
            const page = await doc.getPage(i);
            const viewport = page.getViewport({ scale });

            // Create an off-screen canvas sized to the viewport.
            const canvas = canvasMod.createCanvas(
                Math.ceil(viewport.width),
                Math.ceil(viewport.height),
            );
            const ctx = canvas.getContext('2d');

            // pdfjs uses DOMMatrix on the transform; @napi-rs/canvas is DOM-compatible.
            await page.render({ canvasContext: ctx, viewport }).promise;

            // Encode to PNG base64.
            const pngBuffer = canvas.toBuffer('image/png');
            images.push({ base64: pngBuffer.toString('base64'), mimeType: 'image/png' });
        }

        console.log(`[PdfToImages] ${filename}: rendered ${images.length}/${totalPages} pages to PNG${truncated ? ' (truncated)' : ''}`);
        return { images, totalPages, truncated };
    } catch (err) {
        console.warn(`[PdfToImages] Failed to render ${filename}:`, err.message);
        return null;
    }
}

module.exports = { renderPdfPagesToImages };
