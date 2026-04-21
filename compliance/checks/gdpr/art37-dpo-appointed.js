/**
 * GDPR Art. 37 — Data Protection Officer appointed.
 * Reads compliance_settings.dpo_email.
 */

const complianceStore = require('../../../stores/complianceStore');

module.exports = {
    id: 'GDPR-Art37-dpo-appointed',
    regulation: 'GDPR',
    article: '37',
    severity: 'high',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art37.title',
    descriptionKey: 'compliance.checks.gdpr_art37.desc',
    remediationKey: 'compliance.checks.gdpr_art37.fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const s = await complianceStore.getSettings(orgId);
        const hasEmail = !!(s.dpo_email && /@/.test(s.dpo_email));
        const hasName = !!s.dpo_name;
        let status;
        if (hasEmail && hasName) status = 'pass';
        else if (hasEmail || hasName) status = 'warn';
        else status = 'fail';
        return {
            status,
            evidence: { dpo_name: !!hasName, dpo_email: !!hasEmail },
            details: status === 'pass'
                ? `DPO appointed: ${s.dpo_name} (${s.dpo_email}).`
                : status === 'warn'
                    ? 'DPO details are incomplete. Fill in both name and a valid email.'
                    : 'No Data Protection Officer has been appointed. Required when processing personal data at scale.',
        };
    },
};
