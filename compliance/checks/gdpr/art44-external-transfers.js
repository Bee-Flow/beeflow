/**
 * GDPR Art. 44-46 — International transfers / external LLMs.
 * Scans agents + global AI config for external provider usage.
 * If any agent uses an external LLM, warn (SCC/DPA may be required).
 */

const { getAll } = require('../../../db');
const configStore = require('../../../stores/configStore');
const { classifyProvider } = require('../../../core/providers/classification');

module.exports = {
    id: 'GDPR-Art44-external-transfers',
    regulation: 'GDPR',
    article: '44',
    severity: 'high',
    scope: 'global',
    titleKey: 'compliance.checks.gdpr_art44.title',
    descriptionKey: 'compliance.checks.gdpr_art44.desc',
    remediationKey: 'compliance.checks.gdpr_art44.fix',
    remediationLink: 'admin/ai-config',
    async evaluate(orgId) {
        const ai = (await configStore.getConfig('ai')) || {};
        const providers = ai.providers || {};
        const allowlist = Array.isArray(ai.privateHostAllowlist) ? ai.privateHostAllowlist : [];

        const externalProviders = [];
        for (const [type, cfg] of Object.entries(providers)) {
            if (!cfg || typeof cfg !== 'object') continue;
            const hasKey = !!(cfg.apiKey || cfg.enabled);
            if (!hasKey) continue;
            const result = classifyProvider({ providerType: type, url: cfg.baseUrl || cfg.endpoint || '' }, allowlist);
            if (result.isExternal) externalProviders.push({ type, reason: result.reason });
        }

        let agents = [];
        try {
            agents = await getAll(`SELECT id, name, model, organization_id FROM agents WHERE is_published = TRUE`);
        } catch { /* agents table may not exist in fresh install */ }
        const externalAgents = [];
        for (const a of agents) {
            if (orgId && a.organization_id && a.organization_id !== orgId) continue;
            const model = String(a.model || '');
            if (!model) continue;
            const typeGuess = model.split(/[\/:]/)[0].toLowerCase();
            const cls = classifyProvider({ providerType: typeGuess, url: '' }, allowlist);
            if (cls.isExternal) externalAgents.push({ id: a.id, name: a.name, model });
        }

        let status;
        if (externalProviders.length === 0 && externalAgents.length === 0) status = 'pass';
        else status = 'warn';

        return {
            status,
            evidence: { external_providers: externalProviders, external_agents: externalAgents.slice(0, 20) },
            details: status === 'pass'
                ? 'No external LLM providers detected — all inference stays on self-hosted infrastructure.'
                : `${externalAgents.length} agent(s) and ${externalProviders.length} provider(s) route data outside EU/internal infrastructure. Ensure SCCs/DPAs are in place or switch to internal models.`,
        };
    },
};
