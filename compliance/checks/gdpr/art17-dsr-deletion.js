/**
 * GDPR Art. 17 — Right to erasure ("right to be forgotten").
 *
 * Same SLA structure as Art. 15 but for deletion requests, which carry a
 * higher fail-severity because partial deletion is itself a compliance risk.
 */

const dsrStore = require('../../../stores/dsrStore');

module.exports = {
    id: 'GDPR-Art17-dsr-deletion',
    regulation: 'GDPR',
    article: '17',
    severity: 'critical',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art17.title',
    descriptionKey: 'compliance.checks.gdpr_art17.desc',
    remediationKey: 'compliance.checks.gdpr_art17.fix',
    remediationLink: 'admin/compliance?expand=dsr',
    async evaluate(orgId) {
        let stats;
        try {
            stats = await dsrStore.getSlaStats(orgId, 'deletion', 365);
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
                details: 'No erasure requests received in the last 12 months.',
            };
        }
        const status = stats.overdue > 0 ? 'fail' : (stats.open > 0 && stats.avg_days_to_fulfil > 25 ? 'warn' : 'pass');
        return {
            status,
            evidence: stats,
            details: status === 'pass'
                ? `${stats.fulfilled}/${stats.total} erasure requests fulfilled (avg ${Number(stats.avg_days_to_fulfil || 0).toFixed(1)} days).`
                : status === 'warn'
                    ? `${stats.open} erasure request(s) still open and approaching the 30-day deadline.`
                    : `${stats.overdue} erasure request(s) are overdue. Each missed deadline is a separate Art. 17 breach.`,
        };
    },
};
