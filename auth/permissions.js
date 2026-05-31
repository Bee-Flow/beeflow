/**
 * Permissions, Middleware & Config
 *
 * RBAC system with group/role resolution, middleware factories,
 * and auth config load/save via configStore.
 *
 * Studio authorization helpers:
 *   - assertUserCanUseOrg(req, orgId)   — validates that the requesting user
 *     belongs to `orgId` (or defaults to their primary org if omitted). Use
 *     on every create endpoint that accepts `organizationId` from the body.
 *   - validateSharedGroupsForOrg(orgId, ids) — confirms every supplied group
 *     ID belongs to `orgId`. Use on every publish/share endpoint that mutates
 *     `shared_groups`.
 *
 * Notes:
 *   - Routines (automations) are intentionally user-private and do not have
 *     `is_published` / `shared_groups` columns.
 *   - The legacy `knowledge_metadata` table (per-agent) is NOT the studio KB
 *     path. Studio KBs live in `knowledge_bases` and use the same
 *     org + is_published + shared_groups model as Agents and Webpages.
 */

const path = require('path');
const fs = require('fs');
const userStore = require('../stores/userStore');

// ── Canonical role + permission identifiers ──────────────────────────────────
// String literals for these IDs are scattered across the codebase. New code
// should import from here; old call sites are migrated opportunistically.
// `LEGACY` aliases retain backwards-compat with rows that pre-date the
// 'admin' → 'org_admin' rename (matches the runtime normaliser at
// getUserPermissions ~ line 296).
const OrgRoles = Object.freeze({
    ORG_ADMIN: 'org_admin',
    DPO: 'dpo',
    AGENT_ADMIN: 'agent_admin',
    AGENT_EDITOR: 'agent_editor',
    MEMBER: 'member',
    // Legacy: pre-rename org admins. Always compare with ORG_ADMIN_VARIANTS,
    // never against this constant alone.
    LEGACY_ADMIN: 'admin',
});

const ORG_ADMIN_VARIANTS = Object.freeze([OrgRoles.ORG_ADMIN, OrgRoles.LEGACY_ADMIN]);

function isOrgAdminRole(orgRole) {
    return ORG_ADMIN_VARIANTS.includes(orgRole);
}

// System role values on users.role. 'admin' is the super-admin / platform
// root; 'user' is the default.
const SystemRoles = Object.freeze({
    SUPER_ADMIN: 'admin',
    USER: 'user',
});

// Canonical permission IDs. Keys match the entries declared in
// SYSTEM_PERMISSIONS below — adding a permission means appending it both
// to SYSTEM_PERMISSIONS (for the discovery API) and this constants map
// (for typesafe references from route code).
const Permissions = Object.freeze({
    ALL: 'all',
    PAGE_CHAT: 'page_chat',
    PAGE_SETTINGS: 'page_settings',
    ADMIN_AGENTS: 'admin_agents',
    ADMIN_AGENTS_CHAT: 'admin_agents_chat',
    ADMIN_AGENTS_SYSTEM: 'admin_agents_system',
    ADMIN_AGENTS_PIPELINE: 'admin_agents_pipeline',
    ADMIN_COMPONENTS: 'admin_components',
    ADMIN_AI_CONFIG: 'admin_ai_config',
    ADMIN_SECURITY: 'admin_security',
    ADMIN_MONITORING: 'admin_monitoring',
    ADMIN_COMPLIANCE: 'admin_compliance',
    ADMIN_SUBSCRIPTIONS: 'admin_subscriptions',
    ADMIN_SUPPORT: 'admin_support',
    MANAGE_USERS: 'manage_users',
    MANAGE_AGENTS: 'manage_agents',
    MANAGE_SKILLS: 'manage_skills',
    MANAGE_COMPONENTS: 'manage_components',
    MANAGE_KNOWLEDGE: 'manage_knowledge',
    MANAGE_APPS: 'manage_apps',
    USE_NOTEBOOKS: 'use_notebooks',
    USE_N8N_TOOLS: 'use_n8n_tools',
    MODIFY_N8N_WORKFLOWS: 'modify_n8n_workflows',
    // Org-role marker permissions (granted automatically by the matching
    // orgRole; useful when code wants to test "does this user behave as an
    // org_admin/agent_admin?" without coupling to the orgRole column).
    ORG_ADMIN: 'org_admin',
    AGENT_ADMIN: 'agent_admin',
    AGENT_EDITOR: 'agent_editor',
    DPO: 'dpo',
});

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
    { id: 'admin_support', name: 'Customer Support', description: 'Admin: Bee Flow customer-support inbox (triage, reply, resolve)', group: 'admin' },

    // ── Actions ──
    { id: 'manage_users', name: 'Manage Users', description: 'Create, edit, and delete users', group: 'actions' },
    { id: 'manage_agents', name: 'Manage Agents', description: 'Create, edit, delete, and publish agents', group: 'actions' },
    { id: 'manage_skills', name: 'Manage Skills', description: 'Create, edit, delete, and share skills', group: 'actions' },
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
const USER_CHECK_TTL = 5; // seconds
const PERM_CACHE_TTL = 30; // seconds — permission cache TTL

