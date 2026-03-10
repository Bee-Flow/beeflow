/**
 * Google Calendar API routes — execute calendar actions after user approval
 */
const express = require('express');
const router = express.Router();
const { executeCalendarAction } = require('../../integrations/calendarTools');

/**
 * POST /api/integrations/calendar/execute
 * Execute a calendar action (create/update/delete) after user approval.
 */
router.post('/execute', async (req, res) => {
    try {
        if (!req.session?.accessToken) {
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }
        const action = req.body;
        if (!action?.action) {
            return res.status(400).json({ error: 'Missing action field' });
        }
        const result = await executeCalendarAction(action, req.session);
        res.json(result);
    } catch (err) {
        console.error('[Calendar] Execute action failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
