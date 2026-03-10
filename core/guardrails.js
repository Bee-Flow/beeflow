/**
 * Regex Guardrails — pattern-based input/output content filtering
 * 
 * Extracted from agentRuntime.js.
 * Validates content against named regex rules, returning matches.
 */

/**
 * Check content against an array of named regex patterns.
 * @param {string|object} content - Text to check (objects are JSON-stringified)
 * @param {Array<{name: string, pattern: string}>} rulesWithPatterns - Rules to match
 * @returns {Array<{ruleName: string, pattern: string}>} Matched rules
 */
function checkRegexPatterns(content, rulesWithPatterns) {
    if (!rulesWithPatterns || !Array.isArray(rulesWithPatterns) || rulesWithPatterns.length === 0) {
        return [];
    }

    const textToCheck = typeof content === 'string'
        ? content
        : JSON.stringify(content);

    const matches = [];
    for (const { name, pattern } of rulesWithPatterns) {
        if (!pattern || pattern.trim() === '') continue;

        try {
            // Remove (?i) and similar group constructs that JS doesn't support
            let safePattern = pattern
                .replace(/^\(\?i\)/, '')
                .replace(/^\(\?-[a-z]+\)/, '');

            const regex = new RegExp(safePattern, 'i');
            if (regex.test(textToCheck)) {
                console.warn(`[RegexGuard] Matched rule "${name}" with pattern: ${pattern}`);
                matches.push({ ruleName: name, pattern });
            }
        } catch (e) {
            console.error(`[RegexGuard] Invalid regex pattern: ${pattern}`, e.message);
        }
    }
    return matches;
}

module.exports = {
    checkRegexPatterns
};
