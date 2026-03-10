/**
 * Browser Agent API Routes
 * CRUD endpoints for managing browser agent configurations
 */

const express = require('express');
const router = express.Router();
const browserAgentStore = require('../stores/browserAgentStore');
const { resolveUserOrgIds } = require('../auth');

// GET /browser-agents — List all browser agents
router.get('/', async (req, res) => {
    try {
        let agents = await browserAgentStore.getAllBrowserAgents();

        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null) {
            agents = agents.filter(a => orgIds.has(a.organization_id));
        }

        res.json(agents);
    } catch (err) {
        console.error('[BrowserAgents] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /browser-agents/:id — Get a single browser agent
router.get('/:id', async (req, res) => {
    try {
        const agent = await browserAgentStore.getBrowserAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Browser agent not found' });
        res.json(agent);
    } catch (err) {
        console.error('[BrowserAgents] Get error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /browser-agents — Create a new browser agent
router.post('/', async (req, res) => {
    try {
        const data = { ...req.body };
        if (!data.organization_id) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                data.organization_id = Array.from(orgIds)[0];
            }
        }

        const agent = await browserAgentStore.createBrowserAgent(data);
        res.status(201).json(agent);
    } catch (err) {
        console.error('[BrowserAgents] Create error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /browser-agents/:id — Update a browser agent
router.put('/:id', async (req, res) => {
    try {
        const data = { ...req.body };

        // Ensure it retains or gets an organization
        if (data.organization_id === undefined) {
            const existing = await browserAgentStore.getBrowserAgent(req.params.id);
            data.organization_id = existing ? existing.organization_id : null;
        }

        if (!data.organization_id) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                data.organization_id = Array.from(orgIds)[0];
            }
        }

        const agent = await browserAgentStore.updateBrowserAgent(req.params.id, data);
        if (!agent) return res.status(404).json({ error: 'Browser agent not found' });
        res.json(agent);
    } catch (err) {
        console.error('[BrowserAgents] Update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /browser-agents/:id — Delete a browser agent
router.delete('/:id', async (req, res) => {
    try {
        await browserAgentStore.deleteBrowserAgent(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[BrowserAgents] Delete error:', err);
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
