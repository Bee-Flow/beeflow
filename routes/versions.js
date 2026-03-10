/**
 * Version History API Routes
 * Endpoints for viewing and restoring agent version history.
 */

const express = require('express');
const router = express.Router();
const versionStore = require('../stores/versionStore');
const agentStore = require('../stores/agentStore');
const browserAgentStore = require('../stores/browserAgentStore');
const terminalAgentStore = require('../stores/terminalAgentStore');
const swarmStore = require('../stores/swarmStore');

// GET /versions/:agentId — List all versions for an agent
router.get('/:agentId', async (req, res) => {
    try {
        const versions = versionStore.getVersions(req.params.agentId);
        res.json(versions);
    } catch (err) {
        console.error('[Versions] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /versions/:agentId/:versionId — Get full snapshot of a specific version
router.get('/:agentId/:versionId', async (req, res) => {
    try {
        const version = versionStore.getVersion(req.params.versionId);
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
        const version = versionStore.getVersion(req.params.versionId);
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

            case 'browser_agent':
                await browserAgentStore.updateBrowserAgent(req.params.agentId, {
                    name: snapshot.name,
                    description: snapshot.description,
                    icon: snapshot.icon,
                    model: snapshot.model,
                    system_prompt: snapshot.system_prompt,
                    config: typeof snapshot.config === 'string' ? JSON.parse(snapshot.config) : snapshot.config,
                    enabled: snapshot.enabled,
                    organization_id: snapshot.organization_id
                });
                break;

            case 'terminal_agent':
                await terminalAgentStore.updateTerminalAgent(req.params.agentId, {
                    name: snapshot.name,
                    description: snapshot.description,
                    icon: snapshot.icon,
                    model: snapshot.model,
                    system_prompt: snapshot.system_prompt,
                    config: typeof snapshot.config === 'string' ? JSON.parse(snapshot.config) : snapshot.config,
                    enabled: snapshot.enabled,
                    organization_id: snapshot.organization_id
                });
                break;

            case 'swarm':
                await swarmStore.updateSwarm(req.params.agentId, {
                    name: snapshot.name,
                    description: snapshot.description,
                    icon: snapshot.icon,
                    type: snapshot.type,
                    model: snapshot.model,
                    system_prompt: snapshot.system_prompt,
                    phases: typeof snapshot.phases === 'string' ? JSON.parse(snapshot.phases) : snapshot.phases,
                    config: typeof snapshot.config === 'string' ? JSON.parse(snapshot.config) : snapshot.config,
                    enabled: snapshot.enabled,
                    organization_id: snapshot.organization_id
                });
                break;

            default:
                return res.status(400).json({ error: `Unknown agent type: ${agentType}` });
        }

        res.json({ success: true, restoredTo: version.version_number });
    } catch (err) {
        console.error('[Versions] Restore error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /versions/:agentId/:versionId/restore-partial — Restore a single phase or worker from a swarm version
router.post('/:agentId/:versionId/restore-partial', async (req, res) => {
    try {
        const version = versionStore.getVersion(req.params.versionId);
        if (!version) return res.status(404).json({ error: 'Version not found' });
        if (version.agent_id !== req.params.agentId) return res.status(404).json({ error: 'Version not found for this agent' });
        if (version.agent_type !== 'swarm') return res.status(400).json({ error: 'Partial restore only supported for swarms' });

        const { type, phaseId, workerIndex } = req.body;
        // type: 'phase' | 'worker'

        const snapshot = version.snapshot;
        const snapshotPhases = typeof snapshot.phases === 'string' ? JSON.parse(snapshot.phases) : (snapshot.phases || []);

        // Get current swarm state
        const current = await swarmStore.getSwarm(req.params.agentId);
        if (!current) return res.status(404).json({ error: 'Swarm not found' });

        let currentPhases = typeof current.phases === 'string' ? JSON.parse(current.phases) : (current.phases || []);

        if (type === 'phase') {
            // Find the phase in the snapshot
            const sourcePhase = snapshotPhases.find(p => p.id === phaseId);
            if (!sourcePhase) return res.status(404).json({ error: 'Phase not found in snapshot' });

            // Replace matching phase or append
            const idx = currentPhases.findIndex(p => p.id === phaseId);
            if (idx >= 0) {
                currentPhases[idx] = sourcePhase;
            } else {
                currentPhases.push(sourcePhase);
            }
        } else if (type === 'worker') {
            // Find the phase and worker in the snapshot
            const sourcePhase = snapshotPhases.find(p => p.id === phaseId);
            if (!sourcePhase) return res.status(404).json({ error: 'Phase not found in snapshot' });
            if (!sourcePhase.agents || workerIndex >= sourcePhase.agents.length) {
                return res.status(404).json({ error: 'Worker not found in snapshot phase' });
            }
            const sourceWorker = sourcePhase.agents[workerIndex];

            // Find or create the target phase
            let targetIdx = currentPhases.findIndex(p => p.id === phaseId);
            if (targetIdx < 0) {
                // Phase doesn't exist in current — add it with just this worker
                currentPhases.push({ ...sourcePhase, agents: [sourceWorker] });
            } else {
                // Find the worker in current phase by role/name match, or by index
                const currentAgents = currentPhases[targetIdx].agents || [];
                const matchIdx = currentAgents.findIndex(a =>
                    (a.role && a.role === sourceWorker.role) || (a.name && a.name === sourceWorker.name)
                );
                if (matchIdx >= 0) {
                    currentAgents[matchIdx] = sourceWorker;
                } else if (workerIndex < currentAgents.length) {
                    currentAgents[workerIndex] = sourceWorker;
                } else {
                    currentAgents.push(sourceWorker);
                }
                currentPhases[targetIdx].agents = currentAgents;
            }
        } else {
            return res.status(400).json({ error: 'type must be "phase" or "worker"' });
        }

        // Update the swarm with the merged phases
        await swarmStore.updateSwarm(req.params.agentId, { phases: currentPhases });

        res.json({ success: true, type, phaseId, restoredFrom: version.version_number });
    } catch (err) {
        console.error('[Versions] Partial restore error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /versions/:agentId/:versionId — Delete a specific version
router.delete('/:agentId/:versionId', async (req, res) => {
    try {
        const deleted = versionStore.deleteVersion(req.params.versionId);
        if (!deleted) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Versions] Delete error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
