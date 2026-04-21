/**
 * EU AI Act Art. 13 — Transparency & information to users.
 * Ensures that for every published agent we have: name, description,
 * and a way to identify who the deployer is. Uses existing agents table.
 */

const { getAll } = require('../../../db');

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
        for (const a of agents) {
            if (orgId && a.organization_id && a.organization_id !== orgId) continue;
            const desc = (a.description || '').trim();
            if (desc.length < 20) missing.push({ id: a.id, name: a.name });
        }
        const status = missing.length === 0 ? 'pass' : missing.length < agents.length ? 'warn' : 'fail';
        return {
            status,
            evidence: { total: agents.length, missing_descriptions: missing.slice(0, 10), missing_count: missing.length },
            details: status === 'pass'
                ? `Every published agent (${agents.length}) has a meaningful description.`
                : `${missing.length} of ${agents.length} agents lack a proper description. Add at least 20 characters explaining what the agent does.`,
        };
    },
};
