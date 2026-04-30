/**
 * Webpage Document Tools
 *
 * Exposes three parameterized AI tools — webpage_file_read, webpage_file_write,
 * webpage_file_replace — operating on the three slots (html / css / js) of a
 * webpage. The matcher is plain-text (no HTML-tag walking) since webpage code
 * is canonical, unlike TipTap-encoded notebook prose.
 *
 * Plus webpage_add_source, mirroring notebook_add_source minus the tax-specific
 * metadata (which only existed for the bookkeeping notebook flow).
 */

const VALID_SLOTS = ['html', 'css', 'js'];

const WEBPAGE_DOC_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'webpage_file_read',
            description: 'Read the current content of one of the three webpage files (index.html, style.css, or script.js). The webpage is rendered live in a sandboxed iframe visible to the user. ALWAYS use this BEFORE webpage_file_replace on the same file so you operate on the latest content.',
            parameters: {
                type: 'object',
                properties: {
                    file: {
                        type: 'string',
                        enum: VALID_SLOTS,
                        description: 'Which file to read: "html" (index.html — page structure), "css" (style.css — styles), or "js" (script.js — interactive behavior).',
                    },
                },
                required: ['file'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_write',
            description: 'Replace the ENTIRE content of one webpage file. Use this for new files or full rewrites. For partial edits, prefer webpage_file_replace.\n\nRules of the slot:\n- "html": valid HTML5 document or fragment. The preview iframe will inline the CSS and JS, but the downloaded zip will use <link rel="stylesheet" href="style.css"> and <script src="script.js"></script>, so you can write either way.\n- "css": plain CSS. No SCSS/LESS — there is no build step.\n- "js": vanilla JavaScript. No bundler, no imports of npm modules. CDN <script> tags belong in the HTML, not here.\n\nThe iframe runs with sandbox="allow-scripts" (no same-origin) — code that depends on parent cookies, localStorage, or fetches to the host app will fail.',
            parameters: {
                type: 'object',
                properties: {
                    file: {
                        type: 'string',
                        enum: VALID_SLOTS,
                        description: 'Which file to overwrite.',
                    },
                    content: {
                        type: 'string',
                        description: 'The full new content of the file. Replaces all existing content.',
                    },
                    title: {
                        type: 'string',
                        description: 'Optional short label of what was written, shown to the user (e.g. "Initial layout", "Dark theme").',
                    },
                },
                required: ['file', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_replace',
            description: 'Replace a SPECIFIC portion of one webpage file. Preserves all other content. Plain-text matching — find_text must appear verbatim (or with normalized whitespace) in the file.\n\nIMPORTANT: Always call webpage_file_read on the same file first to see the EXACT current content before replacing.',
            parameters: {
                type: 'object',
                properties: {
                    file: {
                        type: 'string',
                        enum: VALID_SLOTS,
                        description: 'Which file to edit.',
                    },
                    find_text: {
                        type: 'string',
                        description: 'The exact text to find. Must be present verbatim in the file (whitespace-normalized matching is applied as a fallback).',
                    },
                    replace_text: {
                        type: 'string',
                        description: 'The new text to insert in place of find_text. Set to empty string to delete.',
                    },
                },
                required: ['file', 'find_text', 'replace_text'],
            },
        },
    },
];

const WEBPAGE_ADD_SOURCE_TOOL = {
    type: 'function',
    function: {
        name: 'webpage_add_source',
        description: 'Add content as a new source to the webpage. Use this to attach web search results, design references, brand guidelines, or any text content as a source the webpage can be grounded in. The content will be indexed and available for citation in future queries.',
        parameters: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'A short descriptive name for the source (e.g. "Brand style guide", "Bakery menu draft").',
                },
                content: {
                    type: 'string',
                    description: 'The full text content to add as a source.',
                },
                metadata: {
                    type: 'object',
                    description: 'Optional structured metadata for the source.',
                },
            },
            required: ['name', 'content'],
        },
    },
};

/**
 * Execute a webpage document tool call.
 * `files` is an in-memory `{ html, css, js }` object that the chat handler
 * keeps in sync with the frontend (the frontend is the source of truth for
 * the editor while a chat turn is in flight).
 */
