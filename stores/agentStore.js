/**
 * Agent Store — Thin re-export facade
 *
 * All logic lives in stores/agent/*.js sub-modules.
 * This file re-exports everything so that consumers keep using:
 *   const agentStore = require('../stores/agentStore');
 */

const agentCrud = require('./agent/agentCrud');
const agentTools = require('./agent/agentTools');
const agentConversations = require('./agent/agentConversations');
const directConversations = require('./agent/directConversations');
const systemAgents = require('./agent/systemAgents');
const swarmPipelineConfig = require('./agent/swarmPipelineConfig');
const agentStats = require('./agent/agentStats');
const conversationLabels = require('./agent/conversationLabels');

module.exports = {
    // Agent CRUD
    createAgent: agentCrud.createAgent,
    getAgents: agentCrud.getAgents,
    getAgent: agentCrud.getAgent,
    updateAgent: agentCrud.updateAgent,
    deleteAgent: agentCrud.deleteAgent,
    forceDeleteAgent: agentCrud.forceDeleteAgent,
    // Published Agents
    getPublishedAgents: agentCrud.getPublishedAgents,
    getAllAgents: agentCrud.getAllAgents,
    setAgentPublished: agentCrud.setAgentPublished,
    getPublishedAgentsForUser: agentCrud.getPublishedAgentsForUser,
    getSystemAgents: agentCrud.getSystemAgents,
    ensurePlaceholderAgent: agentCrud.ensurePlaceholderAgent,
    // Agent Tools
    getAgentTools: agentTools.getAgentTools,
    getAgentToolsWithParams: agentTools.getAgentToolsWithParams,
    updateAgentToolParams: agentTools.updateAgentToolParams,
    setAgentTools: agentTools.setAgentTools,
    // Conversations
    getConversation: agentConversations.getConversation,
    getOrCreateConversation: agentConversations.getOrCreateConversation,
    createNewConversation: agentConversations.createNewConversation,
    updateConversation: agentConversations.updateConversation,
    clearConversation: agentConversations.clearConversation,
    updateConversationWorkspace: agentConversations.updateConversationWorkspace,
    getConversationWorkspace: agentConversations.getConversationWorkspace,
    // Multi-Conversation
    listConversations: agentConversations.listConversations,
    listAllConversations: agentConversations.listAllConversations,
    searchConversations: agentConversations.searchConversations,
    getConversationById: agentConversations.getConversationById,
    createConversation: agentConversations.createConversation,
    updateConversationTitle: agentConversations.updateConversationTitle,
    pinConversation: agentConversations.pinConversation,
    setConversationLabels: agentConversations.setConversationLabels,
    updateThreadTitles: agentConversations.updateThreadTitles,
    deleteConversationById: agentConversations.deleteConversationById,
    // System Agents
    getTitleGeneratorAgent: systemAgents.getTitleGeneratorAgent,
    TITLE_GENERATOR_AGENT_ID: systemAgents.TITLE_GENERATOR_AGENT_ID,
    getMemoryExtractorAgent: systemAgents.getMemoryExtractorAgent,
    MEMORY_EXTRACTOR_AGENT_ID: systemAgents.MEMORY_EXTRACTOR_AGENT_ID,
    getComponentDesignerAgent: systemAgents.getComponentDesignerAgent,
    getPDFExtractorAgent: systemAgents.getPDFExtractorAgent,
    getSystemPromptDesignerAgent: systemAgents.getSystemPromptDesignerAgent,
    SYSTEM_PROMPT_DESIGNER_AGENT_ID: systemAgents.SYSTEM_PROMPT_DESIGNER_AGENT_ID,
    getConversationStarterAgent: systemAgents.getConversationStarterAgent,
    CONVERSATION_STARTER_AGENT_ID: systemAgents.CONVERSATION_STARTER_AGENT_ID,
    getDescriptionImproverAgent: systemAgents.getDescriptionImproverAgent,
    DESCRIPTION_IMPROVER_AGENT_ID: systemAgents.DESCRIPTION_IMPROVER_AGENT_ID,
    getIdentityImproverAgent: systemAgents.getIdentityImproverAgent,
    IDENTITY_IMPROVER_AGENT_ID: systemAgents.IDENTITY_IMPROVER_AGENT_ID,
    getOrgIntelScoutAgent: systemAgents.getOrgIntelScoutAgent,
    ORGINTEL_SCOUT_AGENT_ID: systemAgents.ORGINTEL_SCOUT_AGENT_ID,
    AI_COMPONENT_DESIGNER_AGENT_ID: systemAgents.AI_COMPONENT_DESIGNER_AGENT_ID,
    getRegexGeneratorAgent: systemAgents.getRegexGeneratorAgent,
    REGEX_GENERATOR_AGENT_ID: systemAgents.REGEX_GENERATOR_AGENT_ID,
    // Reporting Stats
    getSystemStats: agentStats.getSystemStats,
    getAgentStats: agentStats.getAgentStats,
    // Swarm Pipeline Config
    getSwarmConfig: swarmPipelineConfig.getSwarmConfig,
    saveSwarmConfig: swarmPipelineConfig.saveSwarmConfig,
    getSwarmPhases: swarmPipelineConfig.getSwarmPhases,
    getSwarmPhase: swarmPipelineConfig.getSwarmPhase,
    // Direct Conversations (no agent)
    createDirectConversation: directConversations.createDirectConversation,
    getDirectConversation: directConversations.getDirectConversation,
    listDirectConversations: directConversations.listDirectConversations,
    updateDirectConversation: directConversations.updateDirectConversation,
    updateDirectConversationTitle: directConversations.updateDirectConversationTitle,
    pinDirectConversation: directConversations.pinDirectConversation,
    setDirectConversationLabels: directConversations.setDirectConversationLabels,
    deleteDirectConversation: directConversations.deleteDirectConversation,
    updateDirectConversationWorkspace: directConversations.updateDirectConversationWorkspace,
    getDirectConversationWorkspace: directConversations.getDirectConversationWorkspace,
    // Conversation Labels
    listLabels: conversationLabels.listLabels,
    createLabel: conversationLabels.createLabel,
    updateLabel: conversationLabels.updateLabel,
    deleteLabel: conversationLabels.deleteLabel,
};
