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
const { loadConfig, saveConfig, requireAuth, requireAdmin, getUserPermissions, SYSTEM_PERMISSIONS, invalidatePermissionCache, invalidateAllPermissionCaches, resolveUserOrgIds, isOrgAdminRole } = require('./permissions');
const { rewrapUserDEKCompat, adminResetUser, getOrCreateUserDEKCompat } = require('./encryption');
const { checkResourceLimits } = require('../core/limits');
const { perUserRateLimit } = require('../utils/perUserRateLimit');

// Invitation flood control. Two layered limits:
//   • per-inviter:  20 invites / hour (rolling)
//   • per-org/day:  200 invites total (we don't bother tracking per IP
//     because invitations require an authenticated session)
// Both run before the route handler so a malicious admin can't bypass by
// rotating accounts within their org.
const invitationInviterLimiter = perUserRateLimit({ windowMs: 60 * 60_000, max: 20 });

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

    // Must be org_admin role (or legacy 'admin' value pre-rename)
    if (!isOrgAdminRole(user.orgRole)) return false;

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

    // Pre-flight UX hint — atomic enforcement happens inside
    // createUserWithSeatCheck (which holds a row lock and re-counts inside
    // the transaction). Without this hint the API still rejects but the
    // user sees a generic create_failed.
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

    try {
        const result = await userStore.createUserWithSeatCheck(newUser, { strict: true });
        if (result.created) {
            console.log(`[Audit] ${req.session.user?.id || 'system'} created user '${username}' in org '${organizationId || 'none'}' with orgRole '${orgRole || 'none'}'`);
            await userStore.logAccessAudit(
                'user.create',
                'user',
                newUser.id,
                req.session.user?.id || null,
                null,
                { username, displayName, role, orgRole: orgRole || '', organizationId: organizationId || null, groups: finalGroups },
                organizationId || null,
            );
            return res.json({ success: true, user: { id: newUser.id, username, displayName, role } });
        }
        if (result.reason === 'duplicate_id') return res.status(400).json({ error: 'User already exists' });
        return res.status(400).json({ error: result.error || 'User already exists' });
    } catch (e) {
        if (e instanceof userStore.SeatCapExceededError) {
            return res.status(403).json({ error: 'seat_cap_exceeded', current: e.current, max: e.max });
        }
        console.error('[adminRoutes] createUser error:', e);
        return res.status(500).json({ error: 'Failed to create user' });
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

    // Snapshot the user's access-relevant fields before mutation so the
    // audit row captures the actual transition rather than just the new
    // state. Failures here are non-fatal — auditing must not block the
    // update.
    let prevUser = null;
    try { prevUser = await userStore.getUser(id); } catch (_) { prevUser = null; }

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
        // Capture only the access-relevant changes for audit (role, orgRole,
        // groups, organizationId, status) — never log password material.
        const ACCESS_FIELDS = ['role', 'orgRole', 'groups', 'organizationId', 'status'];
        const oldVals = {};
        const newVals = {};
        for (const f of ACCESS_FIELDS) {
            if (updates[f] === undefined) continue;
            if (prevUser && JSON.stringify(prevUser[f]) === JSON.stringify(updates[f])) continue;
            oldVals[f] = prevUser ? prevUser[f] : null;
            newVals[f] = updates[f];
        }
        if (Object.keys(newVals).length > 0) {
            await userStore.logAccessAudit(
                'user.update',
                'user',
                id,
                req.session.user?.id || null,
                oldVals,
                newVals,
                (prevUser && prevUser.organizationId) || updates.organizationId || null,
            );
        }
        // Role / orgRole / group changes alter the user's effective permissions.
        await invalidatePermissionCache(id);
        // Bust the requireAuth user-existence cache so a role demotion takes
        // effect on the very next request instead of waiting USER_CHECK_TTL.
        try {
            const { invalidateUserExistenceCache } = require('./permissions');
            await invalidateUserExistenceCache(id);
        } catch (_) { /* optional helper */ }

        // Soft hint when the admin is assigning a *weaker* orgRole than the
        // user already had. Not an error — admins legitimately demote — but
        // the UI can show a confirm prompt before applying. The ranks come
        // from orgRoles.json's effective-permission count (more permissions
        // = "higher").
        let hint = null;
        if (updates.orgRole !== undefined && prevUser?.orgRole && updates.orgRole !== prevUser.orgRole) {
            const RANK = { org_admin: 4, admin: 4, agent_admin: 3, agent_editor: 2, dpo: 2, member: 1, '': 0 };
            const oldRank = RANK[prevUser.orgRole] ?? 1;
            const newRank = RANK[updates.orgRole] ?? 1;
            if (newRank < oldRank) {
                hint = {
                    kind: 'role_downgrade',
                    from: prevUser.orgRole,
                    to: updates.orgRole,
                    message: `Note: '${updates.orgRole || 'no role'}' has fewer permissions than '${prevUser.orgRole}'. The user will lose access to some features immediately.`,
                };
            }
        }
        res.json({ success: true, ...(hint ? { hint } : {}) });
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

    // Capture the user snapshot before destruction so the audit row records
    // who was removed from which org.
    let prevUser = null;
    try { prevUser = await userStore.getUser(id); } catch (_) { prevUser = null; }

    if (await userStore.deleteUser(id)) {
        console.log(`[Audit] ${req.session.user?.id || 'system'} deleted user '${id}'`);
        await userStore.logAccessAudit(
            'user.delete',
            'user',
            id,
            req.session.user?.id || null,
            prevUser ? {
                username: prevUser.username,
                role: prevUser.role,
                orgRole: prevUser.orgRole,
                organizationId: prevUser.organizationId,
                groups: prevUser.groups,
            } : null,
            null,
            prevUser ? prevUser.organizationId : null,
        );
        // Clear any stale permission cache for the deleted user so existing
        // sessions can't continue resolving against the cached snapshot.
        await invalidatePermissionCache(id);
        try {
            const { invalidateUserExistenceCache } = require('./permissions');
            await invalidateUserExistenceCache(id);
            const { bustSessionsForUser } = require('./sessionCache');
            await bustSessionsForUser(id);
        } catch (_) { /* optional */ }
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
        await userStore.logAccessAudit(
            'org.create',
            'organization',
            id,
            req.session.user?.id || null,
            null,
            { name, description: description || '', allowSignup: !!allowSignup },
            id,
        );
        res.json({ success: true, organization: newOrg });
    } else {
        res.status(400).json({ error: 'Organization already exists' });
    }
});

