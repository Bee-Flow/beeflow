/**
 * Project Routes — REST API for organizing chats into projects.
 *
 * GET    /                          → list user's projects
 * POST   /                          → create project
 * GET    /:id                       → get project details + shares
 * PUT    /:id                       → update project
 * DELETE /:id                       → delete project
 * POST   /:id/share                 → share with user/group
 * DELETE /:id/share/:shareId        → unshare
 * PUT    /:id/conversations         → assign/unassign conversations
 */

const express = require('express');
const router = express.Router();
const projectStore = require('../stores/projectStore');
const userStore = require('../stores/userStore');

function getUserId(req) { return req.session?.user?.id; }
function getUserGroups(req) {
    const groups = req.session?.user?.groups;
    if (Array.isArray(groups)) return groups;
    if (typeof groups === 'string') { try { return JSON.parse(groups); } catch { return []; } }
    return [];
}

// GET / — list user's projects (owned + shared)
router.get('/', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const groupIds = getUserGroups(req);
        const projects = await projectStore.listUserProjects(userId, groupIds);
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
        res.json(project);
    } catch (err) {
        console.error('[Projects] Create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /:id — get project details + shares
router.get('/:id', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });

        // Check access: owner or shared
        if (project.ownerId !== userId) {
            const groupIds = getUserGroups(req);
            const userProjects = await projectStore.listUserProjects(userId, groupIds);
            if (!userProjects.find(p => p.id === project.id)) {
                return res.status(403).json({ error: 'Forbidden' });
            }
        }

        const shares = await projectStore.getProjectShares(project.id);
        res.json({ ...project, shares });
    } catch (err) {
        console.error('[Projects] Get error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /:id — update project
router.put('/:id', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        if (project.ownerId !== userId) return res.status(403).json({ error: 'Only the owner can edit' });

        const { name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories } = req.body;
        const updated = await projectStore.updateProject(req.params.id, {
            name, description, customInstructions, color, icon, knowledgeBaseIds, extractMemories,
        });
        res.json(updated);
    } catch (err) {
        console.error('[Projects] Update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /:id — delete project
router.delete('/:id', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        if (project.ownerId !== userId) return res.status(403).json({ error: 'Only the owner can delete' });

        const ok = await projectStore.deleteProject(req.params.id);
        res.json({ success: ok });
    } catch (err) {
        console.error('[Projects] Delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /:id/share — share with user or group
router.post('/:id/share', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        if (project.ownerId !== userId) return res.status(403).json({ error: 'Only the owner can share' });

        const { sharedWithType, sharedWithId, permission } = req.body;
        if (!sharedWithType || !sharedWithId) return res.status(400).json({ error: 'sharedWithType and sharedWithId required' });
        if (!['user', 'group'].includes(sharedWithType)) return res.status(400).json({ error: 'sharedWithType must be user or group' });

        const shareId = await projectStore.shareProject(req.params.id, sharedWithType, sharedWithId, permission || 'view');
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ shareId, shares });
    } catch (err) {
        console.error('[Projects] Share error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /:id/share/:shareId — remove share
router.delete('/:id/share/:shareId', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });
        if (project.ownerId !== userId) return res.status(403).json({ error: 'Only the owner can manage shares' });

        const ok = await projectStore.unshareProject(req.params.shareId);
        const shares = await projectStore.getProjectShares(req.params.id);
        res.json({ success: ok, shares });
    } catch (err) {
        console.error('[Projects] Unshare error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /:id/conversations — assign/unassign conversations to project
router.put('/:id/conversations', async (req, res) => {
    try {
        const userId = getUserId(req);
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const { assign, unassign } = req.body;
        // assign: [{ id, type: 'direct'|'agent' }]
        // unassign: [{ id, type: 'direct'|'agent' }]

        const results = { assigned: 0, unassigned: 0 };

        if (Array.isArray(assign)) {
            for (const conv of assign) {
                const table = conv.type === 'agent' ? 'agent_conversations' : 'direct_conversations';
                const ok = await projectStore.assignConversation(conv.id, req.params.id, table);
                if (ok) results.assigned++;
            }
        }
        if (Array.isArray(unassign)) {
            for (const conv of unassign) {
                const table = conv.type === 'agent' ? 'agent_conversations' : 'direct_conversations';
                const ok = await projectStore.unassignConversation(conv.id, table);
                if (ok) results.unassigned++;
            }
        }

        res.json({ success: true, ...results });
    } catch (err) {
        console.error('[Projects] Assign conversations error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
