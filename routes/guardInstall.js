/**
 * Admin routes for installing / uninstalling the optional PII guard service.
 * Mounted at /api/admin/guard.
 *
 * All endpoints require the `admin_security` permission (same bar as the
 * Guardrails panel that hosts the install card in the UI).
 */

const express = require('express');
const router = express.Router();
const { requirePermission } = require('../auth/permissions');
const installer = require('../services/guardInstaller');

router.use(requirePermission('admin_security'));

router.get('/status', async (_req, res) => {
    try {
        const status = await installer.getStatus();
        res.json(status);
    } catch (err) {
        console.error('[guardInstall] status error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/install', express.json(), async (req, res) => {
    const { apiKey, model } = req.body || {};
    try {
        installer.install({ apiKey, model });
        res.status(202).json({ status: 'installing' });
    } catch (err) {
        if (err.code === 'UNSUPPORTED_ENV') return res.status(409).json({ error: err.message, code: err.code });
        if (err.code === 'IN_PROGRESS') return res.status(409).json({ error: err.message, code: err.code });
        console.error('[guardInstall] install error:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/uninstall', express.json(), async (req, res) => {
    const { removeVolume = false } = req.body || {};
    try {
        installer.uninstall({ removeVolume });
        res.status(202).json({ status: 'uninstalling' });
    } catch (err) {
        if (err.code === 'UNSUPPORTED_ENV') return res.status(409).json({ error: err.message, code: err.code });
        if (err.code === 'IN_PROGRESS') return res.status(409).json({ error: err.message, code: err.code });
        console.error('[guardInstall] uninstall error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