function executeWebpageDocTool(toolName, args, files) {
    if (toolName === 'webpage_file_read') {
        const file = args.file;
        if (!VALID_SLOTS.includes(file)) {
            return { error: `Invalid file "${file}" — must be one of: ${VALID_SLOTS.join(', ')}.` };
        }
        const content = files?.[file] || '';
        if (!content.trim()) {
            return { content: '', message: `${slotFilename(file)} is currently empty.` };
        }
        return { content };
    }

    if (toolName === 'webpage_file_write') {
        const file = args.file;
        if (!VALID_SLOTS.includes(file)) {
            return { error: `Invalid file "${file}" — must be one of: ${VALID_SLOTS.join(', ')}.` };
        }
        const content = args.content || '';
        const title = args.title || slotFilename(file);
        return {
            _action: 'webpage_doc_update',
            file,
            content,
            title,
            message: `${slotFilename(file)} updated: "${title}"`,
        };
    }

    if (toolName === 'webpage_file_replace') {
        const file = args.file;
        const findText = args.find_text;
        const replaceText = args.replace_text ?? '';

        if (!VALID_SLOTS.includes(file)) {
            return { error: `Invalid file "${file}" — must be one of: ${VALID_SLOTS.join(', ')}.` };
        }
        if (!findText) {
            return { error: 'find_text is required for webpage_file_replace.' };
        }

        const current = files?.[file] || '';
        if (!current) {
            return { error: `${slotFilename(file)} is empty. Use webpage_file_write to create content first.` };
        }

        // Try exact substring match first.
        if (current.includes(findText)) {
            const newContent = current.replace(findText, replaceText);
            return {
                _action: 'webpage_doc_update',
                file,
                content: newContent,
                message: replaceText
                    ? `${slotFilename(file)} updated.`
                    : `${slotFilename(file)} text removed.`,
            };
        }

        // Fall back to whitespace-normalized comparison.
        const normalize = (s) => s.replace(/\s+/g, ' ').trim();
        const findNorm = normalize(findText);
        const idxNorm = normalize(current).indexOf(findNorm);
        if (idxNorm >= 0) {
            // Map normalized offset back to a real range in the original string.
            const range = locateOriginalRange(current, findText);
            if (range) {
                const newContent = current.slice(0, range.start) + replaceText + current.slice(range.end);
                return {
                    _action: 'webpage_doc_update',
                    file,
                    content: newContent,
                    message: replaceText
                        ? `${slotFilename(file)} updated (whitespace-normalized match).`
                        : `${slotFilename(file)} text removed.`,
                };
            }
        }

        // Help the AI self-correct: suggest the closest matching snippet.
        const words = findNorm.split(' ').filter(Boolean);
        let suggestion = '';
        if (words.length >= 2) {
            const needle = words.slice(0, Math.min(4, words.length)).join(' ').toLowerCase();
            const lc = current.toLowerCase();
            const idx = lc.indexOf(needle);
            if (idx >= 0) {
                suggestion = current.slice(idx, idx + Math.min(160, findText.length + 60));
            }
        }
        const hint = suggestion
            ? ` The file contains something similar starting with: "${suggestion.slice(0, 160)}…" — use that exact text as find_text.`
            : ` Call webpage_file_read({ file: "${file}" }) first to see the exact current content, then retry.`;
        return {
            error: `Could not find "${findText.substring(0, 100)}${findText.length > 100 ? '…' : ''}" in ${slotFilename(file)}.${hint}`,
        };
    }

    return { error: `Unknown webpage document tool: ${toolName}` };
}

function slotFilename(slot) {
    return slot === 'html' ? 'index.html' : slot === 'css' ? 'style.css' : 'script.js';
}

/**
 * Locate the byte-range in `original` whose normalized form matches the
 * normalized form of `needle`. Returns { start, end } or null.
 *
 * Used as a fallback when find_text exists in the file modulo whitespace
 * differences (e.g. the AI passed copy-pasted text with collapsed
 * whitespace, but the file has the same characters separated by newlines).
 */
function locateOriginalRange(original, needle) {
    const normNeedle = needle.replace(/\s+/g, ' ').trim();
    if (!normNeedle) return null;

    // Walk `original`, accumulating non-whitespace chars and tracking a
    // sliding window in normalized space.
    let normalized = '';
    const idxMap = []; // normalized-position → original-position
    let lastWasSpace = false;
    for (let i = 0; i < original.length; i++) {
        const c = original[i];
        if (/\s/.test(c)) {
            if (!lastWasSpace && normalized.length > 0) {
                normalized += ' ';
                idxMap.push(i);
                lastWasSpace = true;
            }
        } else {
            normalized += c;
            idxMap.push(i);
            lastWasSpace = false;
        }
    }
    const trimmedStart = normalized.match(/^\s*/)[0].length;
    normalized = normalized.trim();

    const hit = normalized.indexOf(normNeedle);
    if (hit < 0) return null;

    const startNorm = hit + trimmedStart;
    const endNorm = startNorm + normNeedle.length;
    if (endNorm > idxMap.length) return null;
    const startOrig = idxMap[startNorm];
    const endOrig = endNorm < idxMap.length ? idxMap[endNorm] : original.length;
    return { start: startOrig, end: endOrig };
}

module.exports = {
    WEBPAGE_DOC_TOOLS,
    WEBPAGE_ADD_SOURCE_TOOL,
    executeWebpageDocTool,
    VALID_SLOTS,
};
