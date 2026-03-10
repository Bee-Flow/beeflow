/**
 * Monitoring Store — Dashboard configs + visual query builder + multi-source execution
 *
 * Data sources:
 *   'app'    → PostgreSQL beeflow_tasks (tasks, task_ledger, notifications)
 *   'usage'  → PostgreSQL beeflow_core ai_usage_log, message_feedback
 *   'custom' → PostgreSQL monitoring_db custom org tables
 */

const { Pool } = require('pg');
const crypto = require('crypto');
const { pool: corePool } = require('../db');

// ── Connections ────────────────────────────────────────
const appPool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://beeflow:beeflow@localhost:5432/beeflow_tasks',
});

const monitoringPool = new Pool({
    connectionString: process.env.MONITORING_DATABASE_URL || 'postgresql://beeflow:beeflow@localhost:5432/monitoring_db',
});

// ── Schema (monitoring_db) ──────────────────────────────
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS dashboards (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'Untitled Dashboard',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS panels (
    id TEXT PRIMARY KEY,
    dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT 'New Panel',
    visualization_type TEXT NOT NULL DEFAULT 'stat',
    data_source TEXT NOT NULL DEFAULT 'app',
    query_config JSONB DEFAULT '{}',
    grid_position JSONB NOT NULL DEFAULT '{"x":0,"y":0,"w":6,"h":4}',
    panel_config JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS custom_tables (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    table_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    columns JSONB NOT NULL DEFAULT '[]',
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(organization_id, table_name)
);

CREATE INDEX IF NOT EXISTS idx_dashboards_org ON dashboards(organization_id);
CREATE INDEX IF NOT EXISTS idx_panels_dashboard ON panels(dashboard_id);
CREATE INDEX IF NOT EXISTS idx_custom_tables_org ON custom_tables(organization_id);
`;

let initialized = false;

async function initDB() {
    if (initialized) return;
    try {
        // Migration: drop old schema that lacks required columns
        const { rows: cols } = await monitoringPool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'panels'`
        );
        const colNames = cols.map(c => c.column_name);
        if (colNames.length > 0 && (!colNames.includes('query_config') || colNames.includes('query'))) {
            console.log('[MonitoringStore] Migrating to new schema...');
            await monitoringPool.query('DROP TABLE IF EXISTS panels CASCADE');
            await monitoringPool.query('DROP TABLE IF EXISTS dashboards CASCADE');
            await monitoringPool.query('DROP TABLE IF EXISTS data_sources CASCADE');
            await monitoringPool.query('DROP TABLE IF EXISTS custom_tables CASCADE');
        }
        // Also check dashboards for organization_id
        const { rows: dCols } = await monitoringPool.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'dashboards'`
        );
        if (dCols.length > 0 && !dCols.some(c => c.column_name === 'organization_id')) {
            await monitoringPool.query('DROP TABLE IF EXISTS panels CASCADE');
            await monitoringPool.query('DROP TABLE IF EXISTS dashboards CASCADE');
        }
        await monitoringPool.query(INIT_SQL);
        initialized = true;
        console.log('[MonitoringStore] Initialized');
    } catch (err) {
        console.error('[MonitoringStore] Init failed:', err.message);
    }
}

initDB();

function generateId() { return crypto.randomUUID(); }

// ────────────────────────────────────────────────────────
// TABLE + COLUMN METADATA
// ────────────────────────────────────────────────────────

// Columns hidden from org users on usage source (no costs/tokens)
const USAGE_HIDDEN_COLUMNS = ['estimated_cost', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'organization_id'];
const APP_HIDDEN_COLUMNS = ['organization_id'];

const TABLE_REGISTRY = {
    // PostgreSQL tables
    tasks: {
        displayName: 'Tasks', source: 'app', description: 'Organisation tasks',
        columns: [
            { name: 'id', type: 'text', label: 'ID' },
            { name: 'title', type: 'text', label: 'Title' },
            { name: 'description', type: 'text', label: 'Description' },
            { name: 'status', type: 'text', label: 'Status' },
            { name: 'priority', type: 'text', label: 'Priority' },
            { name: 'type', type: 'text', label: 'Type' },
            { name: 'source', type: 'text', label: 'Source' },
            { name: 'requires_ai', type: 'boolean', label: 'Requires AI' },
            { name: 'created_by', type: 'text', label: 'Created By' },
            { name: 'created_for', type: 'text', label: 'Created For' },
            { name: 'approved_by', type: 'text', label: 'Approved By' },
            { name: 'run_count', type: 'number', label: 'Run Count' },
            { name: 'created_at', type: 'date', label: 'Created' },
            { name: 'updated_at', type: 'date', label: 'Updated' },
            { name: 'last_run_at', type: 'date', label: 'Last Run' },
            { name: 'next_run_at', type: 'date', label: 'Next Run' },
        ],
    },
    task_ledger: {
        displayName: 'Task Executions', source: 'app', description: 'Task execution history',
        columns: [
            { name: 'id', type: 'number', label: 'ID' },
            { name: 'task_id', type: 'text', label: 'Task ID' },
            { name: 'action', type: 'text', label: 'Action' },
            { name: 'processed_at', type: 'date', label: 'Processed At' },
        ],
    },
    notifications: {
        displayName: 'Notifications', source: 'app', description: 'System notifications',
        columns: [
            { name: 'id', type: 'text', label: 'ID' },
            { name: 'user_id', type: 'text', label: 'User' },
            { name: 'task_id', type: 'text', label: 'Task ID' },
            { name: 'category', type: 'text', label: 'Category' },
            { name: 'title', type: 'text', label: 'Title' },
            { name: 'message', type: 'text', label: 'Message' },
            { name: 'read', type: 'boolean', label: 'Read' },
            { name: 'created_at', type: 'date', label: 'Created' },
        ],
    },
    // Usage tables (beeflow_core)
    ai_usage_log: {
        displayName: 'AI Usage', source: 'usage', description: 'AI calls, models, agents, latency',
        columns: [
            { name: 'id', type: 'number', label: 'ID' },
            { name: 'timestamp', type: 'date', label: 'Timestamp' },
            { name: 'user_id', type: 'text', label: 'User' },
            { name: 'agent_id', type: 'text', label: 'Agent ID' },
            { name: 'agent_name', type: 'text', label: 'Agent Name' },
            { name: 'agent_type', type: 'text', label: 'Agent Type' },
            { name: 'model', type: 'text', label: 'Model' },
            { name: 'tool_name', type: 'text', label: 'Tool' },
            { name: 'source', type: 'text', label: 'Source' },
            { name: 'duration_ms', type: 'number', label: 'Duration (ms)' },
            { name: 'conversation_id', type: 'text', label: 'Conversation ID' },
        ],
    },
    message_feedback: {
        displayName: 'Feedback', source: 'usage', description: 'User feedback on AI responses',
        columns: [
            { name: 'id', type: 'text', label: 'ID' },
            { name: 'conversation_id', type: 'text', label: 'Conversation' },
            { name: 'agent_id', type: 'text', label: 'Agent ID' },
            { name: 'user_id', type: 'text', label: 'User' },
            { name: 'rating', type: 'text', label: 'Rating' },
            { name: 'comment', type: 'text', label: 'Comment' },
            { name: 'source', type: 'text', label: 'Source' },
            { name: 'created_at', type: 'date', label: 'Created' },
        ],
    },
};

async function getAvailableTables(orgId) {
    await initDB();
    const tables = Object.entries(TABLE_REGISTRY).map(([name, t]) => ({
        name, displayName: t.displayName, source: t.source,
        description: t.description, columns: t.columns,
    }));
    // Add custom tables
    const customTables = await getCustomTables(orgId);
    for (const ct of customTables) {
        tables.push({
            name: ct.table_name, displayName: ct.display_name, source: 'custom',
            description: `Custom table`,
            columns: (ct.columns || []).map(c => ({ name: c.name, type: c.type || 'text', label: c.name })),
        });
    }
    // Add import tables (import_configs is in the app database, not monitoring_db)
    try {
        const { rows: imports } = await appPool.query(
            'SELECT name, target_table, column_mapping, app_source FROM import_configs WHERE organization_id = $1 AND target_table IS NOT NULL', [orgId]
        );
        for (const imp of imports) {
            const cols = (typeof imp.column_mapping === 'string' ? JSON.parse(imp.column_mapping) : imp.column_mapping) || [];
            tables.push({
                name: imp.target_table, displayName: `📥 ${imp.name}`, source: 'import',
                description: `Imported from ${imp.app_source}`,
                columns: cols.map(c => ({ name: c.name, type: c.type || 'text', label: c.label || c.name })),
            });
        }
    } catch (e) { console.error('[MonitoringStore] Import tables query error:', e.message); }
    return tables;
}

// ────────────────────────────────────────────────────────
// VISUAL QUERY BUILDER — generates SQL from structured config
// ────────────────────────────────────────────────────────

/**
 * Build SQL from a visual query config:
 * {
 *   table: 'tasks',
 *   columns: ['status', 'priority'],  // empty = all
 *   aggregation: 'count',             // count | sum | avg | min | max | none
 *   aggregationColumn: 'id',
 *   groupBy: 'status',
 *   filters: [{ column: 'status', operator: '=', value: 'active' }],
 *   sortBy: 'count',
 *   sortDir: 'DESC',
 *   limit: 100
 * }
 */
function buildQuerySQL(queryConfig) {
    const { table, columns = [], aggregation, aggregationColumn, groupBy, filters = [], sortBy, sortDir = 'DESC', limit = 100 } = queryConfig;
    if (!table) throw new Error('Table is required');

    const tableMeta = TABLE_REGISTRY[table];
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 100), 10000);

    // Validate table name
    const safeName = table.replace(/[^a-z0-9_]/gi, '');

    let selectParts = [];
    let groupByClause = '';

    if (aggregation && aggregation !== 'none' && groupBy) {
        // Aggregated query
        const safeGroupBy = groupBy.replace(/[^a-z0-9_]/gi, '');
        const safeAggCol = (aggregationColumn || 'id').replace(/[^a-z0-9_]/gi, '');
        const aggFn = { count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[aggregation] || 'COUNT';
        const aggExpr = aggregation === 'count' ? `${aggFn}(*)` : `${aggFn}("${safeAggCol}")`;
        selectParts = [`"${safeGroupBy}"`, `${aggExpr} as "${aggregation}"`];
        groupByClause = `GROUP BY "${safeGroupBy}"`;
    } else if (aggregation && aggregation !== 'none' && !groupBy) {
        // Single aggregate (stat)
        const safeAggCol = (aggregationColumn || 'id').replace(/[^a-z0-9_]/gi, '');
        const aggFn = { count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX' }[aggregation] || 'COUNT';
        const aggExpr = aggregation === 'count' ? `${aggFn}(*)` : `${aggFn}("${safeAggCol}")`;
        selectParts = [`${aggExpr} as "value"`];
    } else {
        // Raw columns
        if (columns.length > 0) {
            selectParts = columns.map(c => `"${c.replace(/[^a-z0-9_]/gi, '')}"`);
        } else {
            // All columns from metadata (exclude hidden)
            const hidden = tableMeta?.source === 'usage' ? USAGE_HIDDEN_COLUMNS : APP_HIDDEN_COLUMNS;
            const allCols = tableMeta?.columns?.map(c => c.name) || ['*'];
            selectParts = allCols.filter(c => !hidden.includes(c)).map(c => `"${c}"`);
        }
    }

    // WHERE
    let whereClause = '';
    if (filters.length > 0) {
        const conditions = filters.filter(f => f.column && f.operator).map(f => {
            const col = f.column.replace(/[^a-z0-9_]/gi, '');
            const op = { '=': '=', '!=': '!=', '>': '>', '<': '<', '>=': '>=', '<=': '<=', 'like': 'LIKE', 'not_null': 'IS NOT NULL', 'is_null': 'IS NULL' }[f.operator] || '=';
            if (op === 'IS NOT NULL' || op === 'IS NULL') return `"${col}" ${op}`;
            const val = String(f.value || '').replace(/'/g, "''");
            return `"${col}" ${op} '${val}'`;
        });
        if (conditions.length > 0) whereClause = `WHERE ${conditions.join(' AND ')}`;
    }

    // ORDER BY
    let orderClause = '';
    if (sortBy) {
        const safeSort = sortBy.replace(/[^a-z0-9_]/gi, '');
        const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';
        orderClause = `ORDER BY "${safeSort}" ${dir}`;
    }

    const sql = `SELECT ${selectParts.join(', ')} FROM "${safeName}" ${whereClause} ${groupByClause} ${orderClause} LIMIT ${safeLimit}`;
    return sql.replace(/\s+/g, ' ').trim();
}

// ────────────────────────────────────────────────────────
// QUERY EXECUTION — multi-source, org-scoped
// ────────────────────────────────────────────────────────

async function executeQueryConfig(orgId, queryConfig, encryptionKey = null) {
    const sql = buildQuerySQL(queryConfig);
    const tableMeta = TABLE_REGISTRY[queryConfig.table];
    const dataSource = tableMeta?.source || 'custom';
    return executeQuery(orgId, sql, dataSource, encryptionKey, queryConfig.table);
}

async function executeQuery(orgId, sql, dataSource = 'app', encryptionKey = null, tableName = null) {
    await initDB();

    let safeSql = sql.trim();
    if (safeSql.endsWith(';')) safeSql = safeSql.slice(0, -1);

    // Check if querying an encrypted import table
    const isImportTable = tableName?.startsWith('imp_');

    // ── PostgreSQL usage source (beeflow_core) ──
    if (dataSource === 'usage') {
        const client = await corePool.connect();
        try {
            await client.query('BEGIN READ ONLY');
            await client.query('SET statement_timeout = 10000');

            const safeOrgId = orgId.replace(/'/g, "''");
            const finalSql = `
                WITH ai_usage_log AS (
                    SELECT id, timestamp, user_id, agent_id, agent_name, agent_type, model, tool_name, source, duration_ms, conversation_id
                    FROM ai_usage_log WHERE organization_id = '${safeOrgId}' OR organization_id IS NULL
                ),
                message_feedback AS (
                    SELECT id, conversation_id, message_id, agent_id, user_id, rating, comment, source, created_at
                    FROM message_feedback WHERE organization_id = '${safeOrgId}' OR organization_id IS NULL
                )
                ${safeSql}
            `;

            const result = await client.query(finalSql);
            await client.query('COMMIT');

            const rows = result.rows;
            if (rows.length === 0) return { columns: [], rows: [], rowCount: 0 };
            const columns = result.fields
                .filter(f => !USAGE_HIDDEN_COLUMNS.includes(f.name))
                .map(f => ({ name: f.name, dataTypeID: f.dataTypeID }));
            const cleanRows = rows.map(r => {
                const clean = {};
                for (const col of columns) clean[col.name] = r[col.name];
                return clean;
            });
            return { columns, rows: cleanRows, rowCount: cleanRows.length };
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (_) { }
            throw new Error(`Query error: ${err.message}`);
        } finally {
            client.release();
        }
    }

    // ── PostgreSQL sources ──
    const pool = dataSource === 'custom' ? monitoringPool : appPool;
    const client = await pool.connect();
    try {
        await client.query('BEGIN READ ONLY');
        await client.query('SET statement_timeout = 10000');

        let finalSql;
        if (dataSource === 'app') {
            const safeOrgId = orgId.replace(/'/g, "''");
            finalSql = `
                WITH tasks AS (
                    SELECT * FROM tasks WHERE organization_id = '${safeOrgId}' OR organization_id IS NULL
                ),
                task_ledger AS (
                    SELECT tl.* FROM task_ledger tl
                    JOIN tasks t ON tl.task_id::text = t.id::text
                ),
                notifications AS (
                    SELECT * FROM notifications
                )
                ${safeSql}
            `;
        } else {
            finalSql = safeSql;
        }

        const result = await client.query(finalSql);
        await client.query('COMMIT');

        let rows = result.rows;

        // Decrypt imported table field values
        if (isImportTable && encryptionKey && rows.length > 0) {
            try {
                const { decryptRows } = require('./importStore');
                rows = decryptRows(rows, encryptionKey);
            } catch (e) {
                console.error('[MonitoringStore] Decryption error:', e.message);
            }
        }

        return {
            columns: result.fields.map(f => ({ name: f.name, dataTypeID: f.dataTypeID })),
            rows,
            rowCount: result.rowCount,
        };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        throw err;
    } finally {
        client.release();
    }
}

// ────────────────────────────────────────────────────────
// DASHBOARDS
// ────────────────────────────────────────────────────────

async function getDashboards(orgId) {
    await initDB();
    const { rows } = await monitoringPool.query(
        'SELECT * FROM dashboards WHERE organization_id = $1 ORDER BY updated_at DESC', [orgId]
    );
    return rows;
}

async function getDashboard(id, orgId) {
    await initDB();
    const { rows } = await monitoringPool.query(
        'SELECT * FROM dashboards WHERE id = $1 AND organization_id = $2', [id, orgId]
    );
    return rows[0] || null;
}

async function getDashboardWithPanels(id, orgId) {
    await initDB();
    const dashboard = await getDashboard(id, orgId);
    if (!dashboard) return null;
    const { rows: panels } = await monitoringPool.query(
        'SELECT * FROM panels WHERE dashboard_id = $1 ORDER BY created_at ASC', [id]
    );
    return { ...dashboard, panels };
}

async function createDashboard(userId, orgId, name = 'Untitled Dashboard') {
    await initDB();
    const id = generateId();
    const { rows } = await monitoringPool.query(
        'INSERT INTO dashboards (id, user_id, organization_id, name) VALUES ($1, $2, $3, $4) RETURNING *',
        [id, userId, orgId, name]
    );
    return rows[0];
}

async function updateDashboard(id, orgId, updates) {
    await initDB();
    const fields = []; const values = []; let idx = 1;
    if (updates.name !== undefined) { fields.push(`name = $${idx++}`); values.push(updates.name); }
    fields.push('updated_at = NOW()');
    if (fields.length === 1) return getDashboard(id, orgId);
    values.push(id, orgId);
    const { rows } = await monitoringPool.query(
        `UPDATE dashboards SET ${fields.join(', ')} WHERE id = $${idx++} AND organization_id = $${idx++} RETURNING *`, values
    );
    return rows[0] || null;
}

async function deleteDashboard(id, orgId) {
    await initDB();
    const { rowCount } = await monitoringPool.query(
        'DELETE FROM dashboards WHERE id = $1 AND organization_id = $2', [id, orgId]
    );
    return rowCount > 0;
}

// ────────────────────────────────────────────────────────
// PANELS
// ────────────────────────────────────────────────────────

async function createPanel(dashboardId, orgId, data = {}) {
    await initDB();
    const dashboard = await getDashboard(dashboardId, orgId);
    if (!dashboard) throw new Error('Dashboard not found');
    const id = generateId();
    const { rows } = await monitoringPool.query(
        `INSERT INTO panels (id, dashboard_id, title, visualization_type, data_source, query_config, grid_position, panel_config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id, dashboardId, data.title || 'New Panel', data.visualizationType || 'stat',
            data.dataSource || 'app', JSON.stringify(data.queryConfig || {}),
            JSON.stringify(data.gridPosition || { x: 0, y: 0, w: 6, h: 4 }),
            JSON.stringify(data.panelConfig || {})]
    );
    await monitoringPool.query('UPDATE dashboards SET updated_at = NOW() WHERE id = $1', [dashboardId]);
    return rows[0];
}

