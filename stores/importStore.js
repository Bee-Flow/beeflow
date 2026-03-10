/**
 * Import Store — AI-generated import scripts for monitoring dashboards
 *
 * Stores import configs, runs scripts via scriptExecutor context,
 * and encrypts imported field values with the user's DEK (same as conversations).
 *
 * Encryption: JSON structure stays readable, field VALUES are AES-256-GCM encrypted.
 */

const crypto = require('crypto');
const { Pool } = require('pg');

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

// Reuse monitoring_db pool
const monitoringPool = new Pool({
    connectionString: process.env.MONITORING_DATABASE_URL || process.env.DATABASE_URL,
});

// ── Schema ──────────────────────────────────────────────
const INIT_SQL = `
CREATE TABLE IF NOT EXISTS import_configs (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    app_source TEXT NOT NULL,
    import_script TEXT NOT NULL DEFAULT '',
    target_table TEXT,
    column_mapping JSONB DEFAULT '[]',
    last_run_at TIMESTAMPTZ,
    last_run_status TEXT DEFAULT 'never',
    last_run_result JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_configs_org ON import_configs(organization_id);
`;

let initialized = false;
async function initDB() {
    if (initialized) return;
    try {
        await monitoringPool.query(INIT_SQL);
        initialized = true;
        console.log('[ImportStore] Initialized');
    } catch (err) {
        console.error('[ImportStore] Init error:', err.message);
    }
}
initDB();

// ────────────────────────────────────────────────────────
// FIELD-LEVEL ENCRYPTION  (matches agentStore pattern)
// ────────────────────────────────────────────────────────

/**
 * Encrypt a single string value.
 * Returns JSON string: { _e: true, iv, tag, d }
 */
function encryptValue(value, encryptionKeyBase64) {
    if (!encryptionKeyBase64 || value == null) return value;
    const str = String(value);
    try {
        const key = Buffer.from(encryptionKeyBase64, 'base64');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
        let enc = cipher.update(str, 'utf8', 'hex');
        enc += cipher.final('hex');
        const tag = cipher.getAuthTag();
        return JSON.stringify({ _e: true, iv: iv.toString('hex'), tag: tag.toString('hex'), d: enc });
    } catch (err) {
        console.error('[ImportStore] Encrypt failed:', err.message);
        return value; // fallback: store plain
    }
}

/**
 * Decrypt a single value. If value isn't encrypted, returns as-is.
 */
function decryptValue(value, encryptionKeyBase64) {
    if (!encryptionKeyBase64 || value == null) return value;
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        if (!parsed._e) return value;
        const key = Buffer.from(encryptionKeyBase64, 'base64');
        const iv = Buffer.from(parsed.iv, 'hex');
        const tag = Buffer.from(parsed.tag, 'hex');
        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        let dec = decipher.update(parsed.d, 'hex', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    } catch (err) {
        // Not encrypted or wrong key
        return value;
    }
}

/** Encrypt all values in a row object. Column names stay plain. */
function encryptRow(row, encryptionKeyBase64) {
    if (!encryptionKeyBase64 || !row) return row;
    const encrypted = {};
    for (const [key, value] of Object.entries(row)) {
        encrypted[key] = encryptValue(value, encryptionKeyBase64);
    }
    return encrypted;
}

/** Decrypt all values in rows array. */
function decryptRows(rows, encryptionKeyBase64) {
    if (!encryptionKeyBase64 || !rows?.length) return rows;
    return rows.map(row => {
        const decrypted = {};
        for (const [key, value] of Object.entries(row)) {
            decrypted[key] = decryptValue(value, encryptionKeyBase64);
        }
        return decrypted;
    });
}

// ────────────────────────────────────────────────────────
// IMPORT CONFIG CRUD
// ────────────────────────────────────────────────────────

async function getImports(orgId) {
    await initDB();
    const { rows } = await monitoringPool.query(
        'SELECT * FROM import_configs WHERE organization_id = $1 ORDER BY created_at DESC', [orgId]
    );
    return rows;
}

async function getImport(id, orgId) {
    await initDB();
    const { rows } = await monitoringPool.query(
        'SELECT * FROM import_configs WHERE id = $1 AND organization_id = $2', [id, orgId]
    );
    return rows[0] || null;
}

