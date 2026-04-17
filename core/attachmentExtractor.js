/**
 * Unified attachment extractor — single pipeline used by both direct chat
 * (server/routes/ai/directChat.js) and agent chat (server/core/agentRuntime/
 * attachmentProcessor.js). Previously the two paths handled PDFs differently,
 * so Azure Document Intelligence only worked in direct chat.
 *
 * Return shape:
 *   { kind: 'text', text, source, meta }        — inlined into message content
 *   { kind: 'images', images, source, meta }    — vision-model fallback
 *   { kind: 'failed', reason, meta }            — placeholder message to LLM
 *
 * `source` identifies which extractor produced the text so observability
 * shows up in logs and in the header prepended to the LLM message.
 *
 * Pipeline for PDFs:
 *   1. pdfjs text extraction.
 *   2. Density check — if total chars < max(200, numPages * 100), treat as
 *      "needs OCR". A scanned PDF with a sprinkle of text from a broken
 *      source layer would otherwise escape the fallback.
 *   3. Azure Document Intelligence (when `use_azure_doc_processing` flag +
 *      endpoint + key are set).
 *   4. Mistral OCR (when `mistralOcrApiKey` is set).
 *   5. Render pages to PNG and return `kind: 'images'` (when the chat model
 *      supports vision). Capped at 20 pages.
 *   6. `kind: 'failed'` — the caller inlines a clear "could not extract"
 *      placeholder for the LLM.
 *
 * Pipeline for DOCX / XLSX / PPTX:
 *   1. Azure Document Intelligence (preferred — preserves tables/headings).
 *   2. documentParser fallback (mammoth for DOCX, xlsx lib for sheets).
 */

const configStore = require('../stores/configStore');
const { extractTextFromPDFWithStats } = require('./pdfExtractor');
const { renderPdfPagesToImages } = require('./pdfToImages');

// ─── MIME / extension detection ─────────────────────────────
function isPdf(att) {
    return (att.type && att.type.includes('pdf')) || /\.pdf$/i.test(att.name || '');
}
function isDocx(att) {
    return (att.type && att.type.includes('wordprocessingml')) || /\.docx$/i.test(att.name || '');
}
function isSpreadsheet(att) {
    return (att.type && (att.type.includes('spreadsheetml') || att.type.includes('ms-excel') || att.type === 'text/csv' || att.type === 'application/csv'))
        || /\.(xlsx|xls|csv)$/i.test(att.name || '');
}

function decodeBase64(content) {
    const b64 = content.includes(',') ? content.split(',')[1] : content;
    return Buffer.from(b64, 'base64');
}

// ─── Azure helpers ──────────────────────────────────────────
async function tryAzure(buffer, filename) {
    try {
        const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
        if (!useAzure) return null;
        const { extractWithAzure, isAzureDocIntelligenceConfigured } = require('./azureDocIntelligence');
        if (!(await isAzureDocIntelligenceConfigured())) return null;
        const text = await extractWithAzure(buffer, filename);
        return text || null;
    } catch (err) {
        // Wrap every path (config read, Azure client, timeout) so a failure
        // here falls through to the next extractor instead of crashing the
        // whole attachment flow.
        console.warn(`[AttachmentExtractor] Azure Document Intelligence step failed for ${filename}: ${err.message}`);
        return null;
    }
}

async function tryMistralOcr(base64, mimeType, filename) {
    try {
        const { mistralOCR } = require('./ocr');
        const text = await mistralOCR(base64, mimeType, filename);
        return text || null;
    } catch (err) {
        console.warn(`[AttachmentExtractor] Mistral OCR failed for ${filename}: ${err.message}`);
        return null;
    }
}

// ─── Density heuristic ──────────────────────────────────────
// A scanned PDF's pdfjs text layer is usually empty, but some OCR-processed
// or hybrid PDFs have a sprinkle of glyphs that isn't enough to understand
// the content. Treat any PDF with an avg of <100 chars/page as "needs OCR".
function isTextInsufficient(text, numPages) {
    const totalChars = (text || '').trim().length;
    if (totalChars === 0) return true;
    if (numPages <= 0) return totalChars < 200;
    const threshold = Math.max(200, numPages * 100);
    return totalChars < threshold;
}

