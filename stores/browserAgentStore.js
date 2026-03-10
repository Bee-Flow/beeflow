/**
 * Browser Agent Store - PostgreSQL management for Browser Use Agent configurations
 * Stores browser agents that use Playwright to autonomously control a web browser.
 */

const { run, getOne, getAll, exec } = require('../db');
const { v4: uuidv4 } = require('uuid');

// Schema init
let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS browser_agent_configs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            icon TEXT DEFAULT '🌐',
            model TEXT DEFAULT NULL,
            system_prompt TEXT DEFAULT '',
            config TEXT DEFAULT '{}',
            enabled BOOLEAN DEFAULT TRUE,
            organization_id TEXT DEFAULT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    `);
    initialized = true;
}

initDB().catch(err => console.error('[BrowserAgentStore] Init error:', err.message));
console.log('[BrowserAgentStore] Initialized (PostgreSQL)');

// ============ CRUD Functions ============

async function getAllBrowserAgents() {
    await initDB();
    const rows = await getAll('SELECT * FROM browser_agent_configs ORDER BY name ASC');
    return rows.map(parseRow);
}

async function getBrowserAgent(id) {
    await initDB();
    const row = await getOne('SELECT * FROM browser_agent_configs WHERE id = $1', [id]);
    if (!row) return null;
    return parseRow(row);
}

async function createBrowserAgent(data) {
    await initDB();
    const id = data.id || uuidv4();
    await run(`
        INSERT INTO browser_agent_configs (id, name, description, icon, model, system_prompt, config, enabled, organization_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
        id,
        data.name || 'New Browser Agent',
        data.description || '',
        data.icon || '🌐',
        data.model || null,
        data.system_prompt || '',
        JSON.stringify(data.config || getDefaultConfig()),
        data.enabled !== false,
        data.organization_id || null
    ]);
    return getBrowserAgent(id);
}

async function updateBrowserAgent(id, data) {
    await initDB();
    const existing = await getBrowserAgent(id);
    if (!existing) return null;

    try {
        const versionStore = require('./versionStore');
        await versionStore.createVersion(id, 'browser_agent', existing);
    } catch (e) { console.error('[BrowserAgentStore] Version snapshot failed:', e.message); }

    await run(`
        UPDATE browser_agent_configs SET
            name = $1, description = $2, icon = $3,
            model = $4, system_prompt = $5,
            config = $6, enabled = $7,
            organization_id = $8,
            updated_at = NOW()
        WHERE id = $9
    `, [
        data.name ?? existing.name,
        data.description ?? existing.description,
        data.icon ?? existing.icon,
        data.model !== undefined ? (data.model || null) : (existing.model || null),
        data.system_prompt !== undefined ? data.system_prompt : (existing.system_prompt || ''),
        data.config ? JSON.stringify(data.config) : JSON.stringify(existing.config),
        data.enabled !== undefined ? !!data.enabled : !!existing.enabled,
        data.organization_id !== undefined ? (data.organization_id || null) : (existing.organization_id || null),
        id
    ]);
    return getBrowserAgent(id);
}

async function deleteBrowserAgent(id) {
    await initDB();
    await run('DELETE FROM browser_agent_configs WHERE id = $1', [id]);
    return true;
}

// ============ Helpers ============

function getDefaultConfig() {
    return {
        startingUrl: '',
        maxActions: 20,
        headless: true,
        screenshotStreaming: true,
        allowedDomains: [],
        viewport: { width: 1280, height: 720 },
        timeout: 30000
    };
}

function parseRow(row) {
    return {
        ...row,
        config: safeParseJSON(row.config, getDefaultConfig()),
        enabled: !!row.enabled
    };
}

function safeParseJSON(str, fallback) {
    try { return typeof str === 'string' ? JSON.parse(str) : (str || fallback); } catch { return fallback; }
}

module.exports = {
    getAllBrowserAgents,
    getBrowserAgent,
    createBrowserAgent,
    updateBrowserAgent,
    deleteBrowserAgent,
    getDefaultConfig
};
