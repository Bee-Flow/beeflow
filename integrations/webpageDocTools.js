/**
 * Webpage Document Tools
 *
 * Four parameterised AI tools, all operating on the three slots (html / css / js)
 * of a webpage:
 *
 *   webpage_file_read     — return current content
 *   webpage_file_write    — replace ENTIRE slot
 *   webpage_file_replace  — substring replace (default: must be unique; replace_all opts in)
 *   webpage_file_patch    — line-anchored replace with expected_text sanity check
 *
 * Plus webpage_add_source.
 *
 * Edit-tool design follows Claude Code's parity: strict by default, no silent
 * first-match-only behaviour, line-numbered error messages so the AI can
 * self-correct in one round-trip.
 */

const VALID_SLOTS = ['html', 'css', 'js'];

const WEBPAGE_DOC_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'webpage_file_read',
            description: 'Read the current content of one of the three webpage files (index.html, style.css, or script.js). The webpage is rendered live in a sandboxed iframe visible to the user. ALWAYS use this BEFORE webpage_file_replace / webpage_file_patch on the same file so you operate on the latest content.',
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
            description: 'Overwrite the ENTIRE content of one webpage file. STRICTLY for two cases:\n  (1) the file is currently empty (initial creation), or\n  (2) you genuinely need to replace ≥80% of the content (a from-scratch rewrite).\n\nFor any other change — adding a section, tweaking styles, fixing a bug, swapping a word, restructuring a small piece — use webpage_file_replace or webpage_file_patch instead. Those preserve everything around the edit and are dramatically cheaper, faster, and safer than re-emitting the whole file. The system will WARN you in the tool result if you call webpage_file_write on a non-empty file, because in 95% of cases that\'s a mistake.\n\nFile rules:\n- "html": valid HTML5 document or fragment.\n- "css": plain CSS. No SCSS/LESS — no build step.\n- "js": vanilla JavaScript. No npm imports. CDN <script> tags belong in the HTML.\n\nThe iframe runs with sandbox="allow-scripts" (no same-origin) — code that depends on parent cookies, localStorage, or fetches to the host app will fail.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', enum: VALID_SLOTS, description: 'Which file to overwrite.' },
                    content: { type: 'string', description: 'The full new content of the file. Replaces all existing content.' },
                    title: { type: 'string', description: 'Optional short label of what was written, shown to the user (e.g. "Initial layout", "Dark theme").' },
                },
                required: ['file', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_replace',
            description: 'PREFERRED tool for editing existing webpage files. Replace a specific substring while preserving everything else. Use this for: adding/removing/changing sections, tweaking styles, swapping copy, fixing bugs, refactoring blocks — anything that doesn\'t require throwing away the whole file.\n\nWorkflow: webpage_file_read({file}) first to see the exact current text, then webpage_file_replace with find_text copied verbatim from what you read. find_text must match EXACTLY ONCE by default; if it appears multiple times the tool errors with line numbers and you either narrow the snippet or set replace_all: true. Whitespace-normalized matching is a fallback when verbatim fails.\n\nTo INSERT new content (without removing anything), set find_text to a stable anchor near where you want the insertion (e.g. an existing element\'s closing tag) and set replace_text to that anchor PLUS your new content. To DELETE content, set replace_text to "".\n\nDo many small replaces rather than one big rewrite when possible — each replace shows the user exactly what changed.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', enum: VALID_SLOTS, description: 'Which file to edit.' },
                    find_text: { type: 'string', description: 'The exact text to find. Must currently appear in the file (verbatim, or whitespace-normalized as a fallback).' },
                    replace_text: { type: 'string', description: 'The new text to insert in place of find_text. Set to empty string to delete.' },
                    replace_all: { type: 'boolean', description: 'When true, replace every occurrence of find_text. Default false — single-match required.' },
                },
                required: ['file', 'find_text', 'replace_text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_patch',
            description: 'Line-anchored partial edit — replace a contiguous range of lines, preserving everything else. Use this when you know exactly which lines to rewrite (you just read the file and counted) and the change spans more than a simple substring. Common cases: rewriting a function body, swapping a multi-line block, restructuring a CSS rule.\n\nLine numbers are 1-indexed and inclusive — start_line=5, end_line=7 replaces 3 lines (5, 6, 7).\n\nexpected_text sanity check: if the current contents of those lines don\'t match what you provide, the patch refuses to write — protects against corruption from a stale read. Always pair this tool with a fresh webpage_file_read on the same turn.\n\nPrefer this OR webpage_file_replace over webpage_file_write whenever the file already has content.',
            parameters: {
                type: 'object',
                properties: {
                    file: { type: 'string', enum: VALID_SLOTS, description: 'Which file to edit.' },
                    start_line: { type: 'integer', description: '1-indexed first line of the range (inclusive).' },
                    end_line: { type: 'integer', description: '1-indexed last line of the range (inclusive).' },
                    expected_text: { type: 'string', description: 'The current content of those lines exactly as it appears in the file. If it does not match, the patch errors instead of corrupting the file. Use the latest webpage_file_read output.' },
                    replacement: { type: 'string', description: 'The new content to put in place of the range. Can be any number of lines, including 0 (empty string) to delete.' },
                },
                required: ['file', 'start_line', 'end_line', 'expected_text', 'replacement'],
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
                name: { type: 'string', description: 'A short descriptive name for the source (e.g. "Brand style guide", "Bakery menu draft").' },
                content: { type: 'string', description: 'The full text content to add as a source.' },
                metadata: { type: 'object', description: 'Optional structured metadata for the source.' },
            },
            required: ['name', 'content'],
        },
    },
};

