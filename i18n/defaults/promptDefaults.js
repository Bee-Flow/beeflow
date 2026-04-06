/**
 * Prompt Defaults Registry
 *
 * Maps prompt IDs to their default English text.
 * These are the built-in prompts that serve as the fallback for any locale.
 *
 * System agent prompts are auto-derived from the systemAgentRegistry —
 * no need to hardcode IDs or labels here.
 * Markdown prompt files are loaded from disk.
 */

const fs = require('fs');
const path = require('path');
const { REGISTRY } = require('../../stores/agent/systemAgentRegistry');

// ── Auto-derive system agent IDs and labels from the registry ────

const systemAgentIds = REGISTRY.map(a => a.id);
const systemAgentLabels = Object.fromEntries(REGISTRY.map(a => [a.id, a.name]));

// ── Non-system prompt IDs ────────────────────────────────────────

const EXTRA_PROMPT_IDS = [
    // Templates
    'master-template',
    // Pipeline prompts (markdown files)
    'web-researcher',
    'report-writer',
    'page-renderer',
    'app-testing-report',
    'verwerkersovereenkomst-renderer',
    'verwerkersovereenkomst-reviewer',
];

const EXTRA_PROMPT_LABELS = {
    'master-template': 'Master System Prompt Template',
    'web-researcher': 'Web Researcher',
    'report-writer': 'Report Writer',
    'page-renderer': 'Page Renderer',
    'app-testing-report': 'App Testing Report Writer',
    'verwerkersovereenkomst-renderer': 'Verwerkersovereenkomst Renderer',
    'verwerkersovereenkomst-reviewer': 'Verwerkersovereenkomst Reviewer',
};

// ── Combined exports ─────────────────────────────────────────────

const PROMPT_IDS = [...systemAgentIds, ...EXTRA_PROMPT_IDS];

const PROMPT_LABELS = {
    ...systemAgentLabels,
    ...EXTRA_PROMPT_LABELS,
};

// ── Prompt categories for UI grouping ────────────────────────────

const PROMPT_CATEGORIES = {
    'System Agents': systemAgentIds,
    'Templates': ['master-template'],
    'Pipeline Prompts': [
        'web-researcher',
        'report-writer',
        'page-renderer',
        'app-testing-report',
        'verwerkersovereenkomst-renderer',
        'verwerkersovereenkomst-reviewer',
    ],
};

// ── Markdown file paths (relative to server root) ────────────────

const MD_PROMPT_PATHS = {
    'master-template': path.join(__dirname, '..', '..', 'templates', 'system_prompt_master.md'),
    'web-researcher': path.join(__dirname, '..', '..', 'prompts', 'web-researcher-prompt.md'),
    'report-writer': path.join(__dirname, '..', '..', 'prompts', 'report-writer-prompt.md'),
    'page-renderer': path.join(__dirname, '..', '..', 'prompts', 'page-renderer-prompt.md'),
    'app-testing-report': path.join(__dirname, '..', '..', 'prompts', 'app-testing-report-writer-prompt.md'),
    'verwerkersovereenkomst-renderer': path.join(__dirname, '..', '..', 'prompts', 'verwerkersovereenkomst-renderer-prompt.md'),
    'verwerkersovereenkomst-reviewer': path.join(__dirname, '..', '..', 'prompts', 'verwerkersovereenkomst-reviewer-prompt.md'),
};

// ── Cache for loaded defaults ────────────────────────────────────

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
