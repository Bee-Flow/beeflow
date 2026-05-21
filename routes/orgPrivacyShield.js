/**
 * Organization Privacy Shield API
 * 
 * Lets org admins manage regex guardrails that apply to ALL agents
 * and direct chat within their organization.
 */

const express = require('express');
const router = express.Router();
const configStore = require('../stores/configStore');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds, isOrgAdminRole } = require('../auth');

// Lazy-required to avoid pulling the licence module into the route's
// import chain at boot. Licence module depends on stores/userStore which
// some test fixtures stub — keeping this lazy preserves backward compat.
let _license = null;
function _licenseModule() {
    if (!_license) _license = require('../license');
    return _license;
}

/**
 * Returns the tier-driven clamps that apply to a privacy-shield config
 * for the given org. Resolves the tier (via the licence resolver, which
 * already honours the server-wide override) and returns the set of
 * fields that need clamping.
 *
 *   - `pii_tokenize` missing → piiDetectionAction must be 'block'
 *   - `web_search_guard` missing → webSearchGuardEnabled = false,
 *                                  webSearchGuardPiiCategories = []
 *
 * Returns { tier, hasPiiTokenize, hasWebSearchGuard }.
 */
async function _tierClamps({ organizationId, userId }) {
    try {
        const lic = _licenseModule();
        const tier = await lic.resolveTier({ organizationId, userId });
        return {
            tier,
            hasPiiTokenize: lic.tiers.tierHasFeature(tier, 'pii_tokenize'),
            hasWebSearchGuard: lic.tiers.tierHasFeature(tier, 'web_search_guard'),
        };
    } catch (e) {
        // Fail closed: if tier resolution breaks we clamp to the
        // strictest community-tier behaviour. Prevents an upgrade from
        // accidentally getting downgraded; the affected admin sees the
        // clamped values, retries, and gets the real ones.
        console.warn('[OrgPrivacyShield] tier resolve failed, applying community clamps:', e.message);
        return { tier: 'community', hasPiiTokenize: false, hasWebSearchGuard: false };
    }
}

/**
 * In-place clamp of a stored config blob to the tier's allowed values.
 * Returns the list of fields that had to be clamped so the caller can
 * surface a `clamped_fields` marker in the response.
 */
function _applyTierClamps(config, { hasPiiTokenize, hasWebSearchGuard }) {
    const clamped = [];
    if (!hasPiiTokenize && config.piiDetectionAction && config.piiDetectionAction !== 'block') {
        config.piiDetectionAction = 'block';
        clamped.push('piiDetectionAction');
    }
    if (!hasWebSearchGuard) {
        if (config.webSearchGuardEnabled) {
            config.webSearchGuardEnabled = false;
            clamped.push('webSearchGuardEnabled');
        }
        if (Array.isArray(config.webSearchGuardPiiCategories) && config.webSearchGuardPiiCategories.length > 0) {
            config.webSearchGuardPiiCategories = [];
            clamped.push('webSearchGuardPiiCategories');
        }
    }
    return clamped;
}

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Check if the current user is an admin for the given org.
 * Super admins (platform role=admin) can manage any org.
 * Org admins = users whose group belongs to the org AND group has admin role/permission.
 */
async function isOrgAdmin(req, orgId) {
    // Platform super admin
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return true;

    const userId = req.session?.user?.id;
    if (!userId) return false;

    const user = await userStore.getUser(userId);
    if (!user) return false;

    // Check user's direct orgRole (set when user creates or is assigned to an org)
    if (user.organizationId === orgId && isOrgAdminRole(user.orgRole)) return true;

    let groupIds = [];
    if (Array.isArray(user.groups)) groupIds = user.groups;
    else { try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { } }

    const allGroups = await userStore.getAllGroups();
    for (const gid of groupIds) {
        const group = allGroups.find(g => g.id === gid);
        if (group?.organizationId === orgId) {
            // Check if group has admin role/permission
            const perms = Array.isArray(group.permissions) ? group.permissions : [];
            const roles = Array.isArray(group.roles) ? group.roles : [];
            if (perms.includes('all') || perms.includes('admin') ||
                roles.includes('admin') || roles.includes('org_admin')) {
                return true;
            }
        }
    }
    return false;
}