router.get('/organizations/:id', requireOrgAdmin('id'), async (req, res) => {
    const org = await userStore.getOrganization(req.params.id);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json(org);
});

router.put('/organizations/:id', requireOrgAdmin('id'), async (req, res) => {
    const { id } = req.params;
    const { name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod, enabledIntegrations, autoApproveSSO, allowedDomains, usagePooled } = req.body;

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

    const orgUpdates = { name, description, tagline, address, email, phone, website, kvk, vat, logo, footerText, defaultGroups, allowSignup, authMethod: finalAuthMethod, enabledIntegrations: finalIntegrations, autoApproveSSO, allowedDomains: finalAllowedDomains, usagePooled };
    if (await userStore.updateOrganization(id, orgUpdates)) {
        // Record only the access-relevant deltas. existing was loaded above
        // for the authMethod check; reuse it.
        const AUDIT_FIELDS = ['name', 'description', 'tagline', 'address', 'email', 'phone', 'website', 'kvk', 'vat', 'authMethod', 'enabledIntegrations', 'allowSignup', 'autoApproveSSO', 'allowedDomains', 'defaultGroups', 'usagePooled'];
        const oldVals = {};
        const newVals = {};
        for (const f of AUDIT_FIELDS) {
            if (orgUpdates[f] === undefined) continue;
            if (existing && JSON.stringify(existing[f]) === JSON.stringify(orgUpdates[f])) continue;
            oldVals[f] = existing ? existing[f] : null;
            newVals[f] = orgUpdates[f];
        }
        if (Object.keys(newVals).length > 0) {
            await userStore.logAccessAudit(
                'org.update',
                'organization',
                id,
                req.session.user?.id || null,
                oldVals,
                newVals,
                id,
            );
        }
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Organization not found' });
    }
});

