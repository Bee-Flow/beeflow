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
 * Keep a long, idle SSE stream alive through intermediaries.
 *
 * The Nextcloud AppAPI PHP proxy (and some gateways) idle-time-out a silent
 * connection, which 504'd long webpage/notebook builds and surfaced as a false
 * "Error generating response." in the chat (BFSF-221). We write an SSE comment
 * frame (`: ping\n\n`) every `intervalMs`; comment frames are ignored by
 * EventSource and our fetch-based SSE parser, so they keep the socket warm
 * without affecting the event stream. Returns stop() to clear the timer; it is
 * also cleared automatically on res close/finish/error.
 *
 * @param {Object} res - Express response (after headers are written)
 * @param {number} [intervalMs=15000]
 * @returns {Function} stop
 */
function startSseHeartbeat(res, intervalMs = 15000) {
    let timer = null;
    const stop = () => {
        if (timer) { clearInterval(timer); timer = null; }
    };
    timer = setInterval(() => {
        try {
            if (res.writableEnded || res.destroyed) { stop(); return; }
            res.write(': ping\n\n');
        } catch (_e) {
            stop();
        }
    }, intervalMs);
    if (timer.unref) timer.unref();  // don't keep the event loop alive for pings
    res.on('close', stop);
    res.on('finish', stop);
    res.on('error', stop);
    return stop;
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

    // Title generation: deferred to the SECOND exchange (≥2 user and ≥2
    // assistant messages) and built from a tool-free transcript, so the title
    // reflects the real topic rather than a vague opening line. Idempotent —
    // only runs while the title is still a placeholder, so it's set once.
    const userMsgs = Array.isArray(messages) ? messages.filter(m => m && m.role === 'user').length : 0;
    const assistantMsgs = Array.isArray(messages) ? messages.filter(m => m && m.role === 'assistant').length : 0;
    const titleIsPlaceholder = !conversation.title || !String(conversation.title).trim()
        || /^new chat$/i.test(String(conversation.title).trim());
    if (userMsgs >= 2 && assistantMsgs >= 2 && titleIsPlaceholder && generateTitle && !skipTitle) {
        try {
            const transcript = _buildTitleTranscript(messages) || userMessage;
            const title = await generateTitle(transcript, null, orgId, userId);
            if (title && title !== 'New Chat') {
                await agentStore.updateConversationTitle(conversation.id, title);
                sendEvent('title_update', { title, conversationId: conversation.id });
            }
        } catch (e) { /* ignore title gen errors */ }
    }
}

/**
 * Short, tool-free transcript (first two user+assistant exchanges) for title
 * generation — role + text only, no tool calls/results. Mirrors the direct-
 * chat titler so both surfaces title from the conversation, not just the
 * opening message.
 */
function _buildTitleTranscript(messages) {
    if (!Array.isArray(messages)) return '';
    const lines = [];
    let users = 0, assistants = 0;
    for (const m of messages) {
        if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
        if (m.role === 'user' && users >= 2) continue;
        if (m.role === 'assistant' && assistants >= 2) continue;
        let text = '';
        if (typeof m.content === 'string') text = m.content;
        else if (Array.isArray(m.content)) {
            text = m.content
                .filter(b => b && b.type === 'text' && typeof b.text === 'string')
                .map(b => b.text).join(' ');
        }
        text = (text || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > 500) text = text.slice(0, 500);
        lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`);
        if (m.role === 'user') users++; else assistants++;
        if (users >= 2 && assistants >= 2) break;
    }
    return lines.join('\n');
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

module.exports = { setupSSE, sendSSEError, startSseHeartbeat, persistAndTitle, getOrCreateAgentConversation };
