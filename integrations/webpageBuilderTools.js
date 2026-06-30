/**
 * Webpage Builder Tools — used by directChat so the regular AI chat can create
 * and edit webpages without the user being in the dedicated Webpages editor.
 *
 * Exports:
 *   BUILDER_TOOLS   — tool definitions array to append to the directChat tool list
 *   executeBuilderTool(toolName, args, context) — dispatcher
 *
 * `context` = { userId }  — no in-memory liveFiles triple; reads/writes go
 * directly to RustFS so the Webpages editor always sees the latest state.
 */

const webpageStore = require('../stores/webpageStore');
const { executeWebpageDocTool } = require('./webpageDocTools');
const { resolveFramework } = require('./webpageFramework');
const { scheduleThumbnail } = require('../core/webpageThumbnailGenerator');

// Hex like "#aabbcc" or "#abc". Restrict to a known palette range so a stray
// invalid string can't sneak into the DB and break the card render.
function sanitizeHex(c) {
    if (typeof c !== 'string') return '';
    const t = c.trim();
    return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(t) ? t : '';
}
// Keep just the first grapheme — the AI sometimes sends "📊📊" or "📊 Dashboard".
function sanitizeIcon(icon) {
    if (typeof icon !== 'string') return '';
    const t = icon.trim();
    if (!t) return '';
    // Array.from splits surrogate pairs correctly; one user-visible emoji is one entry.
    return [...t][0] || '';
}

const BUILDER_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'create_webpage',
            description: 'Create a new Webpage project (three slots: index.html, style.css, script.js) owned by the current user. Returns { webpageId, url, name, message }. Call this FIRST when the user asks for a NEW webpage; do not call it for edits to an existing one.\n\nAfter creation, populate each slot with webpage_file_write({ webpageId, file, content }). Reply with a clickable link of the form "[<name>](<url>)" so the user can open the editor.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'A short human-readable title for the webpage (e.g. "Tip Calculator", "Bakery Landing Page").',
                    },
                    description: {
                        type: 'string',
                        description: 'Optional one-sentence description of what the page does.',
                    },
                },
                required: ['name'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_read',
            description: 'Read the current content of one file (html/css/js) in an existing webpage. Returns { file, content, lineCount, message }.\n\nWhen to use: ALWAYS before webpage_file_replace or webpage_file_patch on the same file — those tools refuse to run on a slot you haven\'t read this turn (read-before-edit guard). NOT needed before webpage_file_write since that overwrites the whole file.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The ID of the webpage (from create_webpage).' },
                    file: { type: 'string', enum: ['html', 'css', 'js'], description: '"html" (index.html), "css" (style.css), or "js" (script.js).' },
                },
                required: ['webpageId', 'file'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_write',
            description: 'Overwrite the ENTIRE content of one webpage file. STRICT use cases:\n  (1) the slot is currently empty (initial creation right after create_webpage), or\n  (2) you genuinely need to replace ≥80% of the content (a from-scratch rewrite).\n\nNOT for partial edits — adding a section, tweaking styles, fixing a single bug. Use webpage_file_replace (substring) or webpage_file_patch (line range) for those. They are dramatically faster, cheaper, and safer because they don\'t re-emit the whole file.\n\nRules for the CODE YOU WRITE into the page (these constrain the page, not you):\n  • Vanilla HTML/CSS/JS only. CDN <script> tags inside the HTML are fine. No npm imports, no build step.\n  • The generated page runs in a sandbox=\"allow-scripts\" iframe, so code inside it cannot read host-app cookies, host localStorage, or call /api/* directly. Use the pre-injected `window.beeflowDB` client for persistence.\n  • These rules apply to the page you produce, NOT to you. You run server-side and can freely call other tools (Nextcloud, web search, drive, etc.) to fetch data first, then write the results into the page or DB.\n\nReturns { message, file, webpageId }.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The ID of the webpage.' },
                    file: { type: 'string', enum: ['html', 'css', 'js'], description: 'Which file to overwrite.' },
                    content: { type: 'string', description: 'The full new content of the file.' },
                    title: { type: 'string', description: 'Optional short label shown to the user (e.g. "Initial layout").' },
                },
                required: ['webpageId', 'file', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_replace',
            description: 'PREFERRED tool for editing existing webpage files. Replace a specific substring inside one slot, preserving everything else.\n\nWorkflow: webpage_file_read({ webpageId, file }) FIRST to see the exact current text, then call webpage_file_replace with find_text copied verbatim. find_text must match EXACTLY ONCE by default; on multiple matches the tool errors with line numbers — either narrow the snippet or pass replace_all: true.\n\nINSERT new content by anchoring on a stable nearby snippet and including it in replace_text. DELETE by passing replace_text: "".\n\nPrefer many small replaces over one big rewrite — each replace shows the user exactly what changed.\n\nReturns { message, file, webpageId }. NOT for line-range edits where you already know exact line numbers — use webpage_file_patch instead.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The ID of the webpage.' },
                    file: { type: 'string', enum: ['html', 'css', 'js'], description: 'Which file to edit.' },
                    find_text: { type: 'string', description: 'The exact text to find (verbatim, or whitespace-normalized as a fallback).' },
                    replace_text: { type: 'string', description: 'The replacement text. Empty string to delete.' },
                    replace_all: { type: 'boolean', description: 'When true, replace every occurrence. Default false — single-match required.' },
                },
                required: ['webpageId', 'file', 'find_text', 'replace_text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_set_metadata',
            description: 'Set the visual identity of a webpage shown in the Webpages list — a single-character emoji icon, an accent hex colour and a one-line tagline. Call this once right after you finish the initial build (or after a significant redesign) so the user\'s list shows a recognisable tile instead of a generic file icon. Cheap, idempotent — safe to call multiple times.\n\nGuidance:\n  • icon: ONE emoji that captures the page\'s purpose (📊 for dashboards, 🧾 for invoicing, 🍰 for a bakery, 📅 for calendars). No text, no multi-char strings.\n  • accent_color: hex like "#00a86b" matching the page\'s primary colour so the tile and the page feel related. Pick a saturated colour, not pure black/white.\n  • tagline: ≤80 chars, plain text, no emoji. One sentence telling the user what the page does at a glance.\n\nReturns { message, webpageId }.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The ID of the webpage.' },
                    icon: { type: 'string', description: 'A single emoji.' },
                    accent_color: { type: 'string', description: 'Hex colour like "#00a86b".' },
                    tagline: { type: 'string', description: 'One-line description, ≤80 chars.' },
                },
                required: ['webpageId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_patch',
            description: 'Line-anchored partial edit — replace a contiguous range of lines in one slot, preserving everything else. 1-indexed, inclusive on both ends (start_line=5, end_line=7 → 3 lines).\n\nWhen to use: you just read the file, you know the exact line numbers, and the change spans a multi-line block (function body, CSS rule, multi-line element). NOT for substring tweaks — use webpage_file_replace for that.\n\nexpected_text sanity check: if those lines don\'t currently equal expected_text, the patch refuses to write. This protects against stale reads. Always pair with a fresh webpage_file_read on the same turn.\n\nReturns { message, file, webpageId }.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The ID of the webpage.' },
                    file: { type: 'string', enum: ['html', 'css', 'js'], description: 'Which file to edit.' },
                    start_line: { type: 'integer', description: '1-indexed first line of the range (inclusive).' },
                    end_line: { type: 'integer', description: '1-indexed last line of the range (inclusive).' },
                    expected_text: { type: 'string', description: 'The current content of those lines exactly as it appears in the latest webpage_file_read output.' },
                    replacement: { type: 'string', description: 'The new content for the range. Can be any number of lines, including 0 (empty string) to delete.' },
                },
                required: ['webpageId', 'file', 'start_line', 'end_line', 'expected_text', 'replacement'],
            },
        },
    },
];

