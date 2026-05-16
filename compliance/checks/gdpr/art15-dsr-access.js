/**
 * GDPR Art. 15 — Right of access by the data subject.
 *
 * Verifies that the org has a working DSR access workflow and is fulfilling
 * requests within the 30-day statutory window. SLA is read from `dsr_requests`.
 */

const dsrStore = require('../../../stores/dsrStore');

module.exports = {
    id: 'GDPR-Art15-dsr-access',
    regulation: 'GDPR',
    article: '15',
    severity: 'high',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art15.title',
    descriptionKey: 'compliance.checks.gdpr_art15.desc',
    remediationKey: 'compliance.checks.gdpr_art15.fix',
    remediationLink: 'admin/compliance?expand=dsr',
    async evaluate(orgId) {
        let stats;
        try {
            stats = await dsrStore.getSlaStats(orgId, 'access', 365);
        } catch (e) {
            return {
                status: 'warn',
                evidence: { error: e.message },
                details: 'Could not read DSR ledger — open Compliance → DSR Inbox to verify.',
            };
        }
        if (!stats.total) {
            return {
                status: 'not_applicable',
                evidence: stats,
                details: 'No data-subject access requests received in the last 12 months.',
            };
        }
        const status = stats.overdue > 0 ? 'fail' : (stats.open > 0 && stats.avg_days_to_fulfil > 25 ? 'warn' : 'pass');
        return {
            status,
            evidence: stats,
            details: status === 'pass'
                ? `${stats.fulfilled}/${stats.total} access requests fulfilled (avg ${Number(stats.avg_days_to_fulfil || 0).toFixed(1)} days).`
                : status === 'warn'
                    ? `${stats.open} access request(s) still open and approaching the 30-day deadline.`
                    : `${stats.overdue} access request(s) are overdue (>30 days). GDPR Art. 12(3) requires fulfilment within one month.`,
        };
    },
};
