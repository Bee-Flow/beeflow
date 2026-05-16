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
const agentStats = require('./agent/agentStats');
const conversationLabels = require('./agent/conversationLabels');
const agentFavorites = require('./agent/agentFavorites');

module.exports = {
    // ── Agent CRUD ───────────────────────────────────────────────────────────
    createAgent: agentCrud.createAgent,
    getAgents: agentCrud.getAgents,
    getAgent: agentCrud.getAgent,
    updateAgent: agentCrud.updateAgent,
    deleteAgent: agentCrud.deleteAgent,
    forceDeleteAgent: agentCrud.forceDeleteAgent,

    // ── Published Agents ─────────────────────────────────────────────────────
    getPublishedAgents: agentCrud.getPublishedAgents,
    getAllAgents: agentCrud.getAllAgents,
    setAgentPublished: agentCrud.setAgentPublished,
    getPublishedAgentsForUser: agentCrud.getPublishedAgentsForUser,
    getSystemAgents: agentCrud.getSystemAgents,
    ensurePlaceholderAgent: agentCrud.ensurePlaceholderAgent,

    // ── Agent Tools ──────────────────────────────────────────────────────────
    getAgentTools: agentTools.getAgentTools,
    getAgentToolsWithParams: agentTools.getAgentToolsWithParams,
    updateAgentToolParams: agentTools.updateAgentToolParams,
    setAgentTools: agentTools.setAgentTools,

    // ── Conversations ────────────────────────────────────────────────────────
    getConversation: agentConversations.getConversation,
    getOrCreateConversation: agentConversations.getOrCreateConversation,
    createNewConversation: agentConversations.createNewConversation,
    updateConversation: agentConversations.updateConversation,
    clearConversation: agentConversations.clearConversation,
    updateConversationWorkspace: agentConversations.updateConversationWorkspace,
    getConversationWorkspace: agentConversations.getConversationWorkspace,

    // ── Multi-Conversation ───────────────────────────────────────────────────
    listConversations: agentConversations.listConversations,
    listAllConversations: agentConversations.listAllConversations,
    searchConversations: agentConversations.searchConversations,
    getConversationById: agentConversations.getConversationById,
    createConversation: agentConversations.createConversation,
    updateConversationTitle: agentConversations.updateConversationTitle,
    updateConversationMeta: agentConversations.updateConversationMeta,
    pinConversation: agentConversations.pinConversation,
    setConversationLabels: agentConversations.setConversationLabels,
    updateThreadTitles: agentConversations.updateThreadTitles,
    deleteConversationById: agentConversations.deleteConversationById,

    // ── System Agents (unified API) ──────────────────────────────────────────
    getSystemAgent: systemAgents.getSystemAgent,
    seedSystemAgents: systemAgents.seedSystemAgents,
    SYSTEM_AGENT_IDS: systemAgents.SYSTEM_AGENT_IDS,
    REGISTRY: systemAgents.REGISTRY,
    REGISTRY_MAP: systemAgents.REGISTRY_MAP,

    // Backward-compat individual getters (will be removed after consumer migration)
    getTitleGeneratorAgent: systemAgents.getTitleGeneratorAgent,
    TITLE_GENERATOR_AGENT_ID: systemAgents.TITLE_GENERATOR_AGENT_ID,
    getMemoryExtractorAgent: systemAgents.getMemoryExtractorAgent,
    MEMORY_EXTRACTOR_AGENT_ID: systemAgents.MEMORY_EXTRACTOR_AGENT_ID,
    getComponentDesignerAgent: systemAgents.getComponentDesignerAgent,
    AI_COMPONENT_DESIGNER_AGENT_ID: systemAgents.AI_COMPONENT_DESIGNER_AGENT_ID,
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
    getRegexGeneratorAgent: systemAgents.getRegexGeneratorAgent,
    REGEX_GENERATOR_AGENT_ID: systemAgents.REGEX_GENERATOR_AGENT_ID,

    // ── Reporting Stats ──────────────────────────────────────────────────────
    getSystemStats: agentStats.getSystemStats,
    getAgentStats: agentStats.getAgentStats,

    // ── Direct Conversations (no agent) ──────────────────────────────────────
    createDirectConversation: directConversations.createDirectConversation,
    getDirectConversation: directConversations.getDirectConversation,
    listDirectConversations: directConversations.listDirectConversations,
    updateDirectConversation: directConversations.updateDirectConversation,
    updateDirectConversationMeta: directConversations.updateDirectConversationMeta,
    updateDirectConversationTitle: directConversations.updateDirectConversationTitle,
    updateDirectConversationModelTier: directConversations.updateDirectConversationModelTier,
    pinDirectConversation: directConversations.pinDirectConversation,
    setDirectConversationLabels: directConversations.setDirectConversationLabels,
    deleteDirectConversation: directConversations.deleteDirectConversation,
    updateDirectConversationWorkspace: directConversations.updateDirectConversationWorkspace,
    getDirectConversationWorkspace: directConversations.getDirectConversationWorkspace,
    searchDirectConversations: directConversations.searchDirectConversations,

    // ── Conversation Labels ──────────────────────────────────────────────────
    listLabels: conversationLabels.listLabels,
    createLabel: conversationLabels.createLabel,
    updateLabel: conversationLabels.updateLabel,
    deleteLabel: conversationLabels.deleteLabel,

    // ── Agent Categories ─────────────────────────────────────────────────────
    getAgentCategories: agentCrud.getAgentCategories,
    createAgentCategory: agentCrud.createAgentCategory,
    deleteAgentCategory: agentCrud.deleteAgentCategory,

    // ── Skills cross-reference cleanup ───────────────────────────────────────
    scrubSkillFromAllAgents: agentCrud.scrubSkillFromAllAgents,

    // ── Agent Favorites ──────────────────────────────────────────────────────
    listAgentFavorites: agentFavorites.listFavorites,
    addAgentFavorite: agentFavorites.addFavorite,
    removeAgentFavorite: agentFavorites.removeFavorite,
};
