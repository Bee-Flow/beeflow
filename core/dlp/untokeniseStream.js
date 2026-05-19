/**
 * Streaming un-tokeniser — restores DLP tokens (e.g. `[PII:email:1]` or
 * `[PII:customterm:1]`) with the original values on their way back to the
 * client. Handles the case where an LLM echoes a token back and the token
 * is split across two SSE chunks.
 *
 * Usage:
 *   const ut = createUntokeniser(tokenMapObject);
 *   onStreamChunk(textChunk) → client.send(ut.push(textChunk));
 *   onStreamEnd() → client.send(ut.flush());
 *
 * `tokenMapObject` is `Map<token,original>` or a plain `{ token: original }`.
 */

// A DLP token looks like `[PII:<cat>:<n>]`. The longest category we emit is
// short (Azure labels are <= 24 chars), so a 48-char safety buffer is ample.
const MAX_TOKEN_LEN = 48;

function createUntokeniser(tokenMapInput) {
    // Accept either a static map (legacy callers) or a getter function that
    // re-reads the current map. The getter form is used by chatStream so
    // tokens added AFTER the un-tokeniser is wrapped — e.g. tokens produced
    // when an attachment is scanned during processAttachments() — still
    // round-trip on the response stream.
    const isGetter = typeof tokenMapInput === 'function';
    const staticMap = !isGetter
        ? (tokenMapInput instanceof Map ? Object.fromEntries(tokenMapInput) : (tokenMapInput || {}))
        : null;

    function currentMap() {
        if (!isGetter) return staticMap;
        const v = tokenMapInput();
        if (!v) return {};
        if (v instanceof Map) return Object.fromEntries(v);
        return v;
    }

    let buffer = '';
    // Tracks tokens that were actually substituted in this stream. The chat
    // surface uses this so the "Privacy protection" panel still appears on
    // turns where no new redaction fired but the response echoed tokens from
    // earlier turns — e.g. the user asks a follow-up question and the AI
    // refers back to `[email_1]` which is restored to the real address before
    // the user sees it. Map<token, { count, value }>.
    const replacedTokens = new Map();

    function replaceAll(text) {
        if (!text) return text;
        const map = currentMap();
        if (!map || Object.keys(map).length === 0) return text;
        let out = text;
        for (const [token, original] of Object.entries(map)) {
            if (out.indexOf(token) === -1) continue;
            const parts = out.split(token);
            const count = parts.length - 1;
            if (count > 0) {
                const existing = replacedTokens.get(token);
                replacedTokens.set(token, {
                    count: (existing?.count || 0) + count,
                    value: original,
                });
            }
            out = parts.join(original);
        }
        return out;
    }

    /**
     * Push a new chunk of streamed text. Returns the safe portion that can be
     * sent to the client now (with all complete tokens replaced). Retains a
     * small trailing buffer in case the next chunk completes an in-progress
     * token.
     */
    function hasAny() {
        const map = currentMap();
        return !!(map && Object.keys(map).length > 0);
    }

    function push(chunk) {
        if (!hasAny()) return chunk || '';
        if (!chunk) return '';
        buffer += chunk;

        // Find the last position where a token could still be "in progress".
        // Conservative: if the tail contains a `[` within MAX_TOKEN_LEN chars
        // from the end and no closing `]`, hold it.
        let splitAt = buffer.length;
        const searchStart = Math.max(0, buffer.length - MAX_TOKEN_LEN);
        const lastOpen = buffer.lastIndexOf('[', buffer.length - 1);
        if (lastOpen >= searchStart) {
            const after = buffer.slice(lastOpen);
            if (!after.includes(']')) {
                splitAt = lastOpen;
            }
        }

        const safe = buffer.slice(0, splitAt);
        buffer = buffer.slice(splitAt);
        return replaceAll(safe);
    }

    /**
     * Drain any retained buffer; call when the stream closes.
     */
    function flush() {
        const tail = hasAny() ? replaceAll(buffer) : buffer;
        buffer = '';
        return tail;
    }

    /**
     * Returns the tokens that were actually substituted during the stream.
     * Shape: Map<token, { count, value }>. Empty when nothing was replaced.
     */
    function getReplacedTokens() {
        return replacedTokens;
    }

    return { push, flush, hasAny, getReplacedTokens };
}

module.exports = { createUntokeniser };
