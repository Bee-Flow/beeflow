/**
 * Permissions, Middleware & Config
 * 
 * RBAC system with group/role resolution, middleware factories,
 * and auth config load/save via configStore.
 */

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
    { id: 'admin_agents_swarm', name: 'Swarm Agents', description: 'Admin: Swarm agent configuration', group: 'admin' },
    { id: 'admin_agents_browser', name: 'Browser Agents', description: 'Admin: Browser agent configuration', group: 'admin' },
    { id: 'admin_agents_terminal', name: 'Terminal Agents', description: 'Admin: Terminal agent configuration', group: 'admin' },
    { id: 'admin_agents_group', name: 'Round Table', description: 'Admin: Round table configuration', group: 'admin' },
    { id: 'admin_agents_system', name: 'System Agents', description: 'Admin: System agent configuration', group: 'admin' },
    { id: 'admin_agents_pipeline', name: 'Pipeline', description: 'Admin: Pipeline configuration', group: 'admin' },
    { id: 'admin_components', name: 'Components', description: 'Admin: Component builder', group: 'admin' },
    { id: 'admin_ai_config', name: 'AI Config', description: 'Admin: AI model configuration', group: 'admin' },
    { id: 'admin_security', name: 'Security', description: 'Admin: Users, SSO, guardrails', group: 'admin' },
    { id: 'admin_monitoring', name: 'Monitoring', description: 'Admin: Usage & cost monitoring', group: 'admin' },

    // ── Actions ──
    { id: 'manage_users', name: 'Manage Users', description: 'Create, edit, and delete users', group: 'actions' },
    { id: 'manage_agents', name: 'Manage Agents', description: 'Create, edit, and publish agents', group: 'actions' },
    { id: 'manage_components', name: 'Manage Components', description: 'Create and edit workflow components', group: 'actions' },
    { id: 'manage_apps', name: 'Manage Apps', description: 'Create and publish apps', group: 'actions' },
];

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
        scopes: ['openid', 'email', 'profile', 'User.Read', 'Mail.Read', 'Mail.Send', 'Calendars.ReadWrite', 'Files.ReadWrite', 'Contacts.ReadWrite', 'offline_access']
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

const requireAuth = async (req, res, next) => {
    if (!req.session.isAuthenticated || !req.session.user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    // Verify user still exists in DB (cached for 5s to avoid DB spam)
    // Skip for demo sessions — demo users don't exist in the DB
    const userId = req.session.user?.id;
    if (userId && !req.session.isDemo) {
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
    }

    next();
};

// Helper function to get user's current permissions dynamically
async function getUserPermissions(userId, session = null) {
    // Demo users or admin-flagged sessions get full access
    if (session?.isDemo || session?.isAdmin) return ['all'];

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

        // ── Organisation role → permissions mapping ──
        // orgRole grants org-scoped capabilities independent of group/role assignments
        const ORG_ROLE_PERMISSIONS = {
            org_admin: [
                'org_admin', 'manage_users', 'manage_agents', 'page_settings',
                'admin_agents', 'admin_agents_chat', 'admin_agents_swarm',
                'admin_agents_browser', 'admin_agents_terminal', 'admin_agents_group',
                'admin_agents_pipeline', 'admin_security', 'admin_monitoring',
            ],
            agent_admin: [
                'agent_admin', 'manage_agents',
                'admin_agents', 'admin_agents_chat', 'admin_agents_swarm',
                'admin_agents_browser', 'admin_agents_terminal', 'admin_agents_group',
                'admin_agents_pipeline',
            ],
            agent_editor: [
                'agent_editor', 'manage_agents',
                'admin_agents', 'admin_agents_chat',
            ],
        };

        if (user.orgRole && ORG_ROLE_PERMISSIONS[user.orgRole]) {
            for (const p of ORG_ROLE_PERMISSIONS[user.orgRole]) {
                permSet.add(p);
            }
        }

        // Short-circuit: 'all' overrides everything
        if (permSet.has('all')) return ['all'];

        // Ensure at least chat access for any authenticated user
        permSet.add('page_chat');

        return [...permSet];
    } catch (err) {
        console.error('[Auth] getUserPermissions error:', err);
        return ['page_chat'];
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
    // Pass session for backwards compatibility with isAdmin/isDemo flags
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
    resolveUserOrgIds
};
