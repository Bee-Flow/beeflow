// mistralOCR is still invoked, but via the unified attachmentExtractor helper
// (see ../attachmentExtractor.js) so PDF handling stays consistent with direct chat.
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { persistExtractedText } = require('../extractedTextStore');

// Writes the extracted text onto the matching persisted attachment sidecar
// so that historyHydrator can replay the file on future turns. Without this,
// XLSX/DOCX/CSV uploads only existed in the current turn's context and the
// model would lose access to them after ~4 messages once compaction kicked in.
async function persistExtractionOntoSidecar(att, fullText, persistedByLive, userId) {
    if (!fullText || !persistedByLive) return;
    const record = persistedByLive.get(att);
    if (!record || record.extractedText) return; // idempotent: skip if already persisted
    try {
        const tiered = await persistExtractedText(fullText, userId, att.name);
        record.extractedText = tiered.extractedText;
        if (tiered.extractionKey) record.extractionKey = tiered.extractionKey;
    } catch (err) {
        console.warn(`[AttachmentProcessor] Failed to persist extracted text for ${att.name}: ${err.message}`);
    }
}

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
        console.log(`[AttachmentProcessor] Generated inference URL: ${url}`);
        console.log(`[AttachmentProcessor] SERVER_PUBLIC_HOST=${process.env.SERVER_PUBLIC_HOST || '(unset)'}, SERVER_PROTOCOL=${process.env.SERVER_PROTOCOL || '(unset)'}`);
        return url;
    } catch (err) {
        console.warn('[AttachmentProcessor] Could not upload image to RustFS:', err.message);
        return null;
    }
}

// Decide whether a model ID supports vision for the PDF-vision-fallback
// decision. Mirrors the supportsVision regexes in the individual provider
// adapters (see server/core/providers/*.js). Using a regex here keeps us
// independent of which adapter the agent ultimately selects.
function modelSupportsVisionById(modelId) {
    if (!modelId) return false;
    return /gpt-4o|gpt-4\.1|gpt-5|o4|claude-3|claude-opus-4|claude-sonnet-4|claude-haiku-4|claude-mythos|gemini|pixtral/i.test(modelId);
}

async function processAttachments(attachments = [], lastMsg, userId = null, opts = {}) {
    if (!attachments || attachments.length === 0) return { attachmentScanSummaries: [] };

    if (typeof lastMsg.content === 'string') {
        lastMsg.content = [{ type: 'text', text: lastMsg.content }];
    }

    const modelSupportsVision = modelSupportsVisionById(opts.modelId);
    const persistedByLive = opts.persistedByLive || null;
    const orgShield = opts.orgShield || null;
    const conversationId = opts.conversationId || null;
    // Per-file scan summaries (one row per attachment that produced findings).
    // Returned to the caller so the chat UI badge can show per-file detail
    // and the audit logger can emit per-page rows.
    const attachmentScanSummaries = [];

    const { scanAttachmentText, AttachmentPrivacyBlock } = require('../dlp/attachmentScanner');

    async function maybeScan({ text, pages, filename }) {
        if (!orgShield) return { action: 'pass', text };
        const r = await scanAttachmentText({ text, pages, filename, orgShield, conversationId });
        if (r.action === 'block') {
            throw new AttachmentPrivacyBlock({ filename, summary: r.summary, findings: r.findings });
        }
        if (r.action === 'tokenize') {
            attachmentScanSummaries.push({
                filename,
                action: 'tokenize',
                count: r.findings.length,
                byCategory: r.summary.byCategory,
                pages: r.summary.pages,
                overflow: r.summary.overflow,
            });
        } else if (r.summary && r.summary.timeout) {
            // Scan deadline tripped under Tokenize-mode policy — content
            // passed through unredacted. Surface a warning row in the UI badge.
            attachmentScanSummaries.push({
                filename,
                action: 'pass',
                count: 0,
                byCategory: {},
                pages: {},
                overflow: !!r.summary.overflow,
                timeout: true,
            });
        }
        return r;
    }

    for (const att of attachments) {
        if (att.type.includes('pdf')) {
            // Unified extractor — same pipeline as direct chat:
            //   pdfjs → Azure Document Intelligence → Mistral OCR → vision fallback.
            // Behaviour change from the old agent path: Azure now fires here too.
            const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote } = require('../attachmentExtractor');
            const result = await extractAttachment(att, { modelSupportsVision });
            console.log(`[AttachmentProcessor] PDF ${att.name} extraction → kind=${result.kind}, source=${result.source || 'n/a'}`);

            const textBlock = lastMsg.content.find(c => c.type === 'text');
            if (result.kind === 'text') {
                // Privacy Shield: scan extracted PDF text before it touches the
                // model. On `block`, the thrown AttachmentPrivacyBlock bubbles
                // up to chatStream which emits a `dlp_blocked` SSE event and
                // aborts the turn — matching the message-block UX.
                const scanned = await maybeScan({ text: result.text, pages: result.pages, filename: att.name });
                const safeText = scanned.action === 'tokenize' ? scanned.text : result.text;
                const appendText = `\n\n${formatTextHeader(att, result)}\n---\n${safeText}\n---\n`;
                if (textBlock) textBlock.text += appendText;
                else lastMsg.content.push({ type: 'text', text: appendText });
                await persistExtractionOntoSidecar(att, safeText, persistedByLive, userId);
            } else if (result.kind === 'images') {
                // Vision fallback: a header note followed by the page images.
                const note = `\n\n${formatImagesHeader(att, result)}\n`;
                if (textBlock) textBlock.text += note;
                else lastMsg.content.push({ type: 'text', text: note });
                for (const img of result.images) {
                    lastMsg.content.push({
                        type: 'image_url',
                        image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'auto' },
                    });
                }
            } else {
                const fallbackText = `\n\n${formatFailureNote(att, result)}\n`;
                if (textBlock) textBlock.text += fallbackText;
                else lastMsg.content.push({ type: 'text', text: fallbackText });
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
                // att.content is a data URL like "data:<mime>;base64,XXX". If
                // upstream sent only the raw base64 (no comma) treat the whole
                // value as the payload rather than crashing on undefined.
                const base64Data = att.content && att.content.includes(',')
                    ? att.content.split(',')[1]
                    : att.content;
                if (!base64Data) {
                    console.warn(`[AttachmentProcessor] Skipping ${att.name}: no content payload`);
                    continue;
                }
                const buffer = Buffer.from(base64Data, 'base64');
                const text = await parseDocument(buffer, att.type, att.name);

                const scanned = await maybeScan({ text, pages: undefined, filename: att.name });
                const safeText = scanned.action === 'tokenize' ? scanned.text : text;
                const textBlock = lastMsg.content.find(c => c.type === 'text');
                const appendText = `\n\n[Attachment: ${att.name}]\n---\n${safeText}\n---\n`;
                if (textBlock) {
                    textBlock.text += appendText;
                } else {
                    lastMsg.content.push({ type: 'text', text: appendText });
                }
                await persistExtractionOntoSidecar(att, safeText, persistedByLive, userId);
            } catch (e) {
                if (e && e.code === 'ATTACHMENT_PII_BLOCKED') throw e;
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

    return { attachmentScanSummaries };
}

module.exports = { processAttachments };