// GET /:orgId — get shield config
router.get('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        // Must be member of org or super admin
        const orgIds = await resolveUserOrgIds(req);
        const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

        const config = await configStore.getConfig(`org_privacy_shield_${orgId}`) || {
            enabled: false,
            collectionIds: [],
            scope: { userInput: true, agentOutput: true },
            action: 'delete',
            euModeEnabled: false,
            piiDetectionCategories: [],
            piiDetectionConfidenceThreshold: 0.7,
            piiDetectionAction: 'block',
            webSearchGuardPiiCategories: [],
            monitorIntegrations: false,
        };

        // Also pull current global AI config values so the UI stays in sync
        const aiBlob = await configStore.getConfig('ai') || {};
        if (!config.piiDetectionCategories?.length) {
            config.piiDetectionCategories = aiBlob.piiDetectionCategories || [];
        }
        if (config.piiDetectionConfidenceThreshold === undefined) {
            config.piiDetectionConfidenceThreshold = aiBlob.piiDetectionConfidenceThreshold ?? 0.7;
        }
        if (!config.piiDetectionAction) {
            config.piiDetectionAction = aiBlob.piiDetectionAction || 'block';
        }

        // Annotate with resolved-shield warnings so the admin UI can flag
        // orphaned collection / rule references. resolveOrgShield returns null
        // when the shield is disabled, so this is best-effort.
        try {
            const { resolveOrgShield } = require('../core/orgShield');
            const resolved = await resolveOrgShield(orgId);
            if (resolved?.stalenessWarnings?.length) {
                config.stalenessWarnings = resolved.stalenessWarnings;
            }
        } catch (_) { /* non-fatal */ }

        // Tier-driven clamps: a community-tier read of a stored config
        // that pre-dates the tightening must surface the EFFECTIVE values
        // the runtime will honour, not the stale-stored ones — otherwise
        // the admin UI shows "tokenize" while the backend silently treats
        // PII as block-only. We don't rewrite the stored row; we only
        // clamp the response payload. Deep-clone first so we never mutate
        // the (potentially shared) configStore reference.
        const clamps = await _tierClamps({ organizationId: orgId, userId: req.session?.user?.id });
        const responseConfig = JSON.parse(JSON.stringify(config));
        const clampedFields = _applyTierClamps(responseConfig, clamps);
        if (clampedFields.length > 0) {
            responseConfig.clamped_fields = clampedFields;
            responseConfig.clamped_tier = clamps.tier;
        }

        res.json(responseConfig);
    } catch (e) {
        console.error('[OrgPrivacyShield] GET error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /:orgId — save shield config (org admin or super admin only)
router.put('/:orgId', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        if (!(await isOrgAdmin(req, orgId))) {
            return res.status(403).json({ error: 'Only organization admins can manage the privacy shield' });
        }

        const { enabled, collectionIds, scope, action, euModeEnabled, webSearchGuardEnabled, disableSearchOnUpload, piiDetectionCategories, piiDetectionConfidenceThreshold, piiDetectionAction, webSearchGuardPiiCategories, monitorIntegrations,
            // DLP
            dlpEnabled, dlpScope, dlpMode, dlpFailureMode, dlpAllowlistedHosts, customSensitiveTerms,
            // Transparency
            showRawPayload } = req.body;

        // Validate every custom term's regex. Report ALL invalid terms at once
        // so the admin doesn't need to fix-save-fix-save through a dozen regex
        // typos. Valid terms + the rest of the shield are still saved.
        const sanitizedTerms = [];
        const termErrors = [];
        if (Array.isArray(customSensitiveTerms)) {
            for (const term of customSensitiveTerms) {
                if (!term || typeof term !== 'object' || !term.pattern || !term.label) {
                    termErrors.push({ id: term?.id || null, label: term?.label || '(missing)', error: 'Missing label or pattern' });
                    continue;
                }
                const type = term.type === 'literal' ? 'literal' : 'regex';
                if (type === 'regex') {
                    try {
                        new RegExp(term.pattern, term.caseSensitive ? '' : 'i');
                    } catch (err) {
                        termErrors.push({ id: term.id || null, label: term.label, error: err.message });
                        continue;
                    }
                }
                sanitizedTerms.push({
                    id: term.id || `term-${Date.now()}-${sanitizedTerms.length}`,
                    label: String(term.label).slice(0, 120),
                    pattern: String(term.pattern).slice(0, 500),
                    caseSensitive: !!term.caseSensitive,
                    type,
                    createdAt: term.createdAt || new Date().toISOString(),
                    createdBy: term.createdBy || req.session.user.id,
                });
            }
        }

        const config = {
            enabled: !!enabled,
            collectionIds: Array.isArray(collectionIds) ? collectionIds : [],
            // Drop legacy `toolInput`/`toolOutput` scope flags — no runtime code
            // reads them, and keeping them in the form just confuses admins.
            scope: {
                userInput: scope ? !!scope.userInput : true,
                agentOutput: scope ? !!scope.agentOutput : true,
            },
            action: action === 'redact' ? 'redact' : 'delete',
            euModeEnabled: !!euModeEnabled,
            webSearchGuardEnabled: !!webSearchGuardEnabled,
            disableSearchOnUpload: !!disableSearchOnUpload,
            piiDetectionCategories: Array.isArray(piiDetectionCategories) ? piiDetectionCategories : [],
            piiDetectionConfidenceThreshold: typeof piiDetectionConfidenceThreshold === 'number' ? piiDetectionConfidenceThreshold : 0.7,
            piiDetectionAction: ['block', 'tokenize', 'warn'].includes(piiDetectionAction) ? piiDetectionAction : 'block',
            webSearchGuardPiiCategories: Array.isArray(webSearchGuardPiiCategories) ? webSearchGuardPiiCategories : [],
            monitorIntegrations: !!monitorIntegrations,
            // DLP fields
            dlpEnabled: !!dlpEnabled,
            dlpScope: dlpScope === 'all' ? 'all' : 'external',
            dlpMode: ['ask', 'auto_redact', 'block'].includes(dlpMode) ? dlpMode : 'ask',
            dlpFailureMode: dlpFailureMode === 'fail_open' ? 'fail_open' : 'fail_closed',
            dlpAllowlistedHosts: Array.isArray(dlpAllowlistedHosts) ? dlpAllowlistedHosts.slice(0, 50).map(String) : [],
            customSensitiveTerms: sanitizedTerms,
            showRawPayload: !!showRawPayload,
            updatedAt: new Date().toISOString(),
            updatedBy: req.session.user.id,
        };

        // Tier-driven clamps: on community tier we force
        // piiDetectionAction → 'block' and webSearchGuardEnabled → false
        // BEFORE persisting, so the stored row matches what the runtime
        // will honour. Enterprise+ (or a server-wide override) passes
        // through unchanged. The clamp persists in the row: when the
        // customer later upgrades the value stays 'block' and they must
        // re-pick 'tokenize' to opt in — safer default after an upgrade
        // than silently re-enabling a stricter mode.
        const clamps = await _tierClamps({ organizationId: orgId, userId: req.session?.user?.id });
        const clampedFields = _applyTierClamps(config, clamps);

        await configStore.setConfig(`org_privacy_shield_${orgId}`, config);

        // Nudge the in-process custom-terms cache so the next request picks up the new regex.
        try { require('../core/dlp/customTerms').invalidate(orgId); } catch (_) { /* module may not be loaded yet */ }

        // NOTE: we used to copy this org's PII / Azure / severity settings into
        // the global `ai` configStore blob here. That caused a cross-org leak:
        // org A saving a stricter threshold changed the defaults for org B.
        // The runtime already reads org shield first (resolveOrgShield) and
        // falls back to the global blob only when the org has no config, so
        // the sync-write served no purpose. It was removed in the Privacy
        // Shield redesign. See plan: /home/tom/.claude/plans/quirky-wondering-pond.md

        console.log(`[OrgPrivacyShield] Saved config for org ${orgId} by ${req.session.user.id}${termErrors.length ? ` (with ${termErrors.length} invalid term(s))` : ''}${clampedFields.length ? ` (clamped ${clampedFields.join(',')} for tier=${clamps.tier})` : ''}`);
        // If some custom terms failed, the rest of the shield and the valid
        // terms are still persisted. The client shows per-term errors from
        // `termErrors` and keeps the user's other edits in place.
        const response = { ok: true, config, termErrors };
        if (clampedFields.length > 0) {
            response.clamped_fields = clampedFields;
            response.clamped_tier = clamps.tier;
        }
        res.json(response);
    } catch (e) {
        console.error('[OrgPrivacyShield] PUT error:', e);
        res.status(500).json({ error: e.message });
    }
});


