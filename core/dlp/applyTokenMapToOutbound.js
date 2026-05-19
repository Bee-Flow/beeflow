/**
 * Outbound-prompt safety guard.
 *
 * One invariant for every LLM call site: when a conversation has any
 * tokens in its `pii_token_map`, no string we hand to the model may contain
 * those tokens' real values. Whatever channel the content arrived through —
 * stored history, memory injection, compaction summary, edit/retry
 * `historyOverride`, notebook/webpage context, KB chunks, tool results — we
 * funnel it through this helper right before the provider stream and
 * substitute each known real value with its already-minted token.
 *
 * What this is NOT:
 *   - It does NOT run PII detection on the AI's reply (forbidden by spec).
 *   - It does NOT mint new tokens. It only uses what `tokenizeText` already
 *     produced on earlier turns.
 *   - It does NOT mutate the caller's messages array. Returns a new copy.
 *
 * Idempotent: re-running on already-tokenised content is a no-op. Safe to
 * call when conversationId is null or the conv map is empty (returns the
 * inputs unchanged in O(1)).
 */

const { getConversationTokenMap } = require('./dlpRunner');

function _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a value→token replacer from a `{ token: realValue }` map. Returns
 * `null` when the map has nothing usable so callers can short-circuit.
 *
 * Values are sorted longest-first so a long value ("Tomkooy@beeflow.com") is
 * replaced before any substring it contains ("Tom"). Skips empty/non-string
 * values defensively.
 */
function buildReverseReplacer(convMap) {
    const entries = Object.entries(convMap || {})
        .filter(([, v]) => typeof v === 'string' && v.length > 0)
        .sort((a, b) => b[1].length - a[1].length);
    if (entries.length === 0) return null;
    return (text) => {
        if (typeof text !== 'string' || !text) return text;
        let out = text;
        for (const [token, value] of entries) {
            if (out.indexOf(value) === -1) continue;
            out = out.replace(new RegExp(_escapeRegex(value), 'g'), token);
        }
        return out;
    };
}

function _applyToContent(content, replace) {
    if (typeof content === 'string') return replace(content);
    if (Array.isArray(content)) {
        return content.map(part => {
            if (!part || typeof part !== 'object') return part;
            if (part.type === 'text' && typeof part.text === 'string') {
                return { ...part, text: replace(part.text) };
            }
            return part;
        });
    }
    return content;
}

/**
 * Re-tokenise every string about to be handed to the LLM.
 *
 * @param {object} params
 * @param {string|null} params.conversationId   Used to look up the conv token map. null/empty → no-op.
 * @param {string|null} params.systemPrompt     Outbound system prompt (re-tokenised in place).
 * @param {Array}       params.messages         Outbound `messages` array. Each entry's `content`
 *                                              (string or content-block array) is re-tokenised.
 * @returns {{ systemPrompt: string|null, messages: Array }}
 */
function applyTokenMapToOutbound({ conversationId, systemPrompt, messages }) {
    const map = conversationId ? (getConversationTokenMap(conversationId) || {}) : {};
    const replace = buildReverseReplacer(map);
    if (!replace) return { systemPrompt, messages: messages || [] };
    return {
        systemPrompt: typeof systemPrompt === 'string' ? replace(systemPrompt) : systemPrompt,
        messages: (messages || []).map(m => ({ ...m, content: _applyToContent(m.content, replace) })),
    };
}

/**
 * Convenience for call sites that already have a single OpenAI-shape messages
 * array (system at index 0, then user/assistant/tool). Returns a new array;
 * does not mutate the input.
 */
function applyTokenMapToMessages({ conversationId, messages }) {
    const map = conversationId ? (getConversationTokenMap(conversationId) || {}) : {};
    const replace = buildReverseReplacer(map);
    if (!replace) return messages || [];
    return (messages || []).map(m => ({ ...m, content: _applyToContent(m.content, replace) }));
}

module.exports = { applyTokenMapToOutbound, applyTokenMapToMessages, buildReverseReplacer };
