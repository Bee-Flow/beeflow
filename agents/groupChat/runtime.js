/**
 * Round the Table Runtime — orchestrates multi-agent discussions
 * 
 * When the user sends a message, participant agents take turns discussing it.
 * The first participant is the "lead" — they open the discussion, guide
 * the conversation, and deliver a final summary/conclusion.
 */

const { getAIConfig, getProviderForModel, resolveModelId } = require('../../core/aiAgent');
const agentStore = require('../../stores/agentStore');
const groupChatStore = require('../../stores/groupChatStore');
const usageStore = require('../../stores/usageStore');
const { processSystemPrompt } = require('../../core/promptUtils');

/**
 * Execute a full round-the-table discussion: iterate through participant agents sequentially.
 * 
 * @param {string} groupChatId 
 * @param {string} userId 
 * @param {string} userMessage 
 * @param {object} userAuth 
 * @param {function} onEvent - SSE event callback (type, data)
 * @param {object} messageMetadata - { conversationId, messageId, parentId, signal }
 * @returns {object} - { conversationId, conversationLength, responses }
 */
async function executeGroupChat(groupChatId, userId, userMessage, userAuth, onEvent, messageMetadata = {}) {
    const groupChat = await groupChatStore.getGroupChat(groupChatId);
    if (!groupChat) throw new Error(`Round table not found: ${groupChatId}`);

    const participantIds = groupChat.participantIds || [];
    if (participantIds.length === 0) throw new Error('Round table has no participants');

    // Ensure placeholder agent exists for conversation persistence
    await agentStore.ensurePlaceholderAgent(groupChatId, groupChat.name, groupChat.description);

    // Get or create conversation
    let conversation;
    if (messageMetadata.conversationId) {
        conversation = await agentStore.getConversationById(messageMetadata.conversationId, userAuth.encryptionKey);
    }
    if (!conversation) {
        conversation = await agentStore.createNewConversation(groupChatId, userId);
    }

    // Build the running conversation history
    const messages = [...(conversation.messages || [])];

    // Add user message
    messages.push({
        id: messageMetadata.messageId || `msg_${Date.now()}`,
        role: 'user',
        content: userMessage,
        parentId: messageMetadata.parentId || null
    });

    // Track responses for final result
    const responses = [];

    // Load all participant agent configs upfront
    const participants = [];
    for (const agentId of participantIds) {
        const agent = await agentStore.getAgent(agentId);
        if (!agent) {
            console.warn(`[RoundTable] Participant agent not found: ${agentId}, skipping`);
            continue;
        }
        participants.push(agent);
    }

    if (participants.length === 0) throw new Error('No valid participant agents found');

    // The first participant is the lead agent
    const leadAgent = participants[0];
    const participantNames = participants.map(a => a.name);

    // Notify the client which agents will respond
    onEvent('group_chat_start', {
        participants: participants.map((a, idx) => ({
            id: a.id,
            name: a.name,
            avatar: a.avatar || a.name?.[0]?.toUpperCase(),
            isLead: idx === 0
        }))
    });

    // How many full rounds the agents should converse (default 2)
    const maxRounds = groupChat.config?.maxRounds || 2;

    // Multi-round conversation — agents take turns across multiple rounds
    for (let round = 0; round < maxRounds; round++) {
        // Check if client disconnected
        if (messageMetadata.signal?.aborted) {
            console.log('[RoundTable] Client disconnected — stopping');
            break;
        }

        console.log(`[RoundTable] Round ${round + 1}/${maxRounds}`);

        const isFirstRound = round === 0;
        const isLastRound = round === maxRounds - 1;

        for (let i = 0; i < participants.length; i++) {
            const agent = participants[i];

            if (messageMetadata.signal?.aborted) {
                console.log('[RoundTable] Client disconnected — stopping');
                break;
            }

            const agentName = agent.name;
            const agentAvatar = agent.avatar || agentName?.[0]?.toUpperCase();
            const isLead = i === 0;

            onEvent('group_chat_agent_start', {
                agentId: agent.id,
                agentName,
                agentAvatar,
                isLead,
                round: round + 1,
                maxRounds,
                index: i,
                total: participants.length
            });

            try {
                const responseText = await streamAgentResponse(
                    agent,
                    messages,
                    userId,
                    groupChatId,
                    agentName,
                    agentAvatar,
                    onEvent,
                    messageMetadata.signal,
                    {
                        isLead,
                        leadName: leadAgent.name,
                        participantNames,
                        round: round + 1,
                        maxRounds,
                        isFirstRound,
                        isLastRound,
                        lastSpeaker: messages.length > 0 ? messages[messages.length - 1].respondingAgentName || 'User' : null
                    }
                );

                // Add this agent's response to the running history for the next agent
                const responseMessage = {
                    id: `msg_${Date.now()}_r${round}_${i}`,
                    role: 'assistant',
                    content: responseText,
                    respondingAgentName: agentName,
                    respondingAgentAvatar: agentAvatar,
                    respondingAgentId: agent.id
                };
                messages.push(responseMessage);
                responses.push(responseMessage);

                onEvent('group_chat_agent_done', {
                    agentId: agent.id,
                    agentName,
                    round: round + 1,
                    index: i,
                    total: participants.length
                });

            } catch (err) {
                console.error(`[RoundTable] Agent ${agentName} failed (round ${round + 1}):`, err.message);
                onEvent('group_chat_agent_error', {
                    agentId: agent.id,
                    agentName,
                    error: err.message
                });
                // Continue to next agent even if one fails
            }
        }

        // Save after each round so progress isn't lost
        await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);
    }

    // Save the full conversation
    await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);

    return {
        conversationId: conversation.id,
        conversationLength: messages.length,
        responses
    };
}


