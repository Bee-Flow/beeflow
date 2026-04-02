const { mistralOCR } = require('../ocr');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

/**
 * Try to upload an image to RustFS and return a short-lived public URL.
 * This is far more efficient than embedding base64 in the prompt:
 *  - The URL string is ~200 chars vs 500–1000 KB of base64 text
 *  - The AI fetches the image directly; token cost is based on pixels, not string length
 *
 * Falls back silently to null if RustFS is unavailable.
 *
 * @param {string} base64DataUrl  Full data URL (data:image/png;base64,...)
 * @param {string} mimeType       e.g. 'image/png'
 * @param {string} userId         User ID for key namespacing
 * @param {string} [filename]     Original filename (used in the key)
 * @returns {Promise<string|null>} A short-lived HTTPS URL or null
 */
async function uploadImageForInference(base64DataUrl, mimeType, userId, filename = 'image.png') {
    try {
        const storageStore = require('../../stores/storageStore');
        if (!storageStore.isAvailable()) return null;

        // Strip data URL prefix
        const base64 = base64DataUrl.includes(',')
            ? base64DataUrl.split(',')[1]
            : base64DataUrl;
        const buffer = Buffer.from(base64, 'base64');

        // Build a unique key under attachments/
        const ext = path.extname(filename) || `.${mimeType.split('/')[1] || 'png'}`;
        const key = `users/${userId}/attachments/${uuidv4()}${ext}`;

        await storageStore.uploadFile(key, buffer, mimeType);

        // Generate a 15-minute HMAC-signed temp URL (served by our own proxy)
        const { generateTempDownloadUrl } = require('../../routes/storageProxy');
        const url = generateTempDownloadUrl(key, 900);
        return url;
    } catch (err) {
        console.warn('[AttachmentProcessor] Could not upload image to RustFS:', err.message);
        return null;
    }
}

async function processAttachments(attachments = [], lastMsg, userId = null) {
    if (!attachments || attachments.length === 0) return;

    if (typeof lastMsg.content === 'string') {
        lastMsg.content = [{ type: 'text', text: lastMsg.content }];
    }

    for (const att of attachments) {
        if (att.type.includes('pdf')) {
            const base64Data = att.content.split(',')[1];
            const pdfBuffer = Buffer.from(base64Data, 'base64');
            let pdfText = '';

            try {
                const { extractTextFromPDF } = require('./pdfExtractor');
                pdfText = await extractTextFromPDF(pdfBuffer, att.name);
            } catch (parseErr) {
                console.warn(`[AttachmentProcessor] pdfjs extraction failed for ${att.name}:`, parseErr.message);
            }

            if (!pdfText) {
                try {
                    pdfText = await mistralOCR(base64Data, att.type, att.name);
                } catch (ocrErr) {
                    console.warn(`[AttachmentProcessor] OCR failed:`, ocrErr.message);
                }
            }

            if (pdfText) {
                const textBlock = lastMsg.content.find(c => c.type === 'text');
                const appendText = `\n\n[PDF Document: ${att.name}]\n---\n${pdfText}\n---\n`;
                if (textBlock) {
                    textBlock.text += appendText;
                } else {
                    lastMsg.content.push({ type: 'text', text: appendText });
                }
            } else {
                lastMsg.content.push({
                    type: 'file',
                    file: { filename: att.name, file_data: att.content }
                });
            }
        } else if (att.type.startsWith('image/')) {
            const sizeKB = Math.round((att.content?.length || 0) / 1024);
            console.log(`[AttachmentProcessor] Processing image ${att.name || 'unnamed'} (${sizeKB} KB base64)`);

            // Prefer RustFS URL over inline base64 — dramatically reduces context usage.
            // The URL is ~200 chars; the AI model fetches the image directly.
            let imageUrl = null;
            if (userId) {
                imageUrl = await uploadImageForInference(att.content, att.type, userId, att.name);
                if (imageUrl) {
                    console.log(`[AttachmentProcessor] Image uploaded to RustFS → using URL for inference (${att.name})`);
                }
            }

            lastMsg.content.push({
                type: 'image_url',
                image_url: {
                    url: imageUrl || att.content,  // URL preferred; base64 as fallback
                    detail: 'auto'                  // Let the model choose low/high based on task
                }
            });

            if (!imageUrl) {
                console.log(`[AttachmentProcessor] RustFS unavailable — using base64 for ${att.name || 'unnamed'}`);
            }
        } else {
            try {
                const { parseDocument } = require('./documentParser');
                const base64Data = att.content.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                const text = await parseDocument(buffer, att.type, att.name);

                const textBlock = lastMsg.content.find(c => c.type === 'text');
                const appendText = `\n\n[Attachment: ${att.name}]\n---\n${text}\n---\n`;
                if (textBlock) {
                    textBlock.text += appendText;
                } else {
                    lastMsg.content.push({ type: 'text', text: appendText });
                }
            } catch (e) {
                console.error(`[AttachmentProcessor] Failed to parse document ${att.name}`, e);
            }
        }
    }

    // Warn on oversized base64 payload (only relevant when RustFS is unavailable)
    if (Array.isArray(lastMsg.content)) {
        const totalBase64Size = lastMsg.content
            .filter(p => p.type === 'image_url')
            .reduce((sum, p) => {
                const url = p.image_url?.url || '';
                // Only count base64 data URLs, not short https:// URLs
                return sum + (url.startsWith('data:') ? url.length : 0);
            }, 0);
        if (totalBase64Size > 3_000_000) {
            console.warn(`[AttachmentProcessor] ⚠️ Large base64 image payload: ${Math.round(totalBase64Size / 1024)} KB — configure RustFS to avoid context overflow`);
        }
    }
}

module.exports = { processAttachments };
