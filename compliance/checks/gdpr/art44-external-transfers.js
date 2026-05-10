/**
 * GDPR Art. 44-46 — International transfers / external LLMs.
 *
 * Scans the AI provider list and agent models to see whether personal data
 * could leave EU / self-hosted infrastructure. `ai.providers` is an ARRAY of
 * `{id, name, type, url, model, apiKey}` rows (see aiAgent.ensureDefaultProvider).
 */

const { getAll } = require('../../../db');
const configStore = require('../../../stores/configStore');
const { classifyProvider } = require('../../../core/providers/classification');

// Known external provider prefixes that can appear inside an agent.model string
// (e.g. "openai/gpt-4o", "azure:gpt-4o"). A kale modelnaam zoals "gpt-4o"
// wordt NIET geflagd op naam alleen — we vertrouwen op de provider-list.
const EXTERNAL_PROVIDER_PREFIXES = new Set([
    'openai', 'claude', 'anthropic', 'google', 'google-vertex',
    'azure', 'mistral', 'cohere', 'groq', 'together',
    'fireworks', 'perplexity',
]);

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
        const providers = Array.isArray(ai.providers) ? ai.providers : [];
        const allowlist = Array.isArray(ai.privateHostAllowlist) ? ai.privateHostAllowlist : [];

        // ── Scan provider list ─────────────────────────────────────
        const externalProviders = [];
        for (const p of providers) {
            if (!p || typeof p !== 'object') continue;
            // Skip providers without an API key — they aren't actively used.
            if (!p.apiKey && !p.enabled) continue;
            const result = classifyProvider({
                providerType: p.type || '',
                url: p.url || p.baseUrl || p.endpoint || '',
            }, allowlist);
            if (result.isExternal) {
                externalProviders.push({
                    id: p.id, name: p.name || p.type, type: p.type, reason: result.reason,
                });
            }
        }

        // ── Scan agent model strings ───────────────────────────────
        let agents = [];
        try {
            agents = await getAll(`SELECT id, name, model, organization_id FROM agents WHERE is_published = TRUE`);
        } catch { /* fresh install, no agents table yet */ }
        const externalAgents = [];
        for (const a of agents) {
            if (orgId && a.organization_id && a.organization_id !== orgId) continue;
            const model = String(a.model || '').trim();
            if (!model) continue;
            // Extract provider prefix if present ("openai/gpt-4o" → "openai").
            const prefix = model.split(/[\/:]/)[0].toLowerCase();
            if (EXTERNAL_PROVIDER_PREFIXES.has(prefix)) {
                externalAgents.push({ id: a.id, name: a.name, model });
            }
        }

        const hasExternal = externalProviders.length > 0 || externalAgents.length > 0;
        const status = hasExternal ? 'warn' : 'pass';
        return {
            status,
            evidence: {
                external_providers: externalProviders,
                external_agents: externalAgents.slice(0, 20),
                total_providers_configured: providers.length,
            },
            details: status === 'pass'
                ? providers.length === 0
                    ? 'No LLM providers configured — nothing leaves your infrastructure.'
                    : `All ${providers.length} configured provider(s) run on self-hosted or EU-internal infrastructure.`
                : `${externalProviders.length} external provider(s) and ${externalAgents.length} published agent(s) send data to cloud LLMs outside EU/self-hosted boundaries. Confirm SCCs/DPAs are in place or switch those agents to internal models.`,
        };
    },
};
