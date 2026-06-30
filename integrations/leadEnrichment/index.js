/**
 * Lead-enrichment provider registry.
 *
 * Pluggable providers, each: { id, label, isConfigured({orgId}), enrichCompany(company, ctx) }
 * where enrichCompany returns { fields, provenance, contexts }.
 *
 * web_search is the always-available floor; KvK/Hunter/Apify are optional and
 * degrade gracefully when unconfigured. enrichCompany() runs the enabled
 * providers for one company and merges their results — highest-confidence value
 * wins per field, so KvK (0.95) owns the legal identity. One provider failing
 * never aborts the others (partial enrichment is normal and expected).
 */

const webSearch = require('./webSearch');
const kvk = require('./kvk');
const hunter = require('./hunter');
const apollo = require('./apollo');
const apifyLinkedin = require('./apify_linkedin');

// Ordered: identity (kvk) → contacts (hunter, apollo) → social (apify).
// web_search first so its context is collected regardless.
const ALL_PROVIDERS = [webSearch, kvk, hunter, apollo, apifyLinkedin];
const PROVIDER_IDS = ALL_PROVIDERS.map(p => p.id);

/** Providers the UI can offer (id + label, never secrets). */
function listProviderMeta() {
    return ALL_PROVIDERS.map(p => ({ id: p.id, label: p.label, alwaysOn: p.id === 'web_search' }));
}

/** Per-org configured/not status for the /providers route. */
async function getProviderStatus({ orgId } = {}) {
    const out = [];
    for (const p of ALL_PROVIDERS) {
        let configured = false;
        try { configured = await p.isConfigured({ orgId }); } catch (_) {}
        out.push({ id: p.id, label: p.label, configured, alwaysOn: p.id === 'web_search' });
    }
    return out;
}

/**
 * Resolve the providers to actually run: requested ∩ configured, with web_search
 * always included.
 */
async function getEnabledProviders({ orgId, requested } = {}) {
    const want = new Set(['web_search', ...(Array.isArray(requested) ? requested : [])]);
    const out = [];
    for (const p of ALL_PROVIDERS) {
        if (!want.has(p.id)) continue;
        try { if (await p.isConfigured({ orgId })) out.push(p); }
        catch (_) { /* treat as unconfigured */ }
    }
    return out.length ? out : [webSearch];
}

function _mergeResults(results) {
    const fields = {};
    const provenance = {};
    const contexts = [];
    for (const r of results) {
        if (!r) continue;
        for (const [k, v] of Object.entries(r.fields || {})) {
            if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
            const incomingConf = r.provenance?.[k]?.confidence ?? 0;
            const existingConf = provenance[k]?.confidence ?? -1;
            if (!(k in fields) || incomingConf > existingConf) {
                fields[k] = v;
                if (r.provenance?.[k]) provenance[k] = r.provenance[k];
            }
        }
        if (Array.isArray(r.contexts)) contexts.push(...r.contexts);
    }
    return { fields, provenance, contexts };
}

/**
 * Enrich a single company across the given providers. Never throws — a failing
 * provider contributes nothing and is logged.
 * @param {object} company  - { company_name, website?, locatie? }
 * @param {Array}  providers - resolved provider modules
 * @param {object} ctx       - { orgId, userId, signal, log }
 */
async function enrichCompany(company, providers, ctx = {}) {
    const settled = await Promise.allSettled(
        providers.map(p => Promise.resolve()
            .then(() => p.enrichCompany(company, ctx))
            .catch(e => { ctx.log?.(`[${p.id}] error: ${e.message}`); return null; }))
    );
    const results = settled.map(s => (s.status === 'fulfilled' ? s.value : null));
    return _mergeResults(results);
}

module.exports = {
    ALL_PROVIDERS,
    PROVIDER_IDS,
    listProviderMeta,
    getProviderStatus,
    getEnabledProviders,
    enrichCompany,
    _mergeResults,
};
