/**
 * Group Chat API Routes — CRUD for multi-agent group chats
 */

const express = require('express');
const router = express.Router();
const groupChatStore = require('../stores/groupChatStore');
const { resolveUserOrgIds } = require('../auth');
const { getEffectiveUserId } = require('../utils/routeHelpers');

// ── GET /group-chats — List all group chats for user ───────────
router.get('/', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        let groupChats = await groupChatStore.getGroupChats(userId);

        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null) {
            groupChats = groupChats.filter(g => orgIds.has(g.organization_id));
        }

        res.json(groupChats);
    } catch (error) {
        console.error('[GroupChats] List error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ── POST /group-chats — Create a new group chat ───────────────
router.post('/', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const { name, description, avatar, participantIds, turnMode, config, organization_id } = req.body;

        if (!name) return res.status(400).json({ error: 'Name is required' });
        if (!participantIds || participantIds.length < 2) {
            return res.status(400).json({ error: 'At least 2 participant agents are required' });
        }

        // Auto-assign the user's first organization if none provided
        let assignOrgId = organization_id;
        if (!assignOrgId) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                assignOrgId = Array.from(orgIds)[0];
            }
        }

        const groupChat = await groupChatStore.createGroupChat(
            name, description, avatar, userId, participantIds, turnMode, config, assignOrgId
        );
        res.status(201).json(groupChat);
    } catch (error) {
        console.error('[GroupChats] Create error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ── GET /group-chats/:id — Get a specific group chat ──────────
router.get('/:id', async (req, res) => {
    try {
        const groupChat = await groupChatStore.getGroupChat(req.params.id);
        if (!groupChat) return res.status(404).json({ error: 'Group chat not found' });
        res.json(groupChat);
    } catch (error) {
        console.error('[GroupChats] Get error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ── PUT /group-chats/:id — Update a group chat ────────────────
router.put('/:id', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const data = { ...req.body };

        // Ensure it retains or gets an organization
        if (data.organization_id === undefined) {
            const existing = await groupChatStore.getGroupChat(req.params.id);
            data.organization_id = existing ? existing.organization_id : null;
        }

        if (!data.organization_id) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                data.organization_id = Array.from(orgIds)[0];
            }
        }

        const updated = await groupChatStore.updateGroupChat(req.params.id, userId, data);
        if (!updated) return res.status(404).json({ error: 'Group chat not found' });
        res.json(updated);
    } catch (error) {
        console.error('[GroupChats] Update error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ── DELETE /group-chats/:id — Delete a group chat ─────────────
router.delete('/:id', async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const deleted = await groupChatStore.deleteGroupChat(req.params.id, userId);
        if (!deleted) return res.status(404).json({ error: 'Group chat not found or access denied' });
        res.json({ success: true });
    } catch (error) {
        console.error('[GroupChats] Delete error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