// GET /:orgId/effective — inspection-only view of the config the runtime
// actually sees for this org. Useful after a deploy to verify that custom
// deploys aren't stuck on a legacy config shape, or that PII/DLP is
// really enabled (not just toggled in the UI). Mirrors what
// `resolveOrgShield` returns — same fields, same defaults, same warnings.
router.get('/:orgId/effective', requireAuth, async (req, res) => {
    try {
        const { orgId } = req.params;
        const orgIds = await resolveUserOrgIds(req);
        const isMember = orgIds === null || (orgIds && orgIds.has(orgId));
        if (!isMember) return res.status(403).json({ error: 'Not a member of this organization' });

        const raw = await configStore.getConfig(`org_privacy_shield_${orgId}`);
        const { resolveOrgShield } = require('../core/orgShield');
        const resolved = await resolveOrgShield(orgId);
        const summary = resolved ? {
            shieldEnabled: resolved.enabled,
            piiEnabled: resolved.enabled,
            piiCategoriesCount: (resolved.piiDetectionCategories || []).length,
            piiConfidenceThreshold: resolved.piiDetectionConfidenceThreshold,
            piiConfidenceWarning: resolved.piiDetectionConfidenceThreshold >= 0.85
                ? 'Threshold is unusually high; the detector may return scores below this value. Lower to 0.70 if PII does not fire.'
                : null,
            dlpEnabled: resolved.dlpEnabled,
            privacyScanEnabled: resolved.privacyScanEnabled,
            privacyAction: resolved.privacyAction,
            privacyScope: resolved.privacyScope,
            customTermsCount: (resolved.customSensitiveTerms || []).length,
            stalenessWarnings: resolved.stalenessWarnings || [],
        } : { shieldEnabled: false };

        const rawShape = raw && typeof raw === 'object' ? {
            hasPrivacyScanEnabled: 'privacyScanEnabled' in raw,
            hasAzurePiiEnabled: 'azurePiiEnabled' in raw,
            hasDlpEnabled: 'dlpEnabled' in raw,
            hasPiiDetectionAction: 'piiDetectionAction' in raw,
            hasDlpMode: 'dlpMode' in raw,
            legacyShape: ('azurePiiEnabled' in raw || 'piiDetectionAction' in raw) && !('privacyScanEnabled' in raw),
            updatedAt: raw.updatedAt || null,
            updatedBy: raw.updatedBy || null,
        } : null;

        res.json({ orgId, summary, rawShape, resolved });
    } catch (e) {
        console.error('[OrgPrivacyShield] GET effective error:', e);
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
//  User-level Privacy Shield (Consumer Accounts)
// ═══════════════════════════════════════

const USER_SHIELD_DEFAULTS = {
    enabled: false,
    euModeEnabled: false,
    disableSearchOnUpload: false,
    piiDetectionEnabled: false,
    piiDetectionCategories: [],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'tokenize',
    showRawPayload: false,
};

// GET /user/me — get user-level shield config (consumer accounts)
router.get('/user/me', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const stored = await configStore.getConfig(`user_privacy_shield_${userId}`);
        if (stored) {
            return res.json({ ...USER_SHIELD_DEFAULTS, ...stored });
        }
        // Legacy migration: users who turned on EU mode through the
        // (now-removed) Startup Agent toggle had it written to
        // `user_eu_mode_${userId}`. Surface that as enabled+euModeEnabled
        // so the new panel reflects their existing preference; the next
        // Save through the panel persists into the canonical key.
        const legacyEu = await configStore.getConfig(`user_eu_mode_${userId}`);
        if (legacyEu === true) {
            return res.json({ ...USER_SHIELD_DEFAULTS, enabled: true, euModeEnabled: true });
        }
        res.json({ ...USER_SHIELD_DEFAULTS });
    } catch (e) {
        console.error('[UserPrivacyShield] GET error:', e);
        res.status(500).json({ error: e.message });
    }
});

// PUT /user/me — save user-level shield config (consumer accounts)
router.put('/user/me', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const {
            enabled, euModeEnabled, disableSearchOnUpload,
            piiDetectionEnabled, piiDetectionCategories,
            piiDetectionConfidenceThreshold, piiDetectionAction,
            showRawPayload,
        } = req.body;

        const threshold = typeof piiDetectionConfidenceThreshold === 'number'
            ? Math.max(0.1, Math.min(1, piiDetectionConfidenceThreshold))
            : 0.7;

        const config = {
            enabled: !!enabled,
            euModeEnabled: !!euModeEnabled,
            disableSearchOnUpload: !!disableSearchOnUpload,
            piiDetectionEnabled: !!piiDetectionEnabled,
            piiDetectionCategories: Array.isArray(piiDetectionCategories) ? piiDetectionCategories : [],
            piiDetectionConfidenceThreshold: threshold,
            piiDetectionAction: ['block', 'tokenize'].includes(piiDetectionAction) ? piiDetectionAction : 'tokenize',
            showRawPayload: !!showRawPayload,
            updatedAt: new Date().toISOString(),
            updatedBy: userId,
        };

        await configStore.setConfig(`user_privacy_shield_${userId}`, config);
        console.log(`[UserPrivacyShield] Saved config for user ${userId}`);
        res.json({ ok: true, config });
    } catch (e) {
        console.error('[UserPrivacyShield] PUT error:', e);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
