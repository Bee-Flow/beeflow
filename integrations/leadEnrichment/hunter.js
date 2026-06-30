/**
 * Hunter.io enrichment provider — email (and sometimes phone) for a company
 * domain. Primary email source. Carries Hunter's own
 * per-email confidence into provenance.
 *
 * Credential: per-org secret `org_<orgId>_hunter_api_key`, falling back to a
 * global `hunter_api_key`. Degrades to a no-op when unconfigured or no domain.
 */

const configStore = require('../../stores/configStore');
const { fetchJson, isErr, registrableDomain } = require('./_util');

const HUNTER_URL = process.env.HUNTER_API_URL || 'https://api.hunter.io/v2/domain-search';

async function resolveKey(orgId) {
    let key = null;
    try { key = orgId ? await configStore.getSecret(`org_${orgId}_hunter_api_key`) : null; } catch (_) {}
    if (!key) { try { key = await configStore.getSecret('hunter_api_key'); } catch (_) {} }
    return key || null;
}

module.exports = {
    id: 'hunter',
    label: 'Hunter.io',

    async isConfigured({ orgId } = {}) {
        return !!(await resolveKey(orgId));
    },

    async enrichCompany(company, ctx = {}) {
        const key = await resolveKey(ctx.orgId);
        if (!key) return { fields: {}, provenance: {}, contexts: [] };
        const domain = registrableDomain(company.website || company.domain || '');
        if (!domain) return { fields: {}, provenance: {}, contexts: [] };

        const url = `${HUNTER_URL}?domain=${encodeURIComponent(domain)}&limit=5&api_key=${encodeURIComponent(key)}`;
        const data = await fetchJson(url, { signal: ctx.signal });
        if (isErr(data)) {
            if (ctx.log) ctx.log(`[hunter] lookup failed for ${domain}: ${data?._error}`);
            return { fields: {}, provenance: {}, contexts: [] };
        }
        const d = data.data || {};
        const emails = Array.isArray(d.emails) ? d.emails : [];
        // Prefer a decision-maker / generic role email, highest confidence first.
        emails.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        const best = emails.find(e => ['executive', 'owner', 'director'].includes((e.seniority || '').toLowerCase()))
            || emails[0];
        const fields = {};
        const provenance = {};
        const now = new Date().toISOString();
        if (best?.value) {
            fields.email = best.value;
            provenance.email = { source: 'hunter', confidence: (best.confidence || 50) / 100, fetchedAt: now };
            if (best.first_name || best.last_name) {
                fields.owner_name = [best.first_name, best.last_name].filter(Boolean).join(' ');
                provenance.owner_name = { source: 'hunter', confidence: 0.5, fetchedAt: now };
            }
            if (best.position) { fields.contact_title = best.position; provenance.contact_title = { source: 'hunter', confidence: 0.5, fetchedAt: now }; }
            if (best.phone_number) { fields.phone = best.phone_number; provenance.phone = { source: 'hunter', confidence: 0.5, fetchedAt: now }; }
        }
        return { fields, provenance, contexts: [] };
    },
};
