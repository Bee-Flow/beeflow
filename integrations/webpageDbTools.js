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
            description: 'List every table and view in the webpage\'s SQLite database, with their columns, types, and constraints. Call this BEFORE writing queries against unfamiliar tables — the model can\'t see the schema otherwise. Returns an empty list when the DB has no tables yet (a brand new webpage starts with an empty DB).',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_db_query',
            description: 'Run a read-only SELECT against the webpage\'s SQLite database. Returns rows + column names. Errors if the SQL would mutate the database — use webpage_db_exec for that. Result rows are capped at 10000; the response includes `truncated: true` when the cap was hit so you can refine the query.',
            parameters: {
                type: 'object',
                properties: {
                    sql: {
                        type: 'string',
                        description: 'A SELECT statement. Use ? placeholders for parameters; do NOT interpolate user-supplied values into the SQL string.',
                    },
                    params: {
                        type: 'array',
                        description: 'Optional array of values bound positionally to ? placeholders in `sql`. Strings, numbers, booleans, null. Objects/arrays are JSON-stringified.',
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
            description: 'Run a write or DDL statement against the webpage\'s SQLite database. Use this for INSERT, UPDATE, DELETE, CREATE TABLE, CREATE INDEX, ALTER TABLE, DROP, etc. Returns { changes, lastInsertRowid } for parameterized statements.\n\nMulti-statement scripts (several CREATE TABLEs separated by semicolons) are accepted ONLY when `params` is empty or omitted. For parameterized DML, send one statement per call (use this tool multiple times) or use a future batch tool.',
            parameters: {
                type: 'object',
                properties: {
                    sql: {
                        type: 'string',
                        description: 'A SQL statement (or, with no params, a multi-statement script).',
                    },
                    params: {
                        type: 'array',
                        description: 'Optional array of values bound positionally to ? placeholders in `sql`. Required when `sql` contains placeholders. Must be empty/omitted when `sql` contains multiple statements.',
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
