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
            "allowedAgentTypes" TEXT DEFAULT '[]',
            "allowedTiers" TEXT DEFAULT '[]'
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
            price REAL,
            currency TEXT DEFAULT 'EUR',
            billing_interval TEXT DEFAULT 'monthly',
            trial_days INTEGER DEFAULT 0,
            sort_order INTEGER DEFAULT 0,
            is_public BOOLEAN DEFAULT FALSE,
            stripe_price_id TEXT,
            stripe_product_id TEXT,
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
            trial_end_date TEXT,
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            payment_status TEXT DEFAULT 'none',
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS subscription_audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT NOT NULL,
            changed_by TEXT,
            old_values TEXT,
            new_values TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
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
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "allowedTiers" TEXT DEFAULT '[]'`); } catch (e) { /* column already exists */ }
    // Per-group NC integration opt-out (Fase G). Org-admin uses this to
    // disable specific Nextcloud tools for members of a group. Empty array
    // means "inherit org-wide setting".
    try { await exec(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS "disabled_integrations" TEXT DEFAULT '[]'`); } catch (e) { /* column already exists */ }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "azureUserId" TEXT`); } catch (e) { /* column already exists */ }

    // ── Nextcloud connector binding (instance ↔ org, NC uid ↔ user) ──
    // Each NC instance maps 1-op-1 to an org via ocs/v2.php/cloud/capabilities `instanceid`.
    // Auto-provisioned users carry `nc_uid` for sync + dedup; `provider` distinguishes
    // 'nextcloud_connector' from 'oauth_google' / 'local' for downstream auth flows.
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_instance_id" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_base_url" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_admin_uid" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_provisioned_at" TIMESTAMPTZ`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "connector_callback_url" TEXT`); } catch (e) { }
    try { await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orgs_nc_instance_id ON organizations ("nc_instance_id") WHERE "nc_instance_id" IS NOT NULL`); } catch (e) { }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "nc_uid" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "provider" TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "auto_provisioned" BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_users_nc_uid_org ON users ("organizationId", "nc_uid") WHERE "nc_uid" IS NOT NULL`); } catch (e) { }

    // ── NC user/group sync configuration (per org) ──
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_sync_mode" TEXT DEFAULT 'mirror_all'`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_sync_groups" TEXT DEFAULT '[]'`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_sync_excluded_groups" TEXT DEFAULT '[]'`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_new_user_default_status" TEXT DEFAULT 'active'`); } catch (e) { }
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_last_sync_at" TIMESTAMPTZ`); } catch (e) { }
    // First-run wizard flag — null until org-admin completes the App Store
    // onboarding. connectorJwt.js gates auto-provision on this so other NC
    // users wait at a "Setup in progress" screen until the admin is done.
    try { await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "nc_onboarding_completed_at" TIMESTAMPTZ`); } catch (e) { }

    // ── Pending NC bindings (deferred adoption) ──
    // When a connector bootstraps and the NC admin's email maps to an
    // existing Bee Flow org without nc_instance_id, we DO NOT bind
    // automatically — that would let an attacker hosting a fake NC adopt
    // someone else's org. Instead a pending row is created here and the
    // org-admin must explicitly approve the binding from the authenticated
    // SaaS UI.
    try {
        await exec(`CREATE TABLE IF NOT EXISTS pending_nc_bindings (
            id              TEXT PRIMARY KEY,
            org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            nc_instance_id  TEXT NOT NULL,
            nc_base_url     TEXT NOT NULL,
            nc_admin_uid    TEXT NOT NULL,
            nc_admin_email  TEXT NOT NULL,
            nc_admin_display_name TEXT,
            connector_callback_url TEXT,
            theming_name    TEXT,
            nc_version      TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at      TIMESTAMPTZ NOT NULL,
            approved_at     TIMESTAMPTZ,
            approved_by_user_id TEXT
        )`);
    } catch (e) { }
    try { await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_nc_bindings_active
        ON pending_nc_bindings (org_id, nc_instance_id) WHERE status = 'pending'`); } catch (e) { }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_pending_nc_bindings_org_status
        ON pending_nc_bindings (org_id, status)`); } catch (e) { }

    // ── Subscription schema migrations ──
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price REAL`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'EUR'`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_interval TEXT DEFAULT 'monthly'`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS trial_days INTEGER DEFAULT 0`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_price_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS stripe_product_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS trial_end_date TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT`); } catch (e) { }
    try { await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'none'`); } catch (e) { }
    try { await exec(`ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_type TEXT DEFAULT 'organization'`); } catch (e) { }
    // Auto-migrate legacy __consumer_default__ plan
    try { await exec(`UPDATE subscription_plans SET plan_type = 'consumer' WHERE name = '__consumer_default__' AND (plan_type IS NULL OR plan_type = 'organization')`); } catch (e) { }
    // Consumer subscriptions table (per-user, org-less)
    try {
        await exec(`CREATE TABLE IF NOT EXISTS consumer_subscriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT REFERENCES users(id),
            plan_id TEXT REFERENCES subscription_plans(id),
            status TEXT DEFAULT 'active',
            stripe_customer_id TEXT,
            stripe_subscription_id TEXT,
            payment_status TEXT DEFAULT 'none',
            billing_cycle_start TEXT,
            trial_end_date TEXT,
            created_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ
        )`);
    } catch (e) { }

    // ── Phase 2: Indexes on hot auth/org query paths ──────────────────────────
    // getUserByEmail() is called on every login — must be index-scanned
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(LOWER(email)) WHERE email IS NOT NULL`); } catch (e) { /* ok */ }
    // org-scoped queries (getUsersByOrg, admin lists)
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_users_org ON users("organizationId") WHERE "organizationId" IS NOT NULL AND "organizationId" != ''`); } catch (e) { /* ok */ }
    // Audit log index
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_audit_target ON subscription_audit_log(target_type, target_id)`); } catch (e) { }

    // ── License keys (signed JWT activations) ──
    try {
        await exec(`CREATE TABLE IF NOT EXISTS license_keys (
            id TEXT PRIMARY KEY,
            organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
            user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
            scope TEXT NOT NULL DEFAULT 'organization',
            raw_token TEXT NOT NULL,
            tier TEXT NOT NULL,
            issuer TEXT,
            issued_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            billing_interval TEXT NOT NULL DEFAULT 'monthly',
            last_refresh_at TIMESTAMPTZ,
            refresh_status TEXT DEFAULT 'pending',
            revoked_at TIMESTAMPTZ,
            activated_by TEXT,
            metadata TEXT DEFAULT '{}',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )`);
    } catch (e) { /* table already exists */ }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_license_keys_org ON license_keys(organization_id) WHERE organization_id IS NOT NULL`); } catch (e) { }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_license_keys_user ON license_keys(user_id) WHERE user_id IS NOT NULL`); } catch (e) { }
    try { await exec(`CREATE INDEX IF NOT EXISTS idx_license_keys_status ON license_keys(refresh_status)`); } catch (e) { }

    initialized = true;
}

