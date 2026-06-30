/**
 * Web-search enrichment provider — the always-available floor.
 *
 * Wraps the existing `agent_search` tool (integrations/agentSearchTools.js). It
 * does NOT itself parse company data into lead fields — it returns the search
 * markdown as `context`, which the runner feeds to the AI compaction step for
 * structured extraction. `isConfigured` is always true: agent_search resolves
 * its own URL and returns a graceful error string when unconfigured.
 */

const { executeWebSearch } = require('../agentSearchTools');

module.exports = {
    id: 'web_search',
    label: 'Web Search',

    async isConfigured() {
        return true; // floor provider; agent_search handles its own config/errors
    },

    async enrichCompany(company, ctx = {}) {
        const name = company.company_name || company.companyName || '';
        const loc = company.locatie || company.location || '';
        if (!name) return { fields: {}, provenance: {}, contexts: [] };
        const query = `${name} ${loc} eigenaar directeur contact email telefoon`.trim();
        try {
            const md = await executeWebSearch('agent_search', {
                query,
                mode: 'web',
                max_results: 5,
                fetch_top_n: 2,
                detail_level: 'detailed',
            });
            if (typeof md !== 'string') {
                // agent_search returns {error,...} on empty/failed searches
                if (ctx.log) ctx.log(`[web_search] no usable result for "${name}": ${md?.error || 'unknown'}`);
                return { fields: {}, provenance: {}, contexts: [] };
            }
            return {
                fields: {},
                provenance: {},
                contexts: [{ source: 'web_search', text: md.slice(0, 6000) }],
            };
        } catch (e) {
            if (ctx.log) ctx.log(`[web_search] error for "${name}": ${e.message}`);
            return { fields: {}, provenance: {}, contexts: [] };
        }
    },
};
