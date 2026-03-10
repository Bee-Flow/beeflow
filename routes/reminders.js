/**
 * Reminder Routes — REST API for user-bound reminders.
 *
 * GET    /              → list user's reminders
 * POST   /              → create reminder
 * PUT    /:id           → update reminder
 * DELETE /:id           → delete reminder
 * POST   /:id/complete  → mark completed
 */

const express = require('express');
const router = express.Router();
const reminderStore = require('../stores/reminderStore');

// GET / — list reminders
router.get('/', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const includeCompleted = req.query.completed === 'true';
        const reminders = await reminderStore.getReminders(userId, { includeCompleted });
        res.json(reminders);
    } catch (err) {
        console.error('[Reminders] List error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST / — create reminder
router.post('/', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const { title, message, remindAt, repeatInterval } = req.body;
        if (!title || !title.trim()) return res.status(400).json({ error: 'Title is required' });
        if (!remindAt) return res.status(400).json({ error: 'remindAt is required' });

        const reminder = await reminderStore.createReminder({
            userId,
            title: title.trim(),
            message,
            remindAt,
            repeatInterval,
        });
        res.json(reminder);
    } catch (err) {
        console.error('[Reminders] Create error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// PUT /:id — update reminder
router.put('/:id', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        // Verify ownership
        const existing = await reminderStore.getReminder(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        const { title, message, remindAt, repeatInterval } = req.body;
        const ok = await reminderStore.updateReminder(req.params.id, {
            title, message, remindAt, repeatInterval,
        });
        res.json({ success: ok });
    } catch (err) {
        console.error('[Reminders] Update error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /:id — delete reminder
router.delete('/:id', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const existing = await reminderStore.getReminder(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        const ok = await reminderStore.deleteReminder(req.params.id);
        res.json({ success: ok });
    } catch (err) {
        console.error('[Reminders] Delete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /:id/complete — mark completed
router.post('/:id/complete', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const existing = await reminderStore.getReminder(req.params.id);
        if (!existing) return res.status(404).json({ error: 'Not found' });
        if (existing.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

        const ok = await reminderStore.markCompleted(req.params.id);
        res.json({ success: ok });
    } catch (err) {
        console.error('[Reminders] Complete error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