initDB().catch(err => console.error('[UserStore] Init error:', err.message));

// ── Dynamic UPDATE helper ─────────────────────────────
// PG has no COALESCE(?, col) trick so we build SET clauses dynamically
function dynamicUpdate(table, id, updates, columnMapping, whereCol = 'id') {
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
    return { sql: `UPDATE ${table} SET ${setClauses.join(', ')} WHERE "${whereCol}" = $${idx}`, params };
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
               status, "activeIconPackId", "azureUserId",
               "nc_uid", "provider", "auto_provisioned"
        FROM users
    `);
    return rows.map(u => {
        return { ...u, groups: parseJSON(u.groups, []), masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK) };
    });
}

// Lightweight list that *does* include the avatar blob. Use only when callers
// need to render avatars for many users (e.g. the usage / monitoring page).
async function getAllUserAvatars() {
    await initDB();
    return getAll(`SELECT id, username, "displayName", "avatarType", avatar FROM users`);
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
    const { id, username, passwordHash, displayName, firstName, lastName, email, phone, avatar, avatarType, role, groups, orgRole, organizationId, ncUid, provider, autoProvisioned } = userData;
    const existing = await getOne('SELECT id FROM users WHERE id = $1', [id]);
    if (existing) return false;
    try {
        const mwDek = userData.masterWrappedDEK ? (typeof userData.masterWrappedDEK === 'string' ? userData.masterWrappedDEK : JSON.stringify(userData.masterWrappedDEK)) : null;
        const wDek = userData.wrappedDEK ? (typeof userData.wrappedDEK === 'string' ? userData.wrappedDEK : JSON.stringify(userData.wrappedDEK)) : null;
        await run(`INSERT INTO users (id, username, "displayName", "firstName", "lastName", email, phone, avatar, "avatarType", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt", status, "azureUserId", "nc_uid", "provider", "auto_provisioned")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [id, username, displayName || username, firstName || null, lastName || null, email || null, phone || null,
                avatar || null, avatarType || null, passwordHash, role || 'user',
                JSON.stringify(groups || []), mwDek, wDek, orgRole || '', organizationId || '',
                new Date().toISOString().split('T')[0], userData.status || 'active', userData.azureUserId || null,
                ncUid || null, provider || null, autoProvisioned ? true : false]);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function getUserByNcUid(organizationId, ncUid) {
    if (!organizationId || !ncUid) return null;
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE "organizationId" = $1 AND "nc_uid" = $2', [organizationId, ncUid]);
    if (!u) return null;
    // Match the shape produced by getUser/getUserByEmail — JSON columns are
    // parsed so callers can rely on `groups` being an array. Without this
    // ncUserGroupSync's group-diff comparisons silently rewrite every sync.
    return { ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword) };
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
            `signrequest_subdomain_user_${userId}`, `signrequest_token_user_${userId}`,
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
        ncUid: 'nc_uid', provider: 'provider', autoProvisioned: 'auto_provisioned',
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
        ncSyncGroups: parseJSON(o.nc_sync_groups, []),
        ncSyncExcludedGroups: parseJSON(o.nc_sync_excluded_groups, []),
    };
}

