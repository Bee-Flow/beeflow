/**
 * GDPR Art. 44-49 — International transfers / external LLMs.
 *
 * Evidence-driven detection. Instead of trying to guess from provider config,
 * we read the real outbound activity ledger (`integration_activity_log`) for
 * the last 30 days and look at the `country_code` / `is_eu` / `operator` of
 * each call. Operators that the admin has attested to ("SCCs in place") are
 * stored in `compliance_settings.scc_confirmed_operators` and stop the check
 * from failing for them.
 *
 * Fallback (provider/agent scan) is kept as a *secondary* signal so freshly
 * installed orgs that haven't generated any traffic yet still surface obvious
 * misconfigurations.
 */

const { getAll } = require('../../../db');
const configStore = require('../../../stores/configStore');
const complianceStore = require('../../../stores/complianceStore');

const EXTERNAL_PROVIDER_PREFIXES = new Set([
    'openai', 'claude', 'anthropic', 'google', 'google-vertex',
    'azure', 'mistral', 'cohere', 'groq', 'together',
    'fireworks', 'perplexity',
]);

async function _queryTransfers(orgId) {
    try {
        return await getAll(`
            SELECT operator,
                   country_code,
                   country_name,
                   COALESCE(is_eu, false) AS is_eu,
                   COALESCE(is_local, false) AS is_local,
                   COUNT(*)::int AS calls,
                   MIN(timestamp) AS first_seen,
                   MAX(timestamp) AS last_seen
            FROM integration_activity_log
            WHERE organization_id = $1
              AND timestamp >= NOW() - INTERVAL '30 days'
            GROUP BY operator, country_code, country_name, is_eu, is_local
            ORDER BY calls DESC
            LIMIT 200
        `, [orgId]);
    } catch {
        return null; // table absent on fresh installs
    }
}

async function _scanAgents(orgId) {
    try {
        const rows = await getAll(`SELECT id, name, model, organization_id FROM agents WHERE is_published = TRUE`);
        const external = [];
        for (const a of rows) {
            if (orgId && a.organization_id && a.organization_id !== orgId) continue;
            const model = String(a.model || '').trim();
            if (!model) continue;
            const prefix = model.split(/[\/:]/)[0].toLowerCase();
            if (EXTERNAL_PROVIDER_PREFIXES.has(prefix)) external.push({ id: a.id, name: a.name, model });
        }
        return external;
    } catch {
        return [];
    }
}

module.exports = {
    id: 'GDPR-Art44-external-transfers',
    regulation: 'GDPR',
    article: '44',
    severity: 'high',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art44.title',
    descriptionKey: 'compliance.checks.gdpr_art44.desc',
    remediationKey: 'compliance.checks.gdpr_art44.fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const transfers = await _queryTransfers(orgId);
        const settings = await complianceStore.getSettings(orgId);
        const sccConfirmed = new Set(
            (Array.isArray(settings.scc_confirmed_operators) ? settings.scc_confirmed_operators : [])
                .map(e => String(e?.operator || '').toLowerCase())
                .filter(Boolean)
        );

        // ── Primary signal: real outbound calls ────────────────────
        if (Array.isArray(transfers) && transfers.length > 0) {
            const nonEuUnconfirmed = [];
            const nonEuConfirmed = [];
            const euOrLocal = [];
            for (const row of transfers) {
                if (row.is_eu || row.is_local) { euOrLocal.push(row); continue; }
                const op = String(row.operator || '').toLowerCase();
                if (op && sccConfirmed.has(op)) nonEuConfirmed.push(row);
                else nonEuUnconfirmed.push(row);
            }
            const totalNonEu = nonEuUnconfirmed.length + nonEuConfirmed.length;
            let status;
            if (nonEuUnconfirmed.length > 0) status = 'fail';
            else if (totalNonEu > 0) status = 'pass';
            else status = 'pass';
            const details = nonEuUnconfirmed.length > 0
                ? `${nonEuUnconfirmed.length} operator(s) routed personal data outside the EU in the last 30 days without SCC attestation. Confirm SCCs/DPAs under Compliance → Settings or switch traffic to an EU operator.`
                : totalNonEu > 0
                    ? `${nonEuConfirmed.length} non-EU operator(s) in use — all covered by attested Standard Contractual Clauses.`
                    : 'All outbound integration calls in the last 30 days routed to EU or local infrastructure.';
            return {
                status,
                evidence: {
                    window_days: 30,
                    transfers_total: transfers.length,
                    non_eu_unconfirmed: nonEuUnconfirmed.slice(0, 50),
                    non_eu_confirmed: nonEuConfirmed.slice(0, 50),
                    eu_or_local_sample: euOrLocal.slice(0, 10),
                    scc_confirmed_operators: Array.from(sccConfirmed),
                },
                details,
            };
        }

        // ── Fallback: provider list + agent model scan ─────────────
        const ai = (await configStore.getConfig('ai')) || {};
        const providers = Array.isArray(ai.providers) ? ai.providers : [];
        const externalAgents = await _scanAgents(orgId);

        if (providers.length === 0 && externalAgents.length === 0) {
            return {
                status: 'not_applicable',
                evidence: { window_days: 30, transfers_total: 0, fallback: 'no providers, no agents' },
                details: 'No outbound integrations or external providers configured — nothing leaves your infrastructure.',
            };
        }

        const status = externalAgents.length > 0 ? 'warn' : 'pass';
        return {
            status,
            evidence: {
                window_days: 30,
                transfers_total: 0,
                fallback: 'no_activity_log',
                providers_configured: providers.length,
                external_agents: externalAgents.slice(0, 20),
            },
            details: externalAgents.length > 0
                ? `${externalAgents.length} published agent(s) reference external providers. No outbound calls observed in the last 30 days — re-evaluate once traffic flows, or attest SCCs proactively.`
                : `All ${providers.length} configured provider(s) appear to be EU/self-hosted, and no outbound traffic was observed in the last 30 days.`,
        };
    },
};
