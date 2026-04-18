/**
 * Admin Routes — User, Organization, Group, Role CRUD + App Passwords
 * 
 * All routes require authentication. Most require admin access.
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const router = express.Router();

const userStore = require('../stores/userStore');
const { loadConfig, saveConfig, requireAuth, requireAdmin, getUserPermissions, SYSTEM_PERMISSIONS, invalidatePermissionCache, invalidateAllPermissionCaches, resolveUserOrgIds } = require('./permissions');
const { rewrapUserDEKCompat, adminResetUser, getOrCreateUserDEKCompat } = require('./encryption');
const { checkResourceLimits } = require('../core/limits');

/**
 * Check if the current user is an org admin for a given organization.
 * Super admins always pass. Org admins must have orgRole='org_admin' and belong to the target org.
 */
async function isOrgAdminForOrg(req, orgId) {
    // Super admin — always allowed
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;

    const userId = req.session?.user?.id;
    if (!userId) return false;

    const user = await userStore.getUser(userId);
    if (!user) return false;

    // Must be org_admin role
    if (user.orgRole !== 'org_admin') return false;

    // Must belong to the target org
    if (user.organizationId === orgId) return true;

    // Check group-based membership as fallback
    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { } }

    const allGroups = await userStore.getAllGroups();
    return groupIds.some(gid => {
        const g = allGroups.find(gr => gr.id === gid);
        return g?.organizationId === orgId;
    });
}

/**
 * Middleware factory: require org admin access for the org specified by req.params[paramName].
 * Falls back to requireAuth first, then checks org admin status.
 */
function requireOrgAdmin(paramName = 'id') {
    return async (req, res, next) => {
        if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
        const orgId = req.params[paramName];
        if (!orgId) return res.status(400).json({ error: 'Organization ID required' });
        if (!await isOrgAdminForOrg(req, orgId)) {
            return res.status(403).json({ error: 'Organization admin access required' });
        }
        next();
    };
}

/**
 * Middleware: require org admin access for the user specified by :id param.
 * Looks up the target user's org and checks if the requestor is an org admin for it.
 * For POST (create user), uses req.body.organizationId since no user exists yet.
 * Also blocks org admins from setting role='admin' (super admin escalation).
 */
async function requireOrgAdminForUser(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });

    // Super admins pass through
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (isSuperAdmin) return next();

    // Block org admins from setting platform role to 'admin'
    if (req.body?.role === 'admin') {
        return res.status(403).json({ error: 'Cannot assign super admin role' });
    }

    // Determine target org: from existing user (PUT/DELETE) or from body (POST)
    let targetOrgId = null;
    const targetUserId = req.params.id;
    if (targetUserId) {
        const targetUser = await userStore.getUser(targetUserId);
        if (!targetUser) return res.status(404).json({ error: 'User not found' });
        targetOrgId = targetUser.organizationId;
    } else {
        // POST /users — use the org from the body
        targetOrgId = req.body?.organizationId;
    }

    if (!targetOrgId) {
        return res.status(403).json({ error: 'Cannot manage users without an organisation' });
    }

    if (!await isOrgAdminForOrg(req, targetOrgId)) {
        return res.status(403).json({ error: 'You can only manage users in your organisation' });
    }
    next();
}

// === User Management API (Admin Only) ===

