/**
 * Security Agent Store - PostgreSQL management for Security Agent configurations
 * Stores security agents that use Docker containers with Nuclei for automated scanning.
 */

const { run, getOne, getAll, exec } = require('../db');
const { v4: uuidv4 } = require('uuid');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS security_agent_configs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            icon TEXT DEFAULT '🛡️',
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

async function seedDefaults() {
    await initDB();
    const row = await getOne('SELECT COUNT(*) as cnt FROM security_agent_configs');
    if (row && parseInt(row.cnt) === 0) {
        let defaultPrompt = '';
        try {
            const path = require('path');
            const fs = require('fs');
            defaultPrompt = fs.readFileSync(path.join(__dirname, '..', 'security', 'system-prompt.md'), 'utf-8');
        } catch (e) { console.warn('[SecurityAgentStore] Could not load system-prompt.md:', e.message); }

        await run(`
            INSERT INTO security_agent_configs (id, name, description, icon, model, system_prompt, config, enabled)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
            uuidv4(),
            'Security Test',
            'Automated security scanner using Nuclei. Scans targets for vulnerabilities and generates comprehensive reports with severity breakdowns and remediation advice.',
            '🛡️',
            null,
            defaultPrompt,
            JSON.stringify({
                maxIterations: 30, timeout: 120000,
                defaultSeverity: 'low,medium,high,critical',
                defaultTemplates: '', rateLimitRps: 50,
                scanTimeout: 300000,
                blockedCommands: ['rm -rf /', 'shutdown', 'reboot', 'mkfs', 'dd if=', ':(){:|:&};:'],
                sandboxMode: true
            }),
            true
        ]);
        console.log('[SecurityAgentStore] Seeded default "Security Test" agent');
    }
}

initDB().then(() => seedDefaults()).catch(err => console.error('[SecurityAgentStore] Init error:', err.message));
console.log('[SecurityAgentStore] Initialized (PostgreSQL)');

async function getAllSecurityAgents() {
    await initDB();
    const rows = await getAll('SELECT * FROM security_agent_configs ORDER BY name ASC');
    return rows.map(parseRow);
}

async function getSecurityAgent(id) {
    await initDB();
    const row = await getOne('SELECT * FROM security_agent_configs WHERE id = $1', [id]);
    if (!row) return null;
    return parseRow(row);
}

async function createSecurityAgent(data) {
    await initDB();
    const id = data.id || uuidv4();
    await run(`
        INSERT INTO security_agent_configs (id, name, description, icon, model, system_prompt, config, enabled, organization_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
        id,
        data.name || 'New Security Agent',
        data.description || '',
        data.icon || '🛡️',
        data.model || null,
        data.system_prompt || '',
        JSON.stringify(data.config || getDefaultConfig()),
        data.enabled !== false,
        data.organization_id || null
    ]);
    return getSecurityAgent(id);
}

async function updateSecurityAgent(id, data) {
    await initDB();
    const existing = await getSecurityAgent(id);
    if (!existing) return null;

    try {
        const versionStore = require('./versionStore');
        await versionStore.createVersion(id, 'security_agent', existing);
    } catch (e) { console.error('[SecurityAgentStore] Version snapshot failed:', e.message); }

    await run(`
        UPDATE security_agent_configs SET
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
    return getSecurityAgent(id);
}

async function deleteSecurityAgent(id) {
    await initDB();
    await run('DELETE FROM security_agent_configs WHERE id = $1', [id]);
    return true;
}

function getDefaultConfig() {
    return {
        maxIterations: 30,
        timeout: 120000,
        defaultSeverity: 'low,medium,high,critical',
        defaultTemplates: '',
        rateLimitRps: 50,
        scanTimeout: 300000,
        blockedCommands: ['rm -rf /', 'shutdown', 'reboot', 'mkfs', 'dd if=', ':(){:|:&};:'],
        sandboxMode: true
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
    getAllSecurityAgents,
    getSecurityAgent,
    createSecurityAgent,
    updateSecurityAgent,
    deleteSecurityAgent,
    getDefaultConfig
};
