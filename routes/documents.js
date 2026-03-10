/**
 * Document Routes — PDF downloads from the document-renderer component
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUTPUT_DIR = path.join(os.tmpdir(), 'document-renderer');

// GET /api/documents/download/:filename — serve a rendered PDF
router.get('/download/:filename', (req, res) => {
    const { filename } = req.params;
    // Sanitize — only allow alphanumeric, hyphens, underscores, dots
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = path.join(OUTPUT_DIR, safe);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Document not found. It may have expired.' });
    }

    // Derive a clean download name (strip the random prefix)
    const parts = safe.split('_');
    const downloadName = parts.length > 1 ? parts.slice(1).join('_') : safe;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.sendFile(filePath);
});

// GET /api/documents/view/:filename — serve inline (browser preview)
router.get('/view/:filename', (req, res) => {
    const { filename } = req.params;
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = path.join(OUTPUT_DIR, safe);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Document not found. It may have expired.' });
    }

    const parts = safe.split('_');
    const downloadName = parts.length > 1 ? parts.slice(1).join('_') : safe;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${downloadName}"`);
    res.sendFile(filePath);
});

// GET /api/documents/list — list available documents (for debugging)
router.get('/list', (req, res) => {
    try {
        if (!fs.existsSync(OUTPUT_DIR)) {
            return res.json({ documents: [] });
        }

        const files = fs.readdirSync(OUTPUT_DIR)
            .filter(f => f.endsWith('.pdf'))
            .map(f => {
                const stat = fs.statSync(path.join(OUTPUT_DIR, f));
                const parts = f.split('_');
                return {
                    id: f,
                    name: parts.length > 1 ? parts.slice(1).join('_') : f,
                    sizeBytes: stat.size,
                    createdAt: stat.birthtime,
                    downloadUrl: `/api/documents/download/${f}`,
                    viewUrl: `/api/documents/view/${f}`
                };
            })
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        res.json({ documents: files });
    } catch (err) {
        console.error('[Documents] List error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
