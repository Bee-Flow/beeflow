/**
 * Webpage DB Tools
 *
 * Three tools that let the AI work with the webpage's SQLite database. All
 * three operate on the single `data.db` slot stored in RustFS alongside the
 * script files; execution is server-side via better-sqlite3.
 *
 *   webpage_db_schema  — list tables + columns (call this BEFORE generating queries)
 *   webpage_db_query   — read-only SELECT
 *   webpage_db_exec    — INSERT/UPDATE/DELETE/CREATE/etc. (single statement OR multi-statement DDL)
 *
 * The AI uses these to seed schema, populate fixtures, and inspect results.
 * The same DB is then exposed to the running webpage script via the
 * `window.beeflowDB` client injected into the preview iframe.
 */

const webpageDbStore = require('../stores/webpageDbStore');

const WEBPAGE_DB_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'webpage_db_schema',
            description: 'Inspect the webpage\'s SQLite database. Returns every user table and view with columns (name, type, notNull, defaultValue, primaryKey) plus the original CREATE statement.\n\nWhen to use: before writing any SELECT/INSERT/UPDATE against tables you didn\'t create yourself this turn — you cannot see the schema otherwise.\n\nReturn shape: { tables: [{ name, sql, columns: [...] }], message }. A brand new webpage starts with zero tables; the message will say so.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_db_query',
            description: 'Read rows from the webpage\'s SQLite database. SELECT / WITH / PRAGMA only.\n\nWhen to use: any time you need to look at data. NOT for writes — the engine refuses to run a statement that would mutate the database and tells you to call webpage_db_exec instead.\n\nReturn shape: { rows: [...], columns: [string], truncated: boolean, message }. Rows are capped at 10000; `truncated: true` means there were more — narrow the query (add WHERE, LIMIT, etc.) and call again.\n\nAlways use ? placeholders + params for any value that came from user input or another tool — never interpolate strings into the SQL.',
            parameters: {
                type: 'object',
                properties: {
                    sql: {
                        type: 'string',
                        description: 'A read-only SQL statement (SELECT / WITH / PRAGMA). Use ? placeholders for values.',
                    },
                    params: {
                        type: 'array',
                        description: 'Values bound positionally to ? placeholders. Strings, numbers, booleans, null. Objects/arrays are JSON-stringified. Omit or pass [] when the SQL has no placeholders.',
                        items: {},
                    },
                },
                required: ['sql'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_db_exec',
            description: 'Mutate the webpage\'s SQLite database. INSERT / UPDATE / DELETE / CREATE / ALTER / DROP / REINDEX / etc.\n\nWhen to use: ANY write or DDL. NOT for reads — call webpage_db_query for SELECTs (this tool will run them but you get no rows back).\n\nTwo modes:\n  • Single statement (with or without params) — use ? placeholders + params for any user-supplied value.\n      Returns: { changes, lastInsertRowid, multi: false, message }. `changes` is the affected row count; `lastInsertRowid` is set after INSERT.\n  • Multi-statement script — several statements separated by ;  (e.g. seeding several CREATE TABLEs in one call). Allowed ONLY when `params` is empty or omitted; per-statement counts aren\'t available.\n      Returns: { changes: 0, lastInsertRowid: 0, multi: true, message: "Multi-statement script executed." }\n\nFor parameterized DML across many rows, call this tool once per statement — do NOT try to mix params with multi-statement.',
            parameters: {
                type: 'object',
                properties: {
                    sql: {
                        type: 'string',
                        description: 'A single SQL statement, or — when params is empty/omitted — a multi-statement script (statements separated by ;).',
                    },
                    params: {
                        type: 'array',
                        description: 'Values bound positionally to ? placeholders. Required when SQL contains placeholders. MUST be empty or omitted when SQL contains multiple statements.',
                        items: {},
                    },
                },
                required: ['sql'],
            },
        },
    },
];

const TOOL_NAMES = new Set(WEBPAGE_DB_TOOLS.map(t => t.function.name));
function isDbTool(name) {
    return TOOL_NAMES.has(name);
}

/**
 * Execute a DB tool. Same envelope shape as the multi-file executor — write
 * operations include `_action: 'webpage_db_update'` so the chat handler can
 * SSE-broadcast a "DB changed" signal (the file explorer uses this to refresh
 * the data.db size badge).
 */
async function executeDbTool(toolName, args, { webpageId, userId }) {
    if (!userId || !webpageId) {
        return { error: 'Internal: webpageId and userId required to run a DB tool.' };
    }

    if (toolName === 'webpage_db_schema') {
        try {
            const result = await webpageDbStore.schema(userId, webpageId);
            const summary = result.tables.length === 0
                ? 'Database is empty — no tables defined yet.'
                : `${result.tables.length} table${result.tables.length === 1 ? '' : 's'}: ${result.tables.map(t => t.name).join(', ')}`;
            return { ...result, message: summary };
        } catch (err) {
            return { error: `Schema lookup failed: ${err.message}` };
        }
    }

    if (toolName === 'webpage_db_query') {
        const sql = args?.sql;
        const params = Array.isArray(args?.params) ? args.params : [];
        try {
            const result = await webpageDbStore.query(userId, webpageId, sql, params);
            return {
                ...result,
                message: `Returned ${result.rows.length} row${result.rows.length === 1 ? '' : 's'}${result.truncated ? ' (truncated at 10000)' : ''}.`,
            };
        } catch (err) {
            return { error: `Query failed: ${err.message}` };
        }
    }

    if (toolName === 'webpage_db_exec') {
        const sql = args?.sql;
        const params = Array.isArray(args?.params) ? args.params : [];
        try {
            const result = await webpageDbStore.exec(userId, webpageId, sql, params);
            const msg = result.multi
                ? 'Multi-statement script executed.'
                : `OK — ${result.changes} row${result.changes === 1 ? '' : 's'} affected${result.lastInsertRowid ? `, lastInsertRowid=${result.lastInsertRowid}` : ''}.`;
            return {
                _action: 'webpage_db_update',
                ...result,
                message: msg,
            };
        } catch (err) {
            return { error: `Exec failed: ${err.message}` };
        }
    }

    return { error: `Unknown DB tool: ${toolName}` };
}

module.exports = {
    WEBPAGE_DB_TOOLS,
    executeDbTool,
    isDbTool,
};
