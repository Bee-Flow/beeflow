const configStore = require('../../stores/configStore');
const { validateInput } = require('../moderation');
const { validateInputForPii } = require('../azurePiiDetection');
const { resolveOrgShield, mergeWithOrgShield } = require('../orgShield');
const { checkRegexPatterns } = require('../guardrails');
const guardrailEventStore = require('../../stores/guardrailEventStore');
const { sanitizeMessagesUnicode } = require('../../utils/unicodeSanitizer');

async function runInputGuardrails({ agent, messages, userMessage, globalConfig, onEvent, userId, conversationId, source, model }) {
    let moderationViolation = null;
    let guardrailViolation = null;
    let processedUserMessage = userMessage;

    // ── Unicode Smuggling Defense (must run FIRST) ───────────────────
    const unicodeResult = sanitizeMessagesUnicode(messages);
    if (unicodeResult.smugglingDetected) {
        console.warn(`[GuardrailsRunner] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
        // Update processedUserMessage if the last user message was sanitized
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === 'user' && typeof lastMsg.content === 'string') {
            processedUserMessage = lastMsg.content;
        }
        if (onEvent) {
            onEvent('unicode_smuggling_detected', {
                strippedCount: unicodeResult.totalStripped,
                messageIndices: unicodeResult.detectedIn,
            });
        }
        guardrailEventStore.logGuardrailEvent({
            organization_id: agent.organization_id || null,
            user_id: userId || null,
            agent_id: agent.id || null,
            agent_name: agent.name || null,
            conversation_id: conversationId || null,
            violation_type: 'unicode_smuggling',
            violation_categories: `${unicodeResult.totalStripped} hidden chars`,
            direction: 'input',
            action_taken: 'stripped',
            source: source || 'unknown',
            model: model || null,
        }).catch(() => {});
    }

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
            // Per-org provider override — exactly one of Llama Guard / Azure Content Safety
            // runs per turn. When the org hasn't explicitly picked one, moderation.js falls
            // back to the global `ai.moderationProvider` setting.
            const preferredProvider = orgShield?.enabled ? orgShield.moderationProvider : null;
            await validateInput(messages, agent.config?.llamaGuardEnabled, orgShieldCategories, preferredProvider);
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
    // If the org shield is active and explicitly disables PII detection, respect that
    // over the global setting (mirrors the moderation "orgExplicitlyDisabled" pattern).
    const orgExplicitlyDisabledPii = orgShield?.enabled && orgShield?.azurePiiEnabled === false;
    // When the org has the interactive DLP gate enabled, skip the auto-tokenising
    // path here — the downstream dlpRunner call in chatStream.js will do the scan
    // and apply the user's chosen action (ask/redact/block). Running both leads to
    // double scans and conflicting actions.
    const dlpWillHandle = !!(orgShield?.enabled && orgShield?.dlpEnabled);
    if (!dlpWillHandle && ((globalConfig?.piiDetectionEnabled && !orgExplicitlyDisabledPii) || orgPiiEnabled)) {
        try {
            const piiMessages = [
                ...messages.slice(-3), // last few messages for context
            ];
            const piiResult = await validateInputForPii(piiMessages, orgPiiEnabled, orgShield);

            if (piiResult && piiResult.tokenizedText) {
                // Redact/tokenize mode: replace user message with tokenized version
                const lastMsg = messages[messages.length - 1];
                if (lastMsg && lastMsg.role === 'user') {
                    if (typeof lastMsg.content === 'string') {
                        lastMsg.content = piiResult.tokenizedText;
                        processedUserMessage = piiResult.tokenizedText;
                    } else if (Array.isArray(lastMsg.content)) {
                        const textPart = lastMsg.content.find(p => p.type === 'text');
                        if (textPart) {
                            textPart.text = piiResult.tokenizedText;
                            processedUserMessage = piiResult.tokenizedText;
                        }
                    }
                }
                console.warn(`[GuardrailsRunner] 🔒 PII redacted (${Object.keys(piiResult.tokenMap).length} tokens)`);

                // Stash the token map on the shared conversation-scoped store so
                // chatStream's un-tokeniser wrapper restores these values on the
                // response. Without this step the tokens leak through to the UI
                // whenever DLP itself is disabled.
                try {
                    require('../dlp/dlpRunner').mergeTokenMap(conversationId, piiResult.tokenMap);
                } catch (_) { /* non-fatal — missing dlpRunner just means no restoration */ }

                // Let the LLM know that the placeholders in the user's message are
                // redaction tokens and it should echo them back unchanged. Match the
                // format emitted by azurePiiDetection.js → `[email_1]`, `[phone_2]`, …
                if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
                    const categoryList = [...new Set(piiResult.entities.map(e => e.label || e.category))].join(', ');
                    messages[0].content += `\n\n[PII TOKENIZATION ACTIVE: Sensitive values in the user's message have been replaced with placeholder tokens like [email_1] or [phone_2] (${categoryList}). When referring to these values in your response, use the SAME tokens — the system restores the real values for the user automatically. Never invent values; never reveal the token map.]`;
                }

                if (onEvent) {
                    onEvent('pii_tokenized', {
                        entities: piiResult.entities.map(e => ({ label: e.label, category: e.category })),
                        tokenCount: Object.keys(piiResult.tokenMap).length,
                    });
                }

                // Log PII redact event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    ...eventCtx,
                    violation_type: 'pii',
                    violation_categories: [...new Set(piiResult.entities.map(e => e.label || e.category))].join(', '),
                    direction: 'input',
                    action_taken: 'redacted',
                }).catch(() => {});
            }
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
