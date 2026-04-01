// User store for app passwords, user management, and groups
// PostgreSQL-backed with envelope encryption

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { run, getOne, getAll, exec, getClient } = require('../db');

let initialized = false;
async function initDB() {
    if (initialized) return;
    await exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            "displayName" TEXT,
            "firstName" TEXT,
            "lastName" TEXT,
            email TEXT,
            phone TEXT,
            avatar TEXT,
            "avatarType" TEXT,
            "passwordHash" TEXT,
            role TEXT DEFAULT 'user',
            groups TEXT DEFAULT '[]',
            "masterWrappedDEK" TEXT,
            "wrappedDEK" TEXT,
            "kekSalt" TEXT,
            "recoverySalt" TEXT,
            "recoveryWrappedDEK" TEXT,
            "ssoEncryptionSetup" INTEGER DEFAULT 0,
            "passwordResetRequired" INTEGER DEFAULT 0,
            "dekUnwrapFailures" INTEGER DEFAULT 0,
            "dekLockoutUntil" TEXT,
            "appPassword" TEXT,
            "appPasswordCreated" TEXT,
            "orgRole" TEXT DEFAULT '',
            "organizationId" TEXT DEFAULT '',
            "opaqueRecord" TEXT,
            "kdfMode" TEXT DEFAULT 'legacy_argon2',
            "createdAt" TEXT,
            status TEXT DEFAULT 'active',
            "activeIconPackId" TEXT
        );

        CREATE TABLE IF NOT EXISTS organizations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            tagline TEXT,
            address TEXT,
            email TEXT,
            phone TEXT,
            website TEXT,
            kvk TEXT,
            vat TEXT,
            logo TEXT,
            "footerText" TEXT,
            "defaultGroups" TEXT DEFAULT '[]',
            "allowSignup" TEXT DEFAULT '0',
            "authMethod" TEXT,
            "autoApproveSSO" TEXT DEFAULT '0'
        );

        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT,
            name TEXT NOT NULL,
            description TEXT,
            permissions TEXT DEFAULT '[]',
            roles TEXT DEFAULT '[]',
            "userCount" INTEGER DEFAULT 0,
            "allowedAgentTypes" TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS roles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            permissions TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS subscription_plans (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            max_messages_per_month INTEGER,
            max_messages_by_type TEXT DEFAULT '{}',
            max_tokens_per_month INTEGER,
            max_cost_per_month REAL,
            max_users INTEGER,
            max_agents INTEGER,
            max_knowledge_sources INTEGER,
            allowed_features TEXT DEFAULT '[]',
            allowed_models TEXT DEFAULT '[]',
            is_default BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS organization_subscriptions (
            id TEXT PRIMARY KEY,
            organization_id TEXT REFERENCES organizations(id),
            plan_id TEXT REFERENCES subscription_plans(id),
            status TEXT DEFAULT 'active',
            max_messages_per_month INTEGER,
            max_messages_by_type TEXT,
            max_tokens_per_month INTEGER,
            max_cost_per_month REAL,
            max_users INTEGER,
            max_agents INTEGER,
            max_knowledge_sources INTEGER,
            allowed_features TEXT,
            allowed_models TEXT,
            billing_cycle_start TEXT,
            notes TEXT,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        )
    `);

    // ── Column migrations (safe for existing DBs) ─────────────────────────────
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "activeIconPackId" TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "autoApproveSSO" TEXT DEFAULT '0'`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "enabledIntegrations" TEXT DEFAULT NULL`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "allowed_domains" TEXT DEFAULT NULL`); } catch (e) { /* column already exists */ }

    // ── Azure AD Group Sync columns ──
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "azureGroupId" TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'manual'`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "lastSyncedAt" TEXT`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "orgRole" TEXT DEFAULT ''`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "azureUserId" TEXT`); } catch (e) { /* column already exists */ }

    // ── Phase 2: Indexes on hot auth/org query paths ──────────────────────────
    // getUserByEmail() is called on every login — must be index-scanned
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email)) WHERE email IS NOT NULL`); } catch (e) { /* ok */ }
    // org-scoped queries (getUsersByOrg, admin lists)
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_users_org ON users("organizationId") WHERE "organizationId" IS NOT NULL AND "organizationId" != ''`); } catch (e) { /* ok */ }

    initialized = true;
}

initDB().catch(err => console.error('[UserStore] Init error:', err.message));

// ── Dynamic UPDATE helper ─────────────────────────────
// PG has no COALESCE(?, col) trick so we build SET clauses dynamically
function dynamicUpdate(table, id, updates, columnMapping) {
    const setClauses = [];
    const params = [];
    let idx = 1;
    for (const [jsKey, dbCol] of Object.entries(columnMapping)) {
        if (updates[jsKey] !== undefined) {
            setClauses.push(`"${dbCol}" = $${idx++}`);
            params.push(updates[jsKey]);
        }
    }
    if (setClauses.length === 0) return null;
    params.push(id);
    return { sql: `UPDATE ${table} SET ${setClauses.join(', ')} WHERE id = $${idx}`, params };
}

// ── Migration from JSON ─────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const GROUPS_FILE = path.join(DATA_DIR, 'groups.json');
const ROLES_FILE = path.join(DATA_DIR, 'roles.json');

