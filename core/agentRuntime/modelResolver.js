/**
 * Model resolution — resolves tier-based model configs to actual model IDs
 */
const { resolveModelId } = require('../aiAgent');
const configStore = require('../../stores/configStore');

async function resolveAgentModel(agentModel, userMessage, globalConfig) {
    // Not a tier-based model — force tier:auto resolution
    if (!agentModel || !agentModel.startsWith('tier:')) {
        console.log(`[AgentRuntime] Model "${agentModel || 'none'}" is not tier-based, resolving as tier:auto`);
        // Recurse with tier:auto to use the tier system
        return resolveAgentModel('tier:auto', userMessage, globalConfig);
    }

    const tierName = agentModel.substring(5); // strip 'tier:'
    let tiers = await configStore.getConfig('chat_model_tiers') || {};

    // EU mode override: check agent's org first, then fall back to user's org
    const orgId = globalConfig?.organizationId || globalConfig?.userOrgId;
    if (orgId) {
        const shield = await configStore.getConfig(`org_privacy_shield_${orgId}`);
        if (shield?.enabled && shield?.euModeEnabled) {
            const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
            const mergedTiers = { ...tiers };
            for (const [tn, euTier] of Object.entries(euTiers)) {
                if (euTier?.modelId) {
                    mergedTiers[tn] = { ...mergedTiers[tn], ...euTier };
                }
            }
            tiers = mergedTiers;
            console.log(`[AgentRuntime] EU mode active for org ${orgId}`);
        }
    }

    // Fixed tier (fast/thinking/pro) — just look up the model
    if (tierName !== 'auto') {
        const tier = tiers[tierName];
        if (tier?.modelId) {
            console.log(`[AgentRuntime] Tier "${tierName}" → model: ${tier.modelId}`);
            return tier.modelId;
        }
        // Tier not configured, fall back to default
        console.log(`[AgentRuntime] Tier "${tierName}" not configured, using default`);
        return resolveModelId(globalConfig.model);
    }

    // Auto tier — use unified classifier (LLM + heuristic fallback)
    try {
        const { classifyWithLLM } = require('./promptClassifier');
        const result = await classifyWithLLM(userMessage, tiers);
        const model = tiers[result.tier]?.modelId || tiers.fast?.modelId || resolveModelId(globalConfig.model);
        console.log(`[AgentRuntime] Auto: tier="${result.tier}" → model: ${model} (${result.method}: ${result.reason})`);
        return model;
    } catch (err) {
        console.log(`[AgentRuntime] Auto classification failed: ${err.message}, using default`);
        return tiers.fast?.modelId || resolveModelId(globalConfig.model);
    }
}

module.exports = { resolveAgentModel };
