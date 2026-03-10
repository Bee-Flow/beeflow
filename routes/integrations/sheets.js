/**
 * Google Sheets API routes — execute spreadsheet actions after user approval
 */
const express = require('express');
const router = express.Router();
const { executeSheetsAction } = require('../../integrations/sheetsTools');

/**
 * POST /api/integrations/sheets/execute
 * Execute a sheets action (create/append/update) after user approval.
 * Receives the draft data (potentially edited by the user in the inline table editor).
 */
router.post('/execute', async (req, res) => {
    try {
        if (!req.session?.accessToken) {
            return res.status(401).json({ error: 'Not authenticated with Google' });
        }
        const action = req.body;
        if (!action?.operation) {
            return res.status(400).json({ error: 'Missing operation field' });
        }
        const result = await executeSheetsAction(action, req.session);
        res.json(result);
    } catch (err) {
        console.error('[Sheets] Execute action failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
