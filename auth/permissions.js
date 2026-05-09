/**
 * Permissions, Middleware & Config
 * 
 * RBAC system with group/role resolution, middleware factories,
 * and auth config load/save via configStore.
 */

const path = require('path');
const fs = require('fs');
const userStore = require('../stores/userStore');

// System-wide permission definitions
const SYSTEM_PERMISSIONS = [
    // ── Super ──
    { id: 'all', name: 'Full Access', description: 'Grants all permissions', group: 'super' },

    // ── Pages (non-admin) ──
    { id: 'page_chat', name: 'Chat', description: 'Access the chat interface', group: 'pages' },
    { id: 'page_settings', name: 'Settings', description: 'Access user settings page', group: 'pages' },

    // ── Admin Pages ──
    { id: 'admin_agents', name: 'All Agents', description: 'Admin: Access to all agent types', group: 'admin' },
    { id: 'admin_agents_chat', name: 'Agent', description: 'Admin: Agent configuration', group: 'admin' },
    { id: 'admin_agents_system', name: 'System Agents', description: 'Admin: System agent configuration', group: 'admin' },
    { id: 'admin_agents_pipeline', name: 'Pipeline', description: 'Admin: Pipeline configuration', group: 'admin' },
    { id: 'admin_components', name: 'Components', description: 'Admin: Component builder', group: 'admin' },
    { id: 'admin_ai_config', name: 'AI Config', description: 'Admin: AI model configuration', group: 'admin' },
    { id: 'admin_security', name: 'Security', description: 'Admin: Users, SSO, guardrails', group: 'admin' },
    { id: 'admin_monitoring', name: 'Monitoring', description: 'Admin: Usage & cost monitoring', group: 'admin' },
    { id: 'admin_compliance', name: 'Compliance', description: 'Admin: GDPR & AI Act monitoring, DSR, ROPA, audit reports', group: 'admin' },
    { id: 'admin_subscriptions', name: 'Subscriptions', description: 'Admin: Subscription management', group: 'admin' },

    // ── Actions ──
    { id: 'manage_users', name: 'Manage Users', description: 'Create, edit, and delete users', group: 'actions' },
    { id: 'manage_agents', name: 'Manage Agents', description: 'Create, edit, delete, and publish agents', group: 'actions' },
    { id: 'manage_components', name: 'Manage Components', description: 'Create and edit workflow components', group: 'actions' },
    { id: 'manage_knowledge', name: 'Manage Knowledge', description: 'Create, edit, delete, and ingest knowledge bases', group: 'actions' },
    { id: 'manage_apps', name: 'Manage Apps', description: 'Create and publish apps', group: 'actions' },
    { id: 'use_notebooks', name: 'Use Notebooks', description: 'Create, edit, and delete personal notebooks', group: 'actions' },
    // Deprecated since Phase 3: webpages access is now gated solely by the `webpages` beta
    // feature on the user's organisation. Kept in the registry for one release so existing
    // role configurations don't silently lose the entry on save.
    { id: 'use_webpages', name: 'Use Webpages (deprecated)', description: 'Deprecated — webpages access is now controlled by the `webpages` beta feature on your organisation.', group: 'actions', deprecated: true },

    // ── n8n Integration ──
    { id: 'use_n8n_tools', name: 'Use n8n Tools', description: 'Run n8n webhook workflows and inspect workflow definitions via AI', group: 'actions' },
    { id: 'modify_n8n_workflows', name: 'Modify n8n Workflows', description: 'Allow AI to create, edit, delete, activate, and execute n8n workflows on behalf of the user', group: 'actions' },
];

// ── Load org role → permissions mapping from config file ──
let _orgRolePermissions = null;
function getOrgRolePermissions() {
    if (_orgRolePermissions) return _orgRolePermissions;
    try {
        const configPath = path.join(__dirname, '..', 'config', 'orgRoles.json');
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        // Transform { role: { permissions: [...] } } → { role: [...] }
        _orgRolePermissions = {};
        for (const [role, def] of Object.entries(config)) {
            _orgRolePermissions[role] = def.permissions || [];
        }
        return _orgRolePermissions;
    } catch (err) {
        console.error('[Auth] Failed to load orgRoles.json, using empty fallback:', err.message);
        return {};
    }
}

