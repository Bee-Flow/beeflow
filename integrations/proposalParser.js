/**
 * Robust parser for AI-generated proposal JSON that may contain embedded JavaScript scripts.
 * 
 * The AI often produces JSON where the "script" field has unescaped newlines, quotes, etc.
 * This parser extracts proposals one-by-one and handles script fields specially.
 */

/**
 * Parse AI response text that should contain a JSON array of proposals.
 * Falls back to individual object extraction if full-array parse fails.
 */
function parseProposals(text) {
    // Strip markdown code fences
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    // Try 1: standard JSON parse
    try {
        const m = cleaned.match(/\[[\s\S]*\]/);
        if (m) {
            const arr = JSON.parse(m[0]);
            if (Array.isArray(arr)) return arr;
        }
    } catch (e) { /* fall through */ }

    // Try 2: extract the script fields first, replace with placeholders, then parse
    try {
        const result = extractWithScriptPlaceholders(cleaned);
        if (result.length > 0) return result;
    } catch (e) { /* fall through */ }

    // Try 3: extract individual objects with brace matching
    return extractIndividualProposals(cleaned);
}

/**
 * Strategy: find "script" fields, extract their value (which may span multiple
 * lines with unescaped chars), replace with a clean placeholder, parse, then restore.
 */
function extractWithScriptPlaceholders(text) {
    // Find the outermost array
    const arrMatch = text.match(/\[[\s\S]*\]/);
    if (!arrMatch) return [];

    let json = arrMatch[0];
    const scripts = [];

    // Regex to find "script": "..." patterns — we need to handle multi-line strings
    // that the AI might not escape properly. We look for "script" : " and then find
    // the matching close by tracking escaped quotes vs the actual end.
    const scriptFieldRegex = /"script"\s*:\s*"/g;
    let match;
    const replacements = [];

    while ((match = scriptFieldRegex.exec(json)) !== null) {
        const valueStart = match.index + match[0].length;
        // Find the end of the script value — look for the closing quote
        // that is followed by a comma, newline, or closing brace
        const endIdx = findStringEnd(json, valueStart);
        if (endIdx === -1) continue;

        const scriptContent = json.substring(valueStart, endIdx);
        const placeholder = `__SCRIPT_PLACEHOLDER_${scripts.length}__`;
        scripts.push(scriptContent);
        replacements.push({
            from: match.index,
            to: endIdx + 1, // include closing quote
            placeholder: `"script": "${placeholder}"`,
        });
    }

    // Apply replacements in reverse order to preserve indices
    for (let i = replacements.length - 1; i >= 0; i--) {
        const r = replacements[i];
        json = json.substring(0, r.from) + r.placeholder + json.substring(r.to);
    }

    // Now try to parse the cleaned JSON
    try {
        const proposals = JSON.parse(json);
        if (!Array.isArray(proposals)) return [];

        // Restore scripts
        for (const p of proposals) {
            if (p.script && p.script.startsWith('__SCRIPT_PLACEHOLDER_')) {
                const idx = parseInt(p.script.replace('__SCRIPT_PLACEHOLDER_', '').replace('__', ''));
                if (!isNaN(idx) && idx < scripts.length) {
                    p.script = scripts[idx];
                }
            }
        }
        return proposals;
    } catch (e) {
        return [];
    }
}

/**
 * Find the end of a JSON string value starting after the opening quote.
 * Handles escaped characters properly.
 */
function findStringEnd(text, start) {
    let i = start;
    while (i < text.length) {
        if (text[i] === '\\') {
            i += 2; // skip escaped char
            continue;
        }
        if (text[i] === '"') {
            return i;
        }
        // If we hit a raw newline, the AI didn't escape it — skip it
        if (text[i] === '\n' || text[i] === '\r') {
            i++;
            continue;
        }
        i++;
    }
    return -1;
}

/**
 * Extract individual proposal objects by matching braces.
 * This is the most forgiving fallback — pulls each {...} object and tries to clean it.
 */
function extractIndividualProposals(text) {
    const proposals = [];
    let depth = 0, start = -1;

    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (text[i] === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                const objStr = text.substring(start, i + 1);
                try {
                    const obj = JSON.parse(objStr);
                    if (obj.title) proposals.push(obj);
                } catch (e) {
                    // Try to extract script and clean it
                    const cleaned = cleanProposalJson(objStr);
                    if (cleaned) {
                        try {
                            const obj = JSON.parse(cleaned);
                            if (obj.title) proposals.push(obj);
                        } catch (e2) { /* skip */ }
                    }
                }
                start = -1;
            }
        }
    }
    return proposals;
}

/**
 * Clean a single proposal JSON object by extracting and re-encoding the script field.
 */
function cleanProposalJson(objStr) {
    // Find the script field
    const scriptMatch = objStr.match(/"script"\s*:\s*"/);
    if (!scriptMatch) return null;

    const beforeScript = objStr.substring(0, scriptMatch.index);
    const scriptStart = scriptMatch.index + scriptMatch[0].length;

    // Find the end — look for patterns like ", "priority" or ", "reasoning" or "}\n"
    // This is heuristic — look for a quote followed by comma/newline and then a known field
    const knownFields = ['priority', 'reasoning', 'requires_ai', 'trigger', 'conditions', 'actions', 'title', 'description'];
    let bestEnd = -1;

    for (const field of knownFields) {
        const pattern = new RegExp(`"\\s*,\\s*\\n?\\s*"${field}"\\s*:`);
        const fieldMatch = objStr.substring(scriptStart).match(pattern);
        if (fieldMatch) {
            const endPos = scriptStart + fieldMatch.index;
            if (bestEnd === -1 || endPos > bestEnd) {
                bestEnd = endPos;
            }
        }
    }

    // Also check for end of object
    if (bestEnd === -1) {
        // Look for the script being the last field: "..script.." }
        const lastFieldMatch = objStr.substring(scriptStart).match(/"\s*\n?\s*\}/);
        if (lastFieldMatch) {
            bestEnd = scriptStart + lastFieldMatch.index;
        }
    }

    if (bestEnd === -1) return null;

    const rawScript = objStr.substring(scriptStart, bestEnd);
    // Re-encode the script as proper JSON string
    const encodedScript = JSON.stringify(rawScript).slice(1, -1); // Remove outer quotes from stringify
    const afterScript = objStr.substring(bestEnd);

    return beforeScript + `"script": "${encodedScript}${afterScript}`;
}

module.exports = { parseProposals };
