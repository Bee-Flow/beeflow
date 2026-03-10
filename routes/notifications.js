/**
 * Notification Routes — REST API for in-app notifications.
 *
 * GET    /                → list notifications
 * GET    /unread-count    → badge count
 * POST   /:id/read        → mark one as read
 * POST   /read-all        → mark all as read
 * DELETE /:id             → delete one
 */

const express = require('express');
const router = express.Router();
const notificationStore = require('../stores/notificationStore');

// GET / — list notifications
router.get('/', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const unreadOnly = req.query.unread === 'true';
        const limit = parseInt(req.query.limit) || 50;
        const notifications = await notificationStore.getNotifications(userId, { unreadOnly, limit });
        res.json({ notifications });
    } catch (err) {
        console.error('[Notifications] List error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET /unread-count — quick badge count
router.get('/unread-count', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const count = await notificationStore.getUnreadCount(userId);
        res.json({ count });
    } catch (err) {
        console.error('[Notifications] Count error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /read-all — mark all as read (must be before /:id/read to avoid route conflict)
router.post('/read-all', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const count = await notificationStore.markAllRead(userId);
        res.json({ success: true, marked: count });
    } catch (err) {
        console.error('[Notifications] Mark all read error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /:id/read — mark one as read
router.post('/:id/read', async (req, res) => {
    try {
        const ok = await notificationStore.markRead(req.params.id);
        res.json({ success: ok });
    } catch (err) {
        console.error('[Notifications] Mark read error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /:id — delete one
router.delete('/:id', async (req, res) => {
    try {
        const ok = await notificationStore.deleteNotification(req.params.id);
        res.json({ success: ok });
    } catch (err) {
        console.error('[Notifications] Delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
