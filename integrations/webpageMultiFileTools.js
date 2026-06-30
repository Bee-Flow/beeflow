/**
 * Webpage Multi-File Tools
 *
 * Five tools that let the AI work with arbitrary additional files inside a
 * webpage project — beyond the three primary slots (index.html, style.css,
 * script.js) which keep using the existing webpage_file_* tools.
 *
 *   webpage_list_files            — list every file in the project (primary + extras)
 *   webpage_create_file           — create a new extra file at a relative path
 *   webpage_read_file             — read the content of an existing extra file
 *   webpage_replace_in_file       — partial substring replace inside an extra file
 *   webpage_delete_file           — delete an extra file
 *
 * Reserved paths (`index.html`, `style.css`, `script.js`) are routed through
 * the existing webpage_file_* tools — these tools reject them so the model
 * doesn't accidentally bypass the primary slot's auto-versioning logic.
 *
 * Why a separate module instead of extending webpage_file_*: the primary
 * slots are stored in dedicated DB columns + RustFS keys with sha-based
 * change detection and auto-versioning. The extras live in their own table.
 * Keeping the tool surfaces parallel rather than overloaded keeps the
 * dispatcher straightforward and avoids subtle behaviour drift.
 */

const webpageStore = require('../stores/webpageStore');
const { findAllOccurrences, lineNumberForOffset } = require('./webpageDocTools');

const WEBPAGE_MULTI_FILE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'webpage_list_files',
            description: 'List every file in the webpage project — the three primary slots (index.html, style.css, script.js) plus any extra files you or the user have added (components/, assets/, etc). Returns paths, sizes, and whether each file is text or binary. Call this when you need to know what files exist before creating new ones, deleting, or restructuring the project.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_create_file',
            description: 'Create or overwrite an EXTRA file at a relative path. Use for additional files like components/Header.jsx, modules/state.js, src/App.jsx, data/products.json, assets/logo.svg. Folders are created implicitly from the path.\n\nNOT for the three primary slots — use webpage_file_write({ file: "html"|"css"|"js" }) for those instead. Reserved paths (index.html, style.css, script.js) are rejected.\n\nTEXT files only (HTML, CSS, JS, JSX, TS, TSX, JSON, SVG, MD, …). Binary assets (PNG/JPG/fonts/audio) are NOT created here — the user uploads those and you reference them at their path (call webpage_list_assets to see them). In a react-mui project, create src/main.jsx (the entry), src/App.jsx, and components under src/.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Relative path inside the project, e.g. "components/header.html" or "modules/state.js". Use forward slashes for nested folders. No leading slash, no ".." segments. Allowed chars: letters, digits, underscore, dot, hyphen, space.',
                    },
                    content: {
                        type: 'string',
                        description: 'The full content of the file as text. To overwrite an existing extra file, call this again with the new content (no separate update tool — same call upserts).',
                    },
                },
                required: ['path', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_list_assets',
            description: 'List the uploaded binary assets in this project (images, fonts, audio, …) that the user has added. Returns each asset\'s path, MIME type and size so you can reference it at its real path — e.g. <img src="assets/logo.png"> (vanilla) or import logoUrl from "./assets/logo.png" (react-mui). Call this before adding images; do NOT invent external image URLs. Returns an empty list when the user has not uploaded any assets — then fall back to inline SVG, CSS gradients, emoji, or https://placehold.co/WIDTHxHEIGHT.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_read_file',
            description: 'Read the current content of an EXTRA file. Always call this before webpage_replace_in_file on the same file so you operate on the latest content. For the three primary slots, use webpage_file_read instead.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The relative path of the extra file to read.' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_replace_in_file',
            description: 'Replace a substring inside an EXTRA file. Default: find_text must match exactly once; if it matches multiple places the tool errors with line numbers and asks you to either narrow the snippet or set replace_all: true.\n\nNot for the three primary slots — use webpage_file_replace for those.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The extra file path.' },
                    find_text: { type: 'string', description: 'The exact substring to find.' },
                    replace_text: { type: 'string', description: 'Replacement text. Empty string deletes.' },
                    replace_all: { type: 'boolean', description: 'When true, replace every occurrence. Default false.' },
                },
                required: ['path', 'find_text', 'replace_text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_delete_file',
            description: 'Delete an EXTRA file from the project. Cannot delete the three primary slots — use webpage_file_write with empty content if you want to clear them.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'The extra file path to delete.' },
                },
                required: ['path'],
            },
        },
    },
];

const TOOL_NAMES = new Set(WEBPAGE_MULTI_FILE_TOOLS.map(t => t.function.name));
function isMultiFileTool(name) {
    return TOOL_NAMES.has(name);
}

const RESERVED = new Set(['index.html', 'style.css', 'script.js']);
function rejectReserved(path) {
    if (RESERVED.has(path)) {
        const slot = path === 'index.html' ? 'html' : path === 'style.css' ? 'css' : 'js';
        return `"${path}" is a primary slot — use webpage_file_write({ file: "${slot}", content: ... }) for that file instead.`;
    }
    return null;
}

/**
 * Execute a multi-file tool. Returns an envelope similar to the doc-tool
 * executor — `{ ...result, _action?: 'webpage_extra_update' | 'webpage_extra_deleted' }`
 * so the chat handler can emit the matching SSE event for live UI sync.
 */
