/**
 * GDPR Art. 32 — Access / guardrail logging is active.
 * Passes if at least one guardrail_events row exists in the last 7 days.
 */

const { getOne } = require('../../../db');

module.exports = {
    id: 'GDPR-Art32-access-logging',
    regulation: 'GDPR',
    article: '32',
    severity: 'medium',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art32_log.title',
    descriptionKey: 'compliance.checks.gdpr_art32_log.desc',
    remediationKey: 'compliance.checks.gdpr_art32_log.fix',
    remediationLink: 'admin/monitoring/activity',
    async evaluate(orgId) {
        let count = 0;
        try {
            const row = await getOne(`
                SELECT COUNT(*)::int AS c FROM guardrail_events
                WHERE timestamp >= NOW() - INTERVAL '7 days'
                ${orgId ? 'AND organization_id = $1' : ''}
            `, orgId ? [orgId] : []);
            count = row?.c || 0;
        } catch {
            // Table may not exist yet — treat as warn
            return {
                status: 'warn',
                evidence: { table_missing: true },
                details: 'guardrail_events table not available — access logging cannot be confirmed.',
            };
        }
        const status = count > 0 ? 'pass' : 'warn';
        return {
            status,
            evidence: { events_last_7d: count },
            details: status === 'pass'
                ? `${count} guardrail events recorded in the last 7 days — logging is working.`
                : 'No guardrail events logged in the last 7 days. Verify that Guardrails or DLP are active.',
        };
    },
};
