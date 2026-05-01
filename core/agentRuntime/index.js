/**
 * Agent Runtime — re-exports all modules
 * Maintains backward compatibility with require('./core/agentRuntime')
 */
const { resolveAgentModel } = require('./modelResolver');
const { getAgentTools, getAvailableComponents } = require('./agentTools');
const { chatWithAgent, enrichMessagesWithFormData } = require('./chatWithAgent');
const { chatWithAgentStream } = require('./chatStream');
const { generateChatTitle } = require('./chatTitle');
const componentManager = require('../componentManager');
const { componentToTool, executeComponentTool, SYSTEM_TOOLS } = require('../toolExecution');
const { processSystemPrompt } = require('../promptUtils');

module.exports = {
    chatWithAgent,
    chatWithAgentStream,
    getAgentTools,
    getAvailableComponents,
    componentToTool,
    executeComponentTool,
    generateChatTitle,
    SYSTEM_TOOLS,
    componentManager,
    processSystemPrompt,
    resolveAgentModel
};