// OAuth Provider Configurations
const OAUTH_PROVIDERS = {
    google: {
        name: 'Google',
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
        scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/presentations', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/documents', 'https://www.googleapis.com/auth/contacts', 'https://www.googleapis.com/auth/contacts.readonly']
    },
    microsoft: {
        name: 'Microsoft',
        authUrl: (tenantId) => `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/authorize`,
        tokenUrl: (tenantId) => `https://login.microsoftonline.com/${tenantId || 'common'}/oauth2/v2.0/token`,
        userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
        scopes: ['openid', 'email', 'profile', 'User.Read', 'Mail.Read', 'Mail.Send', 'Calendars.ReadWrite', 'Files.ReadWrite', 'Contacts.ReadWrite', 'OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All', 'OnlineMeetingArtifact.Read.All', 'offline_access']
    },
    nextcloud: {
        name: 'Nextcloud',
        // Dynamic URLs based on config
        scopes: []
    }
};

// Load config from persistent storage
async function loadConfig() {
    try {
        const configStore = require('../stores/configStore');
        const admin = await configStore.getConfig('admin') || { username: 'admin', passwordHash: '' };
        const oauth = await configStore.getConfig('oauth') || { nextcloudUrl: '', clientId: '', clientSecret: '' };
        const providers = await configStore.getConfig('providers') || {
            google: { clientId: '', clientSecret: '', enabled: false },
            microsoft: { clientId: '', clientSecret: '', tenantId: 'common', enabled: false }
        };
        return { admin, oauth, providers };
    } catch (err) {
        console.error('Error loading config:', err);
    }
    return {
        admin: { username: 'admin', passwordHash: '' },
        oauth: { nextcloudUrl: '', clientId: '', clientSecret: '' },
        providers: {
            google: { clientId: '', clientSecret: '', enabled: false },
            microsoft: { clientId: '', clientSecret: '', tenantId: 'common', enabled: false }
        }
    };
}

// Save config to persistent storage
function saveConfig(config) {
    try {
        const configStore = require('../stores/configStore');
        if (config.admin) configStore.setConfig('admin', config.admin);
        if (config.oauth) configStore.setConfig('oauth', config.oauth);
        if (config.providers) configStore.setConfig('providers', config.providers);
        return true;
    } catch (err) {
        console.error('Error saving config:', err);
        return false;
    }
}

// Middleware to check authentication
const { getRedis } = require('../db');
const _userExistsCache = new Map(); // in-memory fallback when Redis unavailable
const USER_CHECK_TTL = 5; // seconds
const PERM_CACHE_TTL = 30; // seconds — permission cache TTL
const _permCache = new Map(); // in-memory fallback for permission caching

const requireAuth = async (req, res, next) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    // Verify user still exists in DB (cached for 5s to avoid DB spam)
    const userId = req.session.user?.id;
    if (userId) {
        let exists = null;
        const r = getRedis();
        const cacheKey = `bf:uex:${userId}`;

        if (r) {
            try {
                const val = await r.get(cacheKey);
                if (val !== null) exists = val === '1';
            } catch (_) { /* Redis error — fall through to DB */ }
        } else {
            const cached = _userExistsCache.get(userId);
            const now = Date.now();
            if (cached && (now - cached.ts) <= USER_CHECK_TTL * 1000) {
                exists = cached.exists;
            }
        }

        if (exists === null) {
            // Cache miss — check DB
            try {
                const userStore = require('../stores/userStore');
                const user = await userStore.getUser(userId);
                exists = !!user;
                if (r) {
                    try { await r.set(cacheKey, exists ? '1' : '0', 'EX', USER_CHECK_TTL); } catch (_) { }
                } else {
                    _userExistsCache.set(userId, { exists, ts: Date.now() });
                }
            } catch (e) {
                // On DB error, allow through (don't lock out on transient failures)
                exists = true;
            }
        }

        if (!exists) {
            if (r) { try { await r.del(cacheKey); } catch (_) { } }
            else { _userExistsCache.delete(userId); }
            req.session.destroy(() => { });
            return res.status(401).json({ error: 'User no longer exists' });
        }

        // ── Revalidate isAdmin flag (prevent stale elevation after demotion) ──
        // Piggyback on the user-exists check — we already fetched the user above
        // Re-check every USER_CHECK_TTL seconds alongside the existence check
        try {
            const user = await userStore.getUser(userId);
            if (user) {
                const shouldBeAdmin = user.role === 'admin';
                if (req.session.isAdmin !== shouldBeAdmin) {
                    req.session.isAdmin = shouldBeAdmin;
                    req.session.user.role = user.role;
                    req.session.user.isAdmin = shouldBeAdmin;
                }
            }
        } catch (_) { /* DB error — don't block the request */ }
    }

    next();
};

