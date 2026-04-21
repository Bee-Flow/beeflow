/**
 * EU AI Act Art. 50 — Transparency for deployers of AI systems interacting with humans.
 * Verifies that published agents have an AI-disclosure mechanism:
 * either in the system prompt, starter prompts, or agent config.
 */

const { getAll } = require('../../../db');

const DISCLOSURE_PATTERNS = [
    /\bAI\b/i,
    /artificial intelligence/i,
    /chatbot/i,
    /language model/i,
    /assistant/i,
    /automat(ed|isch)/i,
];

module.exports = {
    id: 'AIA-Art50-ai-disclosure',
    regulation: 'AIA',
    article: '50',
    severity: 'high',
    scope: 'global',
    titleKey: 'compliance.checks.aia_art50.title',
    descriptionKey: 'compliance.checks.aia_art50.desc',
    remediationKey: 'compliance.checks.aia_art50.fix',
    remediationLink: 'admin/agents',
    async evaluate(orgId) {
        let agents = [];
        try {
            agents = await getAll(`
                SELECT id, name, system_prompt, starter_prompts, config, organization_id
                FROM agents WHERE is_published = TRUE
            `);
        } catch {
            return { status: 'not_applicable', evidence: {}, details: 'No agents table yet.' };
        }
        const missing = [];
        for (const a of agents) {
            if (orgId && a.organization_id && a.organization_id !== orgId) continue;
            const haystack = [
                a.system_prompt || '',
                a.starter_prompts || '',
                a.config || '',
            ].join(' ');
            const hasDisclosure = DISCLOSURE_PATTERNS.some(p => p.test(haystack));
            if (!hasDisclosure) missing.push({ id: a.id, name: a.name });
        }

        if (agents.length === 0) {
            return { status: 'not_applicable', evidence: {}, details: 'No published agents to assess.' };
        }
        const status = missing.length === 0 ? 'pass' : 'warn';
        return {
            status,
            evidence: { total_published: agents.length, missing_disclosure: missing.slice(0, 10), missing_count: missing.length },
            details: status === 'pass'
                ? `All ${agents.length} published agents reference their AI nature.`
                : `${missing.length} of ${agents.length} published agents do not mention they are AI. Add an "I am an AI assistant" line to the system prompt or welcome banner.`,
        };
    },
};
