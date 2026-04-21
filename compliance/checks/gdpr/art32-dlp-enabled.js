/**
 * GDPR Art. 32 — DLP (Data Loss Prevention) active.
 * Reads the org Privacy Shield config and checks whether regex, PII, and
 * moderation guardrails are enabled.
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
        const key = `org_privacy_shield_${orgId || 'default'}`;
        const cfg = (await configStore.getConfig(key)) || {};
        const regexEnabled = !!cfg.enabled && Array.isArray(cfg.collectionIds) && cfg.collectionIds.length > 0;
        const piiEnabled = !!cfg.azurePiiEnabled || (Array.isArray(cfg.piiDetectionCategories) && cfg.piiDetectionCategories.length > 0);
        const moderationEnabled = !!cfg.moderationEnabled;

        let status;
        if (regexEnabled && piiEnabled && moderationEnabled) status = 'pass';
        else if (piiEnabled || moderationEnabled) status = 'warn';
        else status = 'fail';

        return {
            status,
            evidence: {
                regex_collections: regexEnabled,
                pii_detection: piiEnabled,
                moderation: moderationEnabled,
                action: cfg.action || 'delete',
            },
            details: status === 'pass'
                ? 'Privacy Shield is fully enabled (regex, PII, and moderation).'
                : status === 'warn'
                    ? 'Privacy Shield is partially enabled. Turn on the missing layers in Security → Guardrails.'
                    : 'Privacy Shield is disabled. Sensitive data may leave the system unredacted.',
        };
    },
};