async function getOrganizationByNcInstanceId(ncInstanceId) {
    if (!ncInstanceId) return null;
    await initDB();
    const o = await getOne('SELECT * FROM organizations WHERE nc_instance_id = $1', [ncInstanceId]);
    return o ? parseOrg(o) : null;
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
    const { id, name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod, autoApproveSSO, enabledIntegrations, allowedDomains, ncInstanceId, ncBaseUrl, ncAdminUid, ncProvisionedAt, connectorCallbackUrl } = orgData;
    const ex = await getOne('SELECT id FROM organizations WHERE id = $1', [id]);
    if (ex) return false;
    try {
        await run(`INSERT INTO organizations (id, name, description, tagline, address, email, phone, website, kvk, vat, logo, "footerText", "defaultGroups", "allowSignup", "authMethod", "autoApproveSSO", "enabledIntegrations", "allowed_domains", "nc_instance_id", "nc_base_url", "nc_admin_uid", "nc_provisioned_at", "connector_callback_url")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
            [id, name, description || '', tagline || '', address || '', email || '', phone || '', website || '', kvk || '', vat || '', logo || '', footerText || '', JSON.stringify(defaultGroups || []), allowSignup ? '1' : '0', authMethod || null, autoApproveSSO ? '1' : '0', enabledIntegrations ? JSON.stringify(enabledIntegrations) : null, allowedDomains ? JSON.stringify(allowedDomains) : null, ncInstanceId || null, ncBaseUrl || null, ncAdminUid || null, ncProvisionedAt || null, connectorCallbackUrl || null]);
        // Auto-assign default subscription plan if one exists
        try {
            const defaultPlan = await getOne('SELECT id FROM subscription_plans WHERE is_default = TRUE LIMIT 1');
            if (defaultPlan) {
                await setOrgSubscription(id, { plan_id: defaultPlan.id, status: 'active' });
                console.log(`[UserStore] Auto-assigned default plan '${defaultPlan.id}' to new org '${id}'`);
            }
        } catch (e) { console.warn('[UserStore] Failed to auto-assign default plan:', e.message); }
        return true;
    } catch (e) { console.error(e); return false; }
}

async function updateOrganization(orgId, updates) {
    await initDB();
    const ex = await getOne('SELECT id FROM organizations WHERE id = $1', [orgId]);
    if (!ex) return false;
    const colMap = { name: 'name', description: 'description', tagline: 'tagline', address: 'address', email: 'email', phone: 'phone', website: 'website', kvk: 'kvk', vat: 'vat', logo: 'logo', footerText: 'footerText', authMethod: 'authMethod', connectorCallbackUrl: 'connector_callback_url', ncSyncMode: 'nc_sync_mode', ncNewUserDefaultStatus: 'nc_new_user_default_status', ncLastSyncAt: 'nc_last_sync_at', ncInstanceId: 'nc_instance_id', ncBaseUrl: 'nc_base_url', ncAdminUid: 'nc_admin_uid', ncProvisionedAt: 'nc_provisioned_at', ncOnboardingCompletedAt: 'nc_onboarding_completed_at' };
    const updateMap = {};
    for (const [k, v] of Object.entries(colMap)) { if (updates[k] !== undefined) updateMap[k] = updates[k]; }
    if (updates.defaultGroups !== undefined) updateMap.defaultGroups = JSON.stringify(updates.defaultGroups);
    if (updates.allowSignup !== undefined) updateMap.allowSignup = updates.allowSignup ? '1' : '0';
    if (updates.autoApproveSSO !== undefined) updateMap.autoApproveSSO = updates.autoApproveSSO ? '1' : '0';
    if (updates.enabledIntegrations !== undefined) updateMap.enabledIntegrations = updates.enabledIntegrations === null ? null : JSON.stringify(updates.enabledIntegrations);
    if (updates.allowedDomains !== undefined) updateMap.allowed_domains = updates.allowedDomains === null ? null : JSON.stringify(updates.allowedDomains);
    if (updates.ncSyncGroups !== undefined) updateMap.nc_sync_groups = JSON.stringify(updates.ncSyncGroups);
    if (updates.ncSyncExcludedGroups !== undefined) updateMap.nc_sync_excluded_groups = JSON.stringify(updates.ncSyncExcludedGroups);
    const fullColMap = { ...colMap, defaultGroups: 'defaultGroups', allowSignup: 'allowSignup', autoApproveSSO: 'autoApproveSSO', enabledIntegrations: 'enabledIntegrations', allowed_domains: 'allowed_domains', nc_sync_groups: 'nc_sync_groups', nc_sync_excluded_groups: 'nc_sync_excluded_groups' };
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

    // Knowledge bases cleanup
    try { await run('DELETE FROM knowledge_bases WHERE organization_id = $1', [orgId]); } catch (e) { }

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
// ── Pending NC bindings ───────────────────────────────────────────────────

function parsePendingBinding(row) {
    if (!row) return null;
    return {
        id: row.id,
        orgId: row.org_id,
        ncInstanceId: row.nc_instance_id,
        ncBaseUrl: row.nc_base_url,
        ncAdminUid: row.nc_admin_uid,
        ncAdminEmail: row.nc_admin_email,
        ncAdminDisplayName: row.nc_admin_display_name,
        connectorCallbackUrl: row.connector_callback_url,
        themingName: row.theming_name,
        ncVersion: row.nc_version,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        approvedAt: row.approved_at,
        approvedByUserId: row.approved_by_user_id,
    };
}

async function createPendingNcBinding(data, ttlSeconds = 1800) {
    await initDB();
    const id = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    // ON CONFLICT on the partial unique index (org_id, nc_instance_id) WHERE status='pending'.
    // PG requires repeating the index predicate for index inference.
    const sql = `
        INSERT INTO pending_nc_bindings
            (id, org_id, nc_instance_id, nc_base_url, nc_admin_uid, nc_admin_email,
             nc_admin_display_name, connector_callback_url, theming_name, nc_version, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (org_id, nc_instance_id) WHERE status = 'pending'
        DO UPDATE SET
            nc_base_url = EXCLUDED.nc_base_url,
            nc_admin_uid = EXCLUDED.nc_admin_uid,
            nc_admin_email = EXCLUDED.nc_admin_email,
            nc_admin_display_name = EXCLUDED.nc_admin_display_name,
            connector_callback_url = EXCLUDED.connector_callback_url,
            theming_name = EXCLUDED.theming_name,
            nc_version = EXCLUDED.nc_version,
            expires_at = GREATEST(pending_nc_bindings.expires_at, EXCLUDED.expires_at)
        RETURNING *
    `;
    const row = await getOne(sql, [
        id,
        data.orgId,
        data.ncInstanceId,
        data.ncBaseUrl,
        data.ncAdminUid,
        data.ncAdminEmail,
        data.ncAdminDisplayName || null,
        data.connectorCallbackUrl || null,
        data.themingName || null,
        data.ncVersion || null,
        expiresAt,
    ]);
    return parsePendingBinding(row);
}

async function getPendingNcBinding(id) {
    if (!id) return null;
    await initDB();
    const row = await getOne(`SELECT * FROM pending_nc_bindings WHERE id = $1`, [id]);
    return parsePendingBinding(row);
}

async function getPendingNcBindingForOrg(orgId) {
    if (!orgId) return null;
    await initDB();
    // Newest non-expired pending row.
    const row = await getOne(
        `SELECT * FROM pending_nc_bindings
         WHERE org_id = $1 AND status = 'pending' AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1`,
        [orgId]
    );
    return parsePendingBinding(row);
}

async function countActivePendingNcBindingsForOrg(orgId) {
    if (!orgId) return 0;
    await initDB();
    const row = await getOne(
        `SELECT COUNT(*)::int AS n FROM pending_nc_bindings
         WHERE org_id = $1 AND status = 'pending' AND expires_at > NOW()`,
        [orgId]
    );
    return row?.n || 0;
}

async function markPendingNcBindingApproved(id, userId) {
    await initDB();
    await run(
        `UPDATE pending_nc_bindings SET status = 'approved', approved_at = NOW(), approved_by_user_id = $2
         WHERE id = $1 AND status = 'pending'`,
        [id, userId || null]
    );
}

async function markPendingNcBindingDenied(id, userId) {
    await initDB();
    await run(
        `UPDATE pending_nc_bindings SET status = 'denied', approved_at = NOW(), approved_by_user_id = $2
         WHERE id = $1 AND status = 'pending'`,
        [id, userId || null]
    );
}

async function expirePendingNcBindings() {
    await initDB();
    const res = await run(
        `UPDATE pending_nc_bindings SET status = 'expired'
         WHERE status = 'pending' AND expires_at <= NOW()`
    );
    return res?.rowCount || 0;
}

async function getAllGroups() {
    await initDB();
    const rows = await getAll('SELECT * FROM groups');
    return rows.map(g => ({
        ...g,
        permissions: parseJSON(g.permissions, []),
        roles: parseJSON(g.roles, []),
        allowedAgentTypes: parseJSON(g.allowedAgentTypes, []),
        allowedTiers: parseJSON(g.allowedTiers, []),
        disabled_integrations: parseJSON(g.disabled_integrations, []),
    }));
}

async function createGroup(groupData) {
    await initDB();
    const { id, organizationId, name, description, permissions, roles, allowedAgentTypes, azureGroupId, source, lastSyncedAt, orgRole } = groupData;
    const ex = await getOne('SELECT id FROM groups WHERE id = $1', [id]);
    if (ex) return false;
    try {
        // Default groups to orgRole='member' so freshly-mirrored groups
        // immediately have a sensible role baseline. The legacy default of
        // '' meant org-admins had to manually pick a role for every synced
        // group before users in those groups could do anything.
        await run('INSERT INTO groups (id, "organizationId", name, description, permissions, roles, "userCount", "allowedAgentTypes", "azureGroupId", "source", "lastSyncedAt", "orgRole") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
            [id, organizationId || null, name, description || '', JSON.stringify(permissions || []), JSON.stringify(roles || []), 0, JSON.stringify(allowedAgentTypes || []), azureGroupId || null, source || 'manual', lastSyncedAt || null, orgRole || 'member']);
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
    if (updates.allowedTiers !== undefined) updateMap.allowedTiers = JSON.stringify(updates.allowedTiers);
    if (updates.disabledIntegrations !== undefined) updateMap.disabledIntegrations = JSON.stringify(updates.disabledIntegrations);
    const fullColMap = { ...colMap, organizationId: 'organizationId', permissions: 'permissions', roles: 'roles', allowedAgentTypes: 'allowedAgentTypes', allowedTiers: 'allowedTiers', disabledIntegrations: 'disabled_integrations' };
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

// ── App Password (Nextcloud / WebDAV) ─────────────────
// Stores `{username, password}` as encrypted JSON in users.appPassword. The username is
// the Nextcloud uid used for WebDAV Basic auth, which may differ from the BeeFlow login
// (e.g. SSO email vs Nextcloud uid). Reads tolerate the legacy plain-password format.
async function storeAppPassword(userId, username, appPassword) {
    await initDB();
    const user = await getUser(userId);
    if (!user) await createUser({ id: userId, username });
    try {
        const payload = JSON.stringify({ username, password: appPassword });
        await run('UPDATE users SET "appPassword" = $1, "appPasswordCreated" = $2 WHERE id = $3',
            [JSON.stringify(encrypt(payload)), new Date().toISOString(), userId]);
        return true;
    } catch (e) { console.error(e); return false; }
}

async function getAppPassword(userId) {
    const user = await getUser(userId);
    if (!user || !user.appPassword) return null;
    const decrypted = decrypt(user.appPassword);
    if (!decrypted) return null;
    // New format: encrypted JSON { username, password }. Legacy: encrypted password only.
    try {
        const parsed = JSON.parse(decrypted);
        if (parsed && typeof parsed === 'object' && parsed.password) {
            return {
                username: parsed.username || user.username,
                password: parsed.password,
                createdAt: user.appPasswordCreated
            };
        }
    } catch (_) { /* legacy bare-password path */ }
    return { username: user.username, password: decrypted, createdAt: user.appPasswordCreated };
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
function parsePlan(p) {
    return { ...p, allowed_features: parseJSON(p.allowed_features, []), allowed_models: parseJSON(p.allowed_models, []), max_messages_by_type: parseJSON(p.max_messages_by_type, {}), is_default: !!p.is_default, is_public: !!p.is_public, plan_type: p.plan_type || 'organization' };
}

async function getAllPlans() {
    await initDB();
    const rows = await getAll('SELECT * FROM subscription_plans ORDER BY sort_order ASC, name ASC');
    return rows.map(parsePlan);
}

async function getPlan(planId) {
    await initDB();
    const p = await getOne('SELECT * FROM subscription_plans WHERE id = $1', [planId]);
    if (!p) return null;
    return parsePlan(p);
}

async function createPlan(data) {
    await initDB();
    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
        throw new Error('Plan name is required');
    }
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    try {
        if (data.is_default) await run('UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE');
        await run(`INSERT INTO subscription_plans (id, name, description, max_messages_per_month, max_messages_by_type, max_tokens_per_month, max_cost_per_month, max_users, max_agents, max_knowledge_sources, allowed_features, allowed_models, is_default, price, currency, billing_interval, trial_days, sort_order, is_public, stripe_price_id, stripe_product_id, plan_type, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
            [id, data.name.trim(), data.description || '', data.max_messages_per_month ?? null, JSON.stringify(data.max_messages_by_type || {}),
                data.max_tokens_per_month ?? null, data.max_cost_per_month ?? null, data.max_users ?? null, data.max_agents ?? null,
                data.max_knowledge_sources ?? null, JSON.stringify(data.allowed_features || []), JSON.stringify(data.allowed_models || []),
                !!data.is_default, data.price ?? null, data.currency || 'EUR', data.billing_interval || 'monthly',
                data.trial_days ?? 0, data.sort_order ?? 0, !!data.is_public,
                data.stripe_price_id || null, data.stripe_product_id || null, data.plan_type || 'organization', now, now]);
        return parsePlan(await getOne('SELECT * FROM subscription_plans WHERE id = $1', [id]));
    } catch (e) { console.error('[UserStore] createPlan error:', e); return null; }
}

async function updatePlan(planId, data) {
    await initDB();
    if (!(await getOne('SELECT id FROM subscription_plans WHERE id = $1', [planId]))) return false;
    if (data.name !== undefined && (!data.name || typeof data.name !== 'string' || !data.name.trim())) {
        throw new Error('Plan name cannot be empty');
    }
    const now = new Date().toISOString();
    try {
        if (data.is_default) await run('UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE');
        const updateMap = {};
        if (data.name !== undefined) updateMap.name = data.name.trim();
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
        if (data.price !== undefined) updateMap.price = data.price;
        if (data.currency !== undefined) updateMap.currency = data.currency;
        if (data.billing_interval !== undefined) updateMap.billing_interval = data.billing_interval;
        if (data.trial_days !== undefined) updateMap.trial_days = data.trial_days;
        if (data.sort_order !== undefined) updateMap.sort_order = data.sort_order;
        if (data.is_public !== undefined) updateMap.is_public = !!data.is_public;
        if (data.stripe_price_id !== undefined) updateMap.stripe_price_id = data.stripe_price_id;
        if (data.stripe_product_id !== undefined) updateMap.stripe_product_id = data.stripe_product_id;
        updateMap.updated_at = now;
        if (data.plan_type !== undefined) updateMap.plan_type = data.plan_type;
        const colMap = { name: 'name', description: 'description', max_messages_per_month: 'max_messages_per_month', max_messages_by_type: 'max_messages_by_type', max_tokens_per_month: 'max_tokens_per_month', max_cost_per_month: 'max_cost_per_month', max_users: 'max_users', max_agents: 'max_agents', max_knowledge_sources: 'max_knowledge_sources', allowed_features: 'allowed_features', allowed_models: 'allowed_models', is_default: 'is_default', price: 'price', currency: 'currency', billing_interval: 'billing_interval', trial_days: 'trial_days', sort_order: 'sort_order', is_public: 'is_public', stripe_price_id: 'stripe_price_id', stripe_product_id: 'stripe_product_id', plan_type: 'plan_type', updated_at: 'updated_at' };
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
    if (data.status && !['active', 'suspended', 'cancelled', 'trialing', 'past_due'].includes(data.status)) {
        throw new Error(`Invalid subscription status: ${data.status}`);
    }
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
            if (data.trial_end_date !== undefined) updateMap.trial_end_date = data.trial_end_date;
            if (data.stripe_customer_id !== undefined) updateMap.stripe_customer_id = data.stripe_customer_id;
            if (data.stripe_subscription_id !== undefined) updateMap.stripe_subscription_id = data.stripe_subscription_id;
            if (data.payment_status !== undefined) updateMap.payment_status = data.payment_status;
            updateMap.updated_at = now;
            const colMap = { plan_id: 'plan_id', status: 'status', max_messages_per_month: 'max_messages_per_month', max_messages_by_type: 'max_messages_by_type', max_tokens_per_month: 'max_tokens_per_month', max_cost_per_month: 'max_cost_per_month', max_users: 'max_users', max_agents: 'max_agents', max_knowledge_sources: 'max_knowledge_sources', allowed_features: 'allowed_features', allowed_models: 'allowed_models', billing_cycle_start: 'billing_cycle_start', notes: 'notes', trial_end_date: 'trial_end_date', stripe_customer_id: 'stripe_customer_id', stripe_subscription_id: 'stripe_subscription_id', payment_status: 'payment_status', updated_at: 'updated_at' };
            const q = dynamicUpdate('organization_subscriptions', orgId, updateMap, colMap, 'organization_id');
            if (q) await run(q.sql, q.params);
        } else {
            const id = crypto.randomUUID();
            await run(`INSERT INTO organization_subscriptions (id, organization_id, plan_id, status, max_messages_per_month, max_messages_by_type, max_tokens_per_month, max_cost_per_month, max_users, max_agents, max_knowledge_sources, allowed_features, allowed_models, billing_cycle_start, notes, trial_end_date, stripe_customer_id, stripe_subscription_id, payment_status, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
                [id, orgId, data.plan_id || null, data.status || 'active',
                    data.max_messages_per_month ?? null, data.max_messages_by_type ? JSON.stringify(data.max_messages_by_type) : null,
                    data.max_tokens_per_month ?? null, data.max_cost_per_month ?? null, data.max_users ?? null,
                    data.max_agents ?? null, data.max_knowledge_sources ?? null,
                    data.allowed_features ? JSON.stringify(data.allowed_features) : null,
                    data.allowed_models ? JSON.stringify(data.allowed_models) : null,
                    data.billing_cycle_start || now, data.notes || '',
                    data.trial_end_date || null, data.stripe_customer_id || null,
                    data.stripe_subscription_id || null, data.payment_status || 'none', now, now]);
        }
        return true;
    } catch (e) { console.error('[UserStore] setOrgSubscription error:', e); return false; }
}

async function deleteOrgSubscription(orgId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM organization_subscriptions WHERE organization_id = $1', [orgId]);
    return rowCount > 0;
}

/**
 * Compute the billing period start/end dates for an org subscription.
 * Uses billing_cycle_start (day of month) to determine period boundaries,
 * falling back to calendar month if not set.
 */
function getBillingPeriod(sub) {
    const now = new Date();
    if (sub?.billing_cycle_start) {
        const cycleStart = new Date(sub.billing_cycle_start);
        const cycleDay = cycleStart.getDate();
        // Find current period start
        let periodStart = new Date(now.getFullYear(), now.getMonth(), cycleDay);
        if (periodStart > now) {
            // We haven't reached the cycle day this month, so period started last month
            periodStart = new Date(now.getFullYear(), now.getMonth() - 1, cycleDay);
        }
        const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, cycleDay);
        return { startDate: periodStart.toISOString(), endDate: periodEnd.toISOString() };
    }
    // Fallback: calendar month
    return {
        startDate: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
        endDate: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
    };
}

async function getEffectiveLimits(orgId) {
    const sub = await getOrgSubscription(orgId);
    if (!sub) return null;
    // Check trial: if in trial and trial hasn't expired, status is 'trialing'
    if (sub.trial_end_date) {
        const trialEnd = new Date(sub.trial_end_date);
        if (trialEnd > new Date() && sub.status === 'trialing') {
            // Trial is active — treat as active
            sub.status = 'active';
        } else if (trialEnd <= new Date() && sub.status === 'trialing') {
            // Trial expired — treat as suspended unless payment is set up
            if (sub.payment_status !== 'paid') {
                sub.status = 'suspended';
            }
        }
    }
    const plan = sub.plan_id ? await getPlan(sub.plan_id) : null;
    const LIMIT_FIELDS = ['max_messages_per_month', 'max_tokens_per_month', 'max_cost_per_month', 'max_users', 'max_agents', 'max_knowledge_sources'];
    const effective = { status: sub.status, billing_cycle_start: sub.billing_cycle_start };
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

// ── Consumer Subscriptions (per-user, org-less) ─────────────────────────────
async function getConsumerSubscription(userId) {
    await initDB();
    const s = await getOne('SELECT cs.*, sp.name as plan_name FROM consumer_subscriptions cs LEFT JOIN subscription_plans sp ON cs.plan_id = sp.id WHERE cs.user_id = $1', [userId]);
    if (!s) return null;
    return s;
}

async function setConsumerSubscription(userId, data) {
    await initDB();
    if (data.status && !['active', 'suspended', 'cancelled', 'trialing', 'past_due'].includes(data.status)) {
        throw new Error(`Invalid subscription status: ${data.status}`);
    }
    const existing = await getConsumerSubscription(userId);
    const now = new Date().toISOString();
    try {
        if (existing) {
            const updateMap = {};
            if (data.plan_id !== undefined) updateMap.plan_id = data.plan_id;
            if (data.status !== undefined) updateMap.status = data.status;
            if (data.stripe_customer_id !== undefined) updateMap.stripe_customer_id = data.stripe_customer_id;
            if (data.stripe_subscription_id !== undefined) updateMap.stripe_subscription_id = data.stripe_subscription_id;
            if (data.payment_status !== undefined) updateMap.payment_status = data.payment_status;
            if (data.billing_cycle_start !== undefined) updateMap.billing_cycle_start = data.billing_cycle_start;
            if (data.trial_end_date !== undefined) updateMap.trial_end_date = data.trial_end_date;
            updateMap.updated_at = now;
            const colMap = { plan_id: 'plan_id', status: 'status', stripe_customer_id: 'stripe_customer_id', stripe_subscription_id: 'stripe_subscription_id', payment_status: 'payment_status', billing_cycle_start: 'billing_cycle_start', trial_end_date: 'trial_end_date', updated_at: 'updated_at' };
            const q = dynamicUpdate('consumer_subscriptions', userId, updateMap, colMap, 'user_id');
            if (q) await run(q.sql, q.params);
        } else {
            const id = crypto.randomUUID();
            await run(`INSERT INTO consumer_subscriptions (id, user_id, plan_id, status, stripe_customer_id, stripe_subscription_id, payment_status, billing_cycle_start, trial_end_date, created_at, updated_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
                [id, userId, data.plan_id || null, data.status || 'active',
                    data.stripe_customer_id || null, data.stripe_subscription_id || null,
                    data.payment_status || 'none', data.billing_cycle_start || now,
                    data.trial_end_date || null, now, now]);
        }
        return true;
    } catch (e) { console.error('[UserStore] setConsumerSubscription error:', e); return false; }
}

async function deleteConsumerSubscription(userId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM consumer_subscriptions WHERE user_id = $1', [userId]);
    return rowCount > 0;
}

async function getAllConsumerSubscriptions() {
    await initDB();
    const rows = await getAll('SELECT cs.*, sp.name as plan_name, u.username, u.email, u."displayName" FROM consumer_subscriptions cs LEFT JOIN subscription_plans sp ON cs.plan_id = sp.id LEFT JOIN users u ON cs.user_id = u.id ORDER BY cs.created_at DESC');
    return rows;
}

// ── Audit Logging ─────────────────────────────
async function logSubscriptionAudit(action, targetType, targetId, changedBy, oldValues, newValues) {
    try {
        await initDB();
        const id = crypto.randomUUID();
        await run(`INSERT INTO subscription_audit_log (id, action, target_type, target_id, changed_by, old_values, new_values) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [id, action, targetType, targetId, changedBy || 'system',
                oldValues ? JSON.stringify(oldValues) : null,
                newValues ? JSON.stringify(newValues) : null]);
    } catch (e) { console.error('[UserStore] Audit log error:', e.message); }
}

async function getAuditLog(opts = {}) {
    await initDB();
    const { targetType, targetId, limit = 50, offset = 0 } = opts;
    let sql = 'SELECT * FROM subscription_audit_log';
    const params = [];
    const conditions = [];
    let idx = 1;
    if (targetType) { conditions.push(`target_type = $${idx++}`); params.push(targetType); }
    if (targetId) { conditions.push(`target_id = $${idx++}`); params.push(targetId); }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);
    const rows = await getAll(sql, params);
    return rows.map(r => ({ ...r, old_values: parseJSON(r.old_values, null), new_values: parseJSON(r.new_values, null) }));
}

module.exports = {
    getAllUsers, getAllUserAvatars, getUser, getUserByEmail, createUser, updateUser, deleteUser,
    getAllOrganizations, getOrganization, getOrganizationByNcInstanceId, createOrganization, updateOrganization, deleteOrganization,
    getUserByNcUid,
    createPendingNcBinding, getPendingNcBinding, getPendingNcBindingForOrg,
    countActivePendingNcBindingsForOrg, markPendingNcBindingApproved,
    markPendingNcBindingDenied, expirePendingNcBindings,
    getAllGroups, createGroup, updateGroup, deleteGroup, getGroupByAzureId, getUserByAzureId,
    storeAppPassword, getAppPassword, hasAppPassword, deleteAppPassword,
    getAllRoles, createRole, updateRole, deleteRole,
    getAllPlans, getPlan, createPlan, updatePlan, deletePlan,
    getAllOrgSubscriptions, getOrgSubscription, setOrgSubscription, deleteOrgSubscription, getEffectiveLimits,
    getConsumerSubscription, setConsumerSubscription, deleteConsumerSubscription, getAllConsumerSubscriptions,
    getBillingPeriod, logSubscriptionAudit, getAuditLog,
};