/**
 * Execute a webpage document tool call.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {{html:string, css:string, js:string}} files — in-memory triple kept in sync with the editor.
 * @param {object} [ctx] — optional per-turn context: `{ readSlots: Set<string> }` for the read-before-edit guard.
 */
function executeWebpageDocTool(toolName, args, files, ctx = {}) {
    const readSlots = ctx.readSlots instanceof Set ? ctx.readSlots : null;

    if (toolName === 'webpage_file_read') {
        const file = args.file;
        if (!VALID_SLOTS.includes(file)) {
            return { error: `Invalid file "${file}" — must be one of: ${VALID_SLOTS.join(', ')}.` };
        }
        if (readSlots) readSlots.add(file);
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

        // Soft warning when overwriting a non-empty file with new content of
        // similar size. The write still applies, but the AI sees this in the
        // tool result and learns to prefer partial edits next time.
        const previous = files?.[file] || '';
        let warning = '';
        if (previous.trim().length > 0) {
            // Heuristic: if both old and new are sizeable (>200 chars) and the
            // new content shares <40% of its lines with the old, this is
            // probably a wholesale rewrite that should have been a series of
            // partial edits. Emit a warning either way for non-empty writes.
            const overlap = lineOverlapRatio(previous, content);
            const previewWasFull = previous.length > 200;
            warning = previewWasFull && overlap < 0.4
                ? ` ⚠ webpage_file_write replaced ${previous.length.toLocaleString()} chars of existing content (line overlap with old version: ${(overlap * 100).toFixed(0)}%). For most edits — adding a section, tweaking styles, fixing copy — webpage_file_replace or webpage_file_patch is faster, cheaper, and safer than rewriting the whole file. Only use webpage_file_write for empty files or genuine from-scratch rewrites.`
                : ` Note: the file already had content — for partial changes, webpage_file_replace or webpage_file_patch are the preferred tools. webpage_file_write is for empty files or full rewrites.`;
        }

        return {
            _action: 'webpage_doc_update',
            file,
            content,
            title,
            message: `${slotFilename(file)} updated: "${title}".${warning}`,
        };
    }

    if (toolName === 'webpage_file_replace') {
        const file = args.file;
        const findText = args.find_text;
        const replaceText = args.replace_text ?? '';
        const replaceAll = args.replace_all === true;

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

        // 1. Verbatim occurrence count
        const occurrences = findAllOccurrences(current, findText);

        if (occurrences.length === 1) {
            const newContent = spliceAt(current, occurrences[0].start, occurrences[0].end, replaceText);
            return wrapEditResult(file, newContent, {
                message: replaceText
                    ? `${slotFilename(file)} updated (1 replacement at line ${occurrences[0].line}).`
                    : `${slotFilename(file)} text removed at line ${occurrences[0].line}.`,
                readSlots,
            });
        }

        if (occurrences.length >= 2) {
            if (!replaceAll) {
                const lines = occurrences.map(o => o.line);
                return {
                    error: `find_text matches ${occurrences.length} places in ${slotFilename(file)} (lines ${lines.join(', ')}). Either narrow find_text so it matches exactly once, or set replace_all: true to replace every occurrence.`,
                };
            }
            // Replace all — walk back-to-front so byte offsets remain valid.
            let next = current;
            for (let i = occurrences.length - 1; i >= 0; i--) {
                next = spliceAt(next, occurrences[i].start, occurrences[i].end, replaceText);
            }
            return wrapEditResult(file, next, {
                message: `${slotFilename(file)} updated (${occurrences.length} replacements, lines ${occurrences.map(o => o.line).join(', ')}).`,
                readSlots,
            });
        }

        // 0 verbatim matches — try whitespace-normalized fallback
        const range = locateOriginalRange(current, findText);
        if (range) {
            // Whitespace fallback: only single replacement supported (the normalized
            // mapping is order-dependent; replace_all here would be ambiguous).
            const newContent = spliceAt(current, range.start, range.end, replaceText);
            const line = lineNumberForOffset(current, range.start);
            return wrapEditResult(file, newContent, {
                message: replaceText
                    ? `${slotFilename(file)} updated at line ${line} (whitespace-normalized match).`
                    : `${slotFilename(file)} text removed at line ${line} (whitespace-normalized match).`,
                readSlots,
            });
        }

        // Not found at all — produce a diff-style hint.
        return {
            error: `Could not find the find_text snippet in ${slotFilename(file)}. ${buildNearestMatchHint(current, findText, file)}`,
        };
    }

    if (toolName === 'webpage_file_patch') {
        const file = args.file;
        const startLine = Number(args.start_line);
        const endLine = Number(args.end_line);
        const expected = args.expected_text ?? '';
        const replacement = args.replacement ?? '';

        if (!VALID_SLOTS.includes(file)) {
            return { error: `Invalid file "${file}" — must be one of: ${VALID_SLOTS.join(', ')}.` };
        }
        if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
            return { error: `start_line and end_line must be 1-indexed integers with start_line ≤ end_line. Got start_line=${args.start_line}, end_line=${args.end_line}.` };
        }

        const current = files?.[file] || '';
        const lines = current.split('\n');
        if (endLine > lines.length) {
            return { error: `end_line (${endLine}) is past end of ${slotFilename(file)} which has ${lines.length} lines. Call webpage_file_read to recount.` };
        }

        const actual = lines.slice(startLine - 1, endLine).join('\n');
        if (normalizeWhitespace(actual) !== normalizeWhitespace(expected)) {
            return {
                error: `expected_text does not match actual content of lines ${startLine}-${endLine} in ${slotFilename(file)}. The file has likely changed since you last read it. Call webpage_file_read({file:"${file}"}) and retry.\n\nWhat the file actually contains on those lines:\n${truncate(actual, 400)}`,
            };
        }

        const replacementLines = replacement === '' ? [] : replacement.split('\n');
        const newLines = [...lines.slice(0, startLine - 1), ...replacementLines, ...lines.slice(endLine)];
        const newContent = newLines.join('\n');

        return wrapEditResult(file, newContent, {
            message: `${slotFilename(file)} patched: replaced lines ${startLine}-${endLine} (${endLine - startLine + 1} → ${replacementLines.length} lines).`,
            readSlots,
        });
    }

    return { error: `Unknown webpage document tool: ${toolName}` };
}

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

