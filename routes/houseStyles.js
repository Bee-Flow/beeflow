/**
 * House Styles API
 *
 * Per-organization Word/DOCX style templates that drive Notebook exports.
 * Read access: any org member. Write access: org admins (or platform admin).
 *
 * Routes:
 *   GET    /:orgId                        — list (no blob)
 *   GET    /:orgId/default                — current default (or null)
 *   GET    /:orgId/:id                    — single style meta
 *   GET    /:orgId/:id/source.docx        — download original .docx
 *   POST   /:orgId                        — upload .docx (multipart, field "file")
 *   PATCH  /:orgId/:id                    — rename / set-default / re-extract
 *   DELETE /:orgId/:id                    — remove
 */

const express = require('express');
const multer = require('multer');
const router = express.Router();
const houseStyleStore = require('../stores/houseStyleStore');
const houseStyleExtractor = require('../core/houseStyleExtractor');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap
});

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

async function isOrgMember(req, orgId) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    const ids = await resolveUserOrgIds(req);
    if (ids === null) return true; // legacy: no orgs scoped
    return !!(ids && ids.has(orgId));
}

async function isOrgAdmin(req, orgId) {
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;
    const userId = req.session?.user?.id;
    if (!userId) return false;
    const user = await userStore.getUser(userId);
    if (!user) return false;
    if (user.organizationId === orgId && user.orgRole === 'org_admin') return true;
    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) {} }
    const allGroups = await userStore.getAllGroups();
    for (const gid of groupIds) {
        const group = allGroups.find(g => g.id === gid);
        if (group?.organizationId === orgId) {
            const perms = Array.isArray(group.permissions) ? group.permissions : [];
            const roles = Array.isArray(group.roles) ? group.roles : [];
            if (perms.includes('all') || perms.includes('admin') ||
                roles.includes('admin') || roles.includes('org_admin')) return true;
        }
    }
    return false;
}

// ── List ───────────────────────────────────────────────────────────
router.get('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        if (!(await isOrgMember(req, orgId))) return res.status(403).json({ error: 'Forbidden' });
        const styles = await houseStyleStore.listForOrg(orgId);
        res.json(styles);
    } catch (e) {
        console.error('[houseStyles] list failed:', e);
        res.status(500).json({ error: 'Failed to list house styles' });
    }
});

// ── Default ────────────────────────────────────────────────────────
router.get('/:orgId/default', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        if (!(await isOrgMember(req, orgId))) return res.status(403).json({ error: 'Forbidden' });
        const style = await houseStyleStore.getDefaultForOrg(orgId);
        res.json(style || null);
    } catch (e) {
        console.error('[houseStyles] default failed:', e);
        res.status(500).json({ error: 'Failed to get default house style' });
    }
});

// ── Single ─────────────────────────────────────────────────────────
router.get('/:orgId/:id', requireAuth, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        if (!(await isOrgMember(req, orgId))) return res.status(403).json({ error: 'Forbidden' });
        const style = await houseStyleStore.getById(id, orgId);
        if (!style) return res.status(404).json({ error: 'Not found' });
        res.json(style);
    } catch (e) {
        console.error('[houseStyles] get failed:', e);
        res.status(500).json({ error: 'Failed to get house style' });
    }
});

// ── Source DOCX download ──────────────────────────────────────────
router.get('/:orgId/:id/source.docx', requireAuth, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        if (!(await isOrgMember(req, orgId))) return res.status(403).json({ error: 'Forbidden' });
        const style = await houseStyleStore.getById(id, orgId, { includeBlob: true });
        if (!style) return res.status(404).json({ error: 'Not found' });
        const safeName = (style.name || 'house-style').replace(/[^a-zA-Z0-9.\-_ ]/g, '_').trim();
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.docx"`);
        res.send(style.docxBlob);
    } catch (e) {
        console.error('[houseStyles] source download failed:', e);
        res.status(500).json({ error: 'Failed to download source' });
    }
});

// ── Upload ─────────────────────────────────────────────────────────
router.post('/:orgId', requireAuth, upload.single('file'), async (req, res) => {
    try {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) return res.status(403).json({ error: 'Org admin required' });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded (field "file" required)' });
        const lower = (req.file.originalname || '').toLowerCase();
        if (!lower.endsWith('.docx')) return res.status(400).json({ error: 'Only .docx files are supported' });

        const name = (req.body.name || req.file.originalname.replace(/\.docx$/i, '')).trim();
        if (!name) return res.status(400).json({ error: 'Name is required' });
        const description = (req.body.description || '').trim();
        const makeDefault = req.body.isDefault === 'true' || req.body.isDefault === true;

        const styleMeta = await houseStyleExtractor.extract(req.file.buffer);
        const created = await houseStyleStore.create({
            orgId,
            name,
            description,
            docxBuffer: req.file.buffer,
            styleMeta,
            createdBy: req.session.user.id,
            makeDefault,
        });
        res.status(201).json(created);
    } catch (e) {
        console.error('[houseStyles] upload failed:', e);
        res.status(500).json({ error: 'Failed to create house style' });
    }
});

// ── Update (rename, set-default, re-extract) ──────────────────────
router.patch('/:orgId/:id', requireAuth, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        if (!(await isOrgAdmin(req, orgId))) return res.status(403).json({ error: 'Org admin required' });
        const updates = {};
        if (req.body.name !== undefined) updates.name = String(req.body.name).trim();
        if (req.body.description !== undefined) updates.description = String(req.body.description);
        if (req.body.isDefault !== undefined) updates.isDefault = !!req.body.isDefault;

        // Re-run extraction on the stored blob — useful when the extractor
        // improves and we want existing styles to pick up new fields.
        if (req.body.reExtract === true) {
            const full = await houseStyleStore.getById(id, orgId, { includeBlob: true });
            if (full?.docxBlob) {
                updates.styleMeta = await houseStyleExtractor.extract(full.docxBlob);
            }
        }

        const updated = await houseStyleStore.update(id, orgId, updates);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (e) {
        console.error('[houseStyles] update failed:', e);
        res.status(500).json({ error: 'Failed to update house style' });
    }
});

// ── Delete ─────────────────────────────────────────────────────────
router.delete('/:orgId/:id', requireAuth, async (req, res) => {
    try {
        const { orgId, id } = req.params;
        if (!(await isOrgAdmin(req, orgId))) return res.status(403).json({ error: 'Org admin required' });
        await houseStyleStore.remove(id, orgId);
        res.json({ ok: true });
    } catch (e) {
        console.error('[houseStyles] delete failed:', e);
        res.status(500).json({ error: 'Failed to delete house style' });
    }
});

module.exports = router;
