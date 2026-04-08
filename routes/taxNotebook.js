/**
 * Tax Assistant Notebook Routes
 *
 * Endpoints for the Dutch Tax Assistant notebook type:
 *   POST   /              — Create a new tax assistant notebook
 *   GET    /              — List user's tax assistant notebooks
 *   GET    /:id/dashboard — Get tax period dashboard data (parsed from sources)
 *   POST   /:id/gather    — Trigger automated document gathering via AI
 *   POST   /:id/export    — Export accountant-ready package
 *
 * All routes are protected by requireBetaFeature('dutch_tax_assistant')
 * which is applied at mount-time in index.js.
 */

const express = require('express');
const router = express.Router();
const notebookStore = require('../stores/notebookStore');

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ── Create tax assistant notebook ──────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { periodType, year, quarter, entityType, btwNumber, kvkNumber } = req.body;

        if (!periodType || !year) {
            return res.status(400).json({ error: 'periodType and year are required' });
        }
        if (periodType === 'quarterly' && !quarter) {
            return res.status(400).json({ error: 'quarter is required for quarterly filing' });
        }

        const periodLabel = periodType === 'quarterly'
            ? `Q${quarter} ${year}`
            : `Year ${year}`;

        const entityLabels = {
            eenmanszaak: 'Eenmanszaak',
            bv: 'BV',
            vof: 'VOF',
        };

        const taxConfig = {
            periodType,
            year: parseInt(year, 10),
            quarter: quarter ? parseInt(quarter, 10) : null,
            entityType: entityType || 'eenmanszaak',
            btwNumber: btwNumber || null,
            kvkNumber: kvkNumber || null,
            period: periodType === 'quarterly' ? `Q${quarter}_${year}` : `annual_${year}`,
            gatherStatus: 'pending',
        };

        const notebook = await notebookStore.createNotebook({
            userId,
            name: `Tax — ${periodLabel} (${entityLabels[entityType] || entityType || 'Eenmanszaak'})`,
            description: `Dutch tax preparation for ${periodLabel}. Entity: ${entityLabels[entityType] || entityType || 'Eenmanszaak'}.`,
            instructions: '',
            type: 'tax_assistant',
            settings: { taxConfig },
        });

        console.log(`[TaxAssistant] Created notebook "${notebook.name}" for user ${userId}`);
        res.json({ success: true, notebook });
    } catch (err) {
        console.error('[TaxAssistant] Create failed:', err);
        res.status(500).json({ error: 'Failed to create tax assistant notebook' });
    }
});

// ── List tax assistant notebooks ───────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebooks = await notebookStore.getNotebooks(userId, { type: 'tax_assistant' });
        res.json({ notebooks });
    } catch (err) {
        console.error('[TaxAssistant] List failed:', err);
        res.status(500).json({ error: 'Failed to list tax assistant notebooks' });
    }
});

// ── Dashboard — financial summary from sources ────────────────────
router.get('/:id/dashboard', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const notebook = await notebookStore.getNotebook(req.params.id, userId);
        if (!notebook) return res.status(404).json({ error: 'Notebook not found' });
        if (notebook.type !== 'tax_assistant') return res.status(400).json({ error: 'Not a tax assistant notebook' });

        const sources = await notebookStore.getSources(notebook.id);
        const taxConfig = notebook.settings?.taxConfig || {};

        // Parse source metadata for financial summary
        let totalIncome = 0;
        let totalExpenses = 0;
        let btwCollected = 0;
        let btwPaid = 0;
        let invoiceCount = 0;
        const categories = { income: [], expenses: [], uncategorized: [] };

        for (const source of sources) {
            const meta = source.metadata || {};
            if (meta.taxCategory === 'income') {
                totalIncome += meta.amount || 0;
                btwCollected += meta.btwAmount || 0;
                categories.income.push(source);
            } else if (meta.taxCategory === 'expense') {
                totalExpenses += meta.amount || 0;
                btwPaid += meta.btwAmount || 0;
                categories.expenses.push(source);
            } else {
                categories.uncategorized.push(source);
            }
            if (meta.isInvoice) invoiceCount++;
        }

        res.json({
            dashboard: {
                period: taxConfig.period,
                periodLabel: taxConfig.periodType === 'quarterly'
                    ? `Q${taxConfig.quarter} ${taxConfig.year}`
                    : `Year ${taxConfig.year}`,
                entityType: taxConfig.entityType,
                gatherStatus: taxConfig.gatherStatus || 'pending',
                stats: {
                    invoiceCount,
                    totalSources: sources.length,
                    totalIncome: Math.round(totalIncome * 100) / 100,
                    totalExpenses: Math.round(totalExpenses * 100) / 100,
                    btwCollected: Math.round(btwCollected * 100) / 100,
                    btwPaid: Math.round(btwPaid * 100) / 100,
                    btwBalance: Math.round((btwCollected - btwPaid) * 100) / 100,
                    profit: Math.round((totalIncome - totalExpenses) * 100) / 100,
                },
                categories,
            },
        });
    } catch (err) {
        console.error('[TaxAssistant] Dashboard failed:', err);
        res.status(500).json({ error: 'Failed to get dashboard' });
    }
});

// ── Gather — update gather status ─────────────────────────────────
// The actual gathering is done by the AI via chat (using Gmail/Drive tools).
// This endpoint manages the status flag so the UI can reflect progress.
router.post('/:id/gather', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { status } = req.body; // 'in_progress' | 'complete' | 'pending'
        const notebook = await notebookStore.getNotebook(req.params.id, userId);
        if (!notebook) return res.status(404).json({ error: 'Notebook not found' });
        if (notebook.type !== 'tax_assistant') return res.status(400).json({ error: 'Not a tax assistant notebook' });

        const currentSettings = notebook.settings || {};
        const taxConfig = currentSettings.taxConfig || {};
        taxConfig.gatherStatus = status || 'in_progress';

        await notebookStore.updateNotebook(req.params.id, userId, {
            settings: { ...currentSettings, taxConfig },
        });

        res.json({ success: true, gatherStatus: taxConfig.gatherStatus });
    } catch (err) {
        console.error('[TaxAssistant] Gather status update failed:', err);
        res.status(500).json({ error: 'Failed to update gather status' });
    }
});

// ── Export — generate accountant-ready package ─────────────────────
router.post('/:id/export', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { format } = req.body; // 'pdf' | 'docx'
        const notebook = await notebookStore.getNotebook(req.params.id, userId);
        if (!notebook) return res.status(404).json({ error: 'Notebook not found' });
        if (notebook.type !== 'tax_assistant') return res.status(400).json({ error: 'Not a tax assistant notebook' });

        // For now, reuse the standard notebook export (PDF/DOCX)
        // The document content already contains the structured tax report
        // A future version could generate a zip with categorized attachments
        res.json({
            success: true,
            message: 'Use the standard notebook export (PDF/DOCX) for the tax report. The document editor contains the structured report.',
            documentContent: notebook.documentContent,
        });
    } catch (err) {
        console.error('[TaxAssistant] Export failed:', err);
        res.status(500).json({ error: 'Failed to export' });
    }
});

module.exports = router;