async function updatePanel(id, orgId, updates) {
    await initDB();
    const { rows: check } = await monitoringPool.query(
        `SELECT p.id FROM panels p JOIN dashboards d ON p.dashboard_id = d.id
         WHERE p.id = $1 AND d.organization_id = $2`, [id, orgId]
    );
    if (check.length === 0) throw new Error('Panel not found');
    const fields = []; const values = []; let idx = 1;
    if (updates.title !== undefined) { fields.push(`title = $${idx++}`); values.push(updates.title); }
    if (updates.visualizationType !== undefined) { fields.push(`visualization_type = $${idx++}`); values.push(updates.visualizationType); }
    if (updates.dataSource !== undefined) { fields.push(`data_source = $${idx++}`); values.push(updates.dataSource); }
    if (updates.queryConfig !== undefined) { fields.push(`query_config = $${idx++}`); values.push(JSON.stringify(updates.queryConfig)); }
    if (updates.gridPosition !== undefined) { fields.push(`grid_position = $${idx++}`); values.push(JSON.stringify(updates.gridPosition)); }
    if (updates.panelConfig !== undefined) { fields.push(`panel_config = $${idx++}`); values.push(JSON.stringify(updates.panelConfig)); }
    if (fields.length === 0) return null;
    values.push(id);
    const { rows } = await monitoringPool.query(
        `UPDATE panels SET ${fields.join(', ')} WHERE id = $${idx++} RETURNING *`, values
    );
    return rows[0] || null;
}

