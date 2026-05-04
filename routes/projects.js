/**
 * Project Routes — REST API for organizing chats into projects.
 *
 * GET    /                          → list user's projects
 * POST   /                          → create project
 * GET    /:id                       → get project details + shares  (viewer+)
 * PUT    /:id                       → update project                (editor+)
 * DELETE /:id                       → delete project                (owner)
 * POST   /:id/share                 → share with user/group         (owner)
 * DELETE /:id/share/:shareId        → unshare                       (owner)
 * PUT    /:id/conversations         → assign/unassign conversations (editor+)
 *
 * Members (members are project_shares; "owner" is implicit via projects.owner_id):
 * GET    /:id/members               → list owner + members          (viewer+)
 * PUT    /:id/members/:memberId     → change a member's role        (owner)
 * DELETE /:id/members/:memberId     → remove a member or self-leave (owner OR self)
 *
 * Activity feed:
 * GET    /:id/activity?limit=&offset=  (viewer+)
 */

const express = require('express');
const router = express.Router();
const projectStore = require('../stores/projectStore');
const userStore = require('../stores/userStore');
const { resolveUserGroups } = require('../auth');

function getUserId(req) { return req.session?.user?.id; }
// Read groups from the DB on every request, not from req.session — group
// removals must take effect without forcing a re-login. Mirrors the pattern
// used by the agents and KB routes.
function getUserGroups(req) {
    return resolveUserGroups(getUserId(req));
}

// ── Role middleware ──────────────────────────────────────
const ROLE_ORDER = { viewer: 0, editor: 1, owner: 2 };

function requireRole(minRole) {
    return async (req, res, next) => {
        try {
            const userId = getUserId(req);
            if (!userId) return res.status(401).json({ error: 'Not authenticated' });
            const role = await projectStore.getProjectRole(userId, req.params.id, await getUserGroups(req));
            if (!role) return res.status(404).json({ error: 'Not found' });
            if (ROLE_ORDER[role] < ROLE_ORDER[minRole]) {
                return res.status(403).json({ error: 'Insufficient permissions' });
            }
            req.projectRole = role;
            next();
        } catch (err) {
            console.error('[Projects] role check failed:', err.message);
            res.status(500).json({ error: err.message });
        }
    };
}

// ── List / create ────────────────────────────────────────