// Helper function to get user's current permissions dynamically
// Results are cached in Redis (or in-memory fallback) for PERM_CACHE_TTL seconds.
async function getUserPermissions(userId, session = null) {
    // Admin-flagged sessions get full access
    if (session?.isAdmin) return ['all'];

    // ── Check permission cache ──
    const r = getRedis();
    const permCacheKey = `bf:perms:${userId}`;
    try {
        if (r) {
            const cached = await r.get(permCacheKey);
            if (cached) return JSON.parse(cached);
        } else {
            const cached = _permCache.get(userId);
            if (cached && (Date.now() - cached.ts) <= PERM_CACHE_TTL * 1000) {
                return cached.perms;
            }
        }
    } catch (_) { /* cache miss — resolve from DB */ }

    try {
        const user = await userStore.getUser(userId);
        if (!user) return ['page_chat']; // minimal fallback

        // Legacy: if user.role === 'admin', grant all
        if (user.role === 'admin') return ['all'];

        const permSet = new Set();

        // Resolve groups — user.groups may already be parsed to an array by getUser()
        let groupIds = [];
        if (Array.isArray(user.groups)) {
            groupIds = user.groups;
        } else {
            try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { }
        }

        const allGroups = await userStore.getAllGroups();
        const allRoles = await userStore.getAllRoles();
        const roleMap = Object.fromEntries(allRoles.map(r => [r.id, r]));

        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            if (!group) continue;

            // Add group-level permissions
            for (const p of (group.permissions || [])) permSet.add(p);

            // Resolve roles attached to the group
            for (const rid of (group.roles || [])) {
                const role = roleMap[rid];
                if (role) {
                    for (const p of (role.permissions || [])) permSet.add(p);
                }
            }
        }

        // Resolve the user's direct role field (e.g. 'admin-light')
        if (user.role && user.role !== 'admin') {
            const directRole = roleMap[user.role];
            if (directRole) {
                for (const p of (directRole.permissions || [])) permSet.add(p);
            }
        }

        // ── Organisation role → permissions mapping (loaded from config) ──
        const ORG_ROLE_PERMISSIONS = getOrgRolePermissions();

        // Legacy compatibility: accounts created before the role rename carry
        // orgRole === 'admin' instead of 'org_admin'. Many code paths already
        // accept both (see server/routes/ai/config.js requireOrgAdminForN8n),
        // but the permissions map only has 'org_admin' — resulting in zero
        // permissions for legacy admins. Normalise here.
        const normaliseOrgRole = (r) => (r === 'admin' ? 'org_admin' : r);

        // Apply user's direct orgRole
        const userOrgRole = normaliseOrgRole(user.orgRole);
        if (userOrgRole && ORG_ROLE_PERMISSIONS[userOrgRole]) {
            for (const p of ORG_ROLE_PERMISSIONS[userOrgRole]) {
                permSet.add(p);
            }
        }

        // Apply group-level orgRoles (a group can grant a role to all its members)
        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            const groupOrgRole = normaliseOrgRole(group?.orgRole);
            if (groupOrgRole && ORG_ROLE_PERMISSIONS[groupOrgRole]) {
                for (const p of ORG_ROLE_PERMISSIONS[groupOrgRole]) {
                    permSet.add(p);
                }
            }
        }

        // Short-circuit: 'all' overrides everything
        if (permSet.has('all')) return ['all'];

        // Ensure at least chat access for any authenticated user
        permSet.add('page_chat');

        const result = [...permSet];

        // ── Write to cache ──
        try {
            if (r) {
                await r.set(permCacheKey, JSON.stringify(result), 'EX', PERM_CACHE_TTL);
            } else {
                _permCache.set(userId, { perms: result, ts: Date.now() });
            }
        } catch (_) { /* cache write failure is non-fatal */ }

        return result;
    } catch (err) {
        console.error('[Auth] getUserPermissions error:', err);
        return ['page_chat'];
    }
}

/**
 * Invalidate the cached permission set for a specific user.
 * Call this after user/group/role mutations (create, update, delete).
 */
async function invalidatePermissionCache(userId) {
    if (!userId) return;
    const r = getRedis();
    if (r) {
        try { await r.del(`bf:perms:${userId}`); } catch (_) { }
    } else {
        _permCache.delete(userId);
    }
}

/**
 * Invalidate every user's cached permission set. Used on group/role mutations
 * where the affected-user set isn't easily enumerable.
 */
