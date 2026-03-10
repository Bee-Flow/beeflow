/**
 * Message Utilities — shared helpers for chat message processing
 * 
 * Extracted from duplicate inline functions in agentRuntime.js
 * (chatWithAgent.sanitize and chatWithAgentStream.sanitize).
 */

/**
 * Sanitize chat messages before sending to LLM API.
 * Strips extra fields (parentId, id, etc.) that providers like Mistral reject.
 * Preserves: role, content, tool_calls, tool_call_id, name.
 * 
 * @param {Array} msgs - Chat messages array
 * @returns {Array} Cleaned messages with only API-safe fields
 */
function sanitizeMessages(msgs) {
    return msgs.map(m => {
        const clean = { role: m.role, content: m.content };
        if (m.tool_calls) clean.tool_calls = m.tool_calls;
        if (m.tool_call_id) clean.tool_call_id = m.tool_call_id;
        if (m.name) clean.name = m.name;
        return clean;
    });
}

module.exports = {
    sanitizeMessages
};