// GET / — list user's projects (owned + shared)
router.get('/', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const projects = await projectStore.listUserProjects(userId, await getUserGroups(req));
        res.json(projects);
    } catch (err) {
        console.error('[Projects] List error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST / — create project
router.post('/', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const { name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

        const organizationId = req.session?.user?.organizationId || '';
        const project = await projectStore.createProject({
            name: name.trim(),
            description,
            customInstructions,
            color,
            icon,
            knowledgeBaseIds,
            extractMemories,
            ownerId: userId,
            organizationId,
        });
        await projectStore.logActivity(project.id, userId, 'project_created', { name: project.name });
        res.json(project);
    } catch (err) {
        console.error('[Projects] Create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Read / update / delete ───────────────────────────────

// GET /:id — get project details + shares
router.get('/:id', requireRole('viewer'), async (req, res) => {
    try {
        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        const shares = await projectStore.getProjectShares(project.id);
        res.json({ ...project, shares, role: req.projectRole });
    } catch (err) {
        console.error('[Projects] Get error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /:id — update project (editor+)
router.put('/:id', requireRole('editor'), async (req, res) => {
    try {
        const userId = getUserId(req);
        const before = await projectStore.getProject(req.params.id);
        if (!before) return res.status(404).json({ error: 'Not found' });

        const { name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories } = req.body;
        const updated = await projectStore.updateProject(req.params.id, {
            name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories,
        });

        // Log activity — diff what changed.
        const changes = {};
        for (const key of ['name', 'description', 'color', 'icon', 'extractMemories']) {
            if (req.body[key] !== undefined && before[key] !== updated[key]) {
                changes[key] = { from: before[key], to: updated[key] };
            }
        }
        if (Object.keys(changes).length > 0) {
            await projectStore.logActivity(req.params.id, userId, 'project_updated', { changes });
        }
        if (req.body.customInstructions !== undefined && before.customInstructions !== updated.customInstructions) {
            await projectStore.logActivity(req.params.id, userId, 'instructions_updated', {});
        }
        if (req.body.knowledgeBaseIds !== undefined) {
            const beforeKBs = new Set(before.knowledgeBaseIds || []);
            const afterKBs = new Set(updated.knowledgeBaseIds || []);
            for (const kb of afterKBs) {
                if (!beforeKBs.has(kb)) {
                    await projectStore.logActivity(req.params.id, userId, 'kb_added', { targetType: 'kb', targetId: kb });
                }
            }
            for (const kb of beforeKBs) {
                if (!afterKBs.has(kb)) {
                    await projectStore.logActivity(req.params.id, userId, 'kb_removed', { targetType: 'kb', targetId: kb });
                }
            }
        }

        res.json(updated);
    } catch (err) {
        console.error('[Projects] Update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /:id — delete project (owner only)
router.delete('/:id', requireRole('owner'), async (req, res) => {
    try {
        const ok = await projectStore.deleteProject(req.params.id);
        // No need to log — the project_activity row cascades away.
        res.json({ success: ok });
    } catch (err) {
        console.error('[Projects] Delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Shares (legacy) — kept for back-compat, aliased to /members semantics ──

// POST /:id/share — share with user or group (owner only)
router.post('/:id/share', requireRole('owner'), async (req, res) => {
    try {
        const userId = getUserId(req);
        const { sharedWithType, sharedWithId, permission } = req.body;
        if (!sharedWithType || !sharedWithId) return res.status(400).json({ error: 'sharedWithType and sharedWithId required' });
        if (!['user', 'group'].includes(sharedWithType)) return res.status(400).json({ error: 'sharedWithType must be user or group' });

        const role = projectStore.normalizePermission(permission || 'viewer');
        if (!['viewer', 'editor'].includes(role)) return res.status(400).json({ error: 'permission must be viewer or editor' });

        // Cross-tenant guard: an owner could otherwise share their project
        // with a foreign-org group ID and leak project content + KB IDs to
        // members of another tenant. Match the target group's org against
        // the project's org before persisting.
        if (sharedWithType === 'group') {
            const project = await projectStore.getProject(req.params.id);
            const allGroups = await userStore.getAllGroups();
            const targetGroup = allGroups.find(g => g.id === sharedWithId);
            if (!targetGroup) return res.status(400).json({ error: 'Unknown group' });
            if (project?.organizationId && targetGroup.organizationId !== project.organizationId) {
                return res.status(400).json({ error: 'Group does not belong to this project\'s organisation' });
            }
        }

        const shareId = await projectStore.shareProject(req.params.id, sharedWithType, sharedWithId, role, userId);
        await projectStore.logActivity(req.params.id, userId, 'member_added', {
            targetType: sharedWithType, targetId: sharedWithId, role,
        });
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ shareId, shares });
    } catch (err) {
        console.error('[Projects] Share error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /:id/share/:shareId — remove share (owner only)
router.delete('/:id/share/:shareId', requireRole('owner'), async (req, res) => {
    try {
        const userId = getUserId(req);
        const share = await projectStore.getShareById(req.params.shareId);
        const ok = await projectStore.unshareProject(req.params.shareId);
        if (share) {
            await projectStore.logActivity(req.params.id, userId, 'member_removed', {
                targetType: share.sharedWithType, targetId: share.sharedWithId,
            });
        }
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ success: ok, shares });
    } catch (err) {
        console.error('[Projects] Unshare error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Members API ──────────────────────────────────────────

// GET /:id/members — owner + members list (viewer+)
router.get('/:id/members', requireRole('viewer'), async (req, res) => {
    try {
        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ ownerId: project.ownerId, members: shares });
    } catch (err) {
        console.error('[Projects] Members list error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /:id/members/:memberId — change role (owner only)
router.put('/:id/members/:memberId', requireRole('owner'), async (req, res) => {
    try {
        const userId = getUserId(req);
        const { role } = req.body;
        const normalized = projectStore.normalizePermission(role);
        if (!['viewer', 'editor'].includes(normalized)) return res.status(400).json({ error: 'role must be viewer or editor' });

        const before = await projectStore.getShareById(req.params.memberId);
        if (!before || before.projectId !== req.params.id) return res.status(404).json({ error: 'Member not found' });

        const ok = await projectStore.updateMemberRole(req.params.memberId, normalized);
        if (!ok) return res.status(404).json({ error: 'Member not found' });

        await projectStore.logActivity(req.params.id, userId, 'member_role_changed', {
            targetType: before.sharedWithType, targetId: before.sharedWithId,
            from: before.permission, to: normalized,
        });
        res.json({ success: true });
    } catch (err) {
        console.error('[Projects] Update member error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /:id/members/:memberId — owner removes OR member self-leaves
router.delete('/:id/members/:memberId', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        const share = await projectStore.getShareById(req.params.memberId);
        if (!share || share.projectId !== req.params.id) return res.status(404).json({ error: 'Member not found' });

        const isOwner = project.ownerId === userId;
        const isSelf = share.sharedWithType === 'user' && share.sharedWithId === userId;
        if (!isOwner && !isSelf) return res.status(403).json({ error: 'Forbidden' });

        const ok = await projectStore.unshareProject(req.params.memberId);
        await projectStore.logActivity(req.params.id, userId, 'member_removed', {
            targetType: share.sharedWithType, targetId: share.sharedWithId,
            selfLeave: isSelf && !isOwner,
        });
        res.json({ success: ok });
    } catch (err) {
        console.error('[Projects] Remove member error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Activity feed ────────────────────────────────────────

router.get('/:id/activity', requireRole('viewer'), async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = parseInt(req.query.offset, 10) || 0;
        const items = await projectStore.listActivity(req.params.id, limit, offset);
        res.json(items);
    } catch (err) {
        console.error('[Projects] Activity error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── Conversation assignment ──────────────────────────────

// PUT /:id/conversations — assign/unassign conversations (editor+)
router.put('/:id/conversations', requireRole('editor'), async (req, res) => {
    try {
        const userId = getUserId(req);
        const { assign, unassign } = req.body;
        // assign: [{ id, type: 'direct'|'agent' }]
        // unassign: [{ id, type: 'direct'|'agent' }]

        const results = { assigned: 0, unassigned: 0 };

        if (Array.isArray(assign)) {
            for (const conv of assign) {
                const table = conv.type === 'agent' ? 'agent_conversations' : 'direct_conversations';
                const ok = await projectStore.assignConversation(conv.id, req.params.id, table);
                if (ok) {
                    results.assigned++;
                    await projectStore.logActivity(req.params.id, userId, 'conversation_assigned', {
                        targetType: 'conversation', targetId: conv.id, conversationType: conv.type,
                    });
                }
            }
        }
        if (Array.isArray(unassign)) {
            for (const conv of unassign) {
                const table = conv.type === 'agent' ? 'agent_conversations' : 'direct_conversations';
                const ok = await projectStore.unassignConversation(conv.id, table);
                if (ok) {
                    results.unassigned++;
                    await projectStore.logActivity(req.params.id, userId, 'conversation_unassigned', {
                        targetType: 'conversation', targetId: conv.id, conversationType: conv.type,
                    });
                }
            }
        }

        res.json({ success: true, ...results });
    } catch (err) {
        console.error('[Projects] Assign conversations error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
