/**
 * Apollo.io enrichment provider — B2B people/contact intelligence.
 *
 * Two-step pipeline (Apollo's People Search returns only masked emails +
 * obfuscated last names; the real contact comes from People Enrichment):
 *   1. People Search  (POST /mixed_people/api_search) — filter by the company's
 *      domain + senior seniorities, take the top match → person id, title,
 *      LinkedIn, company phone.
 *   2. People Match   (POST /people/match) — enrich that person id → full name,
 *      verified work email, phone number(s).
 * Fills owner_name / contact_title / linkedin_url / email / phone. On conflict
 * the higher-confidence value wins; KvK still owns the legal identity.
 *
 * Locked/masked emails (e.g. "email_not_unlocked@domain.com") are dropped rather
 * than persisted. The match step is best-effort: if it fails or is out of scope
 * we still return whatever the search surfaced.
 *
 * Credential: per-org secret `org_<orgId>_apollo_api_key`, fallback global
 * `apollo_api_key`. Auth via the `X-Api-Key` header (URL/body api_key is
 * deprecated by Apollo). People Search needs a master key + the
 * `mixed_people/api_search` scope; the match step needs the people-enrichment
 * scope. Degrades to a no-op when unconfigured or with no usable domain/name.
 */

const configStore = require('../../stores/configStore');
const { fetchJson, isErr, registrableDomain } = require('./_util');

const APOLLO_BASE = process.env.APOLLO_API_URL || 'https://api.apollo.io/api/v1';
const SENIORITIES = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director'];

async function resolveKey(orgId) {
    let key = null;
    try { key = orgId ? await configStore.getSecret(`org_${orgId}_apollo_api_key`) : null; } catch (_) {}
    if (!key) { try { key = await configStore.getSecret('apollo_api_key'); } catch (_) {} }
    return key || null;
}

function headers(key) {
    return { 'Content-Type': 'application/json', 'X-Api-Key': key, 'Cache-Control': 'no-cache' };
}

/** Apollo masks locked emails — only keep real addresses. */
function usableEmail(email) {
    if (!email || typeof email !== 'string') return null;
    const e = email.trim().toLowerCase();
    if (!e.includes('@')) return null;
    if (e.includes('not_unlocked') || e.startsWith('email_')) return null;
    return email.trim();
}

/** Person direct number (sanitized E.164 preferred) → else the company phone. */
function pickPhone(person) {
    const nums = Array.isArray(person.phone_numbers) ? person.phone_numbers : [];
    const direct = nums.map(n => n && (n.sanitized_number || n.raw_number)).find(Boolean);
    return direct
        || person.organization?.primary_phone?.number
        || person.organization?.sanitized_phone
        || person.organization?.phone
        || null;
}

function fullName(person) {
    return person.name || [person.first_name, person.last_name].filter(Boolean).join(' ') || null;
}

module.exports = {
    id: 'apollo',
    label: 'Apollo.io',

    async isConfigured({ orgId } = {}) {
        return !!(await resolveKey(orgId));
    },

    async enrichCompany(company, ctx = {}) {
        const key = await resolveKey(ctx.orgId);
        if (!key) return { fields: {}, provenance: {}, contexts: [] };
        const domain = registrableDomain(company.website || company.domain || '');
        const name = company.company_name || company.companyName || '';
        if (!domain && !name) return { fields: {}, provenance: {}, contexts: [] };

        // ── Step 1: People Search (free, no credits) ──
        const searchBody = { person_seniorities: SENIORITIES, page: 1, per_page: 5 };
        if (domain) searchBody.q_organization_domains_list = [domain];
        else searchBody.q_keywords = name;

        const sdata = await fetchJson(`${APOLLO_BASE}/mixed_people/api_search`, {
            method: 'POST', headers: headers(key), body: searchBody, signal: ctx.signal,
        });
        if (isErr(sdata)) {
            if (ctx.log) ctx.log(`[apollo] search failed for ${domain || name}: ${sdata?._error}`);
            return { fields: {}, provenance: {}, contexts: [] };
        }
        const people = Array.isArray(sdata.people) ? sdata.people
            : (Array.isArray(sdata.contacts) ? sdata.contacts : []);
        if (!people.length) return { fields: {}, provenance: {}, contexts: [] };
        const p = people[0];

        // Search-level fields (name may be partial, email usually masked).
        let ownerName = fullName(p);
        let title = p.title || null;
        let linkedin = p.linkedin_url || null;
        let email = usableEmail(p.email);
        let phone = pickPhone(p);

        // ── Step 2: People Match — real email + full name (credits, best-effort) ──
        if (p.id) {
            const mdata = await fetchJson(`${APOLLO_BASE}/people/match`, {
                method: 'POST', headers: headers(key), body: { id: p.id }, signal: ctx.signal,
            });
            const m = !isErr(mdata) ? (mdata.person || mdata) : null;
            if (m && typeof m === 'object') {
                ownerName = fullName(m) || ownerName;
                title = m.title || title;
                linkedin = m.linkedin_url || linkedin;
                email = usableEmail(m.email) || email;
                phone = pickPhone(m) || phone;
            } else if (isErr(mdata) && ctx.log) {
                ctx.log(`[apollo] match failed for ${ownerName || domain}: ${mdata?._error}`);
            }
        }

        const fields = {};
        const provenance = {};
        const now = new Date().toISOString();
        if (ownerName) { fields.owner_name = ownerName; provenance.owner_name = { source: 'apollo', confidence: 0.7, fetchedAt: now }; }
        if (title) { fields.contact_title = title; provenance.contact_title = { source: 'apollo', confidence: 0.7, fetchedAt: now }; }
        if (linkedin) { fields.linkedin_url = linkedin; provenance.linkedin_url = { source: 'apollo', confidence: 0.7, fetchedAt: now }; }
        if (email) { fields.email = email; provenance.email = { source: 'apollo', confidence: 0.85, fetchedAt: now }; }
        if (phone) { fields.phone = phone; provenance.phone = { source: 'apollo', confidence: 0.6, fetchedAt: now }; }
        return { fields, provenance, contexts: [] };
    },
};
