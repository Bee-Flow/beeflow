/**
 * Token-budget helpers — rough, provider-agnostic sizing for prompt building.
 *
 * We deliberately do NOT depend on tiktoken or any provider-specific tokeniser
 * here: the 4-chars-per-token rule of thumb is within ±15% for English / Dutch
 * across OpenAI/Anthropic/Gemini tokenisers and is good enough for a "fit this
 * into the prompt without blowing the context window" decision.
 *
 * Use `fitIntoTokenBudget` when preparing long content (a notebook document,
 * a concatenated source blob) to inject into a system prompt.
 */

const CHARS_PER_TOKEN = 4;

/**
 * Rough token estimate for a string.
 * @param {string} text
 * @returns {number} estimated tokens
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Rough char budget for a given token budget.
 */
function tokensToChars(tokens) {
    return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

/**
 * Trim `text` so it fits inside `maxTokens`. Preserves the head of the text
 * (most relevant for documents where the opening paragraphs carry the topic)
 * and appends a marker the caller can match on to append its own "truncated"
 * notice to the prompt.
 *
 * Returns `{ text, truncated, originalTokens, keptTokens }`.
 */
function fitIntoTokenBudget(text, maxTokens, { marker = '…[truncated]…' } = {}) {
    if (!text) return { text: '', truncated: false, originalTokens: 0, keptTokens: 0 };
    const originalTokens = estimateTokens(text);
    if (originalTokens <= maxTokens) {
        return { text, truncated: false, originalTokens, keptTokens: originalTokens };
    }
    // Reserve a little budget for the marker itself so the final string still fits.
    const markerTokens = estimateTokens(marker);
    const keepTokens = Math.max(0, maxTokens - markerTokens);
    const keptChars = tokensToChars(keepTokens);
    const slice = text.slice(0, keptChars);
    return {
        text: slice + marker,
        truncated: true,
        originalTokens,
        keptTokens: keepTokens,
    };
}

module.exports = {
    estimateTokens,
    tokensToChars,
    fitIntoTokenBudget,
    CHARS_PER_TOKEN,
};