// ─── PDF pipeline ───────────────────────────────────────────
async function extractPdf(buffer, att, opts) {
    const { text, numPages, pageCharCounts } = await extractTextFromPDFWithStats(buffer, att.name);
    const baseMeta = { numPages, pageCharCounts, totalChars: text.length };

    if (!isTextInsufficient(text, numPages)) {
        return { kind: 'text', text, source: 'pdfjs', meta: baseMeta };
    }

    // Step 2: Azure Document Intelligence
    const azureText = await tryAzure(buffer, att.name);
    if (azureText) {
        return { kind: 'text', text: azureText, source: 'azure', meta: { ...baseMeta, extractedChars: azureText.length } };
    }

    // Step 3: Mistral OCR
    const base64 = att.content.includes(',') ? att.content.split(',')[1] : att.content;
    const mistralText = await tryMistralOcr(base64, att.type || 'application/pdf', att.name);
    if (mistralText) {
        return { kind: 'text', text: mistralText, source: 'mistral', meta: { ...baseMeta, extractedChars: mistralText.length } };
    }

    // Step 4: vision fallback — render pages as images
    if (opts.modelSupportsVision) {
        const rendered = await renderPdfPagesToImages(buffer, { filename: att.name });
        if (rendered && rendered.images.length) {
            return {
                kind: 'images',
                images: rendered.images,
                source: 'vision-fallback',
                meta: { ...baseMeta, renderedPages: rendered.images.length, truncated: rendered.truncated },
            };
        }
    }

    return { kind: 'failed', reason: 'image-only PDF, no OCR provider configured', meta: baseMeta };
}

// ─── Office-doc pipeline ────────────────────────────────────
async function extractOfficeDoc(buffer, att) {
    // Prefer Azure for tables/headings quality.
    const azureText = await tryAzure(buffer, att.name);
    if (azureText) {
        return { kind: 'text', text: azureText, source: 'azure', meta: { extractedChars: azureText.length } };
    }

    try {
        const { parseDocument } = require('./documentParser');
        const text = await parseDocument(buffer, att.type || 'application/octet-stream', att.name);
        if (text && !text.startsWith('[Document:')) {
            return { kind: 'text', text, source: 'documentParser', meta: { extractedChars: text.length } };
        }
    } catch (err) {
        console.warn(`[AttachmentExtractor] documentParser failed for ${att.name}: ${err.message}`);
    }
    return { kind: 'failed', reason: 'Office document extraction failed', meta: {} };
}

// ─── Public API ─────────────────────────────────────────────
/**
 * @param {{ name: string, type: string, content: string }} att
 * @param {{ modelSupportsVision?: boolean }} [opts]
 * @returns {Promise<object>} one of the three result shapes above
 */
async function extractAttachment(att, opts = {}) {
    if (!att || !att.content) {
        return { kind: 'failed', reason: 'missing content', meta: {} };
    }
    const buffer = decodeBase64(att.content);

    if (isPdf(att)) return extractPdf(buffer, att, opts);
    if (isDocx(att) || isSpreadsheet(att)) return extractOfficeDoc(buffer, att);

    // Anything else — let the caller handle (images/text files already have
    // their own paths upstream).
    return { kind: 'failed', reason: 'unsupported type for this extractor', meta: { type: att.type } };
}

/**
 * Build a human-readable header for a successful text extraction so the LLM
 * knows what was done and logs are debuggable.
 */
function formatTextHeader(att, result) {
    const sourceLabel = {
        pdfjs: 'PDF text layer',
        azure: 'Azure Document Intelligence',
        mistral: 'Mistral OCR',
        documentParser: 'document parser',
    }[result.source] || result.source;
    const pages = result.meta?.numPages ? `, ${result.meta.numPages} pages` : '';
    const chars = result.meta?.extractedChars || result.meta?.totalChars;
    const charsStr = chars ? `, ${chars} chars` : '';
    return `[${att.name} — extracted via ${sourceLabel}${pages}${charsStr}]`;
}

function formatImagesHeader(att, result) {
    const truncNote = result.meta?.truncated ? ` (truncated; only first ${result.meta.renderedPages} of ${result.meta.numPages} pages)` : '';
    return `[${att.name} — ${result.meta?.renderedPages || 0} page${result.meta?.renderedPages === 1 ? '' : 's'} rendered as images for vision model${truncNote}]`;
}

function formatFailureNote(att, result) {
    return `[${att.name} — could not extract text: ${result.reason}. The document may be scanned or image-based and no OCR provider is configured for this environment.]`;
}

module.exports = {
    extractAttachment,
    formatTextHeader,
    formatImagesHeader,
    formatFailureNote,
    // exposed for tests
    isTextInsufficient,
    isPdf,
    isDocx,
    isSpreadsheet,
};