// Bounded in-memory caches. Both are pure fallbacks for when Redis is
// unavailable; Redis remains the canonical store in cloud deployments. The
// LRU bound protects multi-day single-node uptime against unbounded growth
// when user counts run into the high thousands.
const PERM_CACHE_MAX = parseInt(process.env.PERM_CACHE_MAX || '5000', 10);
const USER_EXISTS_CACHE_MAX = parseInt(process.env.USER_EXISTS_CACHE_MAX || '5000', 10);
function _makeBoundedMap(max) {
    const m = new Map();
    m.set = function(k, v) {
        if (this.has(k)) Map.prototype.delete.call(this, k);
        Map.prototype.set.call(this, k, v);
        if (this.size > max) {
            // Map preserves insertion order — oldest key is first.
            const oldest = this.keys().next().value;
            Map.prototype.delete.call(this, oldest);
        }
        return this;
    };
    return m;
}
const _userExistsCache = _makeBoundedMap(USER_EXISTS_CACHE_MAX);
const _permCache = _makeBoundedMap(PERM_CACHE_MAX);

// Degraded-state signal — flipped whenever getUserPermissions hits an
// exception path. Stays true for 60s after the last failure so dashboards
// can poll without seeing it bounce. See isPermissionLookupDegraded() below.
let _lastPermLookupFailedAt = 0;

// ─── Cross-node cache invalidation ───────────────────────────────────────────
// Even with Redis as the cache backend, multi-node deploys can end up with
// stale state in two ways:
//   1. Without Redis: each node has its own `_permCache` Map and a delete on
//      node A doesn't fan out.
//   2. With Redis: a read on node B can complete between node A's mutation
//      and node A's `r.del(...)`, so node B briefly held a stale value.
// Publishing the user-id (or '*' for the bulk-clear case) onto a Redis pub/sub
// channel makes every node drop its in-memory copy immediately. Best-effort:
// pub/sub failures are logged and ignored — the existing Redis-key delete
// remains the source of truth.
const PERM_INVALIDATE_CHANNEL = 'bf:perms:invalidate';
const UEX_INVALIDATE_CHANNEL = 'bf:uex:invalidate';
let _subscriberStarted = false;

function _ensureSubscriber() {
    if (_subscriberStarted) return;
    const r = getRedis();
    if (!r || typeof r.duplicate !== 'function') return;
    try {
        const sub = r.duplicate();
        sub.on('error', (e) => console.warn('[Auth] perm invalidate subscriber error:', e.message));
        sub.subscribe(PERM_INVALIDATE_CHANNEL, UEX_INVALIDATE_CHANNEL, (err) => {
            if (err) {
                console.warn('[Auth] perm invalidate subscribe failed:', err.message);
                return;
            }
            _subscriberStarted = true;
        });
        sub.on('message', (channel, message) => {
            try {
                if (channel === PERM_INVALIDATE_CHANNEL) {
                    if (message === '*') _permCache.clear();
                    else _permCache.delete(message);
                } else if (channel === UEX_INVALIDATE_CHANNEL) {
                    if (message === '*') _userExistsCache.clear();
                    else _userExistsCache.delete(message);
                }
            } catch (e) {
                console.warn('[Auth] perm invalidate handler error:', e.message);
            }
        });
    } catch (e) {
        console.warn('[Auth] perm invalidate subscriber setup failed:', e.message);
    }
}

async function _publish(channel, message) {
    const r = getRedis();
    if (!r) return;
    _ensureSubscriber();
    try { await r.publish(channel, message); } catch (_) { /* non-fatal */ }
}

// Eagerly subscribe at module load if Redis is already up. If Redis comes up
// later, the next mutation will trigger _ensureSubscriber() via _publish.
setImmediate(() => { try { _ensureSubscriber(); } catch (_) { /* non-fatal */ } });

