/**
 * Agent Preset Registry — one-click agent templates an org admin can install.
 *
 * Distinct from systemAgentRegistry.js: those are *internal* system agents
 * (Title Generator, Memory Extractor, etc.) that the platform invokes itself.
 * Presets are *user-facing* templates: when an admin clicks "install", we
 * create a real, tenant-owned, editable agent in their org with the preset's
 * system prompt + KB attachments. The Dutch legal integration tools become
 * available automatically through the `dutch_legal_sources` beta feature —
 * no `agent_tools` rows are needed for those.
 */

const path = require('path');

const PRESETS_PROMPTS_DIR = path.join(__dirname, 'prompts');

/**
 * @typedef {Object} AgentPresetDef
 * @property {string}   slug           - Stable URL slug + lookup key
 * @property {string}   name           - Display name (used as the new agent's name)
 * @property {string}   description    - Short one-liner
 * @property {string}   promptFile     - Markdown file in ./prompts/ holding the system prompt
 * @property {string|null} defaultModel - e.g. 'tier:thinking', null = global default
 * @property {string[]} systemKbSlugs  - System KBs to attach (resolved via getSystemKBBySlug)
 * @property {string|null} betaFeature - Hide preset entirely if org doesn't have this feature active
 */

/** @type {AgentPresetDef[]} */
const PRESETS = [
    {
        slug: 'juridisch-concept-auteur',
        name: 'Juridisch Concept-Auteur',
        description: 'Stelt juridische concepten op (memo, contract, pleitnota) met citaten uit Nederlandse wetgeving en jurisprudentie. Roept rechtspraak, EU-recht, kamerstukken en tuchtrecht-tools aan en gebruikt format_citation om losse verwijzingen te canonicaliseren.',
        promptFile: 'juridisch-concept-auteur.md',
        defaultModel: 'tier:thinking',
        systemKbSlugs: ['dutch_legal_sources'],
        betaFeature: 'dutch_legal_sources',
    },
    {
        slug: 'client-intake-assistent',
        name: 'Client Intake Assistent',
        description: 'Voert een gestructureerd intakegesprek met de cliënt en levert een briefing voor de behandelend advocaat. Geeft geen juridisch advies en kwalificeert geen feiten.',
        promptFile: 'client-intake-assistent.md',
        defaultModel: 'tier:smart',
        systemKbSlugs: [],
        betaFeature: 'dutch_legal_sources',
    },
];

const PRESETS_MAP = Object.freeze(
    Object.fromEntries(PRESETS.map(p => [p.slug, p]))
);

module.exports = {
    PRESETS,
    PRESETS_MAP,
    PRESETS_PROMPTS_DIR,
};
