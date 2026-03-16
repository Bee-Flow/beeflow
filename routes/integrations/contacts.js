/**
 * Contacts API routes — execute contact actions after user approval
 * Handles both Google Contacts and Microsoft Contacts (via _provider field).
 */
const express = require('express');
const router = express.Router();
const { executeContactsAction } = require('../../integrations/contactsTools');
const { executeMsContactsAction } = require('../../integrations/msContactsTools');

/**
 * POST /api/integrations/contacts/execute
 * Execute a contacts action (create/update) after user approval.
 * Routes to Google or Microsoft contacts based on _provider field.
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
            result = await executeMsContactsAction(action.action, action, req.session);
        } else {
            result = await executeContactsAction(action, req.session);
        }
        res.json(result);
    } catch (err) {
        console.error('[Contacts] Execute action failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