const requireAuth = async (req, res, next) => {
    if (!req.session || !req.session.isAuthenticated || !req.session.user) {
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
        const normaliseOrgRole = (r) => (r === OrgRoles.LEGACY_ADMIN ? OrgRoles.ORG_ADMIN : r);

        // Apply user's direct orgRole
        const userOrgRole = normaliseOrgRole(user.orgRole);
        if (userOrgRole && ORG_ROLE_PERMISSIONS[userOrgRole]) {
            for (const p of ORG_ROLE_PERMISSIONS[userOrgRole]) {
                permSet.add(p);
            }
        }

        // Apply group-level orgRoles (a group can grant a role to all its members).
        //
        // Why this exists: the canonical place to assign an orgRole is the
        // `users.orgRole` column. The `groups.orgRole` column is a fan-out
        // shortcut for "everyone in this group should also act as <role>"
        // (e.g. an "ops" group that grants `dpo` to its members without
        // editing each user). It is additive — a user's own orgRole and
        // every group orgRole they're in all union into the permission set.
        //
        // Operational notes:
        //   • Group orgRoles do NOT promote a user across org boundaries —
        //     a group's organizationId scopes its members; cross-org
        //     resolution still relies on the per-user orgRole + user.organizationId.
        //   • Removing a member from a group invalidates their cached perms
        //     via invalidateAllPermissionCaches (group mutations) or the
        //     per-user invalidation when adminRoutes updates `users.groups`.
        //   • The mechanism is rarely used today; left in place for orgs
        //     that want to manage "all members of group X get DPO" without
        //     editing per-user rows.
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
        // Genuine DB error → log loudly and bump the degraded-state metric
        // so ops sees the silent "everyone is suddenly restricted" pattern.
        // We still return the minimal fallback rather than 503 here, because
        // many call sites use this for cosmetic UI gating; returning [] would
        // hide the chat window. Routes that need a hard answer should call
        // `hasPermission(userId, perm)` and on `false` decide whether to 403
        // or 503 based on `_lastPermLookupFailedAt`.
        _lastPermLookupFailedAt = Date.now();
        console.error('[Auth] getUserPermissions degraded:', err);
        return ['page_chat'];
    }
}

function isPermissionLookupDegraded() {
    return Date.now() - _lastPermLookupFailedAt < 60_000; // 1-min sticky
}

/**
 * Invalidate the cached permission set for a specific user.
 * Call this after user/group/role mutations (create, update, delete).
 */
async function invalidatePermissionCache(userId) {
    if (!userId) return;
    // Always clear locally — covers the in-memory fallback and any micro-
    // cache window before pub/sub fans out.
    _permCache.delete(userId);
    const r = getRedis();
    if (r) {
        try { await r.del(`bf:perms:${userId}`); } catch (_) { }
    }
    await _publish(PERM_INVALIDATE_CHANNEL, String(userId));
}

/**
 * Invalidate the user-existence cache used by requireAuth. Until this fires,
 * the cached isAdmin / existence value can outlive the user's actual role
 * by USER_CHECK_TTL (5s). Called from admin endpoints that promote/demote.
 */
async function invalidateUserExistenceCache(userId) {
    if (!userId) return;
    _userExistsCache.delete(userId);
    const r = getRedis();
    if (r) {
        try { await r.del(`bf:uex:${userId}`); } catch (_) { }
    }
    await _publish(UEX_INVALIDATE_CHANNEL, String(userId));
}

/**
 * Invalidate every user's cached permission set. Used on group/role mutations
 * where the affected-user set isn't easily enumerable.
 */