router.delete('/organizations/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    // Snapshot the org row before the cascade so the audit trail captures
    // what was destroyed (the row is gone after deleteOrganization).
    let prevOrg = null;
    try { prevOrg = await userStore.getOrganization(id); } catch (_) { prevOrg = null; }
    if (await userStore.deleteOrganization(id)) {
        console.log(`[Audit] ${req.session.user?.id || 'system'} deleted organization '${id}'`);
        await userStore.logAccessAudit(
            'org.delete',
            'organization',
            id,
            req.session.user?.id || null,
            prevOrg,
            null,
            id,
        );
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
        await userStore.logAccessAudit(
            'group.create',
            'group',
            id,
            userId || null,
            null,
            { name, permissions: newGroup.permissions, roles: newGroup.roles, allowedAgentTypes: newGroup.allowedAgentTypes },
            orgId,
        );
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

    // Snapshot the group so the audit row carries the before/after of the
    // access-relevant fields, not just the new state.
    let prevGroup = null;
    try {
        const all = await userStore.getAllGroups();
        prevGroup = all.find(g => g.id === id) || null;
    } catch (_) { prevGroup = null; }

    if (await userStore.updateGroup(id, updates)) {
        console.log(`[Audit] ${userId || 'system'} updated group '${id}' — fields: ${Object.keys(updates).filter(k => updates[k] !== undefined).join(', ')}`);
        const AUDIT_FIELDS = ['permissions', 'roles', 'orgRole', 'allowedAgentTypes', 'allowedTiers', 'organizationId'];
        const oldVals = {};
        const newVals = {};
        for (const f of AUDIT_FIELDS) {
            if (updates[f] === undefined) continue;
            if (prevGroup && JSON.stringify(prevGroup[f]) === JSON.stringify(updates[f])) continue;
            oldVals[f] = prevGroup ? prevGroup[f] : null;
            newVals[f] = updates[f];
        }
        if (Object.keys(newVals).length > 0) {
            await userStore.logAccessAudit(
                'group.update',
                'group',
                id,
                userId || null,
                oldVals,
                newVals,
                (prevGroup && prevGroup.organizationId) || updates.organizationId || null,
            );
        }
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

    // Snapshot before destructive delete so the audit trail records what was
    // removed (the row is gone after deleteGroup).
    let prevGroup = null;
    try {
        const all = await userStore.getAllGroups();
        prevGroup = all.find(g => g.id === id) || null;
    } catch (_) { prevGroup = null; }

    if (await userStore.deleteGroup(id)) {
        console.log(`[Audit] ${userId || 'system'} deleted group '${id}'`);
        await userStore.logAccessAudit(
            'group.delete',
            'group',
            id,
            userId || null,
            prevGroup ? {
                name: prevGroup.name,
                permissions: prevGroup.permissions,
                roles: prevGroup.roles,
                orgRole: prevGroup.orgRole,
                organizationId: prevGroup.organizationId,
            } : null,
            null,
            prevGroup ? prevGroup.organizationId : null,
        );
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
        await userStore.logAccessAudit(
            'role.create',
            'role',
            id,
            req.session.user?.id || null,
            null,
            { name, description: newRole.description, permissions: newRole.permissions },
            null,
        );
        res.json({ success: true, role: newRole });
    } else {
        res.status(400).json({ error: 'Role already exists' });
    }
});

router.put('/roles/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, description, permissions } = req.body;

    let prevRole = null;
    try {
        const all = await userStore.getAllRoles();
        prevRole = all.find(r => r.id === id) || null;
    } catch (_) { prevRole = null; }

    if (await userStore.updateRole(id, { name, description, permissions })) {
        const AUDIT_FIELDS = ['name', 'description', 'permissions'];
        const oldVals = {};
        const newVals = {};
        const incoming = { name, description, permissions };
        for (const f of AUDIT_FIELDS) {
            if (incoming[f] === undefined) continue;
            if (prevRole && JSON.stringify(prevRole[f]) === JSON.stringify(incoming[f])) continue;
            oldVals[f] = prevRole ? prevRole[f] : null;
            newVals[f] = incoming[f];
        }
        if (Object.keys(newVals).length > 0) {
            await userStore.logAccessAudit(
                'role.update',
                'role',
                id,
                req.session.user?.id || null,
                oldVals,
                newVals,
                null,
            );
        }
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

    let prevRole = null;
    try {
        const all = await userStore.getAllRoles();
        prevRole = all.find(r => r.id === id) || null;
    } catch (_) { prevRole = null; }

    if (await userStore.deleteRole(id)) {
        console.log(`[Audit] ${req.session.user?.id || 'system'} deleted role '${id}'`);
        await userStore.logAccessAudit(
            'role.delete',
            'role',
            id,
            req.session.user?.id || null,
            prevRole,
            null,
            null,
        );
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

router.get('/app-password-status', requireAuth, async (req, res) => {
    const userId = req.session.user?.id;
    if (!userId) {
        return res.json({ hasAppPassword: false, isNextcloudUser: false });
    }

    res.json({
        hasAppPassword: await userStore.hasAppPassword(userId),
        isNextcloudUser: !!req.session.accessToken
    });
});

router.post('/create-app-password', requireAuth, async (req, res) => {
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

    // Nextcloud uid for WebDAV Basic auth — falls back to id, then displayName
    const nextcloudUsername = req.session.user?.id || req.session.user?.['display-name'] || userId;

    try {
        // Correct OCS endpoint per Nextcloud docs: /core/getapppassword (not /core/apppassword)
        // https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/ocs-api-overview.html
        // Note: app passwords minted with a Bearer token inherit the OAuth access-token TTL
        // (~10 min). For persistent WebDAV access the user should paste a manually-generated
        // app password via /save-app-password instead.
        const response = await fetch(`${nextcloudUrl}/ocs/v2.php/core/getapppassword`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'OCS-APIRequest': 'true',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const text = await response.text().catch(() => '');
            console.warn(`[Nextcloud] getapppassword failed (${response.status}): ${text.slice(0, 200)}`);
            return res.status(response.status === 403 ? 403 : 502).json({
                error: response.status === 403
                    ? 'Already authenticated with an app password — generate a new one in Nextcloud Settings → Security.'
                    : 'Failed to create app password from Nextcloud'
            });
        }

        const data = await response.json();
        const appPassword = data.ocs?.data?.apppassword;

        if (!appPassword) {
            return res.status(502).json({ error: 'No app password returned by Nextcloud' });
        }

        await userStore.storeAppPassword(userId, nextcloudUsername, appPassword);
        res.json({
            success: true,
            message: 'App password created',
            warning: 'App passwords minted via OAuth inherit the access-token lifetime. For persistent WebDAV access, generate one manually in Nextcloud (Settings → Security) and save it via the password form.'
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/save-app-password', requireAuth, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const userId = req.session.user?.id;
    await userStore.storeAppPassword(userId, username, password);
    res.json({ success: true, message: 'App password saved securely' });
});

router.delete('/app-password', requireAuth, async (req, res) => {
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

// Set beta features for an organization (super-admin allow-list).
// This is the master capability list — org admins use the
// /active-beta-features routes to toggle within this set.
router.put('/organizations/:orgId/beta-features', requireAdmin, async (req, res) => {
    const { orgId } = req.params;
    const { features } = req.body;

    if (!Array.isArray(features)) {
        return res.status(400).json({ error: 'features must be an array of feature IDs' });
    }

    if (await setOrgBetaFeatures(orgId, features)) {
        const updatedFeatures = await getOrgBetaFeatures(orgId);
        // Trim the org-admin "enabled" subset to what's still in the
        // allow-list so a feature pulled by the super admin can't linger.
        try {
            const current = await userStore.getOrgEnabledBetaFeatures(orgId);
            const trimmed = current.filter(id => updatedFeatures.includes(id));
            if (trimmed.length !== current.length) {
                await userStore.setOrgEnabledBetaFeatures(orgId, trimmed);
            }
        } catch (e) { /* non-fatal */ }
        res.json({ success: true, features: updatedFeatures });
    } else {
        res.status(500).json({ error: 'Failed to update beta features' });
    }
});

// ── Org-admin "active" subset routes ─────────────────────────────
// The super admin sets allow-lists (organizations.beta_features and
// organizations.enabledIntegrations). The org admin uses these four
// routes to flip individual items on/off within their allow-list.
// Both layers are intersected at runtime; an item must be in BOTH lists
// to be active.

const { NC_INTEGRATION_ID_SET: NC_ID_SET } = (() => {
    try { return require('../core/ncIntegrationCatalog'); }
    catch (_) { return { NC_INTEGRATION_ID_SET: new Set() }; }
})();

function parseAllowedIntegrations(raw) {
    if (raw === null || raw === undefined) return [];
    if (Array.isArray(raw)) return raw;
    try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
    catch (_) { return []; }
}

router.get('/organizations/:orgId/active-integrations', requireOrgAdmin('orgId'), async (req, res) => {
    try {
        const { orgId } = req.params;
        const org = await userStore.getOrganization(orgId);
        if (!org) return res.status(404).json({ error: 'Organization not found' });
        // Allow-list is the super-admin's enabledIntegrations minus NC IDs
        // (NC is managed by its dedicated panel). null = all enabled, which
        // we materialise via the global default list at request time.
        let allowed;
        const raw = org.enabledIntegrations;
        if (raw === null || raw === undefined) {
            const globalDefaults = await configStore.getConfig('default_org_integrations');
            allowed = globalDefaults ? parseAllowedIntegrations(globalDefaults) : ALL_INTEGRATIONS.map(i => i.id);
        } else {
            allowed = parseAllowedIntegrations(raw);
        }
        allowed = allowed.filter(id => !NC_ID_SET.has(id));
        const enabled = await userStore.getOrgEnabledIntegrations(orgId);
        res.json({ allowed, enabled });
    } catch (e) {
        console.error('[ActiveIntegrations] GET error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.put('/organizations/:orgId/active-integrations', requireOrgAdmin('orgId'), async (req, res) => {
    try {
        const { orgId } = req.params;
        const { enabled } = req.body || {};
        if (!Array.isArray(enabled)) {
            return res.status(400).json({ error: 'enabled must be an array of integration IDs' });
        }
        const org = await userStore.getOrganization(orgId);
        if (!org) return res.status(404).json({ error: 'Organization not found' });
        let allowed;
        const raw = org.enabledIntegrations;
        if (raw === null || raw === undefined) {
            const globalDefaults = await configStore.getConfig('default_org_integrations');
            allowed = globalDefaults ? parseAllowedIntegrations(globalDefaults) : ALL_INTEGRATIONS.map(i => i.id);
        } else {
            allowed = parseAllowedIntegrations(raw);
        }
        const allowedSet = new Set(allowed.filter(id => !NC_ID_SET.has(id)));
        // Intersect — drop anything not in the allow-list (incl. NC IDs).
        const clean = Array.from(new Set(enabled.filter(id => allowedSet.has(id))));
        if (!(await userStore.setOrgEnabledIntegrations(orgId, clean))) {
            return res.status(500).json({ error: 'Failed to save' });
        }
        res.json({ success: true, enabled: clean });
    } catch (e) {
        console.error('[ActiveIntegrations] PUT error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.get('/organizations/:orgId/active-beta-features', requireOrgAdmin('orgId'), async (req, res) => {
    try {
        const { orgId } = req.params;
        const allowed = await getOrgBetaFeatures(orgId); // returns string[] of IDs
        const enabled = await userStore.getOrgEnabledBetaFeatures(orgId);
        res.json({ allowed, enabled, registry: BETA_FEATURES });
    } catch (e) {
        console.error('[ActiveBetaFeatures] GET error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.put('/organizations/:orgId/active-beta-features', requireOrgAdmin('orgId'), async (req, res) => {
    try {
        const { orgId } = req.params;
        const { enabled } = req.body || {};
        if (!Array.isArray(enabled)) {
            return res.status(400).json({ error: 'enabled must be an array of feature IDs' });
        }
        const allowed = await getOrgBetaFeatures(orgId);
        const allowedSet = new Set(allowed);
        const clean = Array.from(new Set(enabled.filter(id => allowedSet.has(id))));
        if (!(await userStore.setOrgEnabledBetaFeatures(orgId, clean))) {
            return res.status(500).json({ error: 'Failed to save' });
        }
        res.json({ success: true, enabled: clean });
    } catch (e) {
        console.error('[ActiveBetaFeatures] PUT error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Self-scoped active-features routes ──────────────────────────
// The org-scoped routes above require the client to know which org it is
// managing. That breaks for super admins (no direct organizationId) and
// for users whose org membership comes through groups — the SPA has no
// reliable way to pick the right org. These "/me" routes resolve the
// caller's primary org from the session instead, so the panel never has
// to guess. Auth is requireAuth + org_admin/all perm so non-admins still
// can't toggle these.

/**
 * Internal helper: resolve the user's "managed" org plus the allow-lists
 * that the active-features panel needs. Returns:
 *   { orgId, allowedBetaFeatures, enabledBetaFeatures,
 *     allowedIntegrations, enabledIntegrations, betaRegistry }
 *
 * - Super admin (resolveUserOrgIds === null) → first org from
 *   getAllOrganizations(); empty everything if no orgs exist.
 * - Org admin / member → first entry of resolveUserOrgIds.
 * - No resolvable org → orgId: null with empty allow-lists so the panel
 *   can render a "not bound" message instead of disappearing.
 */
async function resolveActiveFeaturesContext(req) {
    const userOrgIds = await resolveUserOrgIds(req);
    let orgId = null;
    if (userOrgIds === null) {
        // Super admin — pick first existing org so they get a usable view.
        const all = await userStore.getAllOrganizations().catch(() => []);
        if (Array.isArray(all) && all.length > 0) orgId = all[0].id;
    } else if (userOrgIds.size > 0) {
        orgId = Array.from(userOrgIds)[0];
    }

    if (!orgId) {
        return {
            orgId: null,
            allowedBetaFeatures: [], enabledBetaFeatures: [],
            allowedIntegrations: [], enabledIntegrations: [],
            betaRegistry: BETA_FEATURES,
        };
    }

    const org = await userStore.getOrganization(orgId);

    // Beta allow-list = super admin's grant ∪ features marked `freeForAllOrgs`
    // (open-data sources etc. where a per-org super-admin grant adds friction
    // without security value — the org-admin active toggle is authoritative).
    // The grant overrides the plan cap below; only the freeForAll defaults
    // are capped. An explicit super-admin grant is an authoritative decision
    // that the plan template's ceiling should not silently undo.
    const grantedAllowList = await getOrgBetaFeatures(orgId);
    const freeForAll = BETA_FEATURES.filter(f => f.freeForAllOrgs).map(f => f.id);
    const enabledBetaFeatures = await userStore.getOrgEnabledBetaFeatures(orgId);

    // Integration allow-list = super admin's enabledIntegrations (or global
    // default if null), minus NC IDs (managed separately).
    let allowedIntegrations;
    const raw = org?.enabledIntegrations;
    if (raw === null || raw === undefined) {
        const globalDefaults = await configStore.getConfig('default_org_integrations');
        allowedIntegrations = globalDefaults ? parseAllowedIntegrations(globalDefaults) : ALL_INTEGRATIONS.map(i => i.id);
    } else {
        allowedIntegrations = parseAllowedIntegrations(raw);
    }
    allowedIntegrations = allowedIntegrations.filter(id => !NC_ID_SET.has(id));
    const enabledIntegrations = await userStore.getOrgEnabledIntegrations(orgId);

    // Plan cap applies to plan-driven defaults (freeForAll) and to
    // integrations. Explicit super-admin beta grants override the cap —
    // if a platform admin granted a beta to this org, it surfaces here
    // regardless of the plan template's ceiling.
    let planCappedFreeForAll = freeForAll;
    let planCappedInt = allowedIntegrations;
    try {
        const { getOrgCaps, applyCap } = require('../services/planEntitlements');
        const caps = await getOrgCaps(orgId);
        planCappedFreeForAll = applyCap(freeForAll, caps.betaFeatures);
        planCappedInt = applyCap(allowedIntegrations, caps.integrations);
    } catch (e) {
        console.warn('[ActiveFeatures] plan cap lookup failed:', e.message);
    }
    const allowedBetaFeatures = Array.from(
        new Set([...grantedAllowList, ...planCappedFreeForAll])
    );

    return {
        orgId,
        allowedBetaFeatures, enabledBetaFeatures,
        allowedIntegrations: planCappedInt, enabledIntegrations,
        betaRegistry: BETA_FEATURES,
    };
}

/** Permission check shared by both /me routes. */
async function requireOrgAdminLike(req, res) {
    const userId = req.session?.user?.id;
    if (!userId) { res.status(401).json({ error: 'Not authenticated' }); return false; }
    if (req.session.isAdmin || req.session.user?.role === 'admin') return true;
    const perms = await getUserPermissions(userId, req.session);
    if (perms.includes('all') || perms.includes('org_admin')) return true;
    res.status(403).json({ error: 'Organization admin access required' });
    return false;
}

router.get('/me/active-features', requireAuth, async (req, res) => {
    if (!(await requireOrgAdminLike(req, res))) return;
    try {
        const ctx = await resolveActiveFeaturesContext(req);
        res.json(ctx);
    } catch (e) {
        console.error('[ActiveFeatures] /me GET error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

router.put('/me/active-features', requireAuth, async (req, res) => {
    if (!(await requireOrgAdminLike(req, res))) return;
    try {
        const { betaEnabled, integrationsEnabled } = req.body || {};
        if (betaEnabled !== undefined && !Array.isArray(betaEnabled)) {
            return res.status(400).json({ error: 'betaEnabled must be an array of feature IDs' });
        }
        if (integrationsEnabled !== undefined && !Array.isArray(integrationsEnabled)) {
            return res.status(400).json({ error: 'integrationsEnabled must be an array of integration IDs' });
        }
        const ctx = await resolveActiveFeaturesContext(req);
        if (!ctx.orgId) return res.status(400).json({ error: 'No organisation to update' });

        // Snapshot the current enablement state so the audit row captures the
        // actual transition rather than just the new value.
        const prevBeta = Array.isArray(ctx.enabledBetaFeatures) ? [...ctx.enabledBetaFeatures] : [];
        const prevInt = Array.isArray(ctx.enabledIntegrations) ? [...ctx.enabledIntegrations] : [];
        let savedBeta = ctx.enabledBetaFeatures;
        let savedInt = ctx.enabledIntegrations;

        // Plan caps — an org-admin cannot enable beyond what the plan allows.
        // null cap = unrestricted (legacy plans without the column set).
        const planEntitlements = require('../services/planEntitlements');
        const caps = await planEntitlements.getOrgCaps(ctx.orgId);

        if (Array.isArray(betaEnabled)) {
            // ctx.allowedBetaFeatures is already the authoritative ceiling:
            // super-admin grants override the plan cap, and freeForAll
            // defaults are pre-intersected with the cap. No second cap pass.
            const allowedSet = new Set(ctx.allowedBetaFeatures);
            const clean = Array.from(new Set(betaEnabled.filter(id => allowedSet.has(id))));
            if (!(await userStore.setOrgEnabledBetaFeatures(ctx.orgId, clean))) {
                return res.status(500).json({ error: 'Failed to save beta features' });
            }
            savedBeta = clean;
        }

        if (Array.isArray(integrationsEnabled)) {
            const allowedSet = new Set(ctx.allowedIntegrations);
            let clean = Array.from(new Set(integrationsEnabled.filter(id => allowedSet.has(id))));
            clean = planEntitlements.applyCap(clean, caps.integrations);
            if (!(await userStore.setOrgEnabledIntegrations(ctx.orgId, clean))) {
                return res.status(500).json({ error: 'Failed to save integrations' });
            }
            savedInt = clean;
        }

        // GDPR Art. 30 / SOC 2 — every entitlement mutation needs an audit row.
        // Only fire when at least one of the lists actually changed.
        const betaChanged = Array.isArray(betaEnabled) && JSON.stringify([...prevBeta].sort()) !== JSON.stringify([...savedBeta].sort());
        const intChanged = Array.isArray(integrationsEnabled) && JSON.stringify([...prevInt].sort()) !== JSON.stringify([...savedInt].sort());
        if (betaChanged || intChanged) {
            const oldVals = {};
            const newVals = {};
            if (betaChanged) { oldVals.betaEnabled = prevBeta; newVals.betaEnabled = savedBeta; }
            if (intChanged) { oldVals.integrationsEnabled = prevInt; newVals.integrationsEnabled = savedInt; }
            try {
                await userStore.logAccessAudit(
                    'org.active_features.update',
                    'organization',
                    ctx.orgId,
                    req.session.user?.id || null,
                    oldVals,
                    newVals,
                    ctx.orgId,
                );
            } catch (e) {
                console.warn('[ActiveFeatures] audit log failed:', e.message);
            }
        }

        res.json({ orgId: ctx.orgId, enabledBetaFeatures: savedBeta, enabledIntegrations: savedInt });
    } catch (e) {
        console.error('[ActiveFeatures] /me PUT error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Consumer beta-features (no org) ──────────────────────────────
// Consumer accounts have no organisation, so /me/active-features above
// returns an empty payload for them. Beta grants for consumer users are
// configured deployment-wide in `default_consumer_beta_features` (super
// admin only). This route exposes the resolved list so the personal
// "Beta features" panel can render. Read-only — consumers cannot toggle.
router.get('/me/consumer-features', requireAuth, async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const raw = await require('../stores/configStore').getConfig('default_consumer_beta_features');
        const allowedBetaFeatures = Array.isArray(raw) ? raw : [];
        res.json({ allowedBetaFeatures, betaRegistry: BETA_FEATURES });
    } catch (e) {
        console.error('[ConsumerFeatures] GET error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Self-service leave-org. Lets a member detach themselves from their
// organisation. Anything they own that can't survive an unowned state
// (agents — they have FK constraints, embed flows, etc.) is reassigned to
// a target user the caller specifies, who must be an org_admin of the
// same org. Sole-admin protection: if removing this user would leave the
// org with zero org_admins (and they're an org_admin), the request is
// rejected with 409 — the org would otherwise be unmanageable.
router.post('/users/me/leave-org', requireAuth, async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const me = await userStore.getUser(userId);
        if (!me) return res.status(404).json({ error: 'User not found' });
        const orgId = me.organizationId;
        if (!orgId) return res.status(400).json({ error: 'You are not part of an organization' });

        const { transferTo } = req.body || {};
        if (!transferTo || typeof transferTo !== 'string') {
            return res.status(400).json({ error: 'transferTo (user id) is required' });
        }
        const target = await userStore.getUser(transferTo);
        if (!target || target.organizationId !== orgId) {
            return res.status(400).json({ error: 'transferTo must be a user in your organization' });
        }
        const targetIsOrgAdmin = isOrgAdminRole(target.orgRole);
        if (!targetIsOrgAdmin) {
            return res.status(400).json({ error: 'transferTo must be an organization admin' });
        }

        // Sole-admin protection: count the org's admins excluding self.
        const meIsOrgAdmin = isOrgAdminRole(me.orgRole);
        if (meIsOrgAdmin) {
            const { getAll } = require('../db');
            const others = await getAll(
                `SELECT COUNT(*)::int AS n FROM users WHERE "organizationId" = $1 AND id <> $2 AND "orgRole" IN ('org_admin', 'admin')`,
                [orgId, userId],
            );
            if ((others?.[0]?.n ?? 0) === 0) {
                return res.status(409).json({ error: 'You are the only organization admin. Promote another member before leaving.' });
            }
        }

        // Re-parent owned agents to the target. Bulk update is fine here
        // because we just verified target shares the org. Knowledge bases,
        // skills, automations etc. would follow the same pattern — kept
        // narrow to agents for this change; expand as ownership semantics
        // are formalised for each surface.
        const agentStore = require('../stores/agentStore');
        try {
            const { run } = require('../db');
            await run(
                'UPDATE agents SET owner_id = $1, updated_at = NOW() WHERE owner_id = $2 AND organization_id = $3',
                [transferTo, userId, orgId],
            );
        } catch (e) {
            console.warn('[LeaveOrg] agent reassignment failed:', e.message);
        }

        // Detach the user from the org. Keep the user row itself (don't
        // delete) — they may want to keep their consumer-mode account.
        await userStore.updateUser(userId, {
            organizationId: '',
            orgRole: '',
            groups: [],
        });

        await invalidatePermissionCache(userId);

        await userStore.logAccessAudit(
            'user.leave_org',
            'user',
            userId,
            userId,
            { organizationId: orgId, orgRole: me.orgRole },
            { transferTo },
            orgId,
        );

        res.json({ success: true, transferredTo: transferTo });
    } catch (err) {
        console.error('[LeaveOrg] error:', err);
        res.status(500).json({ error: err.message || 'Failed to leave organization' });
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

// Per-org daily cap. In-memory rolling 24h window keyed on orgId. Cheap,
// resets on process restart (acceptable — the cap is anti-spam, not a hard
// quota). For multi-node deploys, this is per-node; redis would be a future
// upgrade if abuse patterns warrant it.
const ORG_INVITE_DAILY_CAP = 200;
const ORG_INVITE_WINDOW_MS = 24 * 60 * 60_000;
const _orgInviteBuckets = new Map(); // orgId → [timestamps]
function _checkOrgInviteCap(orgId) {
    const now = Date.now();
    const cutoff = now - ORG_INVITE_WINDOW_MS;
    const arr = (_orgInviteBuckets.get(orgId) || []).filter(t => t > cutoff);
    if (arr.length >= ORG_INVITE_DAILY_CAP) return false;
    arr.push(now);
    _orgInviteBuckets.set(orgId, arr);
    return true;
}

// Per-email cooldown — protects an external email from being spammed
// across rotating admin accounts. One hour between invitations to the
// same lower-cased email. Keyed solely on the email so a hostile pair of
// org admins can't take turns.
const EMAIL_INVITE_COOLDOWN_MS = 60 * 60_000;
const _lastInviteByEmail = new Map(); // lowercase email → last ts
function _checkEmailInviteCooldown(email) {
    if (!email) return true;
    const k = String(email).toLowerCase().trim();
    const last = _lastInviteByEmail.get(k) || 0;
    if (Date.now() - last < EMAIL_INVITE_COOLDOWN_MS) return false;
    _lastInviteByEmail.set(k, Date.now());
    return true;
}

// Create invitation + send email
router.post('/invitations', requireAuth, invitationInviterLimiter, async (req, res) => {
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

        // Per-org daily cap. Sits after the auth checks so unauthenticated
        // traffic doesn't pollute the bucket.
        if (!_checkOrgInviteCap(orgId)) {
            return res.status(429).json({ error: `Organisation invitation cap reached (${ORG_INVITE_DAILY_CAP} per 24h). Try again later.` });
        }

        // Per-recipient cooldown — prevents a target email from being
        // spammed even across multiple admin accounts (and orgs).
        if (!_checkEmailInviteCooldown(email)) {
            return res.status(429).json({ error: 'This email was recently invited. Wait an hour before re-inviting.' });
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

        // Build invite URL. Use the path-style redeem endpoint instead of
        // `/login?invite=TOKEN` so the token never appears in the SPA URL
        // bar, the Referer header, or reverse-proxy access logs after the
        // 302 fires. The endpoint moves the token into the session and
        // redirects to /login?signup=1.
        const clientHost = `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
        const inviteUrl = `${clientHost}/api/auth/redeem-invite/${invitation.token}`;

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

        await userStore.logAccessAudit(
            'invitation.create',
            'invitation',
            invitation.id,
            userId || null,
            null,
            { email, role: role || 'user', emailSent: !!emailResult.success },
            orgId,
        );

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

        // Snapshot before destructive delete so the audit trail preserves the
        // grant terms (role, groups, target email, issuer).
        let prevInvite = null;
        try { prevInvite = await invitationStore.getInvitationById(req.params.id); } catch (_) { prevInvite = null; }

        const revoked = await invitationStore.deleteInvitation(req.params.id);
        if (revoked) {
            await userStore.logAccessAudit(
                'invitation.revoke',
                'invitation',
                req.params.id,
                userId || null,
                prevInvite ? {
                    email: prevInvite.email,
                    orgRole: prevInvite.org_role || prevInvite.orgRole,
                    groups: prevInvite.groups,
                    invited_by: prevInvite.invited_by,
                    organization_id: prevInvite.organization_id,
                } : null,
                null,
                user.organizationId,
            );
        }
        res.json({ success: revoked });
    } catch (err) {
        console.error('[Invitations] Revoke error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
