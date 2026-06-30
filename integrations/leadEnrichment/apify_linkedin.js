/**
 * Apify LinkedIn enrichment provider — owner/director profile.
 *
 * LinkedIn blocks direct scraping, so this delegates to an Apify actor (a
 * proxy-backed scraper). It is the most fragile + costly provider and is
 * opt-in per campaign. Fills owner_name / contact_title / linkedin_url.
 *
 * Credentials:
 *   - per-org secret `org_<orgId>_apify_token` (fallback global `apify_token`)
 *   - optional actor id `apify_linkedin_actor` config (default a generic
 *     company-scraper actor); set per deployment.
 * Any error / 429 → graceful no-op (the lead persists without LinkedIn data).
 */

const configStore = require('../../stores/configStore');
const { fetchJson, isErr } = require('./_util');

const DEFAULT_ACTOR = 'apify~linkedin-company-scraper';

async function resolveToken(orgId) {
    let t = null;
    try { t = orgId ? await configStore.getSecret(`org_${orgId}_apify_token`) : null; } catch (_) {}
    if (!t) { try { t = await configStore.getSecret('apify_token'); } catch (_) {} }
    return t || null;
}

async function resolveActor() {
    try {
        const cfg = await configStore.getConfig('apify_linkedin_actor');
        if (cfg && typeof cfg === 'string') return cfg;
    } catch (_) {}
    return process.env.APIFY_LINKEDIN_ACTOR || DEFAULT_ACTOR;
}

module.exports = {
    id: 'apify_linkedin',
    label: 'LinkedIn (Apify)',

    async isConfigured({ orgId } = {}) {
        return !!(await resolveToken(orgId));
    },

    async enrichCompany(company, ctx = {}) {
        const token = await resolveToken(ctx.orgId);
        if (!token) return { fields: {}, provenance: {}, contexts: [] };
        const name = company.company_name || company.companyName || '';
        if (!name) return { fields: {}, provenance: {}, contexts: [] };
        const actor = await resolveActor();

        // run-sync-get-dataset-items: runs the actor and returns its dataset in
        // one call (bounded by our timeout). Input shape varies per actor; we
        // pass a permissive search input and parse defensively.
        const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actor)}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
        const data = await fetchJson(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: { search: name, query: name, companyName: name, maxItems: 1 },
            signal: ctx.signal,
            timeoutMs: 30000, // actors are slower than plain APIs
        });
        if (isErr(data)) {
            if (ctx.log) ctx.log(`[apify_linkedin] skipped for "${name}": ${data?._error}`);
            return { fields: {}, provenance: {}, contexts: [] };
        }
        const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
        const item = items[0];
        if (!item) return { fields: {}, provenance: {}, contexts: [] };

        const fields = {};
        const provenance = {};
        const now = new Date().toISOString();
        const ownerName = item.ceo || item.owner || item.fullName || item.name || null;
        const title = item.title || item.position || (item.ceo ? 'CEO' : null);
        const profile = item.linkedinUrl || item.profileUrl || item.url || item.companyUrl || null;
        if (ownerName && ownerName !== name) { fields.owner_name = ownerName; provenance.owner_name = { source: 'apify_linkedin', confidence: 0.7, fetchedAt: now }; }
        if (title) { fields.contact_title = title; provenance.contact_title = { source: 'apify_linkedin', confidence: 0.6, fetchedAt: now }; }
        if (profile) { fields.linkedin_url = profile; provenance.linkedin_url = { source: 'apify_linkedin', confidence: 0.7, fetchedAt: now }; }
        return { fields, provenance, contexts: [] };
    },
};