async function invalidateAllPermissionCaches() {
    _permCache.clear();
    const r = getRedis();
    if (r) {
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
    await _publish(PERM_INVALIDATE_CHANNEL, '*');
}

// Helper to check if user has a specific permission
async function hasPermission(userId, permission, session = null) {
    const perms = await getUserPermissions(userId, session);
    return perms.includes('all') || perms.includes(permission);
}

// Middleware to check admin or manage_users permission (dynamic)
const requireAdmin = async (req, res, next) => {
    if (!req.session || !req.session.isAuthenticated || !req.session.user) {
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
        if (!req.session || !req.session.isAuthenticated || !req.session.user) {
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
    if (!req.session || !req.session.isAuthenticated || !req.session.user) {
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
 * Block writes/operations when an organization is suspended. The check
 * resolves the caller's primary org (or accepts an orgId override via
 * req.params/[paramName] / req.body.organizationId for super-admin
 * routes). Returns 402 with a stable error code so the frontend can
 * surface a "Subscription paused" banner. Archived orgs trip a 410.
 * Super-admins are exempt (they need to be able to admin a suspended
 * org). Active orgs (or no-org consumer accounts) pass through.
 */
function requireActiveOrg(opts = {}) {
    const paramName = opts.paramName || 'orgId';
    return async (req, res, next) => {
        try {
            if (req.session?.isAdmin || req.session?.user?.role === SystemRoles.SUPER_ADMIN) return next();
            let orgId = (req.params && req.params[paramName]) || (req.body && req.body.organizationId) || null;
            if (!orgId) {
                orgId = await resolvePrimaryOrgId(req);
            }
            if (!orgId) return next(); // consumer / no-org → not blocked
            const org = await userStore.getOrganization(orgId);
            if (!org) return next();
            const status = org.status || 'active';
            if (status === 'suspended') {
                return res.status(402).json({
                    error: 'org_suspended',
                    message: 'Your organization is currently suspended. Please contact your administrator.',
                });
            }
            if (status === 'archived') {
                return res.status(410).json({
                    error: 'org_archived',
                    message: 'Your organization is archived and read-only.',
                });
            }
            return next();
        } catch (e) {
            console.warn('[Auth] requireActiveOrg error:', e.message);
            return next(); // fail-open: don't lock customers out on transient errors
        }
    };
}

/**
 * Variant of `requireActiveOrg` that only enforces on non-GET/non-HEAD
 * requests. Use as a top-level `router.use(...)` middleware so a suspended
 * org can still read/export data but cannot mutate. The status check
 * runs server-side; the suspension banner is rendered client-side from
 * the 402 response.
 */
function requireActiveOrgForMutations(opts = {}) {
    const inner = requireActiveOrg(opts);
    return (req, res, next) => {
        const m = req.method;
        if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
        return inner(req, res, next);
    };
}

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
        if (!user || !isOrgAdminRole(user.orgRole)) {
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

/**
 * Resolve the requesting user's primary org ID from the session.
 * Returns the first org they belong to, or null. Super admins return null.
 */
async function resolvePrimaryOrgId(req) {
    const orgIds = await resolveUserOrgIds(req);
    if (orgIds === null) return null;
    if (orgIds.size === 0) return null;
    return Array.from(orgIds)[0];
}

/**
 * Studio authorization helper: throws a 403-shaped Error if the requesting
 * user does not belong to `orgId`. If `orgId` is falsy, falls back to the
 * user's primary org. Returns the validated orgId.
 *
 * Super admins (resolveUserOrgIds === null) bypass the membership check but
 * still get back the orgId they supplied (or null if none).
 *
 * Usage:
 *   try {
 *     const orgId = await assertUserCanUseOrg(req, req.body.organizationId);
 *     // proceed with orgId
 *   } catch (err) {
 *     return res.status(err.status || 500).json({ error: err.message });
 *   }
 */
async function assertUserCanUseOrg(req, orgId) {
    const userOrgIds = await resolveUserOrgIds(req);
    // Super admin: trust the supplied orgId, or null
    if (userOrgIds === null) return orgId || null;

    if (!orgId) {
        // No explicit orgId — fall back to primary
        if (userOrgIds.size === 0) {
            const err = new Error('User does not belong to any organisation');
            err.status = 403;
            throw err;
        }
        return Array.from(userOrgIds)[0];
    }

    if (!userOrgIds.has(orgId)) {
        const err = new Error('Organisation not accessible');
        err.status = 403;
        throw err;
    }
    return orgId;
}

/**
 * Studio authorization helper: throws a 400-shaped Error if any of
 * `sharedGroupIds` does not belong to `orgId`. An empty/undefined list is a
 * no-op. Returns the validated array (deduped, falsy entries dropped).
 *
 * Usage:
 *   try {
 *     const groups = await validateSharedGroupsForOrg(orgId, sharedGroups);
 *     await store.setPublished(id, true, groups);
 *   } catch (err) {
 *     return res.status(err.status || 500).json({ error: err.message });
 *   }
 */
async function validateSharedGroupsForOrg(orgId, sharedGroupIds) {
    if (sharedGroupIds === undefined || sharedGroupIds === null) return undefined;
    if (!Array.isArray(sharedGroupIds)) {
        const err = new Error('sharedGroups must be an array');
        err.status = 400;
        throw err;
    }
    const ids = Array.from(new Set(sharedGroupIds.filter(Boolean)));
    if (ids.length === 0) return [];
    if (!orgId) {
        const err = new Error('Cannot assign shared groups: resource has no organisation');
        err.status = 400;
        throw err;
    }

    const allGroups = await userStore.getAllGroups();
    const orgGroupIds = new Set(allGroups.filter(g => g.organizationId === orgId).map(g => g.id));
    const invalid = ids.filter(id => !orgGroupIds.has(id));
    if (invalid.length > 0) {
        const err = new Error(`Invalid groups for this organisation: ${invalid.join(', ')}`);
        err.status = 400;
        throw err;
    }
    return ids;
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
    resolvePrimaryOrgId,
    requireOrgAdmin,
    assertUserCanUseOrg,
    validateSharedGroupsForOrg,
    invalidatePermissionCache,
    invalidateAllPermissionCaches,
    invalidateUserExistenceCache,
    OrgRoles,
    SystemRoles,
    Permissions,
    ORG_ADMIN_VARIANTS,
    isOrgAdminRole,
    requireActiveOrg,
    requireActiveOrgForMutations,
    isPermissionLookupDegraded,
};
