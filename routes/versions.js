/**
 * Version History API Routes
 * Endpoints for viewing and restoring agent version history.
 */

const express = require('express');
const router = express.Router();
const versionStore = require('../stores/versionStore');
const agentStore = require('../stores/agentStore');

// GET /versions/:agentId — List all versions for an agent
router.get('/:agentId', async (req, res) => {
    try {
        const versions = await versionStore.getVersions(req.params.agentId);
        res.json(versions);
    } catch (err) {
        console.error('[Versions] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /versions/:agentId/:versionId — Get full snapshot of a specific version
router.get('/:agentId/:versionId', async (req, res) => {
    try {
        const version = await versionStore.getVersion(req.params.versionId);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (version.agent_id !== req.params.agentId) return res.status(404).json({ error: 'Version not found for this agent' });
        res.json(version);
    } catch (err) {
        console.error('[Versions] Get error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /versions/:agentId/:versionId/restore — Restore agent to a specific version
router.post('/:agentId/:versionId/restore', async (req, res) => {
    try {
        const version = await versionStore.getVersion(req.params.versionId);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (version.agent_id !== req.params.agentId) return res.status(404).json({ error: 'Version not found for this agent' });

        const snapshot = version.snapshot;
        const agentType = version.agent_type;

        switch (agentType) {
            case 'agent':
                await agentStore.updateAgent(
                    req.params.agentId,
                    snapshot.name,
                    snapshot.description,
                    snapshot.system_prompt,
                    snapshot.owner_id,
                    snapshot.model,
                    typeof snapshot.starter_prompts === 'string' ? JSON.parse(snapshot.starter_prompts || '[]') : (snapshot.starter_prompts || []),
                    snapshot.avatar,
                    snapshot.threads_enabled !== 0,
                    snapshot.copy_enabled !== 0,
                    snapshot.workspace_enabled !== 0,
                    typeof snapshot.config === 'string' ? JSON.parse(snapshot.config || '{}') : (snapshot.config || {}),
                    snapshot.embed_enabled !== 0,
                    snapshot.organization_id,
                    typeof snapshot.shared_groups === 'string' ? JSON.parse(snapshot.shared_groups || '[]') : (snapshot.shared_groups || [])
                );
                break;

            default:
                return res.status(400).json({ error: `Unknown or unsupported agent type: ${agentType}` });
        }

        res.json({ success: true, restoredTo: version.version_number });
    } catch (err) {
        console.error('[Versions] Restore error:', err);
        res.status(500).json({ error: err.message });
    }
});



// DELETE /versions/:agentId/:versionId — Delete a specific version
router.delete('/:agentId/:versionId', async (req, res) => {
    try {
        const deleted = await versionStore.deleteVersion(req.params.versionId);
        if (!deleted) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Versions] Delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
