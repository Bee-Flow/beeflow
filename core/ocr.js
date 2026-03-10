/**
 * OCR Module — Mistral OCR API integration for PDF/image text extraction
 * 
 * Extracted from duplicate implementations in agentRuntime.js and routes/knowledge.js.
 * Provides a single, reusable function for OCR processing.
 */

const { getAIConfig } = require('./aiAgent');

const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';
const MISTRAL_OCR_MODEL = 'mistral-ocr-latest';

/**
 * Extract text from PDFs/Images using Mistral's OCR API.
 * Returns markdown-formatted text content from the document.
 * 
 * @param {string} base64Data - Base64-encoded file content
 * @param {string} mimeType - File MIME type (e.g. 'application/pdf', 'image/png')
 * @param {string} filename - Original filename (for logging)
 * @returns {Promise<string|null>} Markdown content or null on failure
 */
async function mistralOCR(base64Data, mimeType, filename) {
    try {
        const config = await getAIConfig();
        const mistralApiKey = config.mistralOcrApiKey || config.apiKey || process.env.MISTRAL_API_KEY;
        if (!mistralApiKey) {
            console.log('[MistralOCR] No Mistral OCR API key configured, skipping OCR');
            return null;
        }

        const isPdf = mimeType.includes('pdf');
        const isImage = mimeType.startsWith('image/');

        if (!isPdf && !isImage) {
            console.log(`[MistralOCR] Unsupported type: ${mimeType}`);
            return null;
        }

        console.log(`[MistralOCR] Processing ${isPdf ? 'PDF' : 'image'}: ${filename}`);

        const dataUrl = isPdf
            ? `data:application/pdf;base64,${base64Data}`
            : `data:${mimeType};base64,${base64Data}`;

        const response = await fetch(MISTRAL_OCR_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${mistralApiKey}`
            },
            body: JSON.stringify({
                model: MISTRAL_OCR_MODEL,
                document: {
                    type: 'document_url',
                    document_url: dataUrl
                },
                include_image_base64: false
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[MistralOCR] API Error ${response.status}:`, errorText);
            return null;
        }

        const ocrResult = await response.json();

        if (ocrResult.pages && ocrResult.pages.length > 0) {
            const markdownContent = ocrResult.pages
                .map((page) => `[Page ${page.index + 1}]\n${page.markdown}`)
                .join('\n\n---\n\n');

            console.log(`[MistralOCR] Successfully extracted ${ocrResult.pages.length} pages from ${filename}`);
            return markdownContent;
        }

        console.log('[MistralOCR] No pages found in OCR result');
        return null;

    } catch (error) {
        console.error('[MistralOCR] Error:', error.message);
        return null;
    }
}

/**
 * Get the Mistral OCR API key from config.
 * Useful for checking if OCR is available without running a full extraction.
 * @returns {string|null}
 */
async function getMistralOCRApiKey() {
    const config = await getAIConfig();
    return config.mistralOcrApiKey || config.apiKey || process.env.MISTRAL_API_KEY || null;
}

module.exports = {
    mistralOCR,
    getMistralOCRApiKey
};
