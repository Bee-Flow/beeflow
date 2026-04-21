/**
 * EU AI Act Art. 13 — Transparency / information to users.
 * Ensures each published agent has a meaningful description so users can
 * understand the purpose and limitations of the AI system they interact with.
 */

const { getAll } = require('../../../db');

const MIN_DESCRIPTION_CHARS = 30;

module.exports = {
    id: 'AIA-Art13-transparency',
    regulation: 'AIA',
    article: '13',
    severity: 'medium',
    scope: 'global',
    titleKey: 'compliance.checks.aia_art13.title',
    descriptionKey: 'compliance.checks.aia_art13.desc',
    remediationKey: 'compliance.checks.aia_art13.fix',
    remediationLink: 'admin/agents',
    async evaluate(orgId) {
        let agents = [];
        try {
            agents = await getAll(`
                SELECT id, name, description, organization_id
                FROM agents WHERE is_published = TRUE
            `);
        } catch {
            return { status: 'not_applicable', evidence: {}, details: 'No agents table yet.' };
        }
        if (agents.length === 0) {
            return { status: 'not_applicable', evidence: {}, details: 'No published agents to assess.' };
        }

        const missing = [];
        let applicable = 0;
        for (const a of agents) {
            if (orgId && a.organization_id && a.organization_id !== orgId) continue;
            applicable++;
            const desc = a.description == null ? '' : String(a.description).trim();
            if (desc.length < MIN_DESCRIPTION_CHARS) {
                missing.push({ id: a.id, name: a.name, length: desc.length });
            }
        }

        if (applicable === 0) {
            return { status: 'not_applicable', evidence: {}, details: 'No agents in this organization.' };
        }

        let status;
        if (missing.length === 0) status = 'pass';
        else if (missing.length < applicable) status = 'warn';
        else status = 'fail';

        return {
            status,
            evidence: {
                total: applicable,
                missing_count: missing.length,
                min_chars: MIN_DESCRIPTION_CHARS,
                missing_descriptions: missing.slice(0, 10),
            },
            details: status === 'pass'
                ? `Every published agent (${applicable}) has a meaningful description of ≥${MIN_DESCRIPTION_CHARS} characters.`
                : `${missing.length} of ${applicable} agents have no description or fewer than ${MIN_DESCRIPTION_CHARS} characters. Add a short explanation of what the agent does and its limits.`,
        };
    },
};