async function executeMultiFileTool(toolName, args, { webpageId, userId }) {
    if (toolName === 'webpage_list_files') {
        const extras = await webpageStore.listExtraFiles(webpageId);
        const wp = await webpageStore.getWebpage(webpageId, userId);
        const primary = [
            { path: 'index.html', kind: 'primary', size: wp?.htmlSize || 0, isText: true },
            { path: 'style.css',  kind: 'primary', size: wp?.cssSize  || 0, isText: true },
            { path: 'script.js',  kind: 'primary', size: wp?.jsSize   || 0, isText: true },
        ];
        const extraList = extras.map(e => ({
            path: e.path, kind: 'extra', size: e.size, isText: e.isText, mimeType: e.mimeType,
        }));
        return {
            files: [...primary, ...extraList],
            message: `Project has ${primary.length} primary slot${primary.length === 1 ? '' : 's'} + ${extraList.length} extra file${extraList.length === 1 ? '' : 's'}.`,
        };
    }

    if (toolName === 'webpage_list_assets') {
        const extras = await webpageStore.listExtraFiles(webpageId);
        const assets = extras
            .filter(e => !e.isText)
            .map(e => ({ path: e.path, mimeType: e.mimeType, size: e.size }));
        return {
            assets,
            message: assets.length
                ? `${assets.length} uploaded asset${assets.length === 1 ? '' : 's'}. Reference them at their path; do not invent external image URLs.`
                : 'No uploaded assets yet. Use inline SVG, CSS, emoji, or https://placehold.co/WIDTHxHEIGHT instead of inventing image URLs.',
        };
    }

    if (toolName === 'webpage_create_file') {
        const path = String(args?.path || '').trim();
        const content = typeof args?.content === 'string' ? args.content : '';

        const reservedErr = rejectReserved(path);
        if (reservedErr) return { error: reservedErr };
        const validation = webpageStore.validateExtraPath(path);
        if (validation) return { error: validation };

        try {
            const meta = await webpageStore.upsertExtraFile({ webpageId, userId, path, content });
            return {
                _action: 'webpage_extra_update',
                path,
                meta,
                message: `Created/updated ${path} (${meta.size} bytes).`,
            };
        } catch (err) {
            return { error: `Failed to create ${path}: ${err.message}` };
        }
    }

    if (toolName === 'webpage_read_file') {
        const path = String(args?.path || '').trim();
        const reservedErr = rejectReserved(path);
        if (reservedErr) return { error: reservedErr };
        const file = await webpageStore.readExtraFile({ webpageId, userId, path });
        if (!file) return { error: `File "${path}" not found. Use webpage_list_files to see what exists.` };
        if (!file.meta.isText) {
            return {
                content: '',
                isBinary: true,
                size: file.meta.size,
                mimeType: file.meta.mimeType,
                message: `${path} is binary (${file.meta.mimeType}, ${file.meta.size} bytes) — content is not displayed inline.`,
            };
        }
        return { content: file.text, mimeType: file.meta.mimeType, size: file.meta.size };
    }

    if (toolName === 'webpage_replace_in_file') {
        const path = String(args?.path || '').trim();
        const findText = args?.find_text;
        const replaceText = args?.replace_text ?? '';
        const replaceAll = args?.replace_all === true;

        const reservedErr = rejectReserved(path);
        if (reservedErr) return { error: reservedErr };
        if (!findText) return { error: 'find_text is required.' };

        const file = await webpageStore.readExtraFile({ webpageId, userId, path });
        if (!file) return { error: `File "${path}" not found.` };
        if (!file.meta.isText) return { error: `${path} is binary — webpage_replace_in_file only works on text files.` };

        const current = file.text;
        const occurrences = findAllOccurrences(current, findText);

        if (occurrences.length === 0) {
            return { error: `find_text not found in ${path}. Call webpage_read_file first to see the exact current contents.` };
        }
        if (occurrences.length > 1 && !replaceAll) {
            const lines = occurrences.map(o => o.line);
            return { error: `find_text matches ${occurrences.length} places in ${path} (lines ${lines.join(', ')}). Either narrow find_text or set replace_all: true.` };
        }

        let next;
        if (replaceAll) {
            next = current;
            for (let i = occurrences.length - 1; i >= 0; i--) {
                next = next.slice(0, occurrences[i].start) + replaceText + next.slice(occurrences[i].end);
            }
        } else {
            const o = occurrences[0];
            next = current.slice(0, o.start) + replaceText + current.slice(o.end);
        }

        try {
            const meta = await webpageStore.upsertExtraFile({ webpageId, userId, path, content: next });
            return {
                _action: 'webpage_extra_update',
                path,
                meta,
                message: `${path} updated (${occurrences.length} replacement${occurrences.length === 1 ? '' : 's'}, line${occurrences.length === 1 ? '' : 's'} ${occurrences.map(o => o.line).join(', ')}).`,
            };
        } catch (err) {
            return { error: `Failed to write ${path}: ${err.message}` };
        }
    }

    if (toolName === 'webpage_delete_file') {
        const path = String(args?.path || '').trim();
        const reservedErr = rejectReserved(path);
        if (reservedErr) return { error: reservedErr };
        const ok = await webpageStore.deleteExtraFile({ webpageId, userId, path });
        if (!ok) return { error: `File "${path}" not found.` };
        return {
            _action: 'webpage_extra_deleted',
            path,
            message: `Deleted ${path}.`,
        };
    }

    return { error: `Unknown multi-file tool: ${toolName}` };
}

module.exports = {
    WEBPAGE_MULTI_FILE_TOOLS,
    executeMultiFileTool,
    isMultiFileTool,
};
