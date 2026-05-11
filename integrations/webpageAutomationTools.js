/**
 * Webpage tools surfaced to studio routines / automations.
 *
 * Wraps the existing webpageDbTools + webpageBuilderTools modules and re-exposes
 * them with `webpageId` promoted to an input parameter (instead of a ctx field).
 * That shape lets automations bind a literal default at build time and lets the
 * AI override it via {kind:"ref",...} or {kind:"expr",...} at run time.
 *
 * Access:
 *   • read tools (webpages_list, webpage_db_schema, webpage_db_query,
 *     webpage_file_read) gated on canReadWebpage
 *   • write tools (everything else) gated on canWriteWebpage — same surface as
 *     read by current policy, i.e. owner OR webpage published into the
 *     caller's org/groups
 *   • after the gate, calls into webpageDbStore/RustFS use the OWNER's userId
 *     so the owner-scoped paths (users/{ownerId}/webpages/{id}/...) resolve
 *
 * webpage_create is the one exception: the new webpage is owned by the caller.
 */

const webpageStore = require('../stores/webpageStore');
const { executeDbTool } = require('./webpageDbTools');
const { executeBuilderTool } = require('./webpageBuilderTools');

const WEBPAGE_AUTOMATION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'webpages_list',
            description: 'List the webpages this user can act on (owner + org/group-shared). Use this when an automation needs to pick a target webpage at run time instead of using the webpageId baked into the step. Returns { webpages: [{ id, name, description, isOwner, isPublished, updatedAt }] }.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_db_schema',
            description: 'Inspect a webpage\'s SQLite database. Returns every table and view with columns plus the original CREATE statement. Call this BEFORE writing any SELECT/INSERT/UPDATE so you know the exact column names. Returns { tables: [{ name, sql, columns: [...] }], message }.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The target webpage\'s id. Usually a literal binding chosen in the builder UI; can also be a ref to a webpages_list result.' },
                },
                required: ['webpageId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_db_query',
            description: 'Read rows from a webpage\'s SQLite database. SELECT / WITH / PRAGMA only — refuses to run a statement that would mutate the database. ALWAYS use ? placeholders and pass values via params; never interpolate into the SQL string. Returns { rows: [...], columns: [...], truncated, message }. Rows are capped at 10000.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The target webpage\'s id.' },
                    sql: { type: 'string', description: 'A read-only SQL statement (SELECT / WITH / PRAGMA).' },
                    params: { type: 'array', description: 'Values bound positionally to ? placeholders. Omit or [] when the SQL has no placeholders.', items: {} },
                },
                required: ['webpageId', 'sql'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_db_exec',
            description: 'Mutate a webpage\'s SQLite database. INSERT / UPDATE / DELETE / CREATE / ALTER / DROP. ALWAYS use ? placeholders and pass values via params — never interpolate from trigger/ai output into the SQL string. For idempotent appends (e.g. invoice rows), prefix with a SELECT via webpage_db_query, or use INSERT ... ON CONFLICT DO NOTHING on a unique column. Single statement returns { changes, lastInsertRowid, multi:false }; multi-statement scripts (allowed only when params is empty/omitted) return { changes:0, lastInsertRowid:0, multi:true }.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The target webpage\'s id.' },
                    sql: { type: 'string', description: 'A single SQL statement, or — when params is empty/omitted — a multi-statement script separated by ;.' },
                    params: { type: 'array', description: 'Values bound positionally to ? placeholders. Required when SQL contains placeholders; MUST be empty when SQL contains multiple statements.', items: {} },
                },
                required: ['webpageId', 'sql'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_read',
            description: 'Read the current contents of one source file (html/css/js) in a webpage. Returns { file, content, lineCount, message }. Use before webpage_file_replace.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The target webpage\'s id.' },
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
            description: 'Overwrite the ENTIRE content of one webpage source file. Use only for empty slots or full rewrites — for partial edits use webpage_file_replace. Returns { message, file, webpageId }.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The target webpage\'s id.' },
                    file: { type: 'string', enum: ['html', 'css', 'js'] },
                    content: { type: 'string', description: 'The full new file contents.' },
                    title: { type: 'string', description: 'Optional short label.' },
                },
                required: ['webpageId', 'file', 'content'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_replace',
            description: 'Replace a specific substring inside one webpage source file, preserving everything else. find_text must match exactly once unless replace_all is true. Read the file with webpage_file_read first so you can copy find_text verbatim. Returns { message, file, webpageId }.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The target webpage\'s id.' },
                    file: { type: 'string', enum: ['html', 'css', 'js'] },
                    find_text: { type: 'string', description: 'The exact text to find.' },
                    replace_text: { type: 'string', description: 'The replacement text. Empty string to delete.' },
                    replace_all: { type: 'boolean', description: 'When true, replace every occurrence.' },
                },
                required: ['webpageId', 'file', 'find_text', 'replace_text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_file_patch',
            description: 'Line-anchored partial edit — replace a contiguous range of lines in one webpage source file (1-indexed, inclusive). expected_text must match the current contents of those lines or the patch refuses. Returns { message, file, webpageId }.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The target webpage\'s id.' },
                    file: { type: 'string', enum: ['html', 'css', 'js'] },
                    start_line: { type: 'integer', description: '1-indexed first line of the range (inclusive).' },
                    end_line: { type: 'integer', description: '1-indexed last line of the range (inclusive).' },
                    expected_text: { type: 'string', description: 'The current contents of those lines, as returned by webpage_file_read.' },
                    replacement: { type: 'string', description: 'The new content for the range. Can be any number of lines.' },
                },
                required: ['webpageId', 'file', 'start_line', 'end_line', 'expected_text', 'replacement'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_set_metadata',
            description: 'Set the visual identity of a webpage (icon emoji, accent hex colour, one-line tagline) shown on the Webpages tile.',
            parameters: {
                type: 'object',
                properties: {
                    webpageId: { type: 'string', description: 'The target webpage\'s id.' },
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
            name: 'webpage_create',
            description: 'Create a brand-new webpage owned by the automation\'s user. Use this only when the automation\'s job is to spin up an entire new webapp — for updating an existing one, bind webpageId to that webpage\'s id instead. Returns { webpageId, url, name, message }.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Short title (≤120 chars).' },
                    description: { type: 'string', description: 'Optional one-sentence description.' },
                },
                required: ['name'],
            },
        },
    },
];

