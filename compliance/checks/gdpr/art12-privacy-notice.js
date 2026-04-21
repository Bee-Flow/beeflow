/**
 * GDPR Art. 12/13/14 — Transparent information to data subjects.
 * Verifies that a privacy-notice URL has been published in compliance_settings.
 */

const complianceStore = require('../../../stores/complianceStore');

module.exports = {
    id: 'GDPR-Art12-privacy-notice',
    regulation: 'GDPR',
    article: '12',
    severity: 'medium',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art12.title',
    descriptionKey: 'compliance.checks.gdpr_art12.desc',
    remediationKey: 'compliance.checks.gdpr_art12.fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const s = await complianceStore.getSettings(orgId);
        const url = (s.privacy_notice_url || '').trim();
        const ok = /^https?:\/\//i.test(url);
        return {
            status: ok ? 'pass' : 'fail',
            evidence: { privacy_notice_url: url || null },
            details: ok
                ? `Privacy notice published at ${url}.`
                : 'No privacy-notice URL set. Data subjects must be able to find how their data is processed.',
        };
    },
};
