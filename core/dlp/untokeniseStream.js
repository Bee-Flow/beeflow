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

// Normalise a token (or token-like span) to a comparison key: lowercase,
// letters+digits only. Collapses LLM drift (`[person_2]`, `[person2]`,
// `[Person 2]`, `[email]2`) onto one key. Mirrors `_normToken` in
// server/core/piiDetection.js — kept local to avoid a cross-module dependency.
function normTok(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

    // True when a known token equals `bracket`'s normalised stem followed by a
    // digit counter — i.e. the bracket looks like a drift token still missing its
    // outside-the-brackets counter (`[email]` awaiting `2`, given `[email_2]`).
    // Used by push() to hold such a bracket across the chunk boundary; returns
    // false for complete tokens (`[person_2]`) and ordinary brackets (`[note]`)
    // so normal streaming isn't delayed.
    function couldGainCounter(bracket) {
        const stem = normTok(bracket);
        if (!stem) return false;
        const map = currentMap();
        for (const k of Object.keys(map || {})) {
            const nk = normTok(k);
            if (nk.length > stem.length && nk.startsWith(stem) && /^\d+$/.test(nk.slice(stem.length))) {
                return true;
            }
        }
        return false;
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
        const keys = Object.keys(map || {});
        if (keys.length === 0) return text;

        // Single pass: exact token first (ordered alternation, longest-first),
        // then a drift-tolerant bracketed-span fallback — mirroring
        // restoreTokens() in server/core/piiDetection.js so the LIVE stream
        // restores the same mangled tokens (`[person2]`, `[email]2`) the
        // end-of-turn restore would. One pass means a token literal inside a
        // just-restored value is never re-scanned (no cascade).
        const exactSrc = keys
            .sort((a, b) => b.length - a.length)
            .map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|');
        const byNorm = new Map(); // norm → { token, value }
        for (const k of keys) {
            const nk = normTok(k);
            if (nk && !byNorm.has(nk)) byNorm.set(nk, { token: k, value: map[k] });
        }
        const record = (token, value) => {
            const existing = replacedTokens.get(token);
            replacedTokens.set(token, { count: (existing?.count || 0) + 1, value });
        };
        const re = new RegExp(`(?:${exactSrc})|(\\[[a-z0-9_ ]{1,60}\\])([ \\t]?\\d{1,4})?`, 'gi');
        return text.replace(re, (m, bracket, tail) => {
            if (Object.prototype.hasOwnProperty.call(map, m)) { record(m, map[m]); return map[m]; }
            if (bracket) {
                if (tail) {
                    const wt = byNorm.get(normTok(bracket + tail));
                    if (wt) { record(wt.token, wt.value); return wt.value; }
                    const bo = byNorm.get(normTok(bracket));
                    if (bo) { record(bo.token, bo.value); return bo.value + tail; }
                } else {
                    const v = byNorm.get(normTok(bracket));
                    if (v) { record(v.token, v.value); return v.value; }
                }
            }
            return m;
        });
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
            const close = after.indexOf(']');
            if (close === -1) {
                // Unclosed bracket — the token body may finish in the next chunk.
                splitAt = lastOpen;
            } else {
                const trailing = after.slice(close + 1);
                if (/^[ \t]?\d{1,4}$/.test(trailing)) {
                    // Closed bracket whose trailing counter could still be growing
                    // across the chunk boundary — drift form `[email]2` | `3`.
                    splitAt = lastOpen;
                } else if (trailing === '' && couldGainCounter(after.slice(0, close + 1))) {
                    // Closed bracket with no counter yet, but a known token has this
                    // stem + a digit counter — the counter may be in the next chunk
                    // (drift form `[email]` | `2`). Hold so it isn't split mid-restore.
                    splitAt = lastOpen;
                }
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

    // Stateless one-shot restore for streams that don't need cross-chunk token
    // buffering (e.g. the model's reasoning / "thinking" text, which is emitted
    // in self-contained chunks). Shares the replacedTokens accounting so the
    // privacy panel still reflects substitutions made in reasoning.
    function restore(text) {
        if (!text) return '';
        if (!hasAny()) return text;
        return replaceAll(text);
    }

    return { push, flush, hasAny, getReplacedTokens, restore };
}

module.exports = { createUntokeniser };