// Get all users — requires manage_users, admin_security, or org_admin
router.get('/users', requireAuth, async (req, res) => {
    // Non-super-admins must have user management permissions
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (!isSuperAdmin) {
        const userId = req.session.user?.id;
        const perms = await getUserPermissions(userId, req.session);
        const canView = perms.includes('all') || perms.includes('manage_users') || perms.includes('admin_security') || perms.includes('org_admin');
        if (!canView) {
            return res.status(403).json({ error: 'Permission required to view users' });
        }
    }

    const users = await userStore.getAllUsers();
    const config = await loadConfig();
    const superAdmin = {
        id: 'admin',
        username: config.admin.username,
        displayName: 'Administrator (System)',
        role: 'admin',
        isSystem: true
    };

    let allUsers = [superAdmin, ...users.filter(u => u.id !== 'admin')];

    // Org-scoped filtering using canonical resolver
    if (!isSuperAdmin) {
        const myOrgIds = await resolveUserOrgIds(req);
        if (myOrgIds && myOrgIds.size > 0) {
            const allGroups = await userStore.getAllGroups();
            const orgGroupIds = new Set();
            for (const group of allGroups) {
                if (group.organizationId && myOrgIds.has(group.organizationId)) {
                    orgGroupIds.add(group.id);
                }
            }

            allUsers = allUsers.filter(u => {
                if (u.isSystem) return false;
                if (u.organizationId && myOrgIds.has(u.organizationId)) return true;
                let uGroups = [];
                try { uGroups = Array.isArray(u.groups) ? u.groups : JSON.parse(u.groups || '[]'); } catch (_) { }
                return uGroups.some(gid => orgGroupIds.has(gid));
            });
        }
    }

    res.json(allUsers);
});

