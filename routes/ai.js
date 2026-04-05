/**
 * AI Routes — Slim Router Mount
 * 
 * All route logic has been split into focused sub-modules in routes/ai/.
 * This file just mounts them under the /api/ai prefix.
 */

const express = require('express');
const router = express.Router();

// Sub-route modules
const configRoutes = require('./ai/config');
const providerRoutes = require('./ai/providers');
const agentChatRoutes = require('./ai/agentChat');
const directChatRoutes = require('./ai/directChat');
const designerRoutes = require('./ai/designer');
const researchRoutes = require('./ai/research');
const templateChatRoutes = require('./ai/templateChat');
const notebookChatRoutes = require('./ai/notebookChat');

// Mount all sub-routes
router.use('/', configRoutes);
router.use('/', providerRoutes);
router.use('/', agentChatRoutes);
router.use('/', directChatRoutes);
router.use('/', designerRoutes);
router.use('/', researchRoutes);
router.use('/', templateChatRoutes);
// Notebook chat feature gate
const notebookChatGate = async (req, res, next) => {
    if (!req.path.startsWith('/chat/notebook')) return next();
    try {
        const configStore = require('../stores/configStore');
        const enabled = await configStore.getConfig('feature_notebooks_enabled');
        if (enabled === false) {
            return res.status(403).json({ error: 'Notebooks feature is disabled' });
        }
    } catch (_) { /* fail open */ }
    next();
};
router.use(notebookChatGate);
router.use('/', notebookChatRoutes);
// Slides chat feature gate
const slidesChatRoutes = require('./ai/slidesChat');
const slidesChatGate = async (req, res, next) => {
    if (!req.path.startsWith('/chat/slides')) return next();
    try {
        const configStore = require('../stores/configStore');
        const enabled = await configStore.getConfig('feature_slides_enabled');
        if (enabled === false) {
            return res.status(403).json({ error: 'Slides feature is disabled' });
        }
    } catch (_) { /* fail open */ }
    next();
};
router.use(slidesChatGate);
router.use('/', slidesChatRoutes);
// Sheet chat feature gate
const sheetChatRoutes = require('./ai/sheetChat');
const sheetChatGate = async (req, res, next) => {
    if (!req.path.startsWith('/chat/sheet')) return next();
    try {
        const configStore = require('../stores/configStore');
        const enabled = await configStore.getConfig('feature_sheets_enabled');
        if (enabled === false) {
            return res.status(403).json({ error: 'Sheets feature is disabled' });
        }
    } catch (_) { /* fail open */ }
    next();
};
router.use(sheetChatGate);
router.use('/', sheetChatRoutes);
// Proposal chat (reuses notebooks feature gate)
const proposalChatRoutes = require('./ai/proposalChat');
router.use('/', proposalChatRoutes);

module.exports = router;