const TOOL_NAMES = new Set(WEBPAGE_AUTOMATION_TOOLS.map(t => t.function.name));
function isWebpageAutomationTool(name) {
    return TOOL_NAMES.has(name);
}

const READ_ONLY_TOOLS = new Set(['webpages_list', 'webpage_db_schema', 'webpage_db_query', 'webpage_file_read']);

async function resolveWebpageForAccess(webpageId, ctx, mode) {
    if (!webpageId) return { error: 'webpageId is required.' };
    const webpage = await webpageStore.getWebpageRaw(webpageId).catch(() => null);
    if (!webpage) return { error: `Webpage ${webpageId} not found.` };
    const userGroupIds = Array.isArray(ctx.userGroupIds) ? ctx.userGroupIds : [];
    const userOrgIds = Array.isArray(ctx.userOrgIds) ? ctx.userOrgIds : (ctx.organizationId ? [ctx.organizationId] : []);
    const allowed = mode === 'write'
        ? webpageStore.canWriteWebpage(webpage, ctx.userId, userGroupIds, userOrgIds)
        : webpageStore.canReadWebpage(webpage, ctx.userId, userGroupIds, userOrgIds);
    if (!allowed) {
        return { error: `You do not have ${mode} access to webpage ${webpageId}. Ask the owner to share it with your group or organisation.` };
    }
    return { webpage, ownerUserId: webpage.userId };
}

/**
 * Run a webpage tool on behalf of an automation.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {{ userId: string, organizationId?: string, userGroupIds?: string[], userOrgIds?: string[] }} ctx
 */
async function executeWebpageAutomationTool(toolName, args, ctx) {
    if (!ctx?.userId) return { error: 'Internal: userId required to run a webpage tool.' };

    if (toolName === 'webpages_list') {
        const userGroupIds = Array.isArray(ctx.userGroupIds) ? ctx.userGroupIds : [];
        const userOrgIds = Array.isArray(ctx.userOrgIds) ? ctx.userOrgIds : (ctx.organizationId ? [ctx.organizationId] : []);
        try {
            const rows = await webpageStore.getAccessibleWebpages(ctx.userId, userGroupIds, userOrgIds, { limit: 200 });
            const webpages = rows.map(w => ({
                id: w.id,
                name: w.name,
                description: w.description || '',
                isOwner: w.userId === ctx.userId,
                isPublished: !!w.isPublished,
                updatedAt: w.updatedAt,
            }));
            return { webpages, message: `${webpages.length} accessible webpage${webpages.length === 1 ? '' : 's'}.` };
        } catch (err) {
            return { error: `Could not list webpages: ${err.message}` };
        }
    }

    if (toolName === 'webpage_create') {
        const name = String(args?.name || 'Untitled Webpage').trim().slice(0, 120);
        const description = String(args?.description || '').slice(0, 500);
        try {
            const webpage = await webpageStore.createWebpage({ userId: ctx.userId, name, description });
            return { webpageId: webpage.id, url: `/app/webpages/${webpage.id}`, name: webpage.name, message: `Created webpage "${webpage.name}".` };
        } catch (err) {
            return { error: `Could not create webpage: ${err.message}` };
        }
    }

    const webpageId = args?.webpageId;
    const accessMode = READ_ONLY_TOOLS.has(toolName) ? 'read' : 'write';
    const resolved = await resolveWebpageForAccess(webpageId, ctx, accessMode);
    if (resolved.error) return { error: resolved.error };
    const ownerUserId = resolved.ownerUserId;

    if (toolName === 'webpage_db_schema' || toolName === 'webpage_db_query' || toolName === 'webpage_db_exec') {
        const dbArgs = { sql: args?.sql, params: args?.params };
        try {
            return await executeDbTool(toolName, dbArgs, { webpageId, userId: ownerUserId });
        } catch (err) {
            return { error: `Webpage DB tool failed: ${err.message}` };
        }
    }

    if (toolName === 'webpage_file_read' || toolName === 'webpage_file_write' || toolName === 'webpage_file_replace' || toolName === 'webpage_file_patch' || toolName === 'webpage_set_metadata') {
        try {
            const { result } = await executeBuilderTool(toolName, args, { userId: ownerUserId });
            return result;
        } catch (err) {
            return { error: `Webpage builder tool failed: ${err.message}` };
        }
    }

    return { error: `Unknown webpage tool: ${toolName}` };
}

module.exports = {
    WEBPAGE_AUTOMATION_TOOLS,
    isWebpageAutomationTool,
    executeWebpageAutomationTool,
};
