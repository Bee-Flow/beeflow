/**
 * Proposal Routes — CRUD for proposals (thin wrapper over notebookStore with type='proposal').
 *
 * Endpoints:
 *   POST   /                    — create proposal
 *   GET    /                    — list user's proposals
 *   GET    /:id                 — get proposal detail
 *   PUT    /:id                 — update proposal (content, settings, metadata)
 *   DELETE /:id                 — delete proposal
 *
 * Template Endpoints:
 *   GET    /templates/list      — list all templates (own + org-wide)
 *   POST   /templates           — save current proposal as template
 *   POST   /templates/:id/use   — create new proposal from template
 *   DELETE /templates/:id       — delete a template
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const notebookStore = require('../stores/notebookStore');
const { run, getOne, getAll } = require('../db');

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ═══════════════════════════════════════════════════════════════════
// TEMPLATE ROUTES (must come before /:id to avoid conflict)
// ═══════════════════════════════════════════════════════════════════

// ── List templates ─────────────────────────────────────────────────
// Returns templates created by the user + shared org-wide templates
router.get('/templates/list', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const orgId = req.session.user.organizationId;

        // Get all proposal-type notebooks that have isTemplate in settings
        // Own templates + org-shared ones
        let query = `
            SELECT n.*, COALESCE(s.source_count, 0) AS source_count
            FROM notebooks n
            LEFT JOIN (
                SELECT notebook_id, COUNT(*) AS source_count
                FROM notebook_sources GROUP BY notebook_id
            ) s ON s.notebook_id = n.id
            WHERE n.type = 'proposal'
              AND (n.settings->>'isTemplate')::boolean = true
              AND n.user_id = $1
            ORDER BY n.updated_at DESC
        `;
        const params = [userId];

        const rows = await getAll(query, params);
        const templates = rows.map(r => ({
            id: r.id,
            userId: r.user_id,
            name: r.name,
            description: r.description || '',
            settings: (() => { try { return typeof r.settings === 'string' ? JSON.parse(r.settings) : (r.settings || {}); } catch { return {}; } })(),
            documentContent: (() => { try { return r.document_content ? (typeof r.document_content === 'string' ? JSON.parse(r.document_content) : r.document_content) : ''; } catch { return r.document_content || ''; } })(),
            createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
            updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
            blockCount: 0,
        }));

        // Count blocks in each template
        for (const t of templates) {
            if (t.documentContent && typeof t.documentContent === 'object' && Array.isArray(t.documentContent.blocks)) {
                t.blockCount = t.documentContent.blocks.length;
            }
        }

        res.json(templates);
    } catch (err) {
        console.error('[Proposals] List templates error:', err);
        res.status(500).json({ error: 'Failed to list templates' });
    }
});

// ── Save as template ───────────────────────────────────────────────
// Clones a proposal into a template (or creates a new empty template)
router.post('/templates', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { sourceProposalId, name, description } = req.body;

        let documentContent = '';
        let templateSettings = {
            isTemplate: true,
            proposal: {
                clientName: '',
                clientContact: '',
                companyName: req.session.user.organizationName || 'Bee Flow B.V.',
                validUntil: '',
                currency: 'EUR',
                vatRate: 21,
                vatIncluded: false,
                theme: 'dark-cover',
                brandColors: { primary: '#1a1a2e', accent: '#6366f1' },
            },
        };

        // If cloning from an existing proposal, copy its content and settings
        if (sourceProposalId) {
            const source = await notebookStore.getNotebook(sourceProposalId, userId);
            if (!source) return res.status(404).json({ error: 'Source proposal not found' });

            documentContent = source.documentContent || '';
            // Strip client-specific data from blocks but keep structure
            if (typeof documentContent === 'object' && documentContent.blocks) {
                documentContent = {
                    ...documentContent,
                    blocks: documentContent.blocks.map(block => {
                        // Clear client-specific text from cover blocks
                        if (block.type === 'cover') {
                            return { ...block, subtitle: block.subtitle || '', date: '' };
                        }
                        return block;
                    }),
                };
            }

            // Merge source settings but mark as template
            templateSettings = {
                ...(source.settings || {}),
                isTemplate: true,
                // Clear client-specific fields
                proposal: {
                    ...(source.settings?.proposal || templateSettings.proposal),
                    clientName: '',
                    clientContact: '',
                    validUntil: '',
                },
            };
        }

        const template = await notebookStore.createNotebook({
            userId,
            name: name || 'Nieuwe Template',
            description: description || '',
            instructions: '',
            type: 'proposal',
            settings: templateSettings,
        });

        // Save document content if we have it
        if (documentContent) {
            const contentStr = typeof documentContent === 'string'
                ? documentContent
                : JSON.stringify(documentContent);
            await notebookStore.updateNotebook(template.id, userId, {
                documentContent: contentStr,
            });
            template.documentContent = documentContent;
        }

        res.json(template);
    } catch (err) {
        console.error('[Proposals] Save as template error:', err);
        res.status(500).json({ error: 'Failed to save template' });
    }
});

// ── Create proposal from template ──────────────────────────────────
router.post('/templates/:id/use', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const templateId = req.params.id;
        const { name } = req.body;

        // Load template (must be own template)
        const template = await notebookStore.getNotebook(templateId, userId);
        if (!template) return res.status(404).json({ error: 'Template not found' });

        // Build settings without isTemplate flag
        const newSettings = { ...(template.settings || {}) };
        delete newSettings.isTemplate;

        // Create new proposal
        const proposal = await notebookStore.createNotebook({
            userId,
            name: name || `${template.name}`,
            description: template.description || '',
            instructions: '',
            type: 'proposal',
            settings: newSettings,
        });

        // Copy document content from template
        if (template.documentContent) {
            const contentStr = typeof template.documentContent === 'string'
                ? template.documentContent
                : JSON.stringify(template.documentContent);
            await notebookStore.updateNotebook(proposal.id, userId, {
                documentContent: contentStr,
            });
            proposal.documentContent = template.documentContent;
        }

        res.json(proposal);
    } catch (err) {
        console.error('[Proposals] Create from template error:', err);
        res.status(500).json({ error: 'Failed to create proposal from template' });
    }
});

// ── Delete template ────────────────────────────────────────────────
router.delete('/templates/:id', requireAuth, async (req, res) => {
    try {
        const deleted = await notebookStore.deleteNotebook(req.params.id, req.session.user.id);
        if (!deleted) return res.status(404).json({ error: 'Template not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Proposals] Delete template error:', err);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// ═══════════════════════════════════════════════════════════════════
// PROPOSAL CRUD ROUTES
// ═══════════════════════════════════════════════════════════════════

// ── Create proposal ────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { name, description, settings } = req.body;
        const proposal = await notebookStore.createNotebook({
            userId,
            name: name || 'Nieuwe Offerte',
            description: description || '',
            instructions: '',
            type: 'proposal',
            settings: {
                // Default proposal settings
                proposal: {
                    clientName: '',
                    clientContact: '',
                    companyName: req.session.user.organizationName || 'Bee Flow B.V.',
                    validUntil: '',
                    currency: 'EUR',
                    vatRate: 21,
                    vatIncluded: false,
                    theme: 'dark-cover',
                    brandColors: { primary: '#1a1a2e', accent: '#6366f1' },
                },
                // Merge any provided settings
                ...(settings || {}),
            },
        });
        res.json(proposal);
    } catch (err) {
        console.error('[Proposals] Create error:', err);
        res.status(500).json({ error: 'Failed to create proposal' });
    }
});

// ── List proposals (excludes templates) ────────────────────────────
router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const all = await notebookStore.getNotebooks(userId, { type: 'proposal' });
        // Filter out templates from the list
        const proposals = all.filter(p => !p.settings?.isTemplate);
        res.json(proposals);
    } catch (err) {
        console.error('[Proposals] List error:', err);
        res.status(500).json({ error: 'Failed to list proposals' });
    }
});

// ── Get proposal detail ────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
    try {
        const proposal = await notebookStore.getNotebook(req.params.id, req.session.user.id);
        if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
        if (proposal.type !== 'proposal') return res.status(404).json({ error: 'Not a proposal' });
        res.json(proposal);
    } catch (err) {
        console.error('[Proposals] Get error:', err);
        res.status(500).json({ error: 'Failed to get proposal' });
    }
});

// ── Update proposal ────────────────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
    try {
        const { name, description, settings, documentContent } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = name;
        if (description !== undefined) updates.description = description;
        if (settings !== undefined) updates.settings = settings;
        if (documentContent !== undefined) updates.documentContent = documentContent;

        const ok = await notebookStore.updateNotebook(req.params.id, req.session.user.id, updates);
        if (!ok) return res.status(404).json({ error: 'Proposal not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Proposals] Update error:', err);
        res.status(500).json({ error: 'Failed to update proposal' });
    }
});

// ── Delete proposal ────────────────────────────────────────────────
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const deleted = await notebookStore.deleteNotebook(req.params.id, req.session.user.id);
        if (!deleted) return res.status(404).json({ error: 'Proposal not found' });
        res.json({ success: true });
    } catch (err) {
        console.error('[Proposals] Delete error:', err);
        res.status(500).json({ error: 'Failed to delete proposal' });
    }
});

module.exports = router;
