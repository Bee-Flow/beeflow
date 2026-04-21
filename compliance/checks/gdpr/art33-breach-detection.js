/**
 * GDPR Art. 33 — Breach notification readiness.
 *
 * Art. 33 requires notifying the supervisory authority within 72 hours of a
 * personal-data breach. The only configurable thing we can check is whether
 * at least one breach-notification recipient is set in compliance_settings;
 * anomaly-detection signals (bulk decrypt events) are always available via
 * decryptAudit so they don't need a feature flag.
 */

const complianceStore = require('../../../stores/complianceStore');

module.exports = {
    id: 'GDPR-Art33-breach-detection',
    regulation: 'GDPR',
    article: '33',
    severity: 'high',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art33.title',
    descriptionKey: 'compliance.checks.gdpr_art33.desc',
    remediationKey: 'compliance.checks.gdpr_art33.fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        const recipients = Array.isArray(settings.breach_recipients) ? settings.breach_recipients : [];
        const validRecipients = recipients.filter(r => typeof r === 'string' && /@/.test(r));

        const status = validRecipients.length > 0 ? 'pass' : 'fail';
        return {
            status,
            evidence: { breach_recipients_count: validRecipients.length },
            details: status === 'pass'
                ? `${validRecipients.length} breach-notification recipient(s) configured. The 72-hour window can be met.`
                : 'No breach-notification recipients are set. GDPR Art. 33 requires notification within 72 hours — add at least one email.',
        };
    },
};
