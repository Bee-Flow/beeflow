/**
 * Security Agent API Routes
 * CRUD endpoints for managing security agent configurations.
 * Includes file attachment management for custom Nuclei templates.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const securityAgentStore = require('../stores/securityAgentStore');
const { resolveUserOrgIds } = require('../auth');

// Map security agent DB row to AgentDesigner-compatible format
function normalizeAgent(a) {
    return {
        ...a,
        avatar: a.icon || '🛡️',
        system_prompt: a.system_prompt || '',
        is_published: a.enabled ? 1 : 0,
        tools: a.config?.tools || [],
        tool_params: a.config?.toolParams || {},
        is_security_agent: true,
    };
}

// ── File storage setup ───────────────────────────────────────────
const FILES_BASE_DIR = path.join(__dirname, '..', 'data', 'security-agent-files');

const fileUpload = multer({
    storage: multer.diskStorage({
        destination: (req, _file, cb) => {
            const dir = path.join(FILES_BASE_DIR, req.params.id);
            fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (_req, file, cb) => {
            const safe = file.originalname.replace(/[/\\:\0]/g, '_');
            cb(null, safe);
        }
    }),
    limits: { fileSize: 20 * 1024 * 1024 } // 20 MB
});

// GET /security-agents — List all security agents
router.get('/', async (req, res) => {
    try {
        let agents = await securityAgentStore.getAllSecurityAgents();

        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null) {
            agents = agents.filter(a => !a.organization_id || orgIds.has(a.organization_id));
        }

        res.json(agents.map(normalizeAgent));
    } catch (err) {
        console.error('[SecurityAgents] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /security-agents/:id — Get a single security agent
router.get('/:id', async (req, res) => {
    try {
        const agent = await securityAgentStore.getSecurityAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Security agent not found' });
        res.json(normalizeAgent(agent));
    } catch (err) {
        console.error('[SecurityAgents] Get error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /security-agents — Create a new security agent
router.post('/', async (req, res) => {
    try {
        const body = req.body;
        const data = {
            name: body.name,
            description: body.description || '',
            icon: body.avatar || body.icon || '🛡️',
            model: body.model || null,
            system_prompt: body.systemPrompt ?? body.system_prompt ?? '',
            config: body.config || undefined,
            enabled: body.enabled !== undefined ? body.enabled : true,
        };
        if (!data.organization_id) {
            const orgIds = await resolveUserOrgIds(req);
            if (orgIds !== null && orgIds.size > 0) {
                data.organization_id = Array.from(orgIds)[0];
            }
        }

        const agent = await securityAgentStore.createSecurityAgent(data);
        // Return in AgentDesigner-compatible format
        res.status(201).json(normalizeAgent(agent));
    } catch (err) {
        console.error('[SecurityAgents] Create error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PUT /security-agents/:id — Update a security agent
router.put('/:id', async (req, res) => {
    try {
        const body = req.body;
        const data = {
            name: body.name,
            description: body.description,
            icon: body.avatar || body.icon,
            model: body.model !== undefined ? (body.model || null) : undefined,
            system_prompt: body.systemPrompt ?? body.system_prompt,
            config: body.config,
        };

        // Remove undefined keys so store preserves existing values
        Object.keys(data).forEach(k => data[k] === undefined && delete data[k]);

        const agent = await securityAgentStore.updateSecurityAgent(req.params.id, data);
        if (!agent) return res.status(404).json({ error: 'Security agent not found' });
        res.json(normalizeAgent(agent));
    } catch (err) {
        console.error('[SecurityAgents] Update error:', err);
        res.status(500).json({ error: err.message });
    }
});

// PATCH /security-agents/:id/publish — Toggle publish state
router.patch('/:id/publish', async (req, res) => {
    try {
        const { isPublished } = req.body;
        const agent = await securityAgentStore.updateSecurityAgent(req.params.id, {
            enabled: isPublished ? true : false
        });
        if (!agent) return res.status(404).json({ error: 'Security agent not found' });
        res.json(normalizeAgent(agent));
    } catch (err) {
        console.error('[SecurityAgents] Publish error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /security-agents/:id — Delete a security agent
router.delete('/:id', async (req, res) => {
    try {
        await securityAgentStore.deleteSecurityAgent(req.params.id);
        const dir = path.join(FILES_BASE_DIR, req.params.id);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[SecurityAgents] Delete error:', err);
        res.status(400).json({ error: err.message });
    }
});

// ── File Attachment Endpoints ────────────────────────────────────

// GET /security-agents/:id/files — List attached files
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
        console.error('[SecurityAgents] List files error:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /security-agents/:id/files — Upload a file (custom templates)
router.post('/:id/files', fileUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file provided' });
        console.log(`[SecurityAgents] File uploaded: ${req.file.originalname} (${req.file.size} bytes) for agent ${req.params.id}`);
        res.json({ name: req.file.filename, size: req.file.size });
    } catch (err) {
        console.error('[SecurityAgents] Upload error:', err);
        res.status(500).json({ error: err.message });
    }
});

// DELETE /security-agents/:id/files/:filename — Delete an attached file
router.delete('/:id/files/:filename', async (req, res) => {
    try {
        const filePath = path.join(FILES_BASE_DIR, req.params.id, req.params.filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
        fs.unlinkSync(filePath);
        console.log(`[SecurityAgents] File deleted: ${req.params.filename} from agent ${req.params.id}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[SecurityAgents] Delete file error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