const BUILDER_TOOL_NAMES = new Set(BUILDER_TOOLS.map(t => t.function.name));

function isBuilderTool(toolName) {
    return BUILDER_TOOL_NAMES.has(toolName);
}

/**
 * Execute a builder tool call.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {{ userId: string, readSlots?: Map<string, Set<string>> }} ctx
 *   readSlots is keyed by webpageId — tracks which slots the AI has read this
 *   call-batch so the read-before-edit guard can warn when an edit comes in
 *   on a slot it never read.
 * @returns {{ result, webpageUpdate?: { webpageId, file, content, title? } }}
 */
async function executeBuilderTool(toolName, args, ctx) {
    const { userId, readSlots } = ctx;

    function readSetFor(webpageId) {
        if (!readSlots) return null;
        if (!readSlots.has(webpageId)) readSlots.set(webpageId, new Set());
        return readSlots.get(webpageId);
    }

    if (toolName === 'create_webpage') {
        const name = (args.name || 'Untitled Webpage').trim().slice(0, 120);
        const description = (args.description || '').slice(0, 500);
        const webpage = await webpageStore.createWebpage({ userId, name, description });
        const url = `/app/webpages/${webpage.id}`;
        console.log(`[WebpageBuilder] create_webpage: "${name}" → ${webpage.id}`);
        return {
            result: { webpageId: webpage.id, url, name, message: `Webpage created: "${name}". URL: ${url}` },
        };
    }

    if (toolName === 'webpage_file_read') {
        const { webpageId, file } = args;
        if (!webpageId) return { result: { error: 'webpageId is required.' } };
        const webpage = await webpageStore.getWebpage(webpageId, userId).catch(() => null);
        if (!webpage) return { result: { error: `Webpage ${webpageId} not found.` } };
        const files = await webpageStore.readAllSlots(userId, webpageId);
        const docResult = executeWebpageDocTool('webpage_file_read', { file }, files, { readSlots: readSetFor(webpageId) });
        return { result: docResult };
    }

    if (toolName === 'webpage_set_metadata') {
        const { webpageId } = args;
        if (!webpageId) return { result: { error: 'webpageId is required.' } };
        const webpage = await webpageStore.getWebpage(webpageId, userId).catch(() => null);
        if (!webpage) return { result: { error: `Webpage ${webpageId} not found.` } };
        const icon = sanitizeIcon(args.icon);
        const accentColor = sanitizeHex(args.accent_color);
        const tagline = typeof args.tagline === 'string' ? args.tagline.trim().slice(0, 80) : '';
        const updates = {};
        if (icon) updates.icon = icon;
        if (accentColor) updates.accentColor = accentColor;
        if (tagline) updates.tagline = tagline;
        if (Object.keys(updates).length === 0) {
            return { result: { error: 'Provide at least one of icon, accent_color, tagline.' } };
        }
        await webpageStore.updateWebpageMetadata(webpageId, userId, updates);
        console.log(`[WebpageBuilder] webpage_set_metadata: ${webpageId} ${JSON.stringify(updates)}`);
        return { result: { message: 'Webpage metadata updated.', webpageId, ...updates } };
    }

    if (toolName === 'webpage_file_write') {
        const { webpageId, file, content, title } = args;
        if (!webpageId) return { result: { error: 'webpageId is required.' } };
        const webpage = await webpageStore.getWebpage(webpageId, userId).catch(() => null);
        if (!webpage) return { result: { error: `Webpage ${webpageId} not found.` } };

        const files = { html: '', css: '', js: '' };
        const docResult = executeWebpageDocTool('webpage_file_write', { file, content, title }, files);
        if (docResult.error) return { result: docResult };

        await webpageStore.writeSlot(userId, webpageId, file, content);
        console.log(`[WebpageBuilder] webpage_file_write: ${file} → ${webpageId} (${content.length} chars)`);

        // Soft post-write validation (BFSF-222) — full-page html writes on
        // vanilla projects only. Advisory: appends a one-line note to the
        // tool result, never blocks or alters the write itself.
        let validationNote = '';
        if (file === 'html' && resolveFramework(webpage) !== 'react-mui') {
            try {
                const configStore = require('../stores/configStore');
                if ((await configStore.getConfig('webpage_validation_enabled')) !== 'false') {
                    const { validateWebpageProject, formatToolWarning, mergeAllowedImgHosts } = require('../services/webpageValidation');
                    const allowedHosts = mergeAllowedImgHosts(await configStore.getConfig('webpage_img_host_allowlist'));
                    const extras = await webpageStore.listExtraFiles(webpageId);
                    const slots = await webpageStore.readAllSlots(userId, webpageId);
                    const { violations } = validateWebpageProject({
                        framework: 'vanilla',
                        html: content,
                        scriptTexts: [slots.js],
                        assetPaths: extras.map(e => e.path),
                        allowedHosts,
                    });
                    validationNote = formatToolWarning(violations);
                }
            } catch (valErr) {
                console.warn('[WebpageBuilder] Post-write validation failed (skipping):', valErr.message);
            }
        }

        // Background thumbnail render — debounced so a burst of html+css+js
        // writes coalesce into a single screenshot.
        scheduleThumbnail({ userId, webpageId });

        return {
            result: { message: docResult.message + validationNote, file, webpageId },
            webpageUpdate: { webpageId, file, content, title: title || file },
        };
    }

    if (toolName === 'webpage_file_replace' || toolName === 'webpage_file_patch') {
        const { webpageId, file } = args;
        if (!webpageId) return { result: { error: 'webpageId is required.' } };
        const webpage = await webpageStore.getWebpage(webpageId, userId).catch(() => null);
        if (!webpage) return { result: { error: `Webpage ${webpageId} not found.` } };

        // Read current content from RustFS — pass through to the doc tool
        const files = await webpageStore.readAllSlots(userId, webpageId);
        const docArgs = { ...args };
        delete docArgs.webpageId;
        const docResult = executeWebpageDocTool(toolName, docArgs, files, { readSlots: readSetFor(webpageId) });
        if (docResult.error) return { result: docResult };

        const newContent = docResult.content;
        await webpageStore.writeSlot(userId, webpageId, file, newContent);
        console.log(`[WebpageBuilder] ${toolName}: ${file} in ${webpageId}`);

        scheduleThumbnail({ userId, webpageId });

        return {
            result: { message: docResult.message, file, webpageId },
            webpageUpdate: { webpageId, file, content: newContent },
        };
    }

    return { result: { error: `Unknown builder tool: ${toolName}` } };
}

module.exports = {
    BUILDER_TOOLS,
    isBuilderTool,
    executeBuilderTool,
};
