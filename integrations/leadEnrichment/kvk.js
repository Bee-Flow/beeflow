/**
 * KvK Open Data enrichment provider — official NL company registry.
 *
 * Fills the authoritative company identity: KvK number, canonical name,
 * registered address, SBI activity codes. Highest trust source (confidence
 * 0.95) so it wins legal-name/address/SBI conflicts during compaction.
 *
 * Credential: per-org secret `org_<orgId>_kvk_api_key`, falling back to a
 * global `kvk_api_key`. Degrades to a no-op when unconfigured.
 */

const configStore = require('../../stores/configStore');
const { fetchJson, isErr } = require('./_util');

const KVK_SEARCH_URL = process.env.KVK_API_URL || 'https://api.kvk.nl/api/v2/zoeken';

async function resolveKey(orgId) {
    let key = null;
    try { key = orgId ? await configStore.getSecret(`org_${orgId}_kvk_api_key`) : null; } catch (_) {}
    if (!key) { try { key = await configStore.getSecret('kvk_api_key'); } catch (_) {} }
    return key || null;
}

module.exports = {
    id: 'kvk',
    label: 'KvK Open Data',

    async isConfigured({ orgId } = {}) {
        return !!(await resolveKey(orgId));
    },

    async enrichCompany(company, ctx = {}) {
        const key = await resolveKey(ctx.orgId);
        if (!key) return { fields: {}, provenance: {}, contexts: [] };
        const name = company.company_name || company.companyName || '';
        const plaats = company.locatie || company.location || '';
        if (!name) return { fields: {}, provenance: {}, contexts: [] };

        const params = new URLSearchParams({ naam: name });
        if (plaats) params.set('plaats', plaats);
        const url = `${KVK_SEARCH_URL}?${params.toString()}`;
        const data = await fetchJson(url, { headers: { apikey: key }, signal: ctx.signal });
        if (isErr(data)) {
            if (ctx.log) ctx.log(`[kvk] lookup failed for "${name}": ${data?._error}`);
            return { fields: {}, provenance: {}, contexts: [] };
        }
        const results = Array.isArray(data.resultaten) ? data.resultaten : [];
        const top = results[0];
        if (!top) return { fields: {}, provenance: {}, contexts: [] };

        const adres = top.adres?.binnenlandsAdres || top.adres || {};
        const addressStr = [adres.straatnaam, adres.huisnummer, adres.postcode, adres.plaats]
            .filter(Boolean).join(' ').trim() || null;
        const sbi = [];
        if (top.sbiActiviteit) sbi.push(String(top.sbiActiviteit));
        if (Array.isArray(top.sbiActiviteiten)) sbi.push(...top.sbiActiviteiten.map(s => s.sbiCode || s).filter(Boolean));

        const fields = {
            kvk_number: top.kvkNummer || null,
            company_name: top.naam || null,
            address: addressStr,
            sbi_codes: Array.from(new Set(sbi)),
        };
        const now = new Date().toISOString();
        const provenance = {};
        for (const k of ['kvk_number', 'company_name', 'address']) {
            if (fields[k]) provenance[k] = { source: 'kvk', confidence: 0.95, fetchedAt: now };
        }
        if (fields.sbi_codes.length) provenance.sbi_codes = { source: 'kvk', confidence: 0.95, fetchedAt: now };
        return { fields, provenance, contexts: [] };
    },
};
