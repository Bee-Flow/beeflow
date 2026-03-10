/**
 * PDF Text Extractor
 * 
 * Uses pdfjs-dist to extract text from PDF buffers.
 * pdfjs-dist is the Mozilla PDF.js library — we use `require()`
 * to load it from Node.js CommonJS context.
 */

let _getDocument = null;

/**
 * Lazily load pdfjs-dist getDocument function.
 * We use dynamic import() because pdfjs-dist ships as ESM.
 */
async function loadGetDocument() {
    if (_getDocument) return _getDocument;

    // Dynamic import of the ESM module — wrapped in a timeout to prevent hanging
    const mod = await Promise.race([
        import('pdfjs-dist/legacy/build/pdf.mjs'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('pdfjs-dist import timed out after 10s')), 10000))
    ]);
    _getDocument = mod.getDocument;
    return _getDocument;
}

/**
 * Extract text from a PDF buffer.
 * @param {Buffer|Uint8Array} pdfBuffer - The PDF file as a buffer
 * @param {string} [filename] - Optional filename for logging
 * @returns {Promise<string>} - Extracted text, or empty string if extraction fails
 */
async function extractTextFromPDF(pdfBuffer, filename = 'unknown') {
    try {
        const getDocument = await loadGetDocument();
        const data = new Uint8Array(pdfBuffer);
        const doc = await getDocument({ data, useSystemFonts: true }).promise;

        const pages = [];
        for (let i = 1; i <= doc.numPages; i++) {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items
                .map(item => item.str)
                .join(' ');
            if (pageText.trim()) {
                pages.push(pageText);
            }
        }

        const fullText = pages.join('\n\n').trim();
        if (fullText) {
            console.log(`[PDFExtractor] Extracted ${fullText.length} chars from ${filename} (${doc.numPages} pages)`);
        } else {
            console.log(`[PDFExtractor] No text found in ${filename} (${doc.numPages} pages) — may be scanned/image-based`);
        }

        return fullText;
    } catch (err) {
        console.warn(`[PDFExtractor] Failed to extract text from ${filename}:`, err.message);
        return '';
    }
}

module.exports = { extractTextFromPDF };
