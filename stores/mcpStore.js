/**
 * MCP Server Store — Persistence layer for MCP server definitions
 * 
 * Stores admin-defined MCP server configurations (command, args, required env vars).
 * Tools are discovered at config time and cached. Per-user credentials are stored
 * separately via configStore.
 */

const db = require('../db');

const TABLE = 'mcp_servers';

async function initTable() {
    // Migrate: drop old HTTP-based schema if it exists (has 'url' column)
    try {
        const check = await db.getOne(
            `SELECT column_name FROM information_schema.columns WHERE table_name = '${TABLE}' AND column_name = 'url'`
        );
        if (check) {
            console.log('[MCPStore] Migrating from HTTP to stdio schema...');
            await db.exec(`DROP TABLE ${TABLE}`);
        }
    } catch (_) { /* table might not exist */ }

    await db.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            command TEXT,
            args JSONB DEFAULT '[]',
            required_credentials JSONB DEFAULT '[]',
            tools_cache JSONB DEFAULT '[]',
            enabled BOOLEAN DEFAULT true,
            status TEXT DEFAULT 'disconnected',
            error TEXT,
            transport TEXT DEFAULT 'stdio',
            url TEXT,
            category TEXT,
            description TEXT,
            icon TEXT,
            source TEXT DEFAULT 'manual',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);

    // Migrate: add new columns if they don't exist yet
    const newCols = [
        { name: 'transport', def: "TEXT DEFAULT 'stdio'" },
        { name: 'url', def: 'TEXT' },
        { name: 'category', def: 'TEXT' },
        { name: 'description', def: 'TEXT' },
        { name: 'icon', def: 'TEXT' },
        { name: 'source', def: "TEXT DEFAULT 'manual'" },
    ];
    for (const col of newCols) {
        try {
            await db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${col.name} ${col.def}`);
        } catch (_) { /* column already exists */ }
    }
    // Make command nullable (HTTP servers don't need a command)
    try {
        await db.exec(`ALTER TABLE ${TABLE} ALTER COLUMN command DROP NOT NULL`);
    } catch (_) { /* already nullable or not supported */ }

    console.log('[MCPStore] Initialized (PostgreSQL)');
}

// Initialize on load
initTable().catch(err => console.error('[MCPStore] Init error:', err.message));

/**
 * Create a new MCP server definition.
 * @param {Object} server - { id, name, command, args, required_credentials }
 * required_credentials: [{ key: 'GITHUB_TOKEN', label: 'GitHub Token', description: '...' }]
 */
async function createServer({ id, name, command, args = [], required_credentials = [], transport = 'stdio', url, category, description, icon, source = 'manual' }) {
    await db.run(
        `INSERT INTO ${TABLE} (id, name, command, args, required_credentials, transport, url, category, description, icon, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            command = EXCLUDED.command,
            args = EXCLUDED.args,
            required_credentials = EXCLUDED.required_credentials,
            transport = EXCLUDED.transport,
            url = EXCLUDED.url,
            category = EXCLUDED.category,
            description = EXCLUDED.description,
            icon = EXCLUDED.icon,
            source = EXCLUDED.source,
            updated_at = NOW()`,
        [id, name, command || null, JSON.stringify(args), JSON.stringify(required_credentials), transport, url || null, category || null, description || null, icon || null, source]
    );
}

async function getServer(id) {
    const row = await db.getOne(`SELECT * FROM ${TABLE} WHERE id = $1`, [id]);
    if (!row) return null;
    return parseRow(row);
}

async function listServers() {
    const rows = await db.getAll(`SELECT * FROM ${TABLE} ORDER BY created_at ASC`);
    return rows.map(parseRow);
}

async function getEnabledServers() {
    const rows = await db.getAll(`SELECT * FROM ${TABLE} WHERE enabled = true ORDER BY created_at ASC`);
    return rows.map(parseRow);
}

async function updateServer(id, updates) {
    const fields = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
        if (key === 'id') continue;
        const col = key === 'tools_cache' || key === 'required_credentials' || key === 'args'
            ? key : key;
        const val = (key === 'tools_cache' || key === 'required_credentials' || key === 'args')
            ? JSON.stringify(value) : value;
        fields.push(`${col} = $${idx}`);
        values.push(val);
        idx++;
    }

    if (fields.length === 0) return;
    fields.push(`updated_at = NOW()`);
    values.push(id);

    await db.run(
        `UPDATE ${TABLE} SET ${fields.join(', ')} WHERE id = $${idx}`,
        values
    );
}

async function deleteServer(id) {
    await db.run(`DELETE FROM ${TABLE} WHERE id = $1`, [id]);
}

function parseRow(row) {
    return {
        ...row,
        args: typeof row.args === 'string' ? JSON.parse(row.args) : (row.args || []),
        required_credentials: typeof row.required_credentials === 'string'
            ? JSON.parse(row.required_credentials) : (row.required_credentials || []),
        tools_cache: typeof row.tools_cache === 'string'
            ? JSON.parse(row.tools_cache) : (row.tools_cache || []),
        enabled: row.enabled !== false,
    };
}

module.exports = {
    createServer,
    getServer,
    listServers,
    getEnabledServers,
    updateServer,
    deleteServer,
};
