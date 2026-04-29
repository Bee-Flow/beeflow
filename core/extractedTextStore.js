/**
 * Extracted-text tiering — keep small file extractions inline on the message
 * sidecar, offload large ones to RustFS so meta_json rows don't bloat.
 *
 * The sidecar always carries a usable representation of the file:
 *   - full text when below SIDECAR_INLINE_MAX_CHARS
 *   - head + tail snippet plus an `extractionKey` pointing at the full text in
 *     RustFS when above that threshold
 *
 * Read paths (historyHydrator, compaction) treat `extractedText` as the
 * canonical replay content. They don't re-fetch the full blob automatically
 * because that would add an S3 round-trip to every history load. Tools that
 * need verbatim full content can call loadExtractedText(extractionKey).
 */

const crypto = require('crypto');
const storageStore = require('../stores/storageStore');

// Files at or below this size are persisted in full on the sidecar. Larger
// files get a head+tail snippet inline plus the full text on RustFS.
const SIDECAR_INLINE_MAX_CHARS = 8_000;
// When tiering kicks in, this much head + 1k tail is kept on the sidecar.
const SIDECAR_HEAD_CHARS = 6_000;
const SIDECAR_TAIL_CHARS = 1_000;

/**
 * @param {string} text   Full extracted text (whatever the caller wants stored)
 * @param {string} userId Owning user (for storage key namespace)
 * @param {string} name   Display name for the truncation marker
 * @returns {Promise<{ extractedText: string, extractionKey?: string, fullChars: number }>}
 */
async function persistExtractedText(text, userId, name) {
    const safe = typeof text === 'string' ? text : '';
    if (safe.length <= SIDECAR_INLINE_MAX_CHARS) {
        return { extractedText: safe, fullChars: safe.length };
    }

    // Try RustFS upload of the full text. If RustFS is unavailable, fall back
    // to a head+tail-only sidecar — at least the model still sees both ends.
    let extractionKey = null;
    if (storageStore.isAvailable() && userId) {
        try {
            const filename = `extract_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.txt`;
            const key = storageStore.buildKey(userId, 'extractions', filename);
            await storageStore.uploadFile(key, Buffer.from(safe, 'utf8'), 'text/plain; charset=utf-8');
            extractionKey = key;
            console.log(`[ExtractedTextStore] Tiered extraction → RustFS (${safe.length} chars, ${name || 'unnamed'})`);
        } catch (err) {
            console.warn(`[ExtractedTextStore] Upload failed for ${name || 'unnamed'}: ${err.message}`);
        }
    }

    const head = safe.slice(0, SIDECAR_HEAD_CHARS);
    const tail = safe.slice(-SIDECAR_TAIL_CHARS);
    const ref = extractionKey ? ` storageKey=${extractionKey}` : '';
    const sidecarText = `${head}\n\n[…middle of ${name || 'file'} truncated; full text available on demand${ref}]\n\n${tail}`;

    const out = { extractedText: sidecarText, fullChars: safe.length };
    if (extractionKey) out.extractionKey = extractionKey;
    return out;
}

/**
 * Pull the full extracted text back from RustFS. Returns null on miss/failure.
 * Used by tools that explicitly need verbatim content (e.g. a "show me the
 * full document" UI action). History hydration does NOT call this — it relies
 * on the inline head+tail snippet for normal replay.
 */
async function loadExtractedText(extractionKey) {
    if (!extractionKey || !storageStore.isAvailable()) return null;
    try {
        const { stream } = await storageStore.streamFile(extractionKey);
        const chunks = [];
        for await (const chunk of stream) chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8');
    } catch (err) {
        console.warn(`[ExtractedTextStore] Load failed for ${extractionKey}: ${err.message}`);
        return null;
    }
}

module.exports = {
    persistExtractedText,
    loadExtractedText,
    SIDECAR_INLINE_MAX_CHARS,
};
