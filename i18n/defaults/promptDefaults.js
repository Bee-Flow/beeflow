/**
 * Prompt Defaults Registry
 * 
 * Maps prompt IDs to their default English text.
 * These are the built-in prompts that serve as the fallback for any locale.
 * 
 * System agent prompts are loaded from systemAgents.js at runtime.
 * Markdown prompt files are loaded from disk.
 */

const fs = require('fs');
const path = require('path');

// ── All prompt IDs managed by the i18n system ───────────────────

const PROMPT_IDS = [
    // System agents (from systemAgents.js)
    'system-title-generator',
    'system-memory-extractor',
    'system-component-designer',
    'system-pdf-extractor',
    'system-prompt-designer',
    'system-conversation-starters',
    'system-description-improver',
    'system-identity-improver',
    'system-orgintel-scout',
    'system-regex-generator',
    // Agent-type system prompts (markdown files)
    'browser-agent',
    'terminal-agent',
    'security-agent',
    // Master template
    'master-template',
    // Pipeline prompts (markdown files)
    'web-researcher',
    'report-writer',
    'page-renderer',
    'app-testing-report',
    'verwerkersovereenkomst-renderer',
    'verwerkersovereenkomst-reviewer',
];

// ── Human-readable labels for prompt IDs ────────────────────────

const PROMPT_LABELS = {
    'system-title-generator': 'Title Generator',
    'system-memory-extractor': 'Memory Extractor',
    'system-component-designer': 'AI Component Designer',
    'system-pdf-extractor': 'PDF Extractor',
    'system-prompt-designer': 'System Prompt Designer',
    'system-conversation-starters': 'Conversation Starter Generator',
    'system-description-improver': 'Description Improver',
    'system-identity-improver': 'Identity Improver',
    'system-orgintel-scout': 'OrgIntel Scout',
    'system-regex-generator': 'Regex Rule Generator',
    'browser-agent': 'Browser Agent',
    'terminal-agent': 'Terminal Agent',
    'security-agent': 'Security Agent',
    'master-template': 'Master System Prompt Template',
    'web-researcher': 'Web Researcher',
    'report-writer': 'Report Writer',
    'page-renderer': 'Page Renderer',
    'app-testing-report': 'App Testing Report Writer',
    'verwerkersovereenkomst-renderer': 'Verwerkersovereenkomst Renderer',
    'verwerkersovereenkomst-reviewer': 'Verwerkersovereenkomst Reviewer',
};

// ── Prompt categories for UI grouping ───────────────────────────

const PROMPT_CATEGORIES = {
    'System Agents': [
        'system-title-generator',
        'system-memory-extractor',
        'system-component-designer',
        'system-pdf-extractor',
        'system-prompt-designer',
        'system-conversation-starters',
        'system-description-improver',
        'system-identity-improver',
        'system-orgintel-scout',
        'system-regex-generator',
    ],
    'Agent Types': [
        'browser-agent',
        'terminal-agent',
        'security-agent',
    ],
    'Templates': [
        'master-template',
    ],
    'Pipeline Prompts': [
        'web-researcher',
        'report-writer',
        'page-renderer',
        'app-testing-report',
        'verwerkersovereenkomst-renderer',
        'verwerkersovereenkomst-reviewer',
    ],
};

// ── Markdown file paths (relative to server root) ───────────────

const MD_PROMPT_PATHS = {
    'browser-agent': path.join(__dirname, '..', '..', 'browser', 'system-prompt.md'),
    'terminal-agent': path.join(__dirname, '..', '..', 'terminal', 'system-prompt.md'),
    'security-agent': path.join(__dirname, '..', '..', 'security', 'system-prompt.md'),
    'master-template': path.join(__dirname, '..', '..', 'templates', 'system_prompt_master.md'),
    'web-researcher': path.join(__dirname, '..', '..', 'prompts', 'web-researcher-prompt.md'),
    'report-writer': path.join(__dirname, '..', '..', 'prompts', 'report-writer-prompt.md'),
    'page-renderer': path.join(__dirname, '..', '..', 'prompts', 'page-renderer-prompt.md'),
    'app-testing-report': path.join(__dirname, '..', '..', 'prompts', 'app-testing-report-writer-prompt.md'),
    'verwerkersovereenkomst-renderer': path.join(__dirname, '..', '..', 'prompts', 'verwerkersovereenkomst-renderer-prompt.md'),
    'verwerkersovereenkomst-reviewer': path.join(__dirname, '..', '..', 'prompts', 'verwerkersovereenkomst-reviewer-prompt.md'),
};

// ── Cache for loaded defaults ───────────────────────────────────

let _defaultsCache = null;

/**
 * Load all default prompts (system agents from DB + markdown files from disk).
 * Cached after first load.
 */
async function loadAllDefaults() {
    if (_defaultsCache) return _defaultsCache;

    const defaults = {};

    // Load system agent prompts from the database
    try {
        const { getOne } = require('../../db');
        const systemAgentIds = PROMPT_IDS.filter(id => id.startsWith('system-'));
        for (const agentId of systemAgentIds) {
            const row = await getOne('SELECT system_prompt FROM agents WHERE id = $1', [agentId]);
            if (row?.system_prompt) {
                defaults[agentId] = row.system_prompt;
            }
        }
    } catch (err) {
        console.warn('[PromptDefaults] Failed to load system agent prompts from DB:', err.message);
    }

    // Load markdown file prompts
    for (const [promptId, filePath] of Object.entries(MD_PROMPT_PATHS)) {
        try {
            if (fs.existsSync(filePath)) {
                defaults[promptId] = fs.readFileSync(filePath, 'utf-8');
            }
        } catch (err) {
            console.warn(`[PromptDefaults] Failed to load ${promptId} from ${filePath}:`, err.message);
        }
    }

    _defaultsCache = defaults;
    return defaults;
}

/**
 * Get the default English prompt text for a given prompt ID.
 */
async function getDefaultPrompt(promptId) {
    const defaults = await loadAllDefaults();
    return defaults[promptId] || null;
}

/**
 * Get all defaults as { promptId: text } map.
 */
async function getAllDefaults() {
    return await loadAllDefaults();
}

/**
 * Clear the defaults cache (e.g. after an admin edits a system agent prompt).
 */
function clearDefaultsCache() {
    _defaultsCache = null;
}

module.exports = {
    PROMPT_IDS,
    PROMPT_LABELS,
    PROMPT_CATEGORIES,
    MD_PROMPT_PATHS,
    getDefaultPrompt,
    getAllDefaults,
    clearDefaultsCache,
};
