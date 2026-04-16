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
    const tokenMap = tokenMapInput instanceof Map
        ? Object.fromEntries(tokenMapInput)
        : (tokenMapInput || {});
    const hasAny = Object.keys(tokenMap).length > 0;

    let buffer = '';

    function replaceAll(text) {
        if (!hasAny || !text) return text;
        let out = text;
        for (const [token, original] of Object.entries(tokenMap)) {
            if (out.indexOf(token) === -1) continue;
            out = out.split(token).join(original);
        }
        return out;
    }

    /**
     * Push a new chunk of streamed text. Returns the safe portion that can be
     * sent to the client now (with all complete tokens replaced). Retains a
     * small trailing buffer in case the next chunk completes an in-progress
     * token.
     */
    function push(chunk) {
        if (!hasAny) return chunk || '';
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
        if (!hasAny) {
            const tail = buffer;
            buffer = '';
            return tail;
        }
        const tail = replaceAll(buffer);
        buffer = '';
        return tail;
    }

    return { push, flush, hasAny };
}

module.exports = { createUntokeniser };