async function deletePanel(id, orgId) {
    await initDB();
    const { rowCount } = await monitoringPool.query(
        `DELETE FROM panels p USING dashboards d
         WHERE p.id = $1 AND p.dashboard_id = d.id AND d.organization_id = $2`, [id, orgId]
    );
    return rowCount > 0;
}

async function updateLayout(dashboardId, orgId, positions) {
    await initDB();
    const dashboard = await getDashboard(dashboardId, orgId);
    if (!dashboard) throw new Error('Dashboard not found');
    const client = await monitoringPool.connect();
    try {
        await client.query('BEGIN');
        for (const pos of positions) {
            await client.query('UPDATE panels SET grid_position = $1 WHERE id = $2 AND dashboard_id = $3',
                [JSON.stringify(pos.gridPosition), pos.id, dashboardId]);
        }
        await client.query('UPDATE dashboards SET updated_at = NOW() WHERE id = $1', [dashboardId]);
        await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
}

// ────────────────────────────────────────────────────────
// CUSTOM ORG TABLES  (monitoring_db)
// ────────────────────────────────────────────────────────

async function getCustomTables(orgId) {
    await initDB();
    const { rows } = await monitoringPool.query(
        'SELECT * FROM custom_tables WHERE organization_id = $1 ORDER BY created_at DESC', [orgId]
    );
    return rows;
}

async function createCustomTable(orgId, userId, displayName, columns) {
    await initDB();
    const id = generateId();
    const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const orgPrefix = orgId.replace(/-/g, '').slice(0, 8);
    const tableName = `org_${orgPrefix}_${slug}`;
    const colDefs = columns.map(c => {
        const name = c.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        const type = ({ text: 'TEXT', number: 'NUMERIC', date: 'TIMESTAMPTZ', boolean: 'BOOLEAN' })[c.type] || 'TEXT';
        return `"${name}" ${type}`;
    });
    colDefs.unshift('"id" SERIAL PRIMARY KEY');
    colDefs.push('"created_at" TIMESTAMPTZ DEFAULT NOW()');
    await monitoringPool.query(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(', ')})`);
    const { rows } = await monitoringPool.query(
        `INSERT INTO custom_tables (id, organization_id, table_name, display_name, columns, created_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, orgId, tableName, displayName, JSON.stringify(columns), userId]
    );
    return rows[0];
}

async function deleteCustomTable(id, orgId) {
    await initDB();
    const { rows } = await monitoringPool.query(
        'SELECT table_name FROM custom_tables WHERE id = $1 AND organization_id = $2', [id, orgId]
    );
    if (rows.length === 0) return false;
    await monitoringPool.query(`DROP TABLE IF EXISTS "${rows[0].table_name}"`);
    await monitoringPool.query('DELETE FROM custom_tables WHERE id = $1', [id]);
    return true;
}

module.exports = {
    getDashboards, getDashboard, getDashboardWithPanels,
    createDashboard, updateDashboard, deleteDashboard,
    createPanel, updatePanel, deletePanel, updateLayout,
    getCustomTables, createCustomTable, deleteCustomTable,
    getAvailableTables, executeQuery, executeQueryConfig, buildQuerySQL,
    monitoringPool, appPool,
};
