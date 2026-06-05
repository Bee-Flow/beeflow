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
// Notebook chat feature gate. Mirrors the licence gate on the /api/notebooks*
// mounts (server/index.js) so notebook chat is also disabled when the org's
// tier/subscription doesn't grant `notebooks`. The licence check runs first so
// the SPA gets the actionable `feature_locked` body it already knows how to
// render; the configStore flag remains an operator kill-switch.
const license = require('../license');
const { resolveBestTierForRequest } = require('../license/middleware');
const notebookChatGate = async (req, res, next) => {
    if (!req.path.startsWith('/chat/notebook')) return next();
    if (!req.session?.isAuthenticated) return next(); // let auth middleware reject
    try {
        const resolution = await resolveBestTierForRequest(req);
        if (resolution.error === 'tier_unavailable') {
            return res.status(503).json({ error: 'tier_unavailable', retry_after: 1 });
        }
        const grantedByPlan = await license.orgGrantsFeature(resolution.orgIds, 'notebooks');
        if (!license.tiers.tierHasFeature(resolution.tier, 'notebooks') && !grantedByPlan) {
            return res.status(403).json({
                error: 'feature_locked',
                feature: 'notebooks',
                current: resolution.tier,
                upgrade_url: process.env.LICENSE_UPGRADE_URL || 'https://beeflow.nl/pricing',
            });
        }
    } catch (e) {
        // Fail closed on a real licence-resolution error rather than silently
        // granting access (matches requireFeature semantics).
        return res.status(503).json({ error: 'tier_unavailable', retry_after: 1 });
    }
    try {
        const configStore = require('../stores/configStore');
        const enabled = await configStore.getConfig('feature_notebooks_enabled');
        if (enabled === false) {
            return res.status(403).json({ error: 'Notebooks feature is disabled' });
        }
    } catch (_) { /* fail open on the operator kill-switch only */ }
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
