/**
 * SSE Chat Helpers — Shared utilities for streaming chat routes
 * 
 * Extracts common SSE setup, abort handling, and title generation
 * boilerplate from agents.js.
 */

const agentStore = require('../stores/agentStore');

/**
 * Set up SSE streaming on a response object.
 * @param {Object} res - Express response
 * @returns {{ sendEvent: Function, abortController: AbortController, markEnded: Function }}
 */
function setupSSE(res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const abortController = new AbortController();
    let responseEnded = false;

    res.on('close', () => {
        if (!responseEnded) {
            console.log('[SSE] Client disconnected — aborting');
            abortController.abort();
        }
    });

    const sendEvent = (event, data) => {
        if (!res.writableEnded && !abortController.signal.aborted) {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
    };

    const markEnded = () => {
        responseEnded = true;
    };

    return { sendEvent, abortController, markEnded };
}

/**
 * Send an SSE error and end the response (for limit errors etc.)
 * @param {Object} res - Express response
 * @param {string} error - Error message
 */
function sendSSEError(res, error) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
    res.end();
}

/**
 * Persist conversation messages and generate/update title.
 * Shared across terminal, security, and browser agent handlers.
 * 
 * @param {Object} options
 * @param {Object}  options.conversation   - Conversation object
 * @param {Array}   options.messages       - Messages array to persist
 * @param {string}  options.encryptionKey  - Encryption key
 * @param {string}  options.userId         - User ID
 * @param {string}  options.userMessage    - Original user message
 * @param {string}  options.orgId          - Organization ID
 * @param {Function} options.sendEvent     - SSE event sender
 * @param {Function} options.generateTitle - Title generation function (agentRuntime.generateChatTitle)
 */
async function persistAndTitle({ conversation, messages, encryptionKey, userId, userMessage, orgId, sendEvent, generateTitle, skipTitle }) {
    // Save conversation
    await agentStore.updateConversation(conversation.id, messages, encryptionKey, userId);

    // Generate title for new conversations (skip if moderation violation)
    if (messages.length <= 3 && generateTitle && !skipTitle) {
        try {
            const title = await generateTitle(userMessage, null, orgId);
            if (title && title !== 'New Chat') {
                await agentStore.updateConversationTitle(conversation.id, title);
                sendEvent('title_update', { title, conversationId: conversation.id });
            }
        } catch (e) { /* ignore title gen errors */ }
    }
}

/**
 * Get or create a conversation for a specialized agent.
 * Shared across terminal, security, and browser agent handlers.
 * 
 * @param {Object} agent - Agent object (id, name, description)
 * @param {string} conversationId - Existing conversation ID (or null)
 * @param {string} userId - User ID 
 * @param {string} encryptionKey - Encryption key
 * @returns {Object} conversation
 */
async function getOrCreateAgentConversation(agent, conversationId, userId, encryptionKey) {
    // Ensure placeholder agent exists in agentStore for conversation persistence
    await agentStore.ensurePlaceholderAgent(agent.id, agent.name, agent.description);

    let conversation;
    if (conversationId) {
        conversation = await agentStore.getConversationById(conversationId, encryptionKey);
    }
    if (!conversation) {
        conversation = await agentStore.createNewConversation(agent.id, userId);
    }
    return conversation;
}

module.exports = { setupSSE, sendSSEError, persistAndTitle, getOrCreateAgentConversation };
