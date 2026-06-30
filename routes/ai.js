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
const learningRoutes = require('./ai/learning');
const learningAdminRoutes = require('./ai/learningAdmin');
const { requireCapability } = require('../core/entitlements');

// Mount all sub-routes
router.use('/', configRoutes);
router.use('/', providerRoutes);
router.use('/', agentChatRoutes);
router.use('/', directChatRoutes);

router.use('/', templateChatRoutes);
// Notebook chat feature gate. Resolves `notebooks` through the ONE entitlements
// resolver (requireCapability) — identical to the /api/notebooks* mounts — so
// notebook chat agrees with them on cloud (subscription) and self-hosted
// (licence). The capability check runs first so the SPA gets the actionable
// `feature_locked` body; the configStore flag stays a separate operator
// kill-switch and runs only after the entitlement passes.
const notebookCapGate = requireCapability('notebooks');
const notebookKillSwitch = async (req, res, next) => {
    try {
        const configStore = require('../stores/configStore');
        const enabled = await configStore.getConfig('feature_notebooks_enabled');
        if (enabled === false) {
            return res.status(403).json({ error: 'Notebooks feature is disabled' });
        }
    } catch (_) { /* fail open on the operator kill-switch only */ }
    next();
};
const notebookChatGate = (req, res, next) => {
    if (!req.path.startsWith('/chat/notebook')) return next();
    // requireCapability sends feature_locked/feature_disabled/503 on denial and
    // calls our continuation only on success → then the operator kill-switch.
    return notebookCapGate(req, res, () => notebookKillSwitch(req, res, next));
};
router.use(notebookChatGate);
router.use('/', notebookChatRoutes);

// Webpage chat — gated through the same `webpages` capability as the
// /api/webpages mount, so the AI build path and the list/CRUD API can never
// disagree (the split that made the page render while its API 403'd). Path-
// scoped so the gate only fires on /chat/webpage/* and not on the rest of /ai.
const webpageCapGate = requireCapability('webpages');
const webpageChatGate = (req, res, next) => {
    if (!req.path.startsWith('/chat/webpage')) return next();
    return webpageCapGate(req, res, next);
};
router.use(webpageChatGate);
router.use('/', webpageChatRoutes);

// Voice Chat (Beta) — gated on org-level beta feature flag.
// Further gated on a configured Mistral API key by the voice router itself.
// Mounted at /voice so the beta gate only affects /ai/voice/* requests.
router.use('/voice', requireCapability('voice_chat'), voiceRoutes);

// Swarm Agents (Beta) — gated on org-level beta feature flag. The discovery
// endpoint also returns [] when the gate is disabled, so the sidebar simply
// hides the "Swarms" section for non-eligible users.
router.use('/swarms', requireCapability('swarm'), swarmsRoutes);

// Academy Custom Courses (Beta) — org-admin authoring CRUD + publish. Must be
// mounted BEFORE '/learning': router.use('/learning') also matches
// '/learning/admin/*' paths, so with the other order the learning_center gate
// and router would intercept admin requests first. Org-admin auth is enforced
// inside the router (requirePrimaryOrgAdmin).
router.use('/learning/admin', requireCapability('learning_custom_content'), learningAdminRoutes);

// Learning Center — AI coach (grade/hint), achievements + certificate issuance.
// Gated on the `learning_center` capability so it can be enabled/disabled per
// subscription plan. Auth + rate limiting are enforced inside the router.
router.use('/learning', requireCapability('learning_center'), learningRoutes);

module.exports = router;
