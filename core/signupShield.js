/**
 * Build an org Privacy-Shield config object from a signup-wizard payload.
 *
 * Writes the REAL fields the runtime PII pipeline consumes
 * (piiDetectionCategories / piiDetectionAction / piiDetectionConfidenceThreshold
 * / enabled) — not the dead `moderation*` fields the old signup code wrote,
 * which the runtime no longer reads. This makes a wizard-created org's shield
 * identical to what Settings → Privacy Shield (orgPrivacyShield.js PUT) produces.
 *
 * Accepts the new `orgDetails.privacyShield` shape:
 *   { enabled, piiDetectionCategories, piiDetectionAction, euModeEnabled }
 * and falls back to the legacy coarse `orgDetails.privacyLevel`
 * ('off' | 'basic' | 'strict') so any older / non-wizard caller still produces
 * a valid config. Returns null when the shield should be OFF (write nothing).
 *
 * Tier entitlements (e.g. community → forced 'block') are applied at read time
 * by applyTierClampsToShield in orgShield.js, so no clamping is done here.
 */
const { ALL_PII_CATEGORY_IDS } = require('./piiDetection');

const VALID_PII_ACTIONS = ['block', 'tokenize', 'warn'];

function buildSignupShieldConfig(orgDetails = {}, { updatedBy = 'system-signup' } = {}) {
    const valid = new Set(ALL_PII_CATEGORY_IDS);
    const ps = orgDetails.privacyShield;

    let enabled;
    let categories;
    let action;
    let euMode;

    if (ps && typeof ps === 'object') {
        enabled = ps.enabled !== false;
        categories = Array.isArray(ps.piiDetectionCategories) ? ps.piiDetectionCategories : [];
        action = VALID_PII_ACTIONS.includes(ps.piiDetectionAction) ? ps.piiDetectionAction : 'block';
        euMode = !!ps.euModeEnabled;
    } else {
        // Legacy coarse level. 'basic' leaves categories empty → runtime falls
        // back to all categories; 'strict' selects all explicitly.
        const level = orgDetails.privacyLevel || 'off';
        if (level === 'off') return null;
        enabled = true;
        categories = level === 'strict' ? [...ALL_PII_CATEGORY_IDS] : [];
        action = 'block';
        euMode = !!orgDetails.euModeEnabled;
    }

    if (!enabled) return null;

    return {
        enabled: true,
        collectionIds: [],
        scope: { userInput: true, agentOutput: true },
        action: 'delete',
        euModeEnabled: euMode,
        piiDetectionCategories: categories.filter(id => valid.has(id)),
        piiDetectionConfidenceThreshold: 0.7,
        piiDetectionAction: action,
        updatedAt: new Date().toISOString(),
        updatedBy,
    };
}

module.exports = { buildSignupShieldConfig };
