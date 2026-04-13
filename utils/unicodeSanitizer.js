/**
 * Unicode Smuggling Sanitizer
 * 
 * Defends against "Emoji Smuggling" — a technique where malicious text is hidden
 * inside emoji using Unicode Variation Selectors and Tags block characters.
 * These invisible characters encode shift-cipher payloads that are invisible to
 * humans but readable by LLMs, bypassing human review and security filters.
 * 
 * Reference: https://www.firetail.ai/blog/peek-a-boo-emoji-smuggling-and-modern-llms
 * Encoder:   https://emoji.paulbutler.org/
 * 
 * PRESERVED (legitimate uses):
 *   U+FE0F  — VS16 Emoji presentation selector (❤️ vs ❤)
 *   U+200D  — Zero-Width Joiner (composite emoji: 👩‍💻 = 👩 + ZWJ + 💻)
 * 
 * STRIPPED (steganographic abuse):
 *   U+FE00–U+FE0E  — Variation Selectors 1–15 (shift cipher payload)
 *   U+E0100–U+E01EF — Variation Selectors Supplement (extended payload)
 *   U+E0001–U+E007F — Tags block (ASCII smuggling predecessor)
 *   U+200B          — Zero-Width Space
 *   U+200C          — Zero-Width Non-Joiner
 *   U+2060          — Word Joiner
 *   U+FEFF          — BOM / Zero-Width No-Break Space (except at position 0)
 */

// ── Regex matching all steganographic Unicode ranges ─────────────────────

// Variation Selectors 1-15 (U+FE00–U+FE0E) — NOT U+FE0F (emoji presentation)
// Tags block (U+E0001–U+E007F) — used for ASCII smuggling
// Variation Selectors Supplement (U+E0100–U+E01EF) — extended payload space
// Zero-width characters used for padding: ZWSP, ZWNJ, WJ, BOM
const SMUGGLING_REGEX = /[\uFE00-\uFE0E\u200B\u200C\u2060\uFEFF]|[\uDB40][\uDC01-\uDC7F]|[\uDB40][\uDD00-\uDDEF]/g;

// More precise supplementary plane regex using surrogate pairs:
//   Tags block U+E0001–U+E007F = surrogate pair \uDB40\uDC01 – \uDB40\uDC7F
//   VS Supplement U+E0100–U+E01EF = surrogate pair \uDB40\uDD00 – \uDB40\uDDEF

/**
 * Build a precise regex that covers all smuggling-relevant Unicode code points.
 * Uses a function-based approach for supplementary plane chars since JS regex
 * with surrogate pairs can be tricky.
 */
function containsSmugglingChars(text) {
    if (!text || typeof text !== 'string') return false;

    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);

        // Variation Selectors 1–15 (U+FE00–U+FE0E)
        if (code >= 0xFE00 && code <= 0xFE0E) return true;

        // Zero-Width Space (U+200B)
        if (code === 0x200B) return true;

        // Zero-Width Non-Joiner (U+200C)
        if (code === 0x200C) return true;

        // Word Joiner (U+2060)
        if (code === 0x2060) return true;

        // BOM / ZWNBSP (U+FEFF) — except at position 0 (legitimate BOM)
        if (code === 0xFEFF && i > 0) return true;

        // Check for supplementary plane via surrogate pairs
        if (code === 0xDB40 && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            // Tags block: U+E0001–U+E007F → low surrogate 0xDC01–0xDC7F
            if (low >= 0xDC01 && low <= 0xDC7F) return true;
            // VS Supplement: U+E0100–U+E01EF → low surrogate 0xDD00–0xDDEF
            if (low >= 0xDD00 && low <= 0xDDEF) return true;
        }
    }
    return false;
}

/**
 * Strip all steganographic Unicode characters from a string.
 * Preserves U+FE0F (emoji presentation) and U+200D (ZWJ for composite emoji).
 * 
 * @param {string} text - Input text to sanitize
 * @returns {{ clean: string, stripped: number, detected: boolean }}
 */
function sanitizeUnicode(text) {
    if (!text || typeof text !== 'string') {
        return { clean: text, stripped: 0, detected: false };
    }

    let stripped = 0;
    const chars = [];

    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        let skip = false;

        // Variation Selectors 1–15 (U+FE00–U+FE0E) — STRIP
        if (code >= 0xFE00 && code <= 0xFE0E) {
            skip = true;
        }
        // Zero-Width Space (U+200B) — STRIP
        else if (code === 0x200B) {
            skip = true;
        }
        // Zero-Width Non-Joiner (U+200C) — STRIP
        else if (code === 0x200C) {
            skip = true;
        }
        // Word Joiner (U+2060) — STRIP
        else if (code === 0x2060) {
            skip = true;
        }
        // BOM / ZWNBSP (U+FEFF) — STRIP except at pos 0
        else if (code === 0xFEFF && i > 0) {
            skip = true;
        }
        // Supplementary plane: high surrogate for Tags / VS Supplement
        else if (code === 0xDB40 && i + 1 < text.length) {
            const low = text.charCodeAt(i + 1);
            // Tags block: U+E0001–U+E007F
            if (low >= 0xDC01 && low <= 0xDC7F) {
                skip = true;
                i++; // skip the low surrogate too
            }
            // VS Supplement: U+E0100–U+E01EF
            else if (low >= 0xDD00 && low <= 0xDDEF) {
                skip = true;
                i++; // skip the low surrogate too
            }
        }

        if (skip) {
            stripped++;
        } else {
            chars.push(text[i]);
        }
    }

    return {
        clean: chars.join(''),
        stripped,
        detected: stripped > 0,
    };
}

/**
 * Sanitize all user messages in a chat messages array.
 * Only processes messages with role='user'. Modifies in-place.
 * 
 * @param {Array} messages - Chat messages array
 * @returns {{ smugglingDetected: boolean, totalStripped: number, detectedIn: number[] }}
 */
function sanitizeMessagesUnicode(messages) {
    if (!Array.isArray(messages)) {
        return { smugglingDetected: false, totalStripped: 0, detectedIn: [] };
    }

    let totalStripped = 0;
    const detectedIn = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== 'user') continue;

        if (typeof msg.content === 'string') {
            const result = sanitizeUnicode(msg.content);
            if (result.detected) {
                msg.content = result.clean;
                totalStripped += result.stripped;
                detectedIn.push(i);
            }
        } else if (Array.isArray(msg.content)) {
            // Multimodal messages (text + image parts)
            for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                    const result = sanitizeUnicode(part.text);
                    if (result.detected) {
                        part.text = result.clean;
                        totalStripped += result.stripped;
                        if (!detectedIn.includes(i)) detectedIn.push(i);
                    }
                }
            }
        }
    }

    if (detectedIn.length > 0) {
        console.warn(`[UnicodeGuard] 🚨 Emoji smuggling detected: ${totalStripped} hidden chars stripped from ${detectedIn.length} message(s)`);
    }

    return {
        smugglingDetected: detectedIn.length > 0,
        totalStripped,
        detectedIn,
    };
}

module.exports = {
    sanitizeUnicode,
    sanitizeMessagesUnicode,
    containsSmugglingChars,
};
