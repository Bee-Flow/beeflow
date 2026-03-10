/**
 * Pipeline Phase 2: Credentials
 * Handles credential detection, form building, and credential chat follow-ups.
 */

const { callLLM } = require('../llmHelpers');
const { getSearchTools, executeComponentTool } = require('../toolHelpers');
const { runResearchWorker } = require('./research');

/**
 * Build the credential form message from credential worker results.
 */
function buildCredentialFormMessage(credResult, authResult) {
    const cred = credResult;
    const credentialFields = cred.fields || authResult.credentials || authResult.formFields || [];

    let formMessage = `### ${cred.title || 'Credentials Required'}\n\n`;
    if (cred.instructions) {
        formMessage += `${cred.instructions}\n`;
    }
    if (cred.helpLinks?.length) {
        formMessage += `\n**Useful links:** `;
        formMessage += cred.helpLinks.map(l => `[${l.label}](${l.url})`).join(' · ');
        formMessage += '\n';
    }
    if (cred.notes) {
        formMessage += `\n> ${cred.notes}`;
    }

    return { formMessage, credentialFields };
}

/**
 * Build a fallback credential form when the credential worker didn't produce results.
 */
function buildFallbackCredentialForm(authResult) {
    const credentialFields = authResult.credentials || authResult.formFields || [];
    const formMessage = `## Credentials Required\n\nThe component needs the following credentials to function:\n\n${credentialFields.map((f, i) =>
        `**${i + 1}. ${f.label || f.name}** ${f.required ? '(required)' : '(optional)'}\n${f.description || f.hint || ''}`
    ).join('\n\n')}`;

    return { formMessage, credentialFields };
}

/**
 * Run the credential research worker and build the credential form.
 * Returns { needsCredentials, formMessage, credentialFields, credentialContext } or null if no credentials needed.
 */
async function detectAndBuildCredentials(authOutput, userMessage, plan, config, onEvent) {
    const needsCredentials = authOutput?.result?.authMethod && authOutput.result.authMethod !== 'none';
    if (!needsCredentials) return null;

    const credWorkerConfig = config.workers.credentials;
    if (credWorkerConfig?.enabled !== false) {
        const credContext = {
            userMessage,
            plan,
            priorResearch: `## Auth Research Findings\n${JSON.stringify(authOutput.result, null, 2)}`
        };
        const credResult = await runResearchWorker('credentials', credWorkerConfig, credContext, onEvent);

        if (credResult.success && credResult.result) {
            const { formMessage, credentialFields } = buildCredentialFormMessage(credResult.result, authOutput.result);

            onEvent('needs_input', {
                fields: credentialFields,
                authMethod: authOutput.result.authMethod,
                message: formMessage
            });

            return {
                needsCredentials: true,
                formMessage,
                credentialFields,
                authMethod: authOutput.result.authMethod,
                credentialContext: {
                    fields: credentialFields,
                    instructions: formMessage,
                    authResearch: JSON.stringify(authOutput.result, null, 2),
                    chatHistory: []
                }
            };
        }
    }

    // Fallback
    const { formMessage, credentialFields } = buildFallbackCredentialForm(authOutput.result);

    onEvent('needs_input', {
        fields: credentialFields,
        authMethod: authOutput.result.authMethod,
        message: formMessage
    });

    return {
        needsCredentials: true,
        formMessage,
        credentialFields,
        authMethod: authOutput.result.authMethod,
        credentialContext: {
            fields: credentialFields,
            instructions: formMessage,
            authResearch: JSON.stringify(authOutput.result, null, 2),
            chatHistory: []
        }
    };
}

/**
 * Follow-up chat about credentials during Phase 2.
 * Uses web search tools to help users find credential setup instructions.
 */
async function credentialChat(session, userQuestion) {
    const ctx = session.credentialContext;
    if (!ctx) throw new Error('No credential context available.');

    const config = require('../../stores/agentStore').getSwarmConfig() || {};
    const workersCfg = config.workers || {};
    const credConfig = workersCfg.credentials || {};
    const { getAIConfig } = require('../../core/aiAgent');
    const baseConfig = await getAIConfig();

    const model = credConfig.model || workersCfg.auth?.model || baseConfig.model;
    if (!model) throw new Error('No model configured for credential chat.');

    const systemPrompt = `You are a helpful assistant that helps users obtain API credentials and tokens.
You have access to web search to find up-to-date documentation.

Context about what credentials are needed:
${ctx.instructions}

Auth research findings:
${ctx.authResearch}

Answer the user's question clearly and concisely. If they need step-by-step instructions, provide them.
If you need to search for documentation, use the tavily_search tool.
Do NOT respond with JSON. Respond in natural language with markdown formatting.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        ...ctx.chatHistory,
        { role: 'user', content: userQuestion }
    ];

    const tools = getSearchTools();
    const maxRounds = 3;
    let answer = '';

    for (let round = 0; round < maxRounds; round++) {
        const response = await callLLM({
            systemPrompt,
            messages: messages.slice(1), // callLLM prepends system prompt
            tools,
            model,
            temperature: 0.5,
            maxTokens: 2000
        });

        const choice = response.choices?.[0];
        if (!choice) break;

        const assistantMsg = choice.message;
        messages.push({ ...assistantMsg, content: assistantMsg.content ?? '' });

        if (assistantMsg.tool_calls?.length > 0) {
            // Sanitize: ensure content is never null (Mistral rejects null content)
            for (const tc of assistantMsg.tool_calls) {
                const toolName = tc.function.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch { }
                console.log(`[Swarm] credential-chat → tool: ${toolName}`);

                try {
                    const result = await executeComponentTool(toolName, toolArgs, {}, null);
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
                } catch (e) {
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: e.message }) });
                }
            }
            continue;
        }

        answer = assistantMsg.content || '';
        break;
    }

    ctx.chatHistory.push({ role: 'user', content: userQuestion });
    ctx.chatHistory.push({ role: 'assistant', content: answer });

    return { answer };
}

module.exports = {
    detectAndBuildCredentials,
    credentialChat,
    buildCredentialFormMessage,
    buildFallbackCredentialForm
};