async function createImport(orgId, userId, data) {
    await initDB();
    const id = crypto.randomUUID();
    const { rows } = await monitoringPool.query(
        `INSERT INTO import_configs (id, organization_id, created_by, name, description, app_source, import_script, target_table, column_mapping)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [id, orgId, userId, data.name, data.description || '', data.appSource, data.importScript || '', data.targetTable || null, JSON.stringify(data.columnMapping || [])]
    );
    return rows[0];
}

async function updateImport(id, orgId, data) {
    await initDB();
    const sets = [];
    const params = [id, orgId];
    let idx = 3;
    for (const [key, value] of Object.entries(data)) {
        const col = key.replace(/([A-Z])/g, '_$1').toLowerCase(); // camelCase → snake_case
        sets.push(`${col} = $${idx}`);
        params.push(typeof value === 'object' ? JSON.stringify(value) : value);
        idx++;
    }
    if (sets.length === 0) return null;
    sets.push(`updated_at = NOW()`);
    const { rows } = await monitoringPool.query(
        `UPDATE import_configs SET ${sets.join(', ')} WHERE id = $1 AND organization_id = $2 RETURNING *`, params
    );
    return rows[0] || null;
}

async function deleteImport(id, orgId) {
    await initDB();
    const config = await getImport(id, orgId);
    if (!config) return false;
    // Drop the target data table if it exists
    if (config.target_table) {
        try { await monitoringPool.query(`DROP TABLE IF EXISTS "${config.target_table}"`); } catch (e) { }
    }
    await monitoringPool.query('DELETE FROM import_configs WHERE id = $1', [id]);
    return true;
}

// ────────────────────────────────────────────────────────
// IMPORT EXECUTION
// ────────────────────────────────────────────────────────

/**
 * Run an import script. Returns { imported, status, error? }
 *
 * @param {string} configId
 * @param {object} session — Express session (has user, OAuth tokens, encryptionKey)
 * @param {object} scriptExecutor — { buildContext, executeScript } from scriptExecutor.js
 */
async function runImport(configId, session, scriptExecutor) {
    const orgs = session.user?.organizations || [];
    const orgId = orgs[0] || session.user?.id;
    const encKey = session.encryptionKey;
    const config = await getImport(configId, orgId);
    if (!config) throw new Error('Import config not found');
    if (!config.import_script) throw new Error('No import script configured');
    if (!config.target_table) throw new Error('No target table configured');

    // Build execution context (same ctx.gmail, ctx.drive, etc. as tasks)
    const pseudoTask = { id: `import-${configId}`, title: config.name, description: config.description };
    const ctx = scriptExecutor.buildContext(pseudoTask, session, true);

    // Override ledger with in-memory dedup — task_ledger has FK to tasks table
    const processed = new Set();
    ctx.ledger = {
        hasProcessed: async (itemId) => processed.has(String(itemId)),
        markProcessed: async (itemId) => { processed.add(String(itemId)); },
        filterNew: async (items, idField = 'id') => items.filter(i => !processed.has(String(i[idField]))),
    };

    // Execute the script
    let result;
    try {
        result = await scriptExecutor.executeScript(config.import_script, ctx);
    } catch (err) {
        await updateImport(configId, orgId, { lastRunAt: new Date().toISOString(), lastRunStatus: 'error', lastRunResult: { error: err.message } });
        throw new Error(`Script execution failed: ${err.message}`);
    }

    const rows = result?.rows || [];
    if (!Array.isArray(rows) || rows.length === 0) {
        await updateImport(configId, orgId, { lastRunAt: new Date().toISOString(), lastRunStatus: 'success', lastRunResult: { imported: 0 } });
        return { imported: 0, status: 'success' };
    }

    // Encrypt + insert rows (normalize keys to snake_case, auto-add missing columns)
    let imported = 0;
    const knownCols = new Set();

    for (const row of rows) {
        // Normalize keys: camelCase/PascalCase → snake_case
        const normalized = {};
        for (const [key, value] of Object.entries(row)) {
            const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '').replace(/[^a-z0-9_]/g, '_');
            normalized[snakeKey] = value;
        }

        // Auto-add any new columns to the table
        for (const col of Object.keys(normalized)) {
            if (!knownCols.has(col)) {
                try {
                    await monitoringPool.query(`ALTER TABLE "${config.target_table}" ADD COLUMN IF NOT EXISTS "${col}" TEXT`);
                } catch (e) { /* column exists */ }
                knownCols.add(col);
            }
        }

        const encrypted = encryptRow(normalized, encKey);
        const cols = Object.keys(encrypted);
        const vals = Object.values(encrypted);
        const placeholders = cols.map((_, i) => `$${i + 1}`);
        try {
            await monitoringPool.query(
                `INSERT INTO "${config.target_table}" (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
                vals
            );
            imported++;
        } catch (err) {
            console.error(`[ImportStore] Row insert failed:`, err.message);
        }
    }

    await updateImport(configId, orgId, {
        lastRunAt: new Date().toISOString(),
        lastRunStatus: 'success',
        lastRunResult: { imported, total: rows.length, log: ctx._log?.slice(-20) }
    });

    return { imported, total: rows.length, status: 'success' };
}

// ────────────────────────────────────────────────────────
// HELPER: create target table from column definitions
// ────────────────────────────────────────────────────────

async function createImportTable(orgId, columns, displayName) {
    await initDB();
    const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    const orgPrefix = orgId.replace(/-/g, '').slice(0, 8);
    const tableName = `imp_${orgPrefix}_${slug}`;

    // All columns are TEXT because values are encrypted JSON strings
    const colDefs = columns.map(c => {
        const name = c.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        return `"${name}" TEXT`;
    });
    colDefs.unshift('"id" SERIAL PRIMARY KEY');
    colDefs.push('"imported_at" TIMESTAMPTZ DEFAULT NOW()');

    await monitoringPool.query(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(', ')})`);
    return tableName;
}

// ────────────────────────────────────────────────────────
// APP SOURCE REGISTRY — available apps for import
// ────────────────────────────────────────────────────────

const APP_SOURCES = [
    { id: 'gmail', label: 'Gmail', icon: '📧', description: 'Email headers, senders, dates, response times' },
    { id: 'calendar', label: 'Google Calendar', icon: '📅', description: 'Events, attendees, durations' },
    { id: 'drive', label: 'Google Drive', icon: '📁', description: 'Files, folders, sharing, activity' },
    { id: 'sheets', label: 'Google Sheets', icon: '📊', description: 'Spreadsheet data' },
    { id: 'docs', label: 'Google Docs', icon: '📄', description: 'Document content' },
    { id: 'youtrack', label: 'YouTrack', icon: '🎯', description: 'Issues, sprints, time tracking' },
    { id: 'fireflies', label: 'Fireflies', icon: '🎙️', description: 'Meeting transcripts, summaries' },
];

module.exports = {
    getImports, getImport, createImport, updateImport, deleteImport,
    runImport, createImportTable,
    encryptValue, decryptValue, encryptRow, decryptRows,
    APP_SOURCES,
    monitoringPool,
};