/**
 * Stream a single agent's response using the OpenAI-compatible API.
 * Sends SSE token events with respondingAgentName metadata.
 */
async function streamAgentResponse(agent, conversationMessages, userId, groupChatId, agentName, agentAvatar, onEvent, signal, roundTableContext = {}) {
    const globalConfig = await getAIConfig();
    const modelToUse = resolveModelId(agent.model) || resolveModelId(globalConfig.model);
    const config = await getProviderForModel(modelToUse);

    // Build API URL — match agentRuntime.js pattern: config.url, then append /v1
    let apiUrl = (config.url || '').replace(/\/$/, '');
    if (!apiUrl.endsWith('/v1')) {
        apiUrl = `${apiUrl}/v1`;
    }
    const apiKey = config.apiKey;

    // Process the agent's system prompt (handle template variables)
    let systemPrompt = agent.system_prompt || `You are ${agentName}. Respond helpfully as this character.`;
    try {
        systemPrompt = processSystemPrompt(systemPrompt);
    } catch (e) { /* ignore processing errors */ }

    // Build messages for the LLM
    const llmMessages = [
        { role: 'system', content: systemPrompt },
    ];

    // Build round-the-table context prompt
    const { isLead, leadName, participantNames, round, maxRounds, isFirstRound, isLastRound, lastSpeaker } = roundTableContext;
    const otherNames = participantNames.filter(n => n !== agentName);

    let roundTablePrompt;
    if (isLead) {
        // Lead agent prompt
        roundTablePrompt = [
            `[Round the Table Discussion — You are the LEAD]`,
            `You are "${agentName}", leading this round-the-table discussion.`,
            `Other participants: ${otherNames.join(', ')}.`,
            `Round ${round} of ${maxRounds}.`,
        ];

        if (lastSpeaker && lastSpeaker !== 'User') {
            roundTablePrompt.push(`${lastSpeaker} just spoke — respond directly to their points before adding your own.`);
        }

        roundTablePrompt.push('');
        roundTablePrompt.push('As the lead:');

        if (isFirstRound) {
            roundTablePrompt.push(
                `- Open by framing the user's question and sharing your perspective.`,
                `- Set the direction for the discussion and invite different viewpoints.`
            );
        } else if (isLastRound) {
            roundTablePrompt.push(
                `- This is the FINAL round. Wrap up the discussion.`,
                `- Summarize the key insights, note any consensus or disagreements.`,
                `- Deliver a clear conclusion or recommendation.`
            );
        } else {
            roundTablePrompt.push(
                `- Build on what's been said. Steer the conversation forward.`,
                `- Address the other participants by name when responding to their points.`,
                `- Raise new angles or push for deeper analysis.`
            );
        }

        roundTablePrompt.push(
            ``,
            `Speak naturally — this is a discussion, not a monologue. Be concise.`
        );
    } else {
        // Regular participant prompt
        roundTablePrompt = [
            `[Round the Table Discussion — Participant]`,
            `You are "${agentName}" in a round-the-table discussion led by "${leadName}".`,
            `Other participants: ${otherNames.join(', ')}.`,
            `Round ${round} of ${maxRounds}.`,
        ];

        if (lastSpeaker && lastSpeaker !== 'User') {
            roundTablePrompt.push(`${lastSpeaker} just spoke — respond to their points first, then add your own perspective.`);
        }

        roundTablePrompt.push(
            ``,
            `Engage naturally as a participant:`,
            `- Respond directly to whoever just spoke before making your own points.`,
            `- Address others by name when responding to their points.`,
            `- Share your unique perspective based on your expertise.`,
            `- Agree, disagree, or build on what others have said — be genuine.`,
            `- Ask follow-up questions if something needs clarification.`,
            `- Keep it concise — don't repeat what's already been covered.`,
            `- If you have nothing new to add, acknowledge briefly and pass.`,
            ``,
            `Speak naturally — this is a real discussion, not a formal report.`
        );
    }

    llmMessages.push({ role: 'system', content: roundTablePrompt.join('\n') });

    // Add conversation history — sanitize to remove extra fields Mistral rejects
    for (const msg of conversationMessages) {
        if (msg.role === 'user') {
            llmMessages.push({ role: 'user', content: msg.content });
        } else if (msg.role === 'assistant') {
            if (msg.respondingAgentName && msg.respondingAgentName !== agentName) {
                llmMessages.push({ role: 'user', content: `[${msg.respondingAgentName}]: ${msg.content}` });
            } else {
                llmMessages.push({ role: 'assistant', content: msg.content });
            }
        }
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const requestBody = {
        model: modelToUse,
        messages: llmMessages,
        temperature: 0.7,
        stream: true,
        stream_options: { include_usage: true }
    };

    console.log(`[RoundTable] Streaming ${agentName} with model ${modelToUse} (round ${round}/${maxRounds}, ${isLead ? 'LEAD' : 'participant'})`);
    const _start = Date.now();

    const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: signal || undefined
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error ${response.status}: ${error}`);
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let contentBuffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);

                    // Capture usage
                    if (parsed.usage) {
                        await usageStore.logUsage({
                            user_id: userId,
                            agent_id: groupChatId,
                            agent_name: agentName,
                            agent_type: 'roundtable',
                            model: modelToUse,
                            prompt_tokens: parsed.usage.prompt_tokens || 0,
                            completion_tokens: parsed.usage.completion_tokens || 0,
                            total_tokens: parsed.usage.total_tokens || 0,
                            source: 'roundtable_stream',
                            duration_ms: Date.now() - _start,
                            organization_id: agent.organization_id || null
                        });
                    }

                    const delta = parsed.choices?.[0]?.delta;
                    if (delta?.content) {
                        contentBuffer += delta.content;
                        // Stream to client with agent identity
                        onEvent('content', {
                            text: delta.content,
                            respondingAgentName: agentName,
                            respondingAgentAvatar: agentAvatar
                        });
                    }
                } catch (e) {
                    // Ignore parse errors on individual chunks
                }
            }
        }
    }

    return contentBuffer;
}


module.exports = {
    executeGroupChat
};
