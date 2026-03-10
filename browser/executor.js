/**
 * Browser Agent — Executor Message Builder
 */

const { formatObservation } = require('./observation');
const { processSystemPrompt } = require('../core/promptUtils');

function buildExecutorMessages(agentConfig, coordinator, observation, config) {
    const systemPrompt = buildExecutorSystemPrompt(agentConfig, config);
    const obsText = formatObservation(observation);

    const messages = [
        { role: 'system', content: systemPrompt }
    ];

    // User goal + plan + memory (single user message to anchor context)
    let contextBlock = `## Task\n${coordinator.goal}`;
    if (coordinator.plan) {
        contextBlock += `\n\n## Current Plan\n${coordinator.plan}`;
    }
    if (coordinator.memorySummary) {
        contextBlock += `\n\n## Memory\n${coordinator.memorySummary}`;
    }
    contextBlock += `\n\n## Current Page\n${obsText}`;
    contextBlock += `\n\nActions used: ${coordinator.actionsExecuted}/${config.maxActions || 20}. Be efficient.`;

    messages.push({ role: 'user', content: contextBlock });

    // Append rolling recent messages (bounded + sanitized for API ordering)
    // Some providers (Mistral/Codestral) require tool messages to follow an assistant message.
    // The rolling window may have trimmed the assistant leaving orphaned tool messages.
    const sanitized = sanitizeMessageOrder(coordinator.recentMessages);
    for (const msg of sanitized) {
        messages.push(msg);
    }

    return messages;
}

/**
 * Ensure valid message ordering for strict providers (Mistral/Codestral).
 * Groups messages into (assistant + tool responses) pairs.
 * Drops incomplete groups where tool_call count ≠ tool response count.
 * Drops orphaned tool messages without a preceding assistant.
 */
function sanitizeMessageOrder(messages) {
    // Parse into groups: each group is { assistant: msg, tools: [msg, ...] }
    const groups = [];
    let currentGroup = null;

    for (const msg of messages) {
        if (msg.role === 'assistant') {
            // Finalize previous group
            if (currentGroup) groups.push(currentGroup);
            currentGroup = { assistant: msg, tools: [], expectedTools: 0 };
            // Count expected tool responses
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                currentGroup.expectedTools = msg.tool_calls.length;
            }
        } else if (msg.role === 'tool') {
            if (currentGroup) {
                currentGroup.tools.push(msg);
            }
            // else: orphan tool before any assistant — drop it
        } else {
            // user or system message — finalize any pending group first
            if (currentGroup) {
                groups.push(currentGroup);
                currentGroup = null;
            }
            groups.push({ standalone: msg });
        }
    }
    // Don't forget last group
    if (currentGroup) groups.push(currentGroup);

    // Rebuild, keeping only complete groups
    const result = [];
    for (const group of groups) {
        if (group.standalone) {
            result.push(group.standalone);
        } else if (group.assistant) {
            if (group.expectedTools === 0) {
                // Assistant with no tool_calls (text response) — always valid
                result.push(group.assistant);
            } else if (group.tools.length === group.expectedTools) {
                // Complete group — include assistant + all tool responses
                result.push(group.assistant);
                for (const t of group.tools) result.push(t);
            }
            // else: incomplete group — drop entire group
        }
    }

    return result;
}

function buildExecutorSystemPrompt(agentConfig, config) {
    // Load system prompt from file, fall back to agent config
    let base;
    try {
        const path = require('path');
        const fs = require('fs');
        const promptPath = path.join(__dirname, 'system-prompt.md');
        base = fs.readFileSync(promptPath, 'utf-8').trim();
    } catch (e) {
        base = agentConfig.system_prompt || 'You are an autonomous browser agent.';
    }

    let prompt = base;
    if (config.allowedDomains?.length > 0) {
        prompt += `\n\nDomain restrictions: ${config.allowedDomains.join(', ')}`;
    }
    return processSystemPrompt(prompt);
}

module.exports = {
    buildExecutorMessages,
    sanitizeMessageOrder,
    buildExecutorSystemPrompt
};
