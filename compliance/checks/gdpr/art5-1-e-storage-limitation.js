/**
 * GDPR Art. 5(1)(e) — Storage limitation.
 *
 * Personal data must be kept "no longer than is necessary". We check two
 * things:
 *   1. The memory retention enforcer ran in the last 24 hours (heartbeat in
 *      `compliance_settings.last_retention_run_at`).
 *   2. No `user_memories` rows are older than the org's `default_retention_days`
 *      without `expires_at` set. Orphan rows are a real risk.
 */

const { getOne } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');

module.exports = {
    id: 'GDPR-Art5-1-e-storage-limitation',
    regulation: 'GDPR',
    article: '5(1)(e)',
    severity: 'medium',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art5_1_e.title',
    descriptionKey: 'compliance.checks.gdpr_art5_1_e.desc',
    remediationKey: 'compliance.checks.gdpr_art5_1_e.fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        const retentionDays = settings.default_retention_days || 365;
        const lastRun = settings.last_retention_run_at ? new Date(settings.last_retention_run_at) : null;
        const heartbeatAgeMs = lastRun ? Date.now() - lastRun.getTime() : Infinity;
        const heartbeatOk = heartbeatAgeMs < 26 * 3600 * 1000; // 26h allowance for clock drift

        // Orphan memories — no expires_at AND older than the retention window.
        let orphans = 0;
        try {
            const row = await getOne(`
                SELECT COUNT(*)::int AS c FROM user_memories
                WHERE status = 'active'
                  AND expires_at IS NULL
                  AND created_at < NOW() - ($1 || ' days')::interval
            `, [String(retentionDays)]);
            orphans = row?.c || 0;
        } catch {
            return {
                status: 'not_applicable',
                evidence: { reason: 'user_memories table not available' },
                details: 'Memory retention cannot be verified — the user_memories table is not present yet.',
            };
        }

        const evidence = {
            retention_days: retentionDays,
            heartbeat: lastRun ? settings.last_retention_run_at : null,
            heartbeat_age_hours: lastRun ? Math.round(heartbeatAgeMs / 3600000) : null,
            orphan_memories: orphans,
        };

        if (!heartbeatOk) {
            return {
                status: 'fail',
                evidence,
                details: lastRun
                    ? `Memory retention enforcer last ran ${Math.round(heartbeatAgeMs / 3600000)}h ago — should run every 24h.`
                    : 'Memory retention enforcer has never run. Restart the server or enable the retention job.',
            };
        }
        if (orphans > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${orphans} stored memories have no retention deadline and are older than ${retentionDays} days. Run the retention enforcer or assign expires_at.`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `Retention enforcer ran ${Math.round(heartbeatAgeMs / 3600000)}h ago; no orphan memories beyond the ${retentionDays}-day window.`,
        };
    },
};