function slotFilename(slot) {
    return slot === 'html' ? 'index.html' : slot === 'css' ? 'style.css' : 'script.js';
}

function spliceAt(str, start, end, insert) {
    return str.slice(0, start) + insert + str.slice(end);
}

function truncate(s, n) {
    if (typeof s !== 'string') return '';
    return s.length > n ? s.slice(0, n) + '…' : s;
}

function normalizeWhitespace(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Quick "how similar" check between two text blobs by counting how many
 * lines from the new content appear verbatim in the old content. 1.0 means
 * every line is preserved (probably a partial edit that became a full
 * rewrite — should have used webpage_file_replace). 0.0 means none of the
 * old structure survives.
 */
function lineOverlapRatio(oldText, newText) {
    if (!oldText || !newText) return 0;
    const oldLines = new Set(oldText.split('\n').map(s => s.trim()).filter(Boolean));
    const newLines = newText.split('\n').map(s => s.trim()).filter(Boolean);
    if (newLines.length === 0) return 0;
    let kept = 0;
    for (const ln of newLines) if (oldLines.has(ln)) kept++;
    return kept / newLines.length;
}

/**
 * Wrap a successful edit with the standard `_action` envelope plus a soft
 * read-before-edit warning when the AI skipped reading the slot this turn.
 */
function wrapEditResult(file, newContent, { message, readSlots }) {
    let finalMessage = message;
    if (readSlots && !readSlots.has(file)) {
        finalMessage += ` Note: you didn't call webpage_file_read({file:"${file}"}) this turn before editing — read first next time so whitespace differences don't cause a retry.`;
    }
    return {
        _action: 'webpage_doc_update',
        file,
        content: newContent,
        message: finalMessage,
    };
}

/**
 * Find every occurrence of `needle` in `haystack`. Returns an array of
 * `{ start, end, line }`. Empty needle returns []. Overlap is not supported —
 * advances by needle.length after each hit.
 */
function findAllOccurrences(haystack, needle) {
    const out = [];
    if (!needle) return out;
    let i = 0;
    while (true) {
        const idx = haystack.indexOf(needle, i);
        if (idx < 0) break;
        out.push({ start: idx, end: idx + needle.length, line: lineNumberForOffset(haystack, idx) });
        i = idx + needle.length;
    }
    return out;
}

function lineNumberForOffset(text, offset) {
    let line = 1;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) line++;
    }
    return line;
}

