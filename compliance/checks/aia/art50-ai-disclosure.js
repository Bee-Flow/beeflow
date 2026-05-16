/**
 * EU AI Act Art. 50 — Transparency: users must know they're interacting with an AI.
 *
 * Scans each published agent's system prompt, starter prompts and config for
 * explicit disclosure phrasing. Supports one-click auto-fix that prepends an
 * AI-disclosure sentence (locale-aware) to each affected agent's system prompt.
 * The auto-fix is captured in the compliance_evidence chain so it can be
 * audited and rolled back.
 */

const { getAll, run } = require('../../../db');

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

const DISCLOSURE_SENTENCE = {
    en: 'I am an AI assistant. Tell the user clearly that they are interacting with an automated system, not a human.',
    nl: 'Ik ben een AI-assistent. Maak de gebruiker duidelijk dat hij/zij met een geautomatiseerd systeem praat, niet met een mens.',
};

function _extractText(value) {
    if (!value) return '';
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed.filter(s => typeof s === 'string').join(' ');
            if (parsed && typeof parsed === 'object') return Object.values(parsed).filter(v => typeof v === 'string').join(' ');
            return typeof parsed === 'string' ? parsed : '';
        } catch {
            return value;
        }
    }
    return String(value);
}

function _hasDisclosure(text) {
    return DISCLOSURE_PATTERNS.some(p => p.test(text));
}

async function _missingForOrg(orgId) {
    let agents = [];
    try {
        agents = await getAll(`
            SELECT id, name, system_prompt, starter_prompts, config, organization_id, language
            FROM agents WHERE is_published = TRUE
        `);
    } catch {
        return { agents: [], missing: [], tableMissing: true };
    }
    const missing = [];
    const relevant = [];
    for (const a of agents) {
        if (orgId && a.organization_id && a.organization_id !== orgId) continue;
        relevant.push(a);
        const haystack = [
            a.system_prompt || '',
            _extractText(a.starter_prompts),
            _extractText(a.config),
        ].join('\n');
        if (!_hasDisclosure(haystack)) missing.push(a);
    }
    return { agents: relevant, missing };
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
    autoFixId: 'aia_art50_inject_disclosure',

    async evaluate(orgId) {
        const { agents, missing, tableMissing } = await _missingForOrg(orgId);
        if (tableMissing) {
            return { status: 'not_applicable', evidence: {}, details: 'No agents table yet.' };
        }
        if (agents.length === 0) {
            return { status: 'not_applicable', evidence: {}, details: 'No published agents to assess.' };
        }
        const status = missing.length === 0 ? 'pass' : 'warn';
        return {
            status,
            evidence: {
                total_published: agents.length,
                missing_count: missing.length,
                missing_disclosure: missing.slice(0, 10).map(a => ({ id: a.id, name: a.name })),
            },
            details: status === 'pass'
                ? `All ${agents.length} published agents contain an explicit AI disclosure.`
                : `${missing.length} of ${agents.length} published agents don't disclose they are AI. Use "Fix automatically" or add a line like "I am an AI assistant" to the system prompt.`,
        };
    },

    /**
     * One-click remediation. Prepends a locale-aware disclosure sentence to
     * the system prompt of every agent that's missing one. The original
     * prompt is preserved in the evidence row so the change can be inspected
     * and reverted if needed.
     */
    async autoFix(orgId, { actorId } = {}) {
        const { missing } = await _missingForOrg(orgId);
        if (missing.length === 0) {
            return { changed: 0, summary: 'No agents required a disclosure fix.', agents: [] };
        }
        const changed = [];
        for (const a of missing) {
            const lang = (a.language || '').toLowerCase().startsWith('nl') ? 'nl' : 'en';
            const sentence = DISCLOSURE_SENTENCE[lang];
            const newPrompt = `${sentence}\n\n${a.system_prompt || ''}`.trim();
            try {
                await run(
                    `UPDATE agents SET system_prompt = $1, updated_at = NOW() WHERE id = $2`,
                    [newPrompt, a.id],
                );
                changed.push({
                    agent_id: a.id,
                    agent_name: a.name,
                    language: lang,
                    before_prompt: a.system_prompt || '',
                    after_prompt: newPrompt,
                });
            } catch (e) {
                console.warn(`[Art50 autoFix] could not update agent ${a.id}:`, e.message);
            }
        }
        return {
            changed: changed.length,
            summary: `Prepended AI disclosure to ${changed.length} agent(s).`,
            actor_id: actorId || null,
            agents: changed,
        };
    },
};
