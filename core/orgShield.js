/**
 * Organization Privacy Shield — resolve org-level regex guardrail rules
 * 
 * Used by agentRuntime.js and directChat.js to enforce org-wide guardrails
 * before agent-specific or direct-chat-specific guardrails.
 */

const configStore = require('../stores/configStore');

/**
 * Resolve org privacy shield rules for a given organization ID.
 * Returns null if no shield is configured or enabled.
 * 
 * @param {string} orgId - Organization ID
 * @returns {{ enabled: boolean, rulesWithNames: Array, scope: object, action: string } | null}
 */
async function resolveOrgShield(orgId) {
    if (!orgId) return null;

    const shield = await configStore.getConfig(`org_privacy_shield_${orgId}`);
    if (!shield?.enabled) return null;

    // Need global regex config to resolve collection IDs to actual rules
    const { getAIConfig } = require('./aiAgent');
    const globalConfig = await getAIConfig();
    const globalRegexConfig = globalConfig.regexGuardrails || {};
    const globalRules = globalRegexConfig.rules || [];
    const globalCollections = globalRegexConfig.collections || [];

    const rulesWithNames = [];
    if (shield.collectionIds?.length > 0) {
        for (const colId of shield.collectionIds) {
            const collection = globalCollections.find(c => c.id === colId);
            if (collection) {
                for (const ruleId of collection.ruleIds || []) {
                    const rule = globalRules.find(r => r.id === ruleId);
                    if (rule?.pattern) {
                        rulesWithNames.push({ name: rule.name, pattern: rule.pattern });
                    }
                }
            }
        }
    }

    if (rulesWithNames.length === 0) return null;

    return {
        enabled: true,
        rulesWithNames,
        scope: shield.scope || { userInput: true, agentOutput: true },
        action: shield.action || 'delete',
        webSearchGuardEnabled: !!shield.webSearchGuardEnabled,
    };
}

/**
 * Merge org shield rules with agent/direct-chat rules.
 * Org rules come first. Action uses the stricter of the two ('delete' > 'redact').
 * Scope is merged with OR (if either enables a scope, it's enabled).
 * 
 * @param {object|null} orgConfig - From resolveOrgShield()
 * @param {object|null} localConfig - Agent or direct chat regex config
 * @returns {object|null} Merged config, or null if nothing enabled
 */
function mergeWithOrgShield(orgConfig, localConfig) {
    if (!orgConfig && !localConfig) return null;
    if (!orgConfig) return localConfig;
    if (!localConfig) return orgConfig;

    // Merge rules: org first, then local (dedup by pattern)
    const seenPatterns = new Set();
    const mergedRules = [];
    for (const r of [...orgConfig.rulesWithNames, ...localConfig.rulesWithNames]) {
        if (!seenPatterns.has(r.pattern)) {
            seenPatterns.add(r.pattern);
            mergedRules.push(r);
        }
    }

    // Action: strictest wins (delete > redact)
    const action = (orgConfig.action === 'delete' || localConfig.action === 'delete') ? 'delete' : 'redact';

    // Scope: OR merge
    const scope = {
        userInput: !!(orgConfig.scope?.userInput || localConfig.scope?.userInput),
        agentOutput: !!(orgConfig.scope?.agentOutput || localConfig.scope?.agentOutput),
        toolInput: !!(orgConfig.scope?.toolInput || localConfig.scope?.toolInput),
        toolOutput: !!(orgConfig.scope?.toolOutput || localConfig.scope?.toolOutput),
    };

    return { enabled: true, rulesWithNames: mergedRules, scope, action, webSearchGuardEnabled: !!(orgConfig.webSearchGuardEnabled || localConfig.webSearchGuardEnabled) };
}

module.exports = { resolveOrgShield, mergeWithOrgShield };