async function invalidateAllPermissionCaches() {
    _permCache.clear();
    const r = getRedis();
    if (!r) return;
    try {
        let cursor = '0';
        do {
            const [next, keys] = await r.scan(cursor, 'MATCH', 'bf:perms:*', 'COUNT', 200);
            cursor = next;
            if (keys.length) {
                try { await r.unlink(...keys); } catch (_) { try { await r.del(...keys); } catch (_) { } }
            }
        } while (cursor !== '0');
    } catch (err) {
        console.warn('[Auth] invalidateAllPermissionCaches scan failed:', err.message);
    }
}

// Helper to check if user has a specific permission
async function hasPermission(userId, permission, session = null) {
    const perms = await getUserPermissions(userId, session);
    return perms.includes('all') || perms.includes(permission);
}

// Middleware to check admin or manage_users permission (dynamic)
const requireAdmin = async (req, res, next) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const userId = req.session.user?.id;

    // Check dynamically if user has admin/manage_users permission
    // Pass session for backwards compatibility with isAdmin flag
    if (await hasPermission(userId, 'manage_users', req.session) || await hasPermission(userId, 'all', req.session)) {
        next();
    } else {
        res.status(403).json({ error: 'Admin access required' });
    }
};

// Middleware factory to require a specific permission
const requirePermission = (permissionId) => {
    return async (req, res, next) => {
        if (!req.session.isAuthenticated || !req.session.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }

        const userId = req.session.user?.id;

        if (await hasPermission(userId, permissionId, req.session)) {
            next();
        } else {
            res.status(403).json({ error: `Permission '${permissionId}' required` });
        }
    };
};

const requirePluginAdmin = async (req, res, next) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }
    const userId = req.session.user?.id;
    if (await hasPermission(userId, 'admin_components', req.session) || await hasPermission(userId, 'all', req.session)) {
        next();
    } else {
        res.status(403).json({ error: 'Plugin Admin access required' });
    }
};

/**
 * Helper to resolve the user's organization IDs from their session.
 * Super admins (role=admin) get null → no org filter (see everything).
 * Returns a Set of org IDs the user belongs to, or null.
 */
const resolveUserOrgIds = async (req) => {
    const userId = req.session?.user?.id;
    if (!userId) return new Set();

    // Super admin bypasses org filter
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return null;

    const myOrgIds = new Set();
    try {
        const user = await userStore.getUser(userId);
        if (!user) return myOrgIds;

        // Direct org assignment
        if (user.organizationId) myOrgIds.add(user.organizationId);

        let groupIds = [];
        if (Array.isArray(user.groups)) {
            groupIds = user.groups;
        } else {
            try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { }
        }

        const allGroups = await userStore.getAllGroups();
        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            if (group?.organizationId) myOrgIds.add(group.organizationId);
        }
    } catch (_) { }

    return myOrgIds;
};

/**
 * Shared middleware factory: require org admin access for the org
 * specified by req.params[paramName].
 * Use this across all route files instead of local copies.
 */
function requireOrgAdmin(paramName = 'id') {
    return async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        const orgId = req.params[paramName];
        if (!orgId) return res.status(400).json({ error: 'Organization ID required' });

        // Super admin — always allowed
        if (req.session.isAdmin || req.session.user?.role === 'admin') return next();

        const userId = req.session.user.id;
        if (!userId) return res.status(403).json({ error: 'Organization admin access required' });

        const user = await userStore.getUser(userId);
        if (!user || user.orgRole !== 'org_admin') {
            return res.status(403).json({ error: 'Organization admin access required' });
        }

        // Must belong to the target org
        if (user.organizationId === orgId) return next();

        // Check group-based membership as fallback
        let groupIds = [];
        if (Array.isArray(user.groups)) groupIds = user.groups;
        else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { } }

        const allGroups = await userStore.getAllGroups();
        const isMember = groupIds.some(gid => {
            const g = allGroups.find(gr => gr.id === gid);
            return g?.organizationId === orgId;
        });

        if (!isMember) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }
        next();
    };
}

module.exports = {
    SYSTEM_PERMISSIONS,
    OAUTH_PROVIDERS,
    loadConfig,
    saveConfig,
    requireAuth,
    getUserPermissions,
    hasPermission,
    requireAdmin,
    requirePermission,
    requirePluginAdmin,
    resolveUserOrgIds,
    requireOrgAdmin,
    invalidatePermissionCache,
    invalidateAllPermissionCaches
};
