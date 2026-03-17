/**
 * Terminal Agent API Routes
 * CRUD endpoints for managing terminal agent configurations
 * Includes file attachment management for pre-loading files into containers.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const terminalAgentStore = require('../stores/terminalAgentStore');
const { resolveUserOrgIds } = require('../auth');

// ── File storage setup ───────────────────────────────────────────
const FILES_BASE_DIR = path.join(__dirname, '..', 'data', 'terminal-agent-files');

const fileUpload = multer({
    storage: multer.diskStorage({
        destination: (req, _file, cb) => {
            const dir = path.join(FILES_BASE_DIR, req.params.id);
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (_req, file, cb) => {
            // Keep original filename, sanitize slashes/nulls
            const safe = file.originalname.replace(/[/\\:\0]/g, '_');
            cb(null, safe);
        }
    }),
    limits: { fileSize: 20 * 1024 * 1024 } // 20 MB
});

// GET /terminal-agents — List all terminal agents
router.get('/', async (req, res) => {
    try {
        let agents = await terminalAgentStore.getAllTerminalAgents();

        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null) {
            agents = agents.filter(a => orgIds.has(a.organization_id));
        }

        res.json(agents);
    } catch (err) {
        console.error('[TerminalAgents] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /terminal-agents/:id — Get a single terminal agent
router.get('/:id', async (req, res) => {
    try {
        const agent = await terminalAgentStore.getTerminalAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Terminal agent not found' });
        res.json(agent);
    } catch (err) {
        console.error('[TerminalAgents] Get error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /terminal-agents — Create a new terminal agent
router.post('/', async (req, res) => {
    try {
        const data = { ...req.body };
        if (!data.organization_id) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                data.organization_id = Array.from(orgIds)[0];
            }
        }

        const agent = await terminalAgentStore.createTerminalAgent(data);
        res.status(201).json(agent);
    } catch (err) {
        console.error('[TerminalAgents] Create error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /terminal-agents/:id — Update a terminal agent
router.put('/:id', async (req, res) => {
    try {
        const data = { ...req.body };

        // Ensure it retains or gets an organization
        if (data.organization_id === undefined) {
            const existing = await terminalAgentStore.getTerminalAgent(req.params.id);
            data.organization_id = existing ? existing.organization_id : null;
        }

        if (!data.organization_id) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                data.organization_id = Array.from(orgIds)[0];
            }
        }

        const agent = await terminalAgentStore.updateTerminalAgent(req.params.id, data);
        if (!agent) return res.status(404).json({ error: 'Terminal agent not found' });
        res.json(agent);
    } catch (err) {
        console.error('[TerminalAgents] Update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /terminal-agents/:id — Delete a terminal agent
router.delete('/:id', async (req, res) => {
    try {
        await terminalAgentStore.deleteTerminalAgent(req.params.id);
        // Also clean up attached files
        const dir = path.join(FILES_BASE_DIR, req.params.id);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[TerminalAgents] Delete error:', err);
        res.status(400).json({ error: err.message });
    }
});

// ── File Attachment Endpoints ────────────────────────────────────

// GET /terminal-agents/:id/files — List attached files
router.get('/:id/files', async (req, res) => {
    try {
        const dir = path.join(FILES_BASE_DIR, req.params.id);
        if (!fs.existsSync(dir)) return res.json([]);
        const files = fs.readdirSync(dir).map(name => {
            const stat = fs.statSync(path.join(dir, name));
            return { name, size: stat.size, modified: stat.mtime };
        });
        res.json(files);
    } catch (err) {
        console.error('[TerminalAgents] List files error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /terminal-agents/:id/files — Upload a file
router.post('/:id/files', fileUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        console.log(`[TerminalAgents] File uploaded: ${req.file.originalname} (${req.file.size} bytes) for agent ${req.params.id}`);
        res.json({ name: req.file.filename, size: req.file.size });
    } catch (err) {
        console.error('[TerminalAgents] Upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /terminal-agents/:id/files/:filename — Delete an attached file
router.delete('/:id/files/:filename', async (req, res) => {
    try {
        const filePath = path.join(FILES_BASE_DIR, req.params.id, req.params.filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        fs.unlinkSync(filePath);
        console.log(`[TerminalAgents] File deleted: ${req.params.filename} from agent ${req.params.id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[TerminalAgents] Delete file error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
