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

const researchRoutes = require('./ai/research');
const templateChatRoutes = require('./ai/templateChat');
const notebookChatRoutes = require('./ai/notebookChat');
const voiceRoutes = require('./ai/voice');
const { requireBetaFeature } = require('../core/betaFeatures');

// Mount all sub-routes
router.use('/', configRoutes);
router.use('/', providerRoutes);
router.use('/', agentChatRoutes);
router.use('/', directChatRoutes);

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

// Voice Chat (Beta) — gated on org-level beta feature flag.
// Further gated on a configured Mistral API key by the voice router itself.
// Mounted at /voice so the beta gate only affects /ai/voice/* requests.
router.use('/voice', requireBetaFeature('voice_chat'), voiceRoutes);

module.exports = router;
