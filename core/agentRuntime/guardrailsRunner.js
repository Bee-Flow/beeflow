const configStore = require('../../stores/configStore');
const { validateInput } = require('../moderation');
const { validateInputForPii } = require('../azurePiiDetection');
const { resolveOrgShield, mergeWithOrgShield } = require('../orgShield');
const { checkRegexPatterns } = require('../guardrails');
const guardrailEventStore = require('../../stores/guardrailEventStore');

async function runInputGuardrails({ agent, messages, userMessage, globalConfig, onEvent, userId, conversationId, source, model }) {
    let moderationViolation = null;
    let guardrailViolation = null;
    let processedUserMessage = userMessage;

    // Read org shield config once (was previously read 3 times)
    const orgShield = await (async () => {
        if (!agent.organization_id) return null;
        return await configStore.getConfig(`org_privacy_shield_${agent.organization_id}`);
    })();

    const orgModerationEnabled = !!(orgShield?.enabled && orgShield?.moderationEnabled);
    const orgModerationScope = orgShield?.enabled
        ? (orgShield.scope || { userInput: true, agentOutput: true })
        : { userInput: true, agentOutput: true };

    const webSearchGuardEnabled = !!(orgShield?.enabled && orgShield?.webSearchGuardEnabled) || !!agent.config?.webSearchGuardEnabled;
    const disableSearchOnUpload = !!(orgShield?.enabled && orgShield?.disableSearchOnUpload);
    const webSearchGuardPiiCategories = (orgShield?.enabled && Array.isArray(orgShield?.webSearchGuardPiiCategories) && orgShield.webSearchGuardPiiCategories.length > 0)
        ? orgShield.webSearchGuardPiiCategories : null;
    const orgShieldCategories = orgShield?.moderationCategories || null;

    // Context for guardrail event logging
    const eventCtx = {
        organization_id: agent.organization_id || null,
        user_id: userId || null,
        agent_id: agent.id || null,
        agent_name: agent.name || null,
        conversation_id: conversationId || null,
        source: source || 'unknown',
        model: model || null,
    };

    // Agent-level llamaGuard only fires when the org hasn't explicitly disabled moderation.
    // If org has an active Privacy Shield with moderationEnabled=false, agent config is overridden.
    const orgExplicitlyDisabled = orgShield?.enabled && orgShield.moderationEnabled === false;
    const shouldCheckInputModeration = (orgModerationEnabled && orgModerationScope.userInput) ||
        (!orgExplicitlyDisabled && (agent.config?.llamaGuardEnabled || globalConfig?.llamaGuardConfig?.enabled));
    
    if (shouldCheckInputModeration) {
        try {
            await validateInput(messages, agent.config?.llamaGuardEnabled, orgShieldCategories);
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

                // Log moderation event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    ...eventCtx,
                    violation_type: 'moderation',
                    violation_categories: violationLabels.join(', '),
                    direction: 'input',
                    action_taken: 'hard_block',
                }).catch(() => {});
            }
        }
    }

    // ── PII Detection ─────────────────────────────────────────────────
    // Runs independently of Llama Guard / Azure moderation.
    // Uses Azure Text Analytics when configured, falls back to CPU model via guard service.
    const orgPiiEnabled = !!(orgShield?.enabled && orgShield?.azurePiiEnabled);
    if (globalConfig?.piiDetectionEnabled || orgPiiEnabled) {
        try {
            const piiMessages = [
                ...messages.slice(-3), // last few messages for context
            ];
            await validateInputForPii(piiMessages, orgPiiEnabled, orgShield);
        } catch (piiError) {
            if (piiError.message?.includes('PII Detected')) {
                console.warn('[GuardrailsRunner] PII detected in user input:', piiError.message);
                const entityLabels = piiError.piiEntities
                    ? [...new Set(piiError.piiEntities.map(e => e.label || e.category))]
                    : ['personal information'];
                const labelList = entityLabels.join(', ');

                if (onEvent) {
                    onEvent('guardrail_violation', {
                        rules: entityLabels,
                        autoDeleteSeconds: 5,
                        outcome: JSON.stringify(entityLabels.map(l => ({ label: l }))),
                        categories: entityLabels,
                        type: 'pii'
                    });
                }
                moderationViolation = `PII Detected: ${labelList}`;

                // Log PII event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    ...eventCtx,
                    violation_type: 'pii',
                    violation_categories: labelList,
                    direction: 'input',
                    action_taken: 'blocked',
                }).catch(() => {});
            }
            // Other errors (service unavailable etc.) → fail-open, log and continue
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

                // Log regex redact event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    ...eventCtx,
                    violation_type: 'regex',
                    violation_categories: ruleNames,
                    direction: 'input',
                    action_taken: 'redacted',
                }).catch(() => {});
            } else {
                guardrailViolation = ruleNames;
                if (onEvent) {
                    onEvent('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5 });
                }

                // Log regex block event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    ...eventCtx,
                    violation_type: 'regex',
                    violation_categories: ruleNames,
                    direction: 'input',
                    action_taken: 'blocked',
                }).catch(() => {});
            }
        }
    }

    return { 
        moderationViolation, 
        guardrailViolation, 
        processedUserMessage, 
        regexConfig, 
        webSearchGuardEnabled,
        disableSearchOnUpload,
        webSearchGuardPiiCategories,
        orgShieldCategories
    };
}

module.exports = { runInputGuardrails };
