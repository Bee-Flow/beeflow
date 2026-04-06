/**
 * System Agents — Registry-driven seeding and single getter
 *
 * All agent metadata lives in systemAgentRegistry.js.
 * All prompts live in ./prompts/*.md.
 * This module handles DB lifecycle (seed + get) and nothing else.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { run, getOne } = require('../../db');
const { initDB } = require('./initSchema');
const { REGISTRY, REGISTRY_MAP, SYSTEM_AGENT_IDS, PROMPTS_DIR } = require('./systemAgentRegistry');

// ── Prompt loading ───────────────────────────────────────────────────────────

/**
 * Load a prompt from its markdown file on disk.
 * Returns the raw text content, trimmed.
 */
function loadPromptFile(filename) {
    const filePath = path.join(PROMPTS_DIR, filename);
    try {
        return fs.readFileSync(filePath, 'utf-8').trim();
    } catch (err) {
        console.error(`[SystemAgents] Failed to load prompt file ${filename}:`, err.message);
        return '';
    }
}

/**
 * Compute a short content hash for change detection.
 */
function hashContent(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ── Seeding ──────────────────────────────────────────────────────────────────

/**
 * Seed all system agents into the database.
 *
 * - Creates agents that don't exist yet.
 * - For agents with alwaysUpdate=true, updates the prompt ONLY if the
 *   file content has changed (hash comparison).
 * - Attaches defined tools for agents that declare them.
 *
 * This function should be called once during server startup, not at require() time.
 */
async function seedSystemAgents() {
    await initDB();

    for (const def of REGISTRY) {
        const prompt = loadPromptFile(def.promptFile);
        const promptHash = hashContent(prompt);
        const existing = await getOne('SELECT id, system_prompt FROM agents WHERE id = $1', [def.id]);

        if (!existing) {
            // ── New agent: insert ────────────────────────────────────────────
            await run(
                `INSERT INTO agents (id, name, description, system_prompt, model, owner_id, is_published, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, 'system', FALSE, NOW(), NOW())`,
                [def.id, def.name, def.description, prompt, def.defaultModel]
            );
            console.log(`[SystemAgents] Created ${def.name}`);

            // Attach tools if defined
            if (def.tools && def.tools.length > 0) {
                for (const toolId of def.tools) {
                    await run(
                        'INSERT INTO agent_tools (id, agent_id, component_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
                        [uuidv4(), def.id, toolId]
                    );
                }
                console.log(`[SystemAgents]   └─ Attached ${def.tools.length} tools`);
            }
        } else if (def.alwaysUpdate) {
            // ── Existing agent with alwaysUpdate: update only if prompt file changed ─
            const existingHash = hashContent(existing.system_prompt || '');
            if (promptHash !== existingHash) {
                await run(
                    'UPDATE agents SET system_prompt = $1, updated_at = NOW() WHERE id = $2',
                    [prompt, def.id]
                );
                console.log(`[SystemAgents] Updated prompt for ${def.name} (hash changed)`);
            }
        }
    }
}

// ── Getters ──────────────────────────────────────────────────────────────────

/**
 * Get a system agent by its ID.
 * Single generic getter — replaces the 10 individual get*Agent() functions.
 *
 * @param {string} agentId - e.g. 'system-title-generator'
 * @returns {Promise<Object|null>} The agent row, or null if not found
 */
async function getSystemAgent(agentId) {
    await initDB();
    return getOne('SELECT * FROM agents WHERE id = $1', [agentId]);
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    // Core
    seedSystemAgents,
    getSystemAgent,

    // Registry data (for i18n, admin panels, etc.)
    SYSTEM_AGENT_IDS,
    REGISTRY,
    REGISTRY_MAP,

    // Backward-compat aliases — these will be removed once all consumers migrate
    // to getSystemAgent(SYSTEM_AGENT_IDS.TITLE_GENERATOR) style.
    getTitleGeneratorAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.TITLE_GENERATOR),
    getMemoryExtractorAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.MEMORY_EXTRACTOR),
    getComponentDesignerAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.COMPONENT_DESIGNER),
    getPDFExtractorAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.PDF_EXTRACTOR),
    getSystemPromptDesignerAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.PROMPT_DESIGNER),
    getConversationStarterAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.CONVERSATION_STARTERS),
    getDescriptionImproverAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.DESCRIPTION_IMPROVER),
    getIdentityImproverAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.IDENTITY_IMPROVER),
    getOrgIntelScoutAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.ORGINTEL_SCOUT),
    getRegexGeneratorAgent: () => getSystemAgent(SYSTEM_AGENT_IDS.REGEX_GENERATOR),

    // Legacy ID exports — consumers should migrate to SYSTEM_AGENT_IDS.*
    TITLE_GENERATOR_AGENT_ID: SYSTEM_AGENT_IDS.TITLE_GENERATOR,
    MEMORY_EXTRACTOR_AGENT_ID: SYSTEM_AGENT_IDS.MEMORY_EXTRACTOR,
    AI_COMPONENT_DESIGNER_AGENT_ID: SYSTEM_AGENT_IDS.COMPONENT_DESIGNER,
    PDF_EXTRACTOR_AGENT_ID: SYSTEM_AGENT_IDS.PDF_EXTRACTOR,
    SYSTEM_PROMPT_DESIGNER_AGENT_ID: SYSTEM_AGENT_IDS.PROMPT_DESIGNER,
    CONVERSATION_STARTER_AGENT_ID: SYSTEM_AGENT_IDS.CONVERSATION_STARTERS,
    DESCRIPTION_IMPROVER_AGENT_ID: SYSTEM_AGENT_IDS.DESCRIPTION_IMPROVER,
    IDENTITY_IMPROVER_AGENT_ID: SYSTEM_AGENT_IDS.IDENTITY_IMPROVER,
    ORGINTEL_SCOUT_AGENT_ID: SYSTEM_AGENT_IDS.ORGINTEL_SCOUT,
    REGEX_GENERATOR_AGENT_ID: SYSTEM_AGENT_IDS.REGEX_GENERATOR,
};
