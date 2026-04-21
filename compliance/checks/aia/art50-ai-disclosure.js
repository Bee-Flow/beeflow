/**
 * EU AI Act Art. 50 — Transparency: users must know they're interacting with an AI.
 *
 * Scans each published agent's system prompt, starter prompts and config for
 * explicit disclosure phrasing. The previous implementation matched any
 * occurrence of "assistant" which is default boilerplate in most system
 * prompts, leading to trivial false passes. This version requires SPECIFIC
 * phrasing and excludes kale "assistant".
 */

const { getAll } = require('../../../db');

// Phrases that actually disclose AI nature. Matches are word-boundary safe.
const DISCLOSURE_PATTERNS = [
    /\bI['’]?m an AI\b/i,
    /\bI am an AI\b/i,
    /\bAI assistant\b/i,
    /\bAI (?:model|system|agent|bot|chatbot)\b/i,
    /\bartificial intelligence\b/i,
    /\blanguage model\b/i,
    /\b(?:virtual|automated) (?:assistant|system|agent)\b/i,
    /\bchatbot\b/i,
    /\bpowered by AI\b/i,
    // Dutch phrasings
    /\bik ben een (?:AI|kunstmatige intelligentie|chatbot|virtuele assistent)\b/i,
    /\bAI[- ](?:assistent|model|chatbot)\b/i,
    /\bkunstmatige intelligentie\b/i,
    /\bvirtuele assistent\b/i,
];

function _extractText(value) {
    // `starter_prompts` is stored as TEXT containing JSON (array of strings).
    // `config` is JSON too. Parse, then flatten to a plain string.
    if (!value) return '';
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed.filter(s => typeof s === 'string').join(' ');
            if (parsed && typeof parsed === 'object') return Object.values(parsed).filter(v => typeof v === 'string').join(' ');
            return typeof parsed === 'string' ? parsed : '';
        } catch {
            return value; // Not JSON — scan raw text.
        }
    }
    return String(value);
}

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
        if (agents.length === 0) {
            return { status: 'not_applicable', evidence: {}, details: 'No published agents to assess.' };
        }

        const missing = [];
        for (const a of agents) {
            if (orgId && a.organization_id && a.organization_id !== orgId) continue;
            const haystack = [
                a.system_prompt || '',
                _extractText(a.starter_prompts),
                _extractText(a.config),
            ].join('\n');
            const hasDisclosure = DISCLOSURE_PATTERNS.some(p => p.test(haystack));
            if (!hasDisclosure) missing.push({ id: a.id, name: a.name });
        }

        const status = missing.length === 0 ? 'pass' : 'warn';
        return {
            status,
            evidence: {
                total_published: agents.length,
                missing_count: missing.length,
                missing_disclosure: missing.slice(0, 10),
            },
            details: status === 'pass'
                ? `All ${agents.length} published agents contain an explicit AI disclosure.`
                : `${missing.length} of ${agents.length} published agents don't disclose they are AI. Add a line such as "I am an AI assistant" to the system prompt or welcome banner.`,
        };
    },
};
