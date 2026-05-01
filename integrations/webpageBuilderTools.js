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

const BUILDER_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'create_webpage',
            description: 'Create a new Webpage project (index.html + style.css + script.js) and return its ID and URL. Call this FIRST before writing any files. Then call webpage_file_write to populate the three files.',
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
            description: 'Read the current content of one file in an existing webpage. Call this BEFORE webpage_file_replace so you operate on the latest content.',
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
            description: 'Overwrite the ENTIRE content of one webpage file. Use for initial creation or full rewrites. For partial edits, use webpage_file_replace.\n\nIframe rules: sandbox="allow-scripts" only — no same-origin. Inline CSS/JS into the HTML for the preview, or use separate style.css / script.js. CDN <script> tags are fine inside HTML. No npm imports.',
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
            description: 'Replace a specific substring inside one webpage file. Call webpage_file_read first to get the exact current text.\n\nBy default find_text must match exactly once. If it matches in multiple places the tool errors with line numbers; either narrow the snippet or set replace_all: true.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The ID of the webpage.' },
                    file: { type: 'string', enum: ['html', 'css', 'js'], description: 'Which file to edit.' },
                    find_text: { type: 'string', description: 'The exact text to find (verbatim or whitespace-normalized).' },
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
            name: 'webpage_file_patch',
            description: 'Replace a contiguous range of LINES in one webpage file with sanity-check on expected_text. 1-indexed, inclusive on both ends.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The ID of the webpage.' },
                    file: { type: 'string', enum: ['html', 'css', 'js'], description: 'Which file to edit.' },
                    start_line: { type: 'integer', description: '1-indexed first line of the range (inclusive).' },
                    end_line: { type: 'integer', description: '1-indexed last line of the range (inclusive).' },
                    expected_text: { type: 'string', description: 'The current content of those lines exactly as it appears.' },
                    replacement: { type: 'string', description: 'The new content for the range.' },
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

        return {
            result: { message: docResult.message, file, webpageId },
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
