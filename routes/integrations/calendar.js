/**
 * Calendar API routes — execute calendar actions after user approval
 * Handles both Google Calendar and Microsoft Calendar (via _provider field).
 */
const express = require('express');
const router = express.Router();
const { executeCalendarAction } = require('../../integrations/calendarTools');
const { executeMsCalendarAction } = require('../../integrations/msCalendarTools');

/**
 * POST /api/integrations/calendar/execute
 * Execute a calendar action (create/update/delete) after user approval.
 * Routes to Google or Microsoft calendar based on _provider field.
 */
router.post('/execute', async (req, res) => {
    try {
        if (!req.session?.accessToken) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const action = req.body;
        if (!action?.action) {
            return res.status(400).json({ error: 'Missing action field' });
        }

        let result;
        if (action._provider === 'microsoft') {
            result = await executeMsCalendarAction(action.action, action, req.session);
        } else {
            result = await executeCalendarAction(action, req.session);
        }
        res.json(result);
    } catch (err) {
        console.error('[Calendar] Execute action failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

