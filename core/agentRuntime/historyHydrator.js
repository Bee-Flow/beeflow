/**
 * History Hydrator — rebuild multimodal content from persisted attachments
 *
 * Why this exists:
 *   When a user uploads an image, the image_url content block is only injected
 *   into the live message at send-time (see attachmentProcessor.js). The turn
 *   is persisted with `content: "<plain text>"` and a sidecar
 *   `attachments: [{ storageKey, url, type, name }]` on the message's meta_json.
 *   On subsequent turns the image is therefore invisible to the LLM unless we
 *   rebuild the multimodal content array from the sidecar.
 *
 * Invariant:
 *   RustFS temp URLs live 900 s. This hydrator refreshes them on every turn,
 *   so a paused conversation can still show historical images. Do not weaken
 *   the refresh unless generateTempDownloadUrl's TTL is raised to conversation
 *   lifetime.
 *
 * Scope:
 *   Operates on every message EXCEPT the last. The last (current) user message
 *   is handled by processAttachments() at send-time with live upload data.
 */

function isTempStorageUrl(url) {
    return typeof url === 'string' && url.includes('/api/storage/tmp/');
}

function refreshTempUrl(url, storageKey) {
    try {
        const { generateTempDownloadUrl } = require('../../routes/storageProxy');
        if (storageKey) return generateTempDownloadUrl(storageKey, 900);
        if (isTempStorageUrl(url)) {
            const parsed = new URL(url);
            const key = parsed.searchParams.get('key');
            if (key) return generateTempDownloadUrl(key, 900);
        }
    } catch (e) {
        console.warn(`[HistoryHydrator] Failed to refresh temp URL: ${e.message}`);
    }
    return null;
}

/**
 * Rebuild a message whose content blocks may contain stale image_url parts
 * (base64 or expired temp URLs). Mirrors the previous inline refresh block.
 */
function refreshExistingContentArray(content) {
    return content.map(part => {
        if (part.type !== 'image_url') return part;
        const url = part.image_url?.url || '';

        // Strip base64 from history — blows up context and is already uploaded
        // (processAttachments prefers RustFS). Persisted attachment sidecars
        // hold the durable URL; this path is a defensive fallback.
        if (url.startsWith('data:')) {
            return { type: 'text', text: '[Previously attached image]' };
        }

        if (isTempStorageUrl(url)) {
            const fresh = refreshTempUrl(url, null);
            if (fresh) {
                return { type: 'image_url', image_url: { url: fresh, detail: 'auto' } };
            }
            return { type: 'text', text: '[Previously attached image]' };
        }

        // External URL (unknown origin) — leave alone
        return part;
    });
}

/**
 * Build image_url / text blocks for a list of persisted attachments.
 * Skips attachments without a recoverable URL.
 */
async function attachmentsToContentBlocks(attachments, userId) {
    const blocks = [];
    for (const att of attachments || []) {
        const type = att.type || '';
        const name = att.name || 'file';

        if (type.startsWith('image/')) {
            let url = null;
            if (att.storageKey) {
                url = refreshTempUrl(null, att.storageKey);
            } else if (isTempStorageUrl(att.url)) {
                url = refreshTempUrl(att.url, null);
            } else if (att.url) {
                url = att.url;
            } else if (att.content && userId) {
                // Last-resort lazy upload for base64 content that never made
                // it into RustFS (e.g. pre-RustFS conversations).
                try {
                    const { uploadImageForInference } = require('./attachmentProcessor');
                    url = await uploadImageForInference(att.content, type, userId, name);
                } catch (e) {
                    console.warn(`[HistoryHydrator] Lazy upload failed for ${name}: ${e.message}`);
                }
            }

            if (url) {
                blocks.push({ type: 'image_url', image_url: { url, detail: 'auto' } });
            } else {
                blocks.push({ type: 'text', text: `[Image previously attached: ${name}]` });
            }
        } else if (type.includes('pdf')) {
            // PDFs were OCR-expanded into the text content on their original
            // turn. Re-extracting here would double-count tokens.
            blocks.push({ type: 'text', text: `[PDF previously attached: ${name}]` });
        } else {
            blocks.push({ type: 'text', text: `[File previously attached: ${name}]` });
        }
    }
    return blocks;
}

/**
 * Hydrate persisted attachments into message content arrays and refresh any
 * stale image URLs in existing content blocks.
 *
 * Mutates and returns the input array so existing call sites keep their
 * reference.
 *
 * By default skips the last message — callers appending the current user turn
 * after loading history (agent runtime) rely on this to avoid clobbering the
 * live turn's content while processAttachments() handles it separately.
 * Callers that hydrate *before* appending the current turn (direct chat) can
 * pass `skipLast: false` to hydrate every message.
 *
 * @param {Array}   messages - Message array being built for the LLM
 * @param {object}  [opts]
 * @param {string}  [opts.userId]   - Needed for lazy base64→RustFS fallback
 * @param {boolean} [opts.skipLast=true] - Leave the final message alone
 * @returns {Promise<Array>} the same `messages` array (mutated)
 */
async function hydrateHistoryAttachments(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length < 1) return messages;

    const userId = opts.userId || null;
    const skipLast = opts.skipLast !== false;
    const end = skipLast ? messages.length - 1 : messages.length;
    if (end < 1) return messages;

    for (let i = 0; i < end; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== 'object') continue;

        const hasSidecarAttachments = Array.isArray(msg.attachments) && msg.attachments.length > 0;
        const contentIsArray = Array.isArray(msg.content);
        const hasImageBlocks = contentIsArray && msg.content.some(p => p?.type === 'image_url');

        if (!hasSidecarAttachments && !hasImageBlocks) continue;

        // Start with the existing content (refreshed if it already has image blocks)
        let content;
        if (contentIsArray) {
            content = hasImageBlocks ? refreshExistingContentArray(msg.content) : msg.content.slice();
        } else if (typeof msg.content === 'string' && msg.content.length > 0) {
            content = [{ type: 'text', text: msg.content }];
        } else {
            content = [];
        }

        // Rehydrate sidecar attachments into the content array, but only if
        // their image_url isn't already present (avoids double-inserting
        // when a legacy message happens to carry both).
        if (hasSidecarAttachments) {
            const existingUrls = new Set(
                content
                    .filter(p => p?.type === 'image_url')
                    .map(p => p.image_url?.url)
                    .filter(Boolean)
            );

            const blocks = await attachmentsToContentBlocks(msg.attachments, userId);
            for (const block of blocks) {
                if (block.type === 'image_url' && existingUrls.has(block.image_url?.url)) continue;
                content.push(block);
            }
        }

        messages[i] = { ...msg, content };
    }

    return messages;
}

module.exports = { hydrateHistoryAttachments };
