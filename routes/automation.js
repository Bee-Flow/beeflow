/**
 * Automation Routes — REST API for the conversational automation builder.
 *
 *   GET    /catalog                        list apps, actions, triggers, side-effects
 *   GET    /catalog/sample/:tool           sample output for builder hints
 *
 *   GET    /                               list user's automations
 *   POST   /                               create automation (draft or finalised)
 *   POST   /import                         create a draft from an exported envelope
 *   GET    /:id                            get one
 *   GET    /:id/export                     download sanitized portability envelope
 *   PUT    /:id                            update (bumps version when definition changes)
 *   DELETE /:id                            delete
 *   POST   /:id/activate                   set is_active and re-arm next_run_at
 *   POST   /:id/deactivate                 unset is_active
 *   POST   /:id/run                        manual run (live)
 *   POST   /:id/dry-run                    explicit dry-run on demand
 *   GET    /:id/runs                       list runs
 *   GET    /:id/versions                   list saved versions
 *   POST   /:id/webhook                    create a signed webhook URL
 *   GET    /:id/webhooks                   list webhooks for the automation
 *
 *   POST   /runs/:id/approve               first-run-confirm flow approve
 *   GET    /runs/:id                       run details
 *   GET    /runs/:id/steps                 per-step log
 *
 *   POST   /webhook/:slug                  PUBLIC inbound webhook (HMAC + nonce)
 *   POST   /events/gmail                   PUBLIC Gmail Pub/Sub push
 *   POST   /events/msgraph                 PUBLIC MS Graph notification (handles ?validationToken=)
 *   POST   /events/github                  PUBLIC GitHub webhook
 */

// §WS5 #4 — this file is a thin facade. It owns the shared requireAuth + the
// auth/beta/org middleware chain and mounts the per-concern sub-routers in
// automation/ in the SAME order routes were originally registered (Express is
// first-match, so the flattened order is the contract — see
// automation.routetable.test.js).
const express = require('express');
const router = express.Router();

function requireAuth(req, res, next) {
    if (req.session?.user?.id) return next();
    res.status(401).json({ error: 'Not authenticated' });
}

// ── PUBLIC routes (defined first; auth comes after) ────
router.use(require('./automation/events'));

// ── Authenticated routes ───────────────────────────────
router.use(requireAuth);

// All authenticated automation routes are gated behind the 'automations'
// beta feature. Admins toggle this per-organisation in the admin
// dashboard → Security → Beta. Super admins always have access.
const { requireBetaFeature } = require('../core/betaFeatures');
router.use(requireBetaFeature('automations'));

// Block all writes when the caller's org is suspended/archived. Public webhook
// routes above this point are intentionally not gated — they're inbound from
// external services and have no session/org context.
const { requireActiveOrgForMutations } = require('../auth');
router.use(requireActiveOrgForMutations());

router.use(require('./automation/catalog'));
router.use(require('./automation/crud'));
router.use(require('./automation/runs'));
router.use(require('./automation/versions'));
router.use(require('./automation/webhooksAndRunOps'));

module.exports = router;
