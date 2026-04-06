/**
 * System Agent Registry
 *
 * Declarative metadata for every built-in system agent.
 * Prompts are loaded from markdown files in ./prompts/ at runtime —
 * this file contains ONLY metadata, no prompt text.
 *
 * To add a new system agent:
 *   1. Add a markdown file to ./prompts/
 *   2. Add an entry to REGISTRY below
 *   3. Done — seeding, getters, i18n, and admin UI all derive from this registry.
 */

const path = require('path');

const PROMPTS_DIR = path.join(__dirname, 'prompts');

/**
 * @typedef {Object} SystemAgentDef
 * @property {string}   id           - Stable DB primary key (e.g. 'system-title-generator')
 * @property {string}   name         - Human-readable display name
 * @property {string}   description  - Short one-liner description
 * @property {string}   promptFile   - Filename inside ./prompts/ (e.g. 'title-generator.md')
 * @property {string|null} defaultModel - Default model or tier (e.g. 'tier:fast'), null = use global default
 * @property {boolean}  alwaysUpdate - If true, prompt is force-updated on every seed (unless admin customized)
 * @property {string[]} [tools]      - Component IDs to auto-attach during seeding
 */

/** @type {SystemAgentDef[]} */
const REGISTRY = [
    {
        id: 'system-title-generator',
        name: 'Title Generator',
        description: 'Generates short, descriptive titles for chat conversations',
        promptFile: 'title-generator.md',
        defaultModel: 'tier:fast',
        alwaysUpdate: false,
    },
    {
        id: 'system-memory-extractor',
        name: 'Memory Extractor',
        description: 'Extracts long-term memories from user conversations',
        promptFile: 'memory-extractor.md',
        defaultModel: 'tier:fast',
        alwaysUpdate: false,
    },
    {
        id: 'system-component-designer',
        name: 'AI Component Designer',
        description: 'Expert agent for designing, creating, and testing BeeFlow components',
        promptFile: 'component-designer.md',
        defaultModel: 'tier:smart',
        alwaysUpdate: false,
    },
    {
        id: 'system-pdf-extractor',
        name: 'PDF Extractor',
        description: 'Extracts text from PDF files using native LLM capabilities',
        promptFile: 'pdf-extractor.md',
        defaultModel: 'tier:fast',
        alwaysUpdate: false,
    },
    {
        id: 'system-prompt-designer',
        name: 'System Prompt Designer',
        description: 'Helps create effective system prompts for AI agents',
        promptFile: 'prompt-designer.md',
        defaultModel: 'tier:thinking',
        alwaysUpdate: false,
    },
    {
        id: 'system-conversation-starters',
        name: 'Conversation Starter Generator',
        description: 'Generates conversation starters for AI agents',
        promptFile: 'conversation-starters.md',
        defaultModel: 'tier:smart',
        alwaysUpdate: false,
    },
    {
        id: 'system-description-improver',
        name: 'Description Improver',
        description: 'Improves agent role descriptions',
        promptFile: 'description-improver.md',
        defaultModel: 'tier:smart',
        alwaysUpdate: false,
    },
    {
        id: 'system-identity-improver',
        name: 'Identity Improver',
        description: 'Improves agent name and description from system prompt',
        promptFile: 'identity-improver.md',
        defaultModel: 'tier:smart',
        alwaysUpdate: false,
    },
    {
        id: 'system-orgintel-scout',
        name: 'OrgIntel Scout',
        description: 'Extracts organization information from website domains for signup auto-fill',
        promptFile: 'orgintel-scout.md',
        defaultModel: null,
        alwaysUpdate: true,
        tools: ['webpage-to-markdown', 'website-sitemap-fetcher'],
    },
    {
        id: 'system-regex-generator',
        name: 'Regex Rule Generator',
        description: 'Generates regex detection rules for guardrails (PII, financial data, document IDs)',
        promptFile: 'regex-generator.md',
        defaultModel: null,
        alwaysUpdate: true,
    },
];

// ── Derived constants ────────────────────────────────────────────────────────

/**
 * Frozen map of constant-style keys → agent IDs.
 *   SYSTEM_AGENT_IDS.TITLE_GENERATOR === 'system-title-generator'
 */
const SYSTEM_AGENT_IDS = Object.freeze(
    Object.fromEntries(
        REGISTRY.map(a => [
            a.id.replace('system-', '').replace(/-/g, '_').toUpperCase(),
            a.id,
        ])
    )
);

/**
 * Quick lookup: agentId → registry entry.
 */
const REGISTRY_MAP = Object.freeze(
    Object.fromEntries(REGISTRY.map(a => [a.id, a]))
);

module.exports = {
    REGISTRY,
    REGISTRY_MAP,
    SYSTEM_AGENT_IDS,
    PROMPTS_DIR,
};
