/**
 * Swarm Config API Routes
 * CRUD endpoints for managing swarm agent configurations
 */

const express = require('express');
const router = express.Router();
const swarmStore = require('../stores/swarmStore');
const { resolveUserOrgIds } = require('../auth');

// GET /swarms — List all swarm configs
router.get('/', async (req, res) => {
    try {
        let swarms = await swarmStore.getAllSwarms();

        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null) {
            swarms = swarms.filter(s => orgIds.has(s.organization_id));
        }

        res.json(swarms);
    } catch (err) {
        console.error('[Swarms] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /swarms/:id — Get a single swarm config
router.get('/:id', async (req, res) => {
    try {
        const swarm = await swarmStore.getSwarm(req.params.id);
        if (!swarm) return res.status(404).json({ error: 'Swarm not found' });
        res.json(swarm);
    } catch (err) {
        console.error('[Swarms] Get error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /swarms — Create a new swarm config
router.post('/', async (req, res) => {
    try {
        const data = { ...req.body };
        // If no system_prompt provided, generate the default orchestrator prompt
        if (!data.system_prompt) {
            const swarmOrchestrator = require('../agents/swarm/orchestrator');
            data.system_prompt = swarmOrchestrator.generateOrchestratorPrompt(data);
        }

        if (!data.organization_id) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                data.organization_id = Array.from(orgIds)[0];
            }
        }

        const swarm = await swarmStore.createSwarm(data);
        res.status(201).json(swarm);
    } catch (err) {
        console.error('[Swarms] Create error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /swarms/:id — Update a swarm config
router.put('/:id', async (req, res) => {
    try {
        const data = { ...req.body };

        // Ensure it retains or gets an organization
        if (data.organization_id === undefined) {
            const existing = await swarmStore.getSwarm(req.params.id);
            data.organization_id = existing ? existing.organization_id : null;
        }

        if (!data.organization_id) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                data.organization_id = Array.from(orgIds)[0];
            }
        }

        const swarm = await swarmStore.updateSwarm(req.params.id, data);
        if (!swarm) return res.status(404).json({ error: 'Swarm not found' });
        res.json(swarm);
    } catch (err) {
        console.error('[Swarms] Update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /swarms/:id — Delete a swarm config
router.delete('/:id', async (req, res) => {
    try {
        await swarmStore.deleteSwarm(req.params.id);
        res.json({ success: true });
    } catch (err) {
        console.error('[Swarms] Delete error:', err);
        res.status(400).json({ error: err.message });
    }
});

module.exports = router;