async function migrateJsonToDb() {
    await initDB();
    if (fs.existsSync(USERS_FILE)) {
        try {
            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            for (const [id, u] of Object.entries(users)) {
                const existing = await getOne('SELECT id FROM users WHERE id = $1', [id]);
                if (!existing) {
                    const mwDek = u.masterWrappedDEK ? (typeof u.masterWrappedDEK === 'string' ? u.masterWrappedDEK : JSON.stringify(u.masterWrappedDEK)) : null;
                    const wDek = u.wrappedDEK ? (typeof u.wrappedDEK === 'string' ? u.wrappedDEK : JSON.stringify(u.wrappedDEK)) : null;
                    await run(`INSERT INTO users (id, username, "displayName", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt")
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,

                        [id, u.username, u.displayName || u.username, u.passwordHash, u.role || 'user',
                            JSON.stringify(u.groups || []), mwDek, wDek, '', '',
                            u.createdAt || new Date().toISOString().split('T')[0]]);
                    if (u.appPassword) {
                        await run('UPDATE users SET "appPassword" = $1, "appPasswordCreated" = $2 WHERE id = $3',
                            [typeof u.appPassword === 'object' ? JSON.stringify(u.appPassword) : u.appPassword, u.appPasswordCreated || new Date().toISOString(), id]);
                    }
                }
            }
            fs.renameSync(USERS_FILE, `${USERS_FILE}.bak`);
            console.log('[UserStore] Migrated users.json to database');
        } catch (err) { console.error('[UserStore] Failed to migrate users.json:', err); }
    }
    if (fs.existsSync(GROUPS_FILE)) {
        try {
            const groups = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
            for (const [id, g] of Object.entries(groups)) {
                const ex = await getOne('SELECT id FROM groups WHERE id = $1', [id]);
                if (!ex) await run('INSERT INTO groups (id, "organizationId", name, description, permissions, roles, "userCount") VALUES ($1,$2,$3,$4,$5,$6,$7)',
                    [id, null, g.name, g.description || '', JSON.stringify(g.permissions || []), JSON.stringify(g.roles || []), g.userCount || 0]);
            }
            fs.renameSync(GROUPS_FILE, `${GROUPS_FILE}.bak`);
            console.log('[UserStore] Migrated groups.json to database');
        } catch (err) { console.error('[UserStore] Failed to migrate groups.json:', err); }
    }
    if (fs.existsSync(ROLES_FILE)) {
        try {
            const roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
            for (const [id, r] of Object.entries(roles)) {
                const ex = await getOne('SELECT id FROM roles WHERE id = $1', [id]);
                if (!ex) await run('INSERT INTO roles (id, name, description, permissions) VALUES ($1,$2,$3,$4)',
                    [id, r.name, r.description || '', JSON.stringify(r.permissions || [])]);
            }
            fs.renameSync(ROLES_FILE, `${ROLES_FILE}.bak`);
            console.log('[UserStore] Migrated roles.json to database');
        } catch (err) { console.error('[UserStore] Failed to migrate roles.json:', err); }
    }
}

migrateJsonToDb().catch(err => console.error('[UserStore] Migration error:', err.message));

// ── Encryption (app passwords) ─────────────────────────────
const ALGORITHM = 'aes-256-gcm';
const APP_PWD_IV_LENGTH = 12;

function getEncryptionKey() {
    const secret = process.env.MASTER_ENCRYPTION_KEY || process.env.SESSION_SECRET;
    if (!secret) throw new Error('MASTER_ENCRYPTION_KEY or SESSION_SECRET env var is required');
    return crypto.createHash('sha256').update(secret).digest();
}

function encrypt(text) {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(APP_PWD_IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex'), data: encrypted };
}

function decrypt(encrypted) {
    if (typeof encrypted === 'string') { try { encrypted = JSON.parse(encrypted); } catch (e) { return null; } }
    try {
        const key = getEncryptionKey();
        const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'hex'));
        decipher.setAuthTag(Buffer.from(encrypted.authTag, 'hex'));
        let decrypted = decipher.update(encrypted.data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) { console.error('Decryption failed:', err.message); return null; }
}

function parseJSON(str, fallback) { if (!str) return fallback; try { return JSON.parse(str); } catch (e) { return fallback; } }

// ── Users ─────────────────────────────
async function getAllUsers() {
    await initDB();
    // Phase 2: exclude avatar (base64 blob, up to 200 KB per user) from list
    // queries — callers that need the avatar should use getUser(id) instead.
    const rows = await getAll(`
        SELECT id, username, "displayName", "firstName", "lastName", email, phone,
               "avatarType", role, groups, "orgRole", "organizationId",
               "masterWrappedDEK", "wrappedDEK", "kekSalt", "recoverySalt",
               "recoveryWrappedDEK", "ssoEncryptionSetup", "passwordResetRequired",
               "dekUnwrapFailures", "dekLockoutUntil", "kdfMode", "createdAt",
               status, "activeIconPackId", "azureUserId"
        FROM users
    `);
    return rows.map(u => {
        return { ...u, groups: parseJSON(u.groups, []), masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK) };
    });
}


async function getUser(userId) {
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!u) return null;
    return {
        ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword),
        masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK),
        recoveryWrappedDEK: parseJSON(u.recoveryWrappedDEK, u.recoveryWrappedDEK),
        dekUnwrapFailures: u.dekUnwrapFailures || 0, ssoEncryptionSetup: u.ssoEncryptionSetup || 0,
        passwordResetRequired: u.passwordResetRequired || 0
    };
}

async function getUserByEmail(email) {
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!u) return null;
    return {
        ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword),
        masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK),
        recoveryWrappedDEK: parseJSON(u.recoveryWrappedDEK, u.recoveryWrappedDEK),
        dekUnwrapFailures: u.dekUnwrapFailures || 0, ssoEncryptionSetup: u.ssoEncryptionSetup || 0,
        passwordResetRequired: u.passwordResetRequired || 0
    };
}

async function createUser(userData) {
    await initDB();
    const { id, username, passwordHash, displayName, firstName, lastName, email, phone, avatar, avatarType, role, groups, orgRole, organizationId } = userData;
    const existing = await getOne('SELECT id FROM users WHERE id = $1', [id]);
    if (existing) return false;
    try {
        const mwDek = userData.masterWrappedDEK ? (typeof userData.masterWrappedDEK === 'string' ? userData.masterWrappedDEK : JSON.stringify(userData.masterWrappedDEK)) : null;
        const wDek = userData.wrappedDEK ? (typeof userData.wrappedDEK === 'string' ? userData.wrappedDEK : JSON.stringify(userData.wrappedDEK)) : null;
        await run(`INSERT INTO users (id, username, "displayName", "firstName", "lastName", email, phone, avatar, "avatarType", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt", status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [id, username, displayName || username, firstName || null, lastName || null, email || null, phone || null,
                avatar || null, avatarType || null, passwordHash, role || 'user',
                JSON.stringify(groups || []), mwDek, wDek, orgRole || '', organizationId || '',
                new Date().toISOString().split('T')[0], userData.status || 'active']);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function deleteUser(userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM users WHERE id = $1', [userId]);
    if (rowCount === 0) return false;

    console.log(`[UserStore] Cleaning up data for deleted user '${userId}'...`);
    try {
        const configStore = require('./configStore');
        const configKeys = [
            `fireflies_api_key_user_${userId}`, `youtrack_url_user_${userId}`, `youtrack_token_user_${userId}`,
            `gamma_api_key_user_${userId}`, `gads_developer_token_user_${userId}`, `gads_manager_id_user_${userId}`,
            `gads_customer_id_user_${userId}`, `enabled_apps_user_${userId}`,
        ];
        for (const key of configKeys) await configStore.deleteConfig(key);
    } catch (e) { console.error('[UserStore] Failed to clean user config keys:', e.message); }

    try { await run('DELETE FROM user_memories WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM agent_conversations WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM direct_conversations WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM execution_history WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }

    try {
        const notificationStore = require('./notificationStore');
        if (notificationStore.deleteUserNotifications) await notificationStore.deleteUserNotifications(userId);
    } catch (e) { /* PG store may not be initialized */ }

    console.log(`[UserStore] Cleanup complete for user '${userId}'`);
    return true;
}

async function updateUser(userId, updates) {
    await initDB();
    const existing = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!existing) return false;

    const serializeDek = (val) => {
        if (val === null) return null;
        if (val === undefined) return undefined;
        return typeof val === 'string' ? val : JSON.stringify(val);
    };

    // Build update map: jsKey → dbCol
    const updateMap = {};
    const colMap = {
        username: 'username', displayName: 'displayName', firstName: 'firstName', lastName: 'lastName',
        email: 'email', phone: 'phone', avatar: 'avatar', avatarType: 'avatarType',
        passwordHash: 'passwordHash', role: 'role', orgRole: 'orgRole', organizationId: 'organizationId',
        kekSalt: 'kekSalt', recoverySalt: 'recoverySalt', ssoEncryptionSetup: 'ssoEncryptionSetup',
        passwordResetRequired: 'passwordResetRequired', dekUnwrapFailures: 'dekUnwrapFailures',
        dekLockoutUntil: 'dekLockoutUntil', opaqueRecord: 'opaqueRecord', kdfMode: 'kdfMode',
        status: 'status', activeIconPackId: 'activeIconPackId', azureUserId: 'azureUserId',
    };

    for (const [jsKey, dbCol] of Object.entries(colMap)) {
        if (updates[jsKey] !== undefined) updateMap[jsKey] = updates[jsKey];
    }

    // Special serialization
    if (updates.groups !== undefined) updateMap.groups = JSON.stringify(updates.groups);
    if (updates.wrappedDEK !== undefined) updateMap.wrappedDEK = serializeDek(updates.wrappedDEK);
    if (updates.masterWrappedDEK !== undefined) updateMap.masterWrappedDEK = serializeDek(updates.masterWrappedDEK);
    if (updates.recoveryWrappedDEK !== undefined) updateMap.recoveryWrappedDEK = serializeDek(updates.recoveryWrappedDEK);

    try {
        const fullColMap = { ...colMap, groups: 'groups', wrappedDEK: 'wrappedDEK', masterWrappedDEK: 'masterWrappedDEK', recoveryWrappedDEK: 'recoveryWrappedDEK' };
        const q = dynamicUpdate('users', userId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { console.error(e); return false; }
}

// ── Organizations ─────────────────────────────
function parseOrg(o) {
    return {
        ...o,
        defaultGroups: parseJSON(o.defaultGroups, []),
        allowSignup: o.allowSignup === '1' || o.allowSignup === true,
        autoApproveSSO: o.autoApproveSSO === '1' || o.autoApproveSSO === true,
        allowedDomains: parseJSON(o.allowed_domains, []),
    };
}

async function getAllOrganizations() {
    await initDB();
    const rows = await getAll('SELECT * FROM organizations');
    return rows.map(parseOrg);
}

async function getOrganization(id) {
    await initDB();
    const o = await getOne('SELECT * FROM organizations WHERE id = $1', [id]);
    if (!o) return null;
    return parseOrg(o);
}

async function createOrganization(orgData) {
    await initDB();
    const { id, name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod, autoApproveSSO, enabledIntegrations, allowedDomains } = orgData;
    const ex = await getOne('SELECT id FROM organizations WHERE id = $1', [id]);
    if (ex) return false;
    try {
        await run(`INSERT INTO organizations (id, name, description, tagline, address, email, phone, website, kvk, vat, logo, "footerText", "defaultGroups", "allowSignup", "authMethod", "autoApproveSSO", "enabledIntegrations", "allowed_domains")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [id, name, description || '', tagline || '', address || '', email || '', phone || '', website || '', kvk || '', vat || '', logo || '', footerText || '', JSON.stringify(defaultGroups || []), allowSignup ? '1' : '0', authMethod || null, autoApproveSSO ? '1' : '0', enabledIntegrations ? JSON.stringify(enabledIntegrations) : null, allowedDomains ? JSON.stringify(allowedDomains) : null]);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function updateOrganization(orgId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM organizations WHERE id = $1', [orgId]);
    if (!ex) return false;
    const colMap = { name: 'name', description: 'description', tagline: 'tagline', address: 'address', email: 'email', phone: 'phone', website: 'website', kvk: 'kvk', vat: 'vat', logo: 'logo', footerText: 'footerText', authMethod: 'authMethod' };
    const updateMap = {};
    for (const [k, v] of Object.entries(colMap)) { if (updates[k] !== undefined) updateMap[k] = updates[k]; }
    if (updates.defaultGroups !== undefined) updateMap.defaultGroups = JSON.stringify(updates.defaultGroups);
    if (updates.allowSignup !== undefined) updateMap.allowSignup = updates.allowSignup ? '1' : '0';
    if (updates.autoApproveSSO !== undefined) updateMap.autoApproveSSO = updates.autoApproveSSO ? '1' : '0';
    if (updates.enabledIntegrations !== undefined) updateMap.enabledIntegrations = updates.enabledIntegrations === null ? null : JSON.stringify(updates.enabledIntegrations);
    if (updates.allowedDomains !== undefined) updateMap.allowed_domains = updates.allowedDomains === null ? null : JSON.stringify(updates.allowedDomains);
    const fullColMap = { ...colMap, defaultGroups: 'defaultGroups', allowSignup: 'allowSignup', autoApproveSSO: 'autoApproveSSO', enabledIntegrations: 'enabledIntegrations', allowed_domains: 'allowed_domains' };
    try {
        const q = dynamicUpdate('organizations', orgId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function deleteOrganization(orgId) {
    await initDB();
    const org = await getOne('SELECT id FROM organizations WHERE id = $1', [orgId]);
    if (!org) return false;
    console.log(`[UserStore] Deleting organization '${orgId}' and all related data...`);

    try {
        const orgUsers = await getAll('SELECT id FROM users WHERE "organizationId" = $1', [orgId]);
        for (const u of orgUsers) await deleteUser(u.id);
        if (orgUsers.length > 0) console.log(`[UserStore] Deleted ${orgUsers.length} user(s) from org '${orgId}'`);
    } catch (e) { console.error('[UserStore] Failed to delete org users:', e.message); }

    try { await run('DELETE FROM groups WHERE "organizationId" = $1', [orgId]); } catch (e) { }
    try { await run('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgId]); } catch (e) { }
    try { const configStore = require('./configStore'); await configStore.deleteConfig(`org_privacy_shield_${orgId}`); } catch (e) { }

    try {
        const orgAgents = await getAll('SELECT id FROM agents WHERE organization_id = $1', [orgId]);
        for (const agent of orgAgents) { try { await run('DELETE FROM agent_conversations WHERE agent_id = $1', [agent.id]); } catch (_) { } }
        await run('DELETE FROM agents WHERE organization_id = $1', [orgId]);
    } catch (e) { }

    try { await run('DELETE FROM swarm_configs WHERE organization_id = $1', [orgId]); } catch (e) { }
    try { await run('DELETE FROM group_chats WHERE organization_id = $1', [orgId]); } catch (e) { }

    // Tasks DB cleanup (same PG pool now)
    try { await run('DELETE FROM tasks WHERE organization_id = $1', [orgId]); } catch (e) { }
    try {
        const customTables = await getAll('SELECT table_name FROM custom_tables WHERE organization_id = $1', [orgId]);
        for (const ct of customTables) { const safeName = ct.table_name.replace(/[^a-zA-Z0-9_]/g, ''); try { await run(`DROP TABLE IF EXISTS "${safeName}"`); } catch (_) { } }
        await run('DELETE FROM custom_tables WHERE organization_id = $1', [orgId]);
    } catch (e) { }
    try {
        const dashboards = await getAll('SELECT id FROM dashboards WHERE organization_id = $1', [orgId]);
        if (dashboards.length > 0) { const ids = dashboards.map(d => d.id); await run('DELETE FROM dashboard_panels WHERE dashboard_id = ANY($1)', [ids]); }
        await run('DELETE FROM dashboards WHERE organization_id = $1', [orgId]);
    } catch (e) { }
    try { await run('DELETE FROM import_configs WHERE organization_id = $1', [orgId]); } catch (e) { }

    await run('DELETE FROM organizations WHERE id = $1', [orgId]);
    console.log(`[UserStore] Organization '${orgId}' deleted successfully`);
    return true;
}

// ── Groups ─────────────────────────────
async function getAllGroups() {
    await initDB();
    const rows = await getAll('SELECT * FROM groups');
    return rows.map(g => ({ ...g, permissions: parseJSON(g.permissions, []), roles: parseJSON(g.roles, []), allowedAgentTypes: parseJSON(g.allowedAgentTypes, []) }));
}

async function createGroup(groupData) {
    await initDB();
    const { id, organizationId, name, description, permissions, roles, allowedAgentTypes, azureGroupId, source, lastSyncedAt } = groupData;
    const ex = await getOne('SELECT id FROM groups WHERE id = $1', [id]);
    if (ex) return false;
    try {
        await run('INSERT INTO groups (id, "organizationId", name, description, permissions, roles, "userCount", "allowedAgentTypes", "azureGroupId", "source", "lastSyncedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
            [id, organizationId || null, name, description || '', JSON.stringify(permissions || []), JSON.stringify(roles || []), 0, JSON.stringify(allowedAgentTypes || []), azureGroupId || null, source || 'manual', lastSyncedAt || null]);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function updateGroup(groupId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM groups WHERE id = $1', [groupId]);
    if (!ex) return false;
    const colMap = { name: 'name', description: 'description', azureGroupId: 'azureGroupId', source: 'source', lastSyncedAt: 'lastSyncedAt', orgRole: 'orgRole' };
    const updateMap = {};
    for (const [k, v] of Object.entries(colMap)) { if (updates[k] !== undefined) updateMap[k] = updates[k]; }
    if (updates.organizationId !== undefined) updateMap.organizationId = updates.organizationId;
    if (updates.permissions !== undefined) updateMap.permissions = JSON.stringify(updates.permissions);
    if (updates.roles !== undefined) updateMap.roles = JSON.stringify(updates.roles);
    if (updates.allowedAgentTypes !== undefined) updateMap.allowedAgentTypes = JSON.stringify(updates.allowedAgentTypes);
    const fullColMap = { ...colMap, organizationId: 'organizationId', permissions: 'permissions', roles: 'roles', allowedAgentTypes: 'allowedAgentTypes' };
    try {
        const q = dynamicUpdate('groups', groupId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function deleteGroup(groupId) {
    await initDB();

    // Phase 7b: Replace 3 full-table-scan + JS loops with targeted SQL UPDATEs.
    //
    // Old approach: SELECT * FROM table → JS loop → N individual UPDATE round-trips
    // New approach: single UPDATE per table using chained REPLACE on the JSON text.
    //
    // Four REPLACE passes handle all comma-adjacency edge cases:
    //   ["a","b","c"] → delete "b" → "a","c" → ["a","c"]   (middle: fix ,,)
    //   ["a","b"]     → delete "a" → ,"b"    → ["b"]        (first: fix [,)
    //   ["a","b"]     → delete "b" → "a",    → ["a"]        (last: fix ,])
    //   ["a"]         → delete "a" → ""      → []           (only: ,] + [, both clean)

    const entry = `"${groupId}"`;       // e.g. "admins"
    const like  = `%"${groupId}"%`;     // LIKE filter — only update rows that contain it

    const replaceChain = (col) => `REPLACE(REPLACE(REPLACE(REPLACE(${col}, $1, ''), ',,', ','), ',]', ']'), '[,', '[')`;

    // Remove groupId from users.groups
    await run(`UPDATE users SET groups = ${replaceChain('groups')} WHERE groups LIKE $2`, [entry, like]);

    // Remove groupId from agents.shared_groups
    await run(`UPDATE agents SET shared_groups = ${replaceChain('shared_groups')} WHERE shared_groups LIKE $2`, [entry, like]);

    // Remove groupId from organizations.defaultGroups
    await run(`UPDATE organizations SET "defaultGroups" = ${replaceChain('"defaultGroups"')} WHERE "defaultGroups" LIKE $2`, [entry, like]);

    const { rowCount } = await run('DELETE FROM groups WHERE id = $1', [groupId]);
    return rowCount > 0;
}

// ── Azure AD Lookup Helpers ─────────────────────────────
async function getGroupByAzureId(azureGroupId) {
    await initDB();
    return await getOne('SELECT * FROM groups WHERE "azureGroupId" = $1', [azureGroupId]);
}

async function getUserByAzureId(azureUserId) {
    await initDB();
    const row = await getOne('SELECT * FROM users WHERE "azureUserId" = $1', [azureUserId]);
    if (!row) return null;
    return { ...row, groups: parseJSON(row.groups, []) };
}

async function initDefaultGroups() {
    await initDB();
    if (!(await getOne('SELECT id FROM groups WHERE id = $1', ['admins']))) await createGroup({ id: 'admins', name: 'Administrators', description: 'Full system access', permissions: ['all'] });
    if (!(await getOne('SELECT id FROM groups WHERE id = $1', ['users']))) await createGroup({ id: 'users', name: 'Users', description: 'Standard user access', permissions: ['read', 'chat'] });
}
initDefaultGroups().catch(err => console.error('[UserStore] initDefaultGroups error:', err.message));

// ── App Password (Legacy) ─────────────────────────────
async function storeAppPassword(userId, username, appPassword) {
    await initDB();
    const user = await getUser(userId);
    if (!user) await createUser({ id: userId, username });
    try { await run('UPDATE users SET "appPassword" = $1, "appPasswordCreated" = $2 WHERE id = $3', [JSON.stringify(encrypt(appPassword)), new Date().toISOString(), userId]); return true; } catch (e) { console.error(e); return false; }
}

async function getAppPassword(userId) {
    const user = await getUser(userId);
    if (!user || !user.appPassword) return null;
    return { username: user.username, password: decrypt(user.appPassword), createdAt: user.appPasswordCreated };
}

async function hasAppPassword(userId) { const user = await getUser(userId); return !!(user && user.appPassword); }

async function deleteAppPassword(userId) {
    await initDB();
    const { rowCount } = await run('UPDATE users SET "appPassword" = NULL, "appPasswordCreated" = NULL WHERE id = $1', [userId]);
    return rowCount > 0;
}

// ── Roles ─────────────────────────────
async function getAllRoles() {
    await initDB();
    const rows = await getAll('SELECT * FROM roles');
    return rows.map(r => ({ ...r, permissions: parseJSON(r.permissions, []) }));
}

async function createRole(roleData) {
    await initDB();
    const { id, name, description, permissions } = roleData;
    const ex = await getOne('SELECT id FROM roles WHERE id = $1', [id]);
    if (ex) return false;
    try { await run('INSERT INTO roles (id, name, description, permissions) VALUES ($1,$2,$3,$4)', [id, name, description || '', JSON.stringify(permissions || [])]); return true; } catch (e) { console.error(e); return false; }
}

async function updateRole(roleId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM roles WHERE id = $1', [roleId]);
    if (!ex) return false;
    const updateMap = {};
    if (updates.name !== undefined) updateMap.name = updates.name;
    if (updates.description !== undefined) updateMap.description = updates.description;
    if (updates.permissions !== undefined) updateMap.permissions = JSON.stringify(updates.permissions);
    const colMap = { name: 'name', description: 'description', permissions: 'permissions' };
    try { const q = dynamicUpdate('roles', roleId, updateMap, colMap); if (q) await run(q.sql, q.params); return true; } catch (e) { console.error(e); return false; }
}

async function deleteRole(roleId) { await initDB(); const { rowCount } = await run('DELETE FROM roles WHERE id = $1', [roleId]); return rowCount > 0; }

async function initDefaultRoles() {
    await initDB();
    const defaults = [
        { id: 'admin', name: 'Administrator', description: 'Full system access', permissions: ['all'] },
        { id: 'user', name: 'User', description: 'Standard user access', permissions: ['read', 'chat'] },
        { id: 'org_admin', name: 'Organisation Admin', description: 'Edit org settings, manage users/groups/permissions, set Privacy Shield, plus all agent permissions', permissions: ['org.manage', 'org.users', 'org.privacy_shield', 'agents.create', 'agents.edit_published', 'agents.edit_unpublished'] },
        { id: 'agent_admin', name: 'Agent Admin', description: 'Create and edit all published and unpublished agents', permissions: ['agents.create', 'agents.edit_published', 'agents.edit_unpublished'] },
        { id: 'agent_editor', name: 'Agent Editor', description: 'Create and edit all published agents', permissions: ['agents.create', 'agents.edit_published'] },
    ];
    for (const r of defaults) { if (!(await getOne('SELECT id FROM roles WHERE id = $1', [r.id]))) await createRole(r); }
}
initDefaultRoles().catch(err => console.error('[UserStore] initDefaultRoles error:', err.message));

// ── Subscription Plans ─────────────────────────────
async function getAllPlans() {
    await initDB();
    const rows = await getAll('SELECT * FROM subscription_plans ORDER BY name');
    return rows.map(p => ({ ...p, allowed_features: parseJSON(p.allowed_features, []), allowed_models: parseJSON(p.allowed_models, []), max_messages_by_type: parseJSON(p.max_messages_by_type, {}), is_default: !!p.is_default }));
}

async function getPlan(planId) {
    await initDB();
    const p = await getOne('SELECT * FROM subscription_plans WHERE id = $1', [planId]);
    if (!p) return null;
    return { ...p, allowed_features: parseJSON(p.allowed_features, []), allowed_models: parseJSON(p.allowed_models, []), max_messages_by_type: parseJSON(p.max_messages_by_type, {}), is_default: !!p.is_default };
}

async function createPlan(data) {
    await initDB();
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    try {
        if (data.is_default) await run('UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE');
        await run(`INSERT INTO subscription_plans (id, name, description, max_messages_per_month, max_messages_by_type, max_tokens_per_month, max_cost_per_month, max_users, max_agents, max_knowledge_sources, allowed_features, allowed_models, is_default, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [id, data.name, data.description || '', data.max_messages_per_month ?? null, JSON.stringify(data.max_messages_by_type || {}),
                data.max_tokens_per_month ?? null, data.max_cost_per_month ?? null, data.max_users ?? null, data.max_agents ?? null,
                data.max_knowledge_sources ?? null, JSON.stringify(data.allowed_features || []), JSON.stringify(data.allowed_models || []),
                !!data.is_default, now, now]);
        return { id, ...data, created_at: now, updated_at: now };
    } catch (e) { console.error('[UserStore] createPlan error:', e); return null; }
}

async function updatePlan(planId, data) {
    await initDB();
    if (!(await getOne('SELECT id FROM subscription_plans WHERE id = $1', [planId]))) return false;
    const now = new Date().toISOString();
    try {
        if (data.is_default) await run('UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE');
        const updateMap = {};
        if (data.name !== undefined) updateMap.name = data.name;
        if (data.description !== undefined) updateMap.description = data.description;
        if (data.max_messages_per_month !== undefined) updateMap.max_messages_per_month = data.max_messages_per_month;
        if (data.max_messages_by_type !== undefined) updateMap.max_messages_by_type = JSON.stringify(data.max_messages_by_type);
        if (data.max_tokens_per_month !== undefined) updateMap.max_tokens_per_month = data.max_tokens_per_month;
        if (data.max_cost_per_month !== undefined) updateMap.max_cost_per_month = data.max_cost_per_month;
        if (data.max_users !== undefined) updateMap.max_users = data.max_users;
        if (data.max_agents !== undefined) updateMap.max_agents = data.max_agents;
        if (data.max_knowledge_sources !== undefined) updateMap.max_knowledge_sources = data.max_knowledge_sources;
        if (data.allowed_features !== undefined) updateMap.allowed_features = JSON.stringify(data.allowed_features);
        if (data.allowed_models !== undefined) updateMap.allowed_models = JSON.stringify(data.allowed_models);
        if (data.is_default !== undefined) updateMap.is_default = !!data.is_default;
        updateMap.updated_at = now;
        const colMap = { name: 'name', description: 'description', max_messages_per_month: 'max_messages_per_month', max_messages_by_type: 'max_messages_by_type', max_tokens_per_month: 'max_tokens_per_month', max_cost_per_month: 'max_cost_per_month', max_users: 'max_users', max_agents: 'max_agents', max_knowledge_sources: 'max_knowledge_sources', allowed_features: 'allowed_features', allowed_models: 'allowed_models', is_default: 'is_default', updated_at: 'updated_at' };
        const q = dynamicUpdate('subscription_plans', planId, updateMap, colMap);
        if (q) await run(q.sql, q.params);
        return true;
    } catch (e) { console.error('[UserStore] updatePlan error:', e); return false; }
}

async function deletePlan(planId) {
    await initDB();
    await run('UPDATE organization_subscriptions SET plan_id = NULL WHERE plan_id = $1', [planId]);
    const { rowCount } = await run('DELETE FROM subscription_plans WHERE id = $1', [planId]);
    return rowCount > 0;
}

// ── Organization Subscriptions ─────────────────────────────
async function getAllOrgSubscriptions() {
    await initDB();
    const rows = await getAll('SELECT os.*, sp.name as plan_name FROM organization_subscriptions os LEFT JOIN subscription_plans sp ON os.plan_id = sp.id ORDER BY os.created_at DESC');
    return rows.map(s => ({ ...s, allowed_features: parseJSON(s.allowed_features, null), allowed_models: parseJSON(s.allowed_models, null), max_messages_by_type: parseJSON(s.max_messages_by_type, null) }));
}

async function getOrgSubscription(orgId) {
    await initDB();
    const s = await getOne('SELECT os.*, sp.name as plan_name FROM organization_subscriptions os LEFT JOIN subscription_plans sp ON os.plan_id = sp.id WHERE os.organization_id = $1', [orgId]);
    if (!s) return null;
    return { ...s, allowed_features: parseJSON(s.allowed_features, null), allowed_models: parseJSON(s.allowed_models, null), max_messages_by_type: parseJSON(s.max_messages_by_type, null) };
}

async function setOrgSubscription(orgId, data) {
    await initDB();
    const existing = await getOrgSubscription(orgId);
    const now = new Date().toISOString();
    try {
        if (existing) {
            const updateMap = {};
            if (data.plan_id !== undefined) updateMap.plan_id = data.plan_id;
            if (data.status !== undefined) updateMap.status = data.status;
            if (data.max_messages_per_month !== undefined) updateMap.max_messages_per_month = data.max_messages_per_month;
            if (data.max_messages_by_type !== undefined) updateMap.max_messages_by_type = JSON.stringify(data.max_messages_by_type);
            if (data.max_tokens_per_month !== undefined) updateMap.max_tokens_per_month = data.max_tokens_per_month;
            if (data.max_cost_per_month !== undefined) updateMap.max_cost_per_month = data.max_cost_per_month;
            if (data.max_users !== undefined) updateMap.max_users = data.max_users;
            if (data.max_agents !== undefined) updateMap.max_agents = data.max_agents;
            if (data.max_knowledge_sources !== undefined) updateMap.max_knowledge_sources = data.max_knowledge_sources;
            if (data.allowed_features !== undefined) updateMap.allowed_features = JSON.stringify(data.allowed_features);
            if (data.allowed_models !== undefined) updateMap.allowed_models = JSON.stringify(data.allowed_models);
            if (data.billing_cycle_start !== undefined) updateMap.billing_cycle_start = data.billing_cycle_start;
            if (data.notes !== undefined) updateMap.notes = data.notes;
            updateMap.updated_at = now;
            const colMap = { plan_id: 'plan_id', status: 'status', max_messages_per_month: 'max_messages_per_month', max_messages_by_type: 'max_messages_by_type', max_tokens_per_month: 'max_tokens_per_month', max_cost_per_month: 'max_cost_per_month', max_users: 'max_users', max_agents: 'max_agents', max_knowledge_sources: 'max_knowledge_sources', allowed_features: 'allowed_features', allowed_models: 'allowed_models', billing_cycle_start: 'billing_cycle_start', notes: 'notes', updated_at: 'updated_at' };
            const q = dynamicUpdate('organization_subscriptions', orgId, updateMap, colMap);
            if (q) {
                // Fix: dynamicUpdate uses id column, but org subs use organization_id
                const sql = q.sql.replace('WHERE id =', 'WHERE organization_id =');
                await run(sql, q.params);
            }
        } else {
            const id = crypto.randomUUID();
            await run(`INSERT INTO organization_subscriptions (id, organization_id, plan_id, status, max_messages_per_month, max_messages_by_type, max_tokens_per_month, max_cost_per_month, max_users, max_agents, max_knowledge_sources, allowed_features, allowed_models, billing_cycle_start, notes, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
                [id, orgId, data.plan_id || null, data.status || 'active',
                    data.max_messages_per_month ?? null, data.max_messages_by_type ? JSON.stringify(data.max_messages_by_type) : null,
                    data.max_tokens_per_month ?? null, data.max_cost_per_month ?? null, data.max_users ?? null,
                    data.max_agents ?? null, data.max_knowledge_sources ?? null,
                    data.allowed_features ? JSON.stringify(data.allowed_features) : null,
                    data.allowed_models ? JSON.stringify(data.allowed_models) : null,
                    data.billing_cycle_start || now, data.notes || '', now, now]);
        }
        return true;
    } catch (e) { console.error('[UserStore] setOrgSubscription error:', e); return false; }
}

async function deleteOrgSubscription(orgId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgId]);
    return rowCount > 0;
}

async function getEffectiveLimits(orgId) {
    const sub = await getOrgSubscription(orgId);
    if (!sub) return null;
    const plan = sub.plan_id ? await getPlan(sub.plan_id) : null;
    const LIMIT_FIELDS = ['max_messages_per_month', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources'];
    const effective = { status: sub.status };
    for (const field of LIMIT_FIELDS) {
        effective[field] = sub[field] !== null && sub[field] !== undefined ? sub[field] : (plan ? plan[field] : null);
    }
    const planByType = plan?.max_messages_by_type || {};
    const subByType = sub.max_messages_by_type || {};
    const mergedByType = { ...planByType, ...subByType };
    for (const key of Object.keys(mergedByType)) { if (mergedByType[key] === null || mergedByType[key] === undefined) delete mergedByType[key]; }
    effective.max_messages_by_type = Object.keys(mergedByType).length > 0 ? mergedByType : null;
    effective.allowed_features = sub.allowed_features || (plan ? plan.allowed_features : []);
    effective.allowed_models = sub.allowed_models || (plan ? plan.allowed_models : []);
    return effective;
}

module.exports = {
    getAllUsers, getUser, getUserByEmail, createUser, updateUser, deleteUser,
    getAllOrganizations, getOrganization, createOrganization, updateOrganization, deleteOrganization,
    getAllGroups, createGroup, updateGroup, deleteGroup, getGroupByAzureId, getUserByAzureId,
    storeAppPassword, getAppPassword, hasAppPassword, deleteAppPassword,
    getAllRoles, createRole, updateRole, deleteRole,
    getAllPlans, getPlan, createPlan, updatePlan, deletePlan,
    getAllOrgSubscriptions, getOrgSubscription, setOrgSubscription, deleteOrgSubscription, getEffectiveLimits,
};