/**
 * When the AI's find_text doesn't match, surface a short diff-style hint so it
 * can self-correct in one round-trip instead of guessing again.
 */
function buildNearestMatchHint(current, findText, file) {
    const norm = normalizeWhitespace(findText);
    if (!norm) return ` Call webpage_file_read({file:"${file}"}) first to see the exact current content, then retry.`;

    const words = norm.split(' ').filter(Boolean);
    if (words.length === 0) return '';

    const probe = words.slice(0, Math.min(4, words.length)).join(' ').toLowerCase();
    const lc = current.toLowerCase();
    const idx = lc.indexOf(probe);
    if (idx < 0) {
        return ` No similar snippet found. Call webpage_file_read({file:"${file}"}) and copy the exact text into find_text.`;
    }

    // Build a 3-line diff-style preview around the nearest hit.
    const previewStart = Math.max(0, current.lastIndexOf('\n', idx) + 1);
    const previewEnd = current.indexOf('\n', idx + Math.min(160, findText.length));
    const realEnd = previewEnd < 0 ? Math.min(current.length, idx + 200) : previewEnd;
    const actualSlice = current.slice(previewStart, realEnd);
    const line = lineNumberForOffset(current, idx);

    return ` The closest match is at line ${line}. Whitespace likely differs. Diff:\n- ${truncate(findText.replace(/\n/g, '⏎'), 160)}\n+ ${truncate(actualSlice.replace(/\n/g, '⏎'), 160)}\nUse the "+" line verbatim as your next find_text.`;
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
    const normNeedle = normalizeWhitespace(needle);
    if (!normNeedle) return null;

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
    // Exported for tests / reuse by builder tools
    findAllOccurrences,
    lineNumberForOffset,
};