// Create user
router.post('/users', requireOrgAdminForUser, async (req, res) => {
    const { username, displayName, firstName, lastName, email, phone, avatar, avatarType, password, role, groups, orgRole, organizationId } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    if (username === 'admin') {
        return res.status(400).json({ error: 'Cannot create user "admin"' });
    }

    // Check user count limit for target org
    const targetOrgId = organizationId || null;
    if (targetOrgId) {
        const allUsers = await userStore.getAllUsers();
        const orgUserCount = allUsers.filter(u => u.organizationId === targetOrgId).length;
        const limitErr = checkResourceLimits(targetOrgId, 'users', orgUserCount);
        if (limitErr) {
            return res.status(403).json({ error: limitErr });
        }
    }

    // Merge default groups from all organizations
    let finalGroups = groups || [];
    try {
        const orgs = await userStore.getAllOrganizations();
        for (const org of orgs) {
            if (org.defaultGroups && Array.isArray(org.defaultGroups)) {
                for (const gid of org.defaultGroups) {
                    if (!finalGroups.includes(gid)) {
                        finalGroups.push(gid);
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[Auth] Failed to merge default groups:', e.message);
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = {
        id: username,
        username,
        displayName: displayName || username,
        firstName: firstName || null,
        lastName: lastName || null,
        email: email || null,
        phone: phone || null,
        avatar: avatar || null,
        avatarType: avatarType || null,
        passwordHash,
        role: role || 'user',
        groups: finalGroups,
        orgRole: orgRole || '',
        organizationId: organizationId || ''
    };

    if (await userStore.createUser(newUser)) {
        console.log(`[Audit] ${req.session.user?.id || 'system'} created user '${username}' in org '${organizationId || 'none'}' with orgRole '${orgRole || 'none'}'`);
        res.json({ success: true, user: { id: newUser.id, username, displayName, role } });
    } else {
        res.status(400).json({ error: 'User already exists' });
    }
});

// Update user
router.put('/users/:id', requireOrgAdminForUser, async (req, res) => {
    const { id } = req.params;
    const { role, groups, displayName, firstName, lastName, email, phone, avatar, avatarType, password, oldPassword, orgRole, organizationId, status } = req.body;

    if (id === 'admin') {
        if (role && role !== 'admin') {
            return res.status(400).json({ error: 'Cannot downgrade system admin' });
        }
    }

    const updates = { role, groups, displayName, firstName, lastName, email, phone, avatar, avatarType, orgRole, organizationId, status };
    if (password) {
        updates.passwordHash = await bcrypt.hash(password, 10);

        if (oldPassword) {
            // User-initiated password change — rewrap DEK
            try {
                const result = await rewrapUserDEKCompat(id, oldPassword, password);
                if (!result.success) {
                    return res.status(400).json({ error: 'Failed to verify old password' });
                }
            } catch (err) {
                console.error('[Auth] DEK rewrap failed:', err.message);
                return res.status(400).json({ error: 'Failed to verify old password' });
            }
        } else {
            // Admin-initiated password reset — destructive (zero-knowledge)
            await adminResetUser(id);
            console.warn(`[Auth] Admin reset user ${id} — encrypted data requires recovery key`);
        }
    }

    if (await userStore.updateUser(id, updates)) {
        const changedFields = Object.keys(updates).filter(k => updates[k] !== undefined);
        console.log(`[Audit] ${req.session.user?.id || 'system'} updated user '${id}' — fields: ${changedFields.join(', ')}`);
        // Role / orgRole / group changes alter the user's effective permissions.
        await invalidatePermissionCache(id);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Delete user
router.delete('/users/:id', requireOrgAdminForUser, async (req, res) => {
    const { id } = req.params;
    if (id === 'admin') {
        return res.status(400).json({ error: 'Cannot delete system admin' });
    }

    if (await userStore.deleteUser(id)) {
        console.log(`[Audit] ${req.session.user?.id || 'system'} deleted user '${id}'`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'User not found' });
    }
});

// Upload user avatar image
const userAvatarUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const uploadDir = path.join(__dirname, '..', 'data', 'uploads');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `user-avatar-${req.params.id}-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(png|jpeg|jpg|svg\+xml|webp|gif)$/.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, JPG, SVG, WEBP, GIF images are allowed'));
        }
    }
});

router.post('/users/:id/avatar', requireOrgAdminForUser, userAvatarUpload.single('avatar'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarPath = `/uploads/${req.file.filename}`;
    await userStore.updateUser(req.params.id, { avatar: avatarPath, avatarType: 'image' });
    res.json({ success: true, avatar: avatarPath, avatarType: 'image' });
});

router.delete('/users/:id/avatar', requireOrgAdminForUser, async (req, res) => {
    const user = await userStore.getUser(req.params.id);
    if (user && user.avatar && user.avatarType === 'image') {
        const filePath = path.join(__dirname, '..', 'data', user.avatar);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    // Use PostgreSQL to set NULL
    const { run } = require('../db');
    await run('UPDATE users SET avatar = NULL, "avatarType" = NULL WHERE id = $1', [req.params.id]);
    res.json({ success: true });
});

// Change own password (user-facing, requires old password for DEK re-wrap)
router.post('/change-password', requireAuth, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const userId = req.session.user?.id;

    if (!userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: 'Old and new password required' });
    }

    if (newPassword.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }

    const user = await userStore.getUser(userId);
    if (!user || !user.passwordHash) {
        return res.status(404).json({ error: 'User not found' });
    }

    const isValid = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!isValid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
    }

    try {
        const result = await rewrapUserDEKCompat(userId, oldPassword, newPassword);
        if (!result.success) {
            return res.status(500).json({ error: 'Failed to update encryption keys' });
        }

        const passwordHash = await bcrypt.hash(newPassword, 10);
        await userStore.updateUser(userId, { passwordHash });

        // Update session encryption key
        if (result.encryptionKey) {
            req.session.encryptionKey = result.encryptionKey;
        }

        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
            }
            res.json({ success: true, message: 'Password changed successfully' });
        });
    } catch (err) {
        console.error('[Auth] Password change DEK operation failed:', err.message);
        return res.status(500).json({ error: 'Failed to update encryption keys' });
    }
});


// === Organizations Management API (Admin Only) ===

router.get('/organizations', requireAuth, async (req, res) => {
    // Non-super-admins must have org-level permissions
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (!isSuperAdmin) {
        const userId = req.session.user?.id;
        const perms = await getUserPermissions(userId, req.session);
        const canView = perms.includes('all') || perms.includes('manage_users') || perms.includes('admin_security') || perms.includes('org_admin');
        if (!canView) {
            return res.status(403).json({ error: 'Permission required to view organisations' });
        }
    }

    let orgs = await userStore.getAllOrganizations();

    // Org-scoped filtering using canonical resolver
    if (!isSuperAdmin) {
        const myOrgIds = await resolveUserOrgIds(req);
        if (myOrgIds) {
            orgs = orgs.filter(o => myOrgIds.has(o.id));
        }
    }

    res.json(orgs);
});

router.post('/organizations', requireAdmin, async (req, res) => {
    const { name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup } = req.body;
    if (!name) return res.status(400).json({ error: 'Organization name required' });

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    // Apply default integrations from global config
    const configStore = require('../stores/configStore');
    const defaultIntegrations = await configStore.getConfig('default_org_integrations') || null;

    const newOrg = { id, name, description: description || '', tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups: defaultGroups || [], allowSignup: !!allowSignup, enabledIntegrations: defaultIntegrations };

    if (await userStore.createOrganization(newOrg)) {
        console.log(`[Audit] ${req.session.user?.id || 'system'} created organization '${name}' (${id})`);
        res.json({ success: true, organization: newOrg });
    } else {
        res.status(400).json({ error: 'Organization already exists' });
    }
});

router.put('/organizations/:id', requireOrgAdmin('id'), async (req, res) => {
    const { id } = req.params;
    const { name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod, enabledIntegrations, autoApproveSSO, allowedDomains } = req.body;

    // authMethod can only be set once — if already set, ignore any change
    const existing = await userStore.getOrganization(id);
    const finalAuthMethod = (existing && existing.authMethod) ? undefined : authMethod;

    // enabledIntegrations: only super admins can change this
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const finalIntegrations = isSuperAdmin && enabledIntegrations !== undefined ? enabledIntegrations : undefined;

    // ── allowedDomains validation (private-cloud only) ──
    let finalAllowedDomains = undefined;
    if (allowedDomains !== undefined && process.env.DEPLOYMENT_MODE === 'private-cloud') {
        if (!Array.isArray(allowedDomains)) {
            return res.status(400).json({ error: 'allowedDomains must be an array' });
        }

        // Validate domain formats
        const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
        const normalised = [];
        for (const d of allowedDomains) {
            const domain = String(d).trim().toLowerCase();
            if (!domain) continue;
            if (!domainRegex.test(domain)) {
                return res.status(400).json({ error: `Invalid domain format: "${domain}"` });
            }
            normalised.push(domain);
        }

        // Collision check: no domain can belong to another org
        if (normalised.length > 0) {
            const allOrgs = await userStore.getAllOrganizations();
            for (const domain of normalised) {
                const collision = allOrgs.find(o =>
                    o.id !== id && Array.isArray(o.allowedDomains) && o.allowedDomains.includes(domain)
                );
                if (collision) {
                    return res.status(400).json({ error: `Domain "${domain}" is already assigned to organisation "${collision.name}"` });
                }
            }
        }

        finalAllowedDomains = normalised;
    }

    if (await userStore.updateOrganization(id, { name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod: finalAuthMethod, enabledIntegrations: finalIntegrations, autoApproveSSO, allowedDomains: finalAllowedDomains })) {
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Organization not found' });
    }
});

router.delete('/organizations/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    if (await userStore.deleteOrganization(id)) {
        console.log(`[Audit] ${req.session.user?.id || 'system'} deleted organization '${id}'`);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Organization not found' });
    }
});

// Upload organization logo
const orgLogoUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const uploadDir = path.join(__dirname, '..', 'data', 'uploads');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname);
            cb(null, `org-logo-${req.params.id}-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (/^image\/(png|jpeg|jpg|svg\+xml|webp)$/.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, JPG, SVG, WEBP images are allowed'));
        }
    }
});

router.post('/organizations/:id/logo', requireOrgAdmin('id'), orgLogoUpload.single('logo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const logoPath = `/uploads/${req.file.filename}`;
    await userStore.updateOrganization(req.params.id, { logo: logoPath });
    res.json({ success: true, logo: logoPath });
});

router.delete('/organizations/:id/logo', requireOrgAdmin('id'), async (req, res) => {
    const org = await userStore.getAllOrganizations().find(o => o.id === req.params.id);
    if (org && org.logo) {
        const filePath = path.join(__dirname, '..', 'data', org.logo);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    await userStore.updateOrganization(req.params.id, { logo: '' });
    res.json({ success: true });
});


// === Group Management API (Admin Only) ===

router.get('/groups', requireAuth, async (req, res) => {
    // Non-super-admins must have group management permissions
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    if (!isSuperAdmin) {
        const userId = req.session.user?.id;
        const perms = await getUserPermissions(userId, req.session);
        const canView = perms.includes('all') || perms.includes('manage_users') || perms.includes('admin_security') || perms.includes('org_admin');
        if (!canView) {
            return res.status(403).json({ error: 'Permission required to view groups' });
        }
    }

    let groups = await userStore.getAllGroups();

    // Org-scoped filtering using canonical resolver
    if (!isSuperAdmin) {
        const myOrgIds = await resolveUserOrgIds(req);
        if (myOrgIds) {
            groups = groups.filter(g => g.organizationId && myOrgIds.has(g.organizationId));
        }
    }

    res.json(groups);
});

router.post('/groups', requireAuth, async (req, res) => {
    const { name, description, permissions, roles, organizationId, allowedAgentTypes } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Group name required' });
    }

    // Require org_admin or manage_users permission to create groups
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const userId = req.session.user?.id;
    if (!isSuperAdmin) {
        const perms = await getUserPermissions(userId, req.session);
        if (!perms.includes('all') && !perms.includes('org_admin') && !perms.includes('manage_users')) {
            return res.status(403).json({ error: 'Organisation admin access required to manage groups' });
        }
    }

    // For non-super-admins, force the group into their org
    let orgId = organizationId || null;
    if (!isSuperAdmin) {
        const currentUser = await userStore.getUser(userId);
        if (!currentUser?.organizationId) {
            return res.status(403).json({ error: 'You must belong to an organisation to create groups' });
        }
        orgId = currentUser.organizationId;

        // Validate permissions — users can only grant permissions they possess
        if (permissions && permissions.length > 0) {
            const userPerms = await getUserPermissions(userId, req.session);
            if (!userPerms.includes('all')) {
                const unauthorized = permissions.filter(p => !userPerms.includes(p));
                if (unauthorized.length > 0) {
                    return res.status(403).json({ error: `Cannot assign permissions you don't have: ${unauthorized.join(', ')}` });
                }
            }
        }
    }

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const newGroup = {
        id,
        organizationId: orgId,
        name,
        description: description || '',
        permissions: permissions || [],
        roles: roles || [],
        allowedAgentTypes: allowedAgentTypes || []
    };

    if (await userStore.createGroup(newGroup)) {
        console.log(`[Audit] ${userId || 'system'} created group '${name}' (${id}) in org '${orgId || 'global'}'`);
        res.json({ success: true, group: newGroup });
    } else {
        res.status(400).json({ error: 'Group already exists' });
    }
});

router.put('/groups/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    const { description, permissions, roles, organizationId, allowedAgentTypes, allowedTiers, orgRole } = req.body;

    // Require org_admin or manage_users permission to edit groups
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const userId = req.session.user?.id;
    if (!isSuperAdmin) {
        const perms = await getUserPermissions(userId, req.session);
        if (!perms.includes('all') && !perms.includes('org_admin') && !perms.includes('manage_users')) {
            return res.status(403).json({ error: 'Organisation admin access required to manage groups' });
        }

        const currentUser = await userStore.getUser(userId);
        const allGroups = await userStore.getAllGroups();
        const group = allGroups.find(g => g.id === id);
        if (!group || !currentUser?.organizationId || group.organizationId !== currentUser.organizationId) {
            return res.status(403).json({ error: 'You can only edit groups in your organisation' });
        }

        // Validate permissions — users can only grant permissions they possess
        if (permissions && permissions.length > 0) {
            const userPerms = await getUserPermissions(userId, req.session);
            if (!userPerms.includes('all')) {
                const unauthorized = permissions.filter(p => !userPerms.includes(p));
                if (unauthorized.length > 0) {
                    return res.status(403).json({ error: `Cannot assign permissions you don't have: ${unauthorized.join(', ')}` });
                }
            }
        }
    }

    const updates = { description, permissions, roles };
    // Only super admins can reassign a group to a different org
    if (organizationId !== undefined && isSuperAdmin) {
        updates.organizationId = organizationId;
    }
    if (allowedAgentTypes !== undefined) {
        updates.allowedAgentTypes = allowedAgentTypes;
    }
    if (allowedTiers !== undefined) {
        updates.allowedTiers = allowedTiers;
    }
    if (orgRole !== undefined) {
        updates.orgRole = orgRole;
    }

    if (await userStore.updateGroup(id, updates)) {
        console.log(`[Audit] ${userId || 'system'} updated group '${id}' — fields: ${Object.keys(updates).filter(k => updates[k] !== undefined).join(', ')}`);
        // Permissions / roles / orgRole on the group change the effective
        // permission set of every member. Easiest safe bet: clear all.
        await invalidateAllPermissionCaches();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Group not found' });
    }
});

router.delete('/groups/:id', requireAuth, async (req, res) => {
    const { id } = req.params;
    if (id === 'admins' || id === 'users') {
        return res.status(400).json({ error: 'Cannot delete system groups' });
    }

    // Require org_admin or manage_users permission to delete groups
    const isSuperAdmin = req.session.isAdmin || req.session.user?.role === 'admin';
    const userId = req.session.user?.id;
    if (!isSuperAdmin) {
        const perms = await getUserPermissions(userId, req.session);
        if (!perms.includes('all') && !perms.includes('org_admin') && !perms.includes('manage_users')) {
            return res.status(403).json({ error: 'Organisation admin access required to manage groups' });
        }

        const currentUser = await userStore.getUser(userId);
        const allGroups = await userStore.getAllGroups();
        const group = allGroups.find(g => g.id === id);
        if (!group || !currentUser?.organizationId || group.organizationId !== currentUser.organizationId) {
            return res.status(403).json({ error: 'You can only delete groups in your organisation' });
        }
    }

    if (await userStore.deleteGroup(id)) {
        console.log(`[Audit] ${userId || 'system'} deleted group '${id}'`);
        await invalidateAllPermissionCaches();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Group not found' });
    }
});


// === Roles Management API (Admin Only) ===

router.get('/roles', requireAdmin, async (req, res) => {
    const roles = await userStore.getAllRoles();
    res.json(roles);
});

router.post('/roles', requireAdmin, async (req, res) => {
    const { name, description, permissions } = req.body;

    if (!name) {
        return res.status(400).json({ error: 'Role name required' });
    }

    const id = name.toLowerCase().replace(/\s+/g, '-');
    const newRole = {
        id,
        name,
        description: description || '',
        permissions: permissions || []
    };

    if (await userStore.createRole(newRole)) {
        console.log(`[Audit] ${req.session.user?.id || 'system'} created role '${name}' (${id})`);
        res.json({ success: true, role: newRole });
    } else {
        res.status(400).json({ error: 'Role already exists' });
    }
});

router.put('/roles/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, description, permissions } = req.body;

    if (await userStore.updateRole(id, { name, description, permissions })) {
        await invalidateAllPermissionCaches();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Role not found' });
    }
});

router.delete('/roles/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    if (id === 'admin' || id === 'user') {
        return res.status(400).json({ error: 'Cannot delete system roles' });
    }

    if (await userStore.deleteRole(id)) {
        console.log(`[Audit] ${req.session.user?.id || 'system'} deleted role '${id}'`);
        await invalidateAllPermissionCaches();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Role not found' });
    }
});


