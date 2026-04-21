/**
 * GDPR Art. 33 — Breach notification readiness.
 * Requires: (1) breach recipients configured in compliance_settings,
 *           (2) decryptAudit module active (bulk-decrypt detection).
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
        let decryptAuditLoaded = false;
        try {
            require('../../../auth/decryptAudit');
            decryptAuditLoaded = true;
        } catch { /* module missing */ }

        let status;
        if (recipients.length > 0 && decryptAuditLoaded) status = 'pass';
        else if (decryptAuditLoaded) status = 'warn';
        else status = 'fail';

        return {
            status,
            evidence: {
                breach_recipients_count: recipients.length,
                decrypt_audit_module: decryptAuditLoaded,
            },
            details: status === 'pass'
                ? `${recipients.length} breach recipient(s) configured; bulk-decrypt anomaly detection active.`
                : status === 'warn'
                    ? 'Breach detection is active but no recipients are set — add at least one email to alert on 72-hour window.'
                    : 'Breach detection module is not loaded; the 72-hour notification window in Art. 33 cannot be met.',
        };
    },
};
