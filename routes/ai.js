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

const templateChatRoutes = require('./ai/templateChat');
const notebookChatRoutes = require('./ai/notebookChat');
const webpageChatRoutes = require('./ai/webpageChat');
const voiceRoutes = require('./ai/voice');
const swarmsRoutes = require('./ai/swarms');
const { requireBetaFeature } = require('../core/betaFeatures');

// Mount all sub-routes
router.use('/', configRoutes);
router.use('/', providerRoutes);
router.use('/', agentChatRoutes);
router.use('/', directChatRoutes);

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

// Webpage chat — gated per-organization via the beta-feature registry. Path-
// scoped so the gate only fires on /chat/webpage/* and not on the rest of /ai.
const { userHasBetaFeature: userHasWebpagesBeta } = require('../core/betaFeatures');
const webpageChatGate = async (req, res, next) => {
    if (!req.path.startsWith('/chat/webpage')) return next();
    if (!req.session?.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
        if (await userHasWebpagesBeta(req.session.user.id, 'webpages', req.session)) {
            return next();
        }
        return res.status(403).json({ error: "Beta feature 'webpages' is not enabled for your organization" });
    } catch (_) {
        return res.status(403).json({ error: "Beta feature 'webpages' is not enabled for your organization" });
    }
};
router.use(webpageChatGate);
router.use('/', webpageChatRoutes);

// Voice Chat (Beta) — gated on org-level beta feature flag.
// Further gated on a configured Mistral API key by the voice router itself.
// Mounted at /voice so the beta gate only affects /ai/voice/* requests.
router.use('/voice', requireBetaFeature('voice_chat'), voiceRoutes);

// Swarm Agents (Beta) — gated on org-level beta feature flag. The discovery
// endpoint also returns [] when the gate is disabled, so the sidebar simply
// hides the "Swarms" section for non-eligible users.
router.use('/swarms', requireBetaFeature('swarm'), swarmsRoutes);

module.exports = router;