// === Permissions API ===

router.get('/permissions', requireAdmin, async (req, res) => {
    res.json(SYSTEM_PERMISSIONS);
});


// === App Password Management ===

router.get('/app-password-status', async (req, res) => {
    if (!req.session.isAuthenticated) {
        return res.json({ hasAppPassword: false, isNextcloudUser: false });
    }

    const userId = req.session.user?.id;
    if (!userId) {
        return res.json({ hasAppPassword: false, isNextcloudUser: false });
    }

    res.json({
        hasAppPassword: await userStore.hasAppPassword(userId),
        isNextcloudUser: !!req.session.accessToken
    });
});

router.post('/create-app-password', async (req, res) => {
    if (!req.session.isAuthenticated) {
        return res.status(401).json({ error: 'Must be logged in' });
    }

    const accessToken = req.session.accessToken;
    const userId = req.session.user?.id;

    if (!accessToken || !userId) {
        return res.status(401).json({ error: 'Not authenticated with Nextcloud' });
    }

    const config = await loadConfig();
    const nextcloudUrl = config.oauth?.nextcloudUrl;

    if (!nextcloudUrl) {
        return res.status(400).json({ error: 'Nextcloud URL not configured' });
    }

    try {
        const response = await fetch(`${nextcloudUrl}/ocs/v2.php/core/apppassword`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'OCS-APIRequest': 'true',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            return res.status(500).json({ error: 'Failed to create app password' });
        }

        const data = await response.json();
        const appPassword = data.ocs?.data?.apppassword;

        if (!appPassword) {
            return res.status(500).json({ error: 'No app password returned' });
        }

        await userStore.storeAppPassword(userId, userId, appPassword);
        res.json({ success: true, message: 'App password created' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/save-app-password', async (req, res) => {
    if (!req.session.isAuthenticated) {
        return res.status(401).json({ error: 'Must be logged in' });
    }

    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const userId = req.session.user?.id;
    await userStore.storeAppPassword(userId, username, password);
    res.json({ success: true, message: 'App password saved securely' });
});

router.delete('/app-password', async (req, res) => {
    if (!req.session.isAuthenticated) {
        return res.status(401).json({ error: 'Must be logged in' });
    }

    const userId = req.session.user?.id;
    await userStore.deleteAppPassword(userId);
    res.json({ success: true });
});


// === Beta Features Management API (Admin Only) ===

const { BETA_FEATURES, getOrgBetaFeatures, setOrgBetaFeatures } = require('../core/betaFeatures');

// Get the full beta feature registry + per-org assignments
router.get('/beta-features', requireAdmin, async (req, res) => {
    const orgs = await userStore.getAllOrganizations();
    const assignments = {};
    for (const org of orgs) {
        assignments[org.id] = await getOrgBetaFeatures(org.id);
    }
    res.json({ registry: BETA_FEATURES, assignments });
});

// Set beta features for an organization
router.put('/organizations/:orgId/beta-features', requireOrgAdmin('orgId'), async (req, res) => {
    const { orgId } = req.params;
    const { features } = req.body;

    if (!Array.isArray(features)) {
        return res.status(400).json({ error: 'features must be an array of feature IDs' });
    }

    if (await setOrgBetaFeatures(orgId, features)) {
        const updatedFeatures = await getOrgBetaFeatures(orgId);
        res.json({ success: true, features: updatedFeatures });
    } else {
        res.status(500).json({ error: 'Failed to update beta features' });
    }
});

// === Default Integrations Config (Super Admin Only) ===

const configStore = require('../stores/configStore');

// All available integration IDs
const ALL_INTEGRATIONS = [
    { id: 'gmail', label: 'Gmail' },
    { id: 'google-calendar', label: 'Calendar' },
    { id: 'google-drive', label: 'Drive' },
    { id: 'google-docs', label: 'Docs' },
    { id: 'image-gen', label: 'Image Generation' },
    { id: 'fireflies', label: 'Fireflies' },
    { id: 'youtrack', label: 'YouTrack' },
    { id: 'gamma', label: 'Gamma' },
    { id: 'n8n', label: 'n8n' },
];

router.get('/default-integrations', requireAdmin, async (req, res) => {
    const defaults = await configStore.getConfig('default_org_integrations') || null;
    // Include installed MCP servers
    let mcpIntegrations = [];
    try {
        const mcpStore = require('../stores/mcpStore');
        const mcpServers = await mcpStore.listServers();
        mcpIntegrations = mcpServers.map(s => ({
            id: `mcp:${s.id}`,
            label: s.name,
            category: 'MCP',
            icon: s.icon || '🔌',
        }));
    } catch (e) { /* mcpStore not available */ }
    res.json({ integrations: [...ALL_INTEGRATIONS, ...mcpIntegrations], defaults });
});

router.put('/default-integrations', requireAdmin, async (req, res) => {
    const { defaults } = req.body;
    // defaults = null means all enabled, or array of enabled IDs
    await configStore.setConfig('default_org_integrations', defaults === null ? null : defaults);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// ── Invitations ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════
const invitationStore = require('../stores/invitationStore');
const { sendInvitationEmail } = require('../utils/emailService');

// Create invitation + send email
router.post('/invitations', requireAuth, async (req, res) => {
    try {
        const { email, role } = req.body;
        if (!email) return res.status(400).json({ error: 'Email is required' });

        const userId = req.session?.user?.id;
        const user = await userStore.getUser(userId);
        if (!user) return res.status(401).json({ error: 'Not authenticated' });

        // Must be org admin
        const orgId = user.organizationId;
        if (!orgId) return res.status(403).json({ error: 'You are not part of an organisation' });
        if (!(await isOrgAdminForOrg(req, orgId))) {
            return res.status(403).json({ error: 'Only organisation admins can send invitations' });
        }

        // Check if user already exists with this email
        const existingUser = await userStore.getUserByEmail(email);
        if (existingUser && existingUser.organizationId === orgId) {
            return res.status(409).json({ error: 'A user with this email is already in your organisation' });
        }

        // Create invitation token
        const invitation = await invitationStore.createInvitation({
            email,
            organizationId: orgId,
            invitedBy: userId,
            role: role || 'user',
        });
        if (!invitation) return res.status(500).json({ error: 'Failed to create invitation' });

        // Build invite URL
        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.ai'}`;
        const inviteUrl = `${clientHost}/login?invite=${invitation.token}`;

        // Get org name and inviter display name
        const org = await userStore.getOrganization(orgId);
        const orgName = org?.name || 'your organisation';
        const inviterName = user.displayName || user.username || 'A team member';

        // Send email
        const emailResult = await sendInvitationEmail({
            email,
            orgName,
            inviterName,
            inviteUrl,
            role: role || 'user',
        });

        if (!emailResult.success) {
            console.error('[Invitations] Email send failed:', emailResult.error);
            // Still return the invitation — admin can share the link manually
        }

        res.json({
            success: true,
            invitation: {
                id: invitation.id,
                email,
                expiresAt: invitation.expiresAt,
            },
            emailSent: emailResult.success,
            emailError: emailResult.success ? undefined : emailResult.error,
            inviteUrl, // fallback for manual sharing
        });
    } catch (err) {
        console.error('[Invitations] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// List invitations for the current user's organisation
router.get('/invitations', requireAuth, async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        const user = await userStore.getUser(userId);
        if (!user?.organizationId) return res.json([]);

        if (!(await isOrgAdminForOrg(req, user.organizationId))) {
            return res.status(403).json({ error: 'Only organisation admins can view invitations' });
        }

        const invitations = await invitationStore.getInvitationsForOrg(user.organizationId);

        // Enrich with inviter display name
        const enriched = await Promise.all(invitations.map(async (inv) => {
            const inviter = await userStore.getUser(inv.invited_by);
            return { ...inv, inviterName: inviter?.displayName || inviter?.username || 'Unknown' };
        }));

        res.json(enriched);
    } catch (err) {
        console.error('[Invitations] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Revoke an invitation
router.delete('/invitations/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        const user = await userStore.getUser(userId);
        if (!user?.organizationId) return res.status(403).json({ error: 'Not in an organisation' });
        if (!(await isOrgAdminForOrg(req, user.organizationId))) {
            return res.status(403).json({ error: 'Only organisation admins can revoke invitations' });
        }

        const revoked = await invitationStore.deleteInvitation(req.params.id);
        res.json({ success: revoked });
    } catch (err) {
        console.error('[Invitations] Revoke error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
