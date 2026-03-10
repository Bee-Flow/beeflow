const configStore = require('../../stores/configStore');
const { validateWithLlamaGuard } = require('../moderation');
const { resolveOrgShield, mergeWithOrgShield } = require('../orgShield');
const { checkRegexPatterns } = require('../guardrails');

async function runInputGuardrails({ agent, messages, userMessage, globalConfig, onEvent }) {
    let moderationViolation = null;
    let guardrailViolation = null;
    let processedUserMessage = userMessage;

    const orgModerationEnabled = await (async () => {
        if (!agent.organization_id) return false;
        const shield = await configStore.getConfig(`org_privacy_shield_${agent.organization_id}`);
        return shield?.enabled && shield?.moderationEnabled;
    })();
    const orgModerationScope = await (async () => {
        if (!agent.organization_id) return { userInput: true, agentOutput: true };
        const shield = await configStore.getConfig(`org_privacy_shield_${agent.organization_id}`);
        return shield?.enabled ? (shield.scope || { userInput: true, agentOutput: true }) : { userInput: true, agentOutput: true };
    })();

    const orgShieldData = await (async () => {
        if (!agent.organization_id) return { webSearchGuard: false, categories: null };
        const shield = await configStore.getConfig(`org_privacy_shield_${agent.organization_id}`);
        return {
            webSearchGuard: !!(shield?.enabled && shield?.webSearchGuardEnabled),
            categories: shield?.moderationCategories || null,
        };
    })();
    const webSearchGuardEnabled = orgShieldData.webSearchGuard || !!agent.config?.webSearchGuardEnabled;
    const orgShieldCategories = orgShieldData.categories;
    const shouldCheckInputModeration = (orgModerationEnabled && orgModerationScope.userInput) ||
        agent.config?.llamaGuardEnabled || globalConfig?.llamaGuardConfig?.enabled;
    
    if (shouldCheckInputModeration) {
        try {
            await validateWithLlamaGuard(messages, agent.config?.llamaGuardEnabled, orgShieldCategories);
        } catch (guardError) {
            console.error('[GuardrailsRunner] Guardrails Check Failed:', guardError.message);
            if (guardError.violationCodes) {
                let violationLabels = guardError.violationCodes;
                try {
                    const parsed = JSON.parse(guardError.outcome);
                    violationLabels = parsed.map(f => f.label || f.category);
                } catch (e) { /* ignore */ }
                
                if (onEvent) {
                    onEvent('guardrail_violation', {
                        rules: violationLabels,
                        autoDeleteSeconds: 5,
                        outcome: guardError.outcome,
                        categories: violationLabels
                    });
                }
                moderationViolation = violationLabels.join(', ');
            }
        }
    }

    const agentRegexConfig = agent.config?.regexGuardrails;
    let regexConfig = null;
    const orgShieldConfig = await resolveOrgShield(agent.organization_id);
    let agentLocalConfig = null;
    
    if (agentRegexConfig?.enabled) {
        const globalRegexConfig = globalConfig?.regexGuardrails || {};
        const globalRules = globalRegexConfig.rules || [];
        const globalCollections = globalRegexConfig.collections || [];

        let rulesWithNames = [];
        if (agentRegexConfig.collectionIds?.length > 0) {
            for (const colId of agentRegexConfig.collectionIds) {
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

        const scope = agentRegexConfig.scope || { userInput: true, agentOutput: true, toolInput: false, toolOutput: false };
        const action = agentRegexConfig.action || 'delete';
        if (rulesWithNames.length > 0) {
            agentLocalConfig = { enabled: true, rulesWithNames, scope, action };
        }
    }

    regexConfig = mergeWithOrgShield(orgShieldConfig, agentLocalConfig);

    if (regexConfig?.enabled && regexConfig?.scope?.userInput) {
        const matches = checkRegexPatterns(userMessage, regexConfig.rulesWithNames);
        if (matches.length > 0) {
            const ruleNames = matches.map(m => m.ruleName).join(', ');
            
            if (regexConfig.action === 'redact') {
                for (const rule of regexConfig.rulesWithNames) {
                    try {
                        const regex = new RegExp(rule.pattern, 'gi');
                        processedUserMessage = processedUserMessage.replace(regex, `[REDACTED: ${rule.name}]`);
                    } catch (e) { /* ignore */ }
                }
                if (onEvent) {
                    onEvent('content_redact', {
                        originalMessage: userMessage,
                        redactedMessage: processedUserMessage,
                        rules: ruleNames,
                        autoRedactSeconds: 5
                    });
                }
            } else {
                guardrailViolation = ruleNames;
                if (onEvent) {
                    onEvent('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5 });
                }
            }
        }
    }

    return { 
        moderationViolation, 
        guardrailViolation, 
        processedUserMessage, 
        regexConfig, 
        webSearchGuardEnabled,
        orgShieldCategories
    };
}

module.exports = { runInputGuardrails };
