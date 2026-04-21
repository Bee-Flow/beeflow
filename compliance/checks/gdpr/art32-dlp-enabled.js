/**
 * GDPR Art. 32 — DLP (Data Loss Prevention) active.
 *
 * Checks whether regex guardrails, PII detection, and content moderation are
 * enabled. Reads BOTH the org-specific Privacy Shield config AND falls back
 * to the global `ai` config so single-tenant installs (where nobody set a
 * per-org shield) don't get false-negative results.
 */

const configStore = require('../../../stores/configStore');

module.exports = {
    id: 'GDPR-Art32-dlp-enabled',
    regulation: 'GDPR',
    article: '32',
    severity: 'high',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art32_dlp.title',
    descriptionKey: 'compliance.checks.gdpr_art32_dlp.desc',
    remediationKey: 'compliance.checks.gdpr_art32_dlp.fix',
    remediationLink: 'admin/security/guardrails',
    async evaluate(orgId) {
        const orgKey = `org_privacy_shield_${orgId || 'default'}`;
        const shield = (await configStore.getConfig(orgKey)) || {};
        const ai = (await configStore.getConfig('ai')) || {};

        // Regex guardrails: either org shield enabled with collections, or
        // global regex guardrails configured in ai config.
        const regexEnabled =
            (!!shield.enabled && Array.isArray(shield.collectionIds) && shield.collectionIds.length > 0) ||
            (!!ai.regexGuardrails && (Array.isArray(ai.regexGuardrails) ? ai.regexGuardrails.length > 0 : Object.keys(ai.regexGuardrails).length > 0));

        // PII detection: org shield PII toggled or categories list set on org or global.
        const piiEnabled =
            !!shield.azurePiiEnabled ||
            (Array.isArray(shield.piiDetectionCategories) && shield.piiDetectionCategories.length > 0) ||
            (Array.isArray(ai.piiDetectionCategories) && ai.piiDetectionCategories.length > 0);

        // Moderation: either org moderation flag or global moderation provider set.
        const moderationEnabled =
            !!shield.moderationEnabled ||
            !!ai.moderationEnabled ||
            !!ai.moderationProvider;

        let status;
        if (regexEnabled && piiEnabled && moderationEnabled) status = 'pass';
        else if (piiEnabled || moderationEnabled || regexEnabled) status = 'warn';
        else status = 'fail';

        return {
            status,
            evidence: {
                regex_guardrails: regexEnabled,
                pii_detection: piiEnabled,
                moderation: moderationEnabled,
                source: shield.enabled ? 'org_privacy_shield' : 'global_ai_config',
            },
            details: status === 'pass'
                ? 'Regex guardrails, PII detection and content moderation are all enabled.'
                : status === 'warn'
                    ? 'DLP is partially enabled. Open Security → Guardrails and turn on the missing layers (regex collections, PII detection, moderation).'
                    : 'No DLP protection active. Sensitive data can leave the system unchecked.',
        };
    },
};
