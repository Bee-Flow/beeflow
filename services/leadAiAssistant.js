/**
 * Lead AI Assistant — on-demand, per-lead AI actions (NOT the bulk campaign run).
 *
 * Two operations, both reusing the exact same model/adapter/enrichment path as
 * the campaign runner (services/leadGenerationRunner.js exports its primitives):
 *
 *   • researchLead — deep-enrich ONE existing lead on demand (a fresh, deeper web
 *     search + a re-run of the campaign's enrichment providers → compaction →
 *     merge into the same lead row, preserving collaboration columns).
 *   • draftEmail   — web-search for info relevant to *why we're approaching* the
 *     company (the campaign's outreach pitch), then write a personalized Dutch
 *     B2B outreach e-mail grounded only in the gathered facts. Persisted on the
 *     lead so teammates see the same draft.
 *
 * Web search is best-effort in both: a transport failure (no Serper key / service
 * down) degrades to provider/stored data — it never aborts the action.
 */

const leadStudioStore = require('../stores/leadStudioStore');
const leadEnrichment = require('../integrations/leadEnrichment');
// Module-object access (not destructured) for the dependencies tests stub:
// runner.resolveModelAndAdapter/chatOnce/compactLead + agentSearch.executeWebSearch.
const agentSearch = require('../integrations/agentSearchTools');
const runner = require('./leadGenerationRunner');
const { criteriaSummary, extractJson } = runner; // pure helpers, no mocking needed

const noopLog = () => {};

// ── Helpers ─────────────────────────────────────────────────────────

/** Best-effort city from a Dutch address ("1187 KL Amstelveen" / "..., Amstelveen"). */
function cityFromAddress(addr) {
    if (!addr) return null;
    const s = String(addr);
    const pc = s.match(/\b\d{4}\s?[A-Za-z]{2}\b\s*(.+)$/);
    if (pc && pc[1]) return pc[1].split(',')[0].trim() || null;
    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : null;
}

function leadLocatie(lead, campaign) {
    const c = campaign?.criteria || {};
    return (c.locatie || c.location || cityFromAddress(lead.address) || '').trim() || null;
}

/** Shape an existing lead back into the candidate object the enrichment/compaction expect. */
function companyFromLead(lead, campaign) {
    return {
        company_name: lead.companyName || lead.company_name || 'Onbekend',
        website: lead.website || null,
        locatie: leadLocatie(lead, campaign),
    };
}

/** Run one best-effort web search; return markdown context or '' (never throws). */
async function searchContext(query, { detail = 'detailed', log } = {}) {
    try {
        const r = await agentSearch.executeWebSearch('agent_search', {
            query, mode: 'web', max_results: 6, fetch_top_n: 3, detail_level: detail,
        });
        if (typeof r === 'string' && !/^search failed/i.test(r)) return r;
        log?.(`[assistant] search "${query}" no usable result: ${typeof r === 'string' ? r.slice(0, 120) : (r && r.error) || 'unknown'}`);
    } catch (e) { log?.(`[assistant] search "${query}" threw: ${e.message}`); }
    return '';
}

function firstWords(s, n) {
    return String(s || '').split(/\s+/).filter(Boolean).slice(0, n).join(' ');
}

const FACT_KEYS = ['kvk_number', 'address', 'website', 'branche', 'company_size', 'owner_name', 'contact_title', 'email', 'phone', 'linkedin_url'];
const LEAD_KEY_MAP = {
    kvk_number: 'kvkNumber', address: 'address', website: 'website', branche: 'branche',
    company_size: 'companySize', owner_name: 'ownerName', contact_title: 'contactTitle',
    email: 'email', phone: 'phone', linkedin_url: 'linkedinUrl',
};

// ── researchLead ────────────────────────────────────────────────────

/**
 * Deep-enrich a single existing lead. Merges new findings into the SAME lead row
 * (keeps lead.dedupKey so the upsert updates in place) and never clobbers the
 * collaboration columns (status/assignee/verified/notes/email_draft_*).
 * @returns {Promise<{ lead, usedSearch, changed: string[] }>}
 */
async function researchLead({ leadId, focus = 'all', orgId, userId, log = noopLog }) {
    const lead = await leadStudioStore.getLead(leadId);
    if (!lead) throw new Error('lead_not_found');
    const effectiveOrg = orgId || lead.organizationId;
    const campaign = await leadStudioStore.getCampaign(lead.campaignId);
    const company = companyFromLead(lead, campaign);
    const locatie = company.locatie || '';

    const mc = await runner.resolveModelAndAdapter({ modelTier: campaign?.modelTier, orgId: effectiveOrg, userId, log });

    // Re-run the campaign's enrichment providers (kvk/hunter/apify + web_search).
    const providers = await leadEnrichment.getEnabledProviders({ orgId: effectiveOrg, requested: campaign?.enrichmentProviders });
    let enriched = { fields: {}, provenance: {}, contexts: [] };
    try { enriched = await leadEnrichment.enrichCompany(company, providers, { orgId: effectiveOrg, userId, log }); }
    catch (e) { log(`[research] enrich failed: ${e.message}`); }

    // Plus a deeper, focus-aware web search on top of the providers' own context.
    const queries = [];
    if (focus === 'owner') {
        queries.push([lead.ownerName, company.company_name, locatie, 'eigenaar directeur LinkedIn contact'].filter(Boolean).join(' '));
    } else {
        queries.push([company.company_name, locatie, 'over ons bedrijf diensten contact eigenaar'].filter(Boolean).join(' '));
        if (focus === 'all') queries.push([lead.ownerName, company.company_name, locatie, 'directeur eigenaar'].filter(Boolean).join(' '));
    }
    let usedSearch = false;
    for (const q of queries) {
        const md = await searchContext(q, { detail: 'highly_detailed', log });
        if (md) { usedSearch = true; enriched.contexts.push({ source: 'web_search', text: md.slice(0, 8000) }); }
    }

    let aiFields = {};
    try { aiFields = await runner.compactLead(mc, { company, enriched, criteria: campaign?.criteria || {}, orgId: effectiveOrg, userId }); }
    catch (e) { log(`[research] compaction failed: ${e.message}`); }

    const { finalFields, provenance, aiConfidence } = runner.mergeFinalLead(company, enriched, aiFields);

    // Which fields are genuinely new vs the lead we started from (for a soft toast).
    const changed = FACT_KEYS.filter((k) => {
        const v = finalFields[k];
        if (v == null || v === '') return false;
        return !lead[LEAD_KEY_MAP[k]];
    });

    // CRITICAL: pass the lead's existing dedupKey so ON CONFLICT updates THIS row
    // (a newly-found KvK number would otherwise compute a different key → new row).
    await leadStudioStore.upsertLead({
        campaignId: lead.campaignId,
        organizationId: effectiveOrg,
        dedupKey: lead.dedupKey,
        aiConfidence,
        provenance,
        ...finalFields,
    });
    const updated = await leadStudioStore.markResearched(leadId, userId);
    // Surface the AI action on the CRM timeline (best-effort).
    try {
        require('../stores/leadCrmStore').logActivity({
            leadId, organizationId: effectiveOrg, type: 'ai', actorUserId: userId,
            body: changed.length ? `AI-onderzoek: ${changed.join(', ')} bijgewerkt` : 'AI-onderzoek uitgevoerd (geen nieuwe velden)',
            metadata: { changed },
        }).catch(() => {});
    } catch (_) { /* timeline is non-critical */ }
    return { lead: updated, usedSearch, changed };
}

// ── draftEmail ──────────────────────────────────────────────────────

const EMAIL_SYSTEM = `Je bent een ervaren Nederlandse B2B sales copywriter. Je schrijft een persoonlijke, warme cold-outreach e-mail.
Regels:
- Schrijf in het Nederlands, beleefd maar menselijk — geen generieke marketingtaal.
- Gebruik UITSLUITEND feiten uit de meegeleverde gegevens en zoekresultaten. Verzin NIETS (geen namen, cijfers, of gebeurtenissen die er niet staan).
- Verwijs naar een concreet, relevant detail over het bedrijf om oprechte interesse te tonen, indien beschikbaar.
- Houd het bondig: 120–180 woorden.
- Eén duidelijke, niet-opdringerige call-to-action.
- Spreek de contactpersoon bij naam aan als die bekend is, anders een nette aanhef.
- Sluit af met "[Jouw naam]" als ondertekening-placeholder.
- Geef ALLEEN een JSON-object terug, zonder uitleg: {"subject": string, "body": string}.`;

function buildEmailUserPrompt({ lead, campaign, locatie, pitch, context, extraInstructions, tone }) {
    const facts = {
        bedrijf: lead.companyName,
        contactpersoon: lead.ownerName || null,
        functie: lead.contactTitle || null,
        email: lead.email || null,
        branche: lead.branche || (campaign?.criteria?.branche) || null,
        plaats: locatie || null,
        website: lead.website || null,
    };
    return [
        `Reden van benadering / ons aanbod:\n${pitch || '(niet opgegeven — leid een passende, respectvolle reden af uit de branche/criteria)'}`,
        `Campagne-criteria:\n${criteriaSummary(campaign?.criteria || {})}`,
        `Lead-gegevens (alleen niet-null velden gebruiken):\n${JSON.stringify(facts, null, 0)}`,
        `Relevante webinformatie (alleen feiten hieruit gebruiken):\n${context || '(geen aanvullende webinformatie gevonden)'}`,
        tone ? `Gewenste toon: ${tone}` : null,
        extraInstructions ? `Extra instructies van de gebruiker:\n${extraInstructions}` : null,
        `Schrijf nu het JSON-object met "subject" en "body".`,
    ].filter(Boolean).join('\n\n');
}

function parseEmail(content) {
    const parsed = extractJson(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.subject || parsed.body)) {
        return {
            subject: String(parsed.subject || '').trim() || 'Voorstel tot kennismaking',
            body: String(parsed.body || '').trim(),
        };
    }
    // Fallback: first non-empty line = subject, rest = body.
    const lines = String(content || '').split('\n').map(l => l.trim());
    const firstIdx = lines.findIndex(Boolean);
    if (firstIdx === -1) return { subject: 'Voorstel tot kennismaking', body: '' };
    const subject = lines[firstIdx].replace(/^(onderwerp|subject)\s*:\s*/i, '').slice(0, 200) || 'Voorstel tot kennismaking';
    const body = lines.slice(firstIdx + 1).join('\n').trim();
    return { subject, body: body || lines.slice(firstIdx).join('\n').trim() };
}

/**
 * Draft a personalized outreach e-mail for a lead. Best-effort web search for
 * outreach-relevant context, then a grounded one-shot generation. Persists the
 * draft on the lead by default (collaborative).
 * @returns {Promise<{ subject, body, usedSearch, lead? }>}
 */
async function draftEmail({ leadId, orgId, userId, extraInstructions = null, tone = null, save = true, log = noopLog }) {
    const lead = await leadStudioStore.getLead(leadId);
    if (!lead) throw new Error('lead_not_found');
    const effectiveOrg = orgId || lead.organizationId;
    const campaign = await leadStudioStore.getCampaign(lead.campaignId);
    const locatie = leadLocatie(lead, campaign);
    const pitch = campaign?.outreachPitch || '';

    const mc = await runner.resolveModelAndAdapter({ modelTier: campaign?.modelTier, orgId: effectiveOrg, userId, log });

    // Search for info relevant to *why* we're reaching out (pitch-keyed).
    const q = [lead.companyName, locatie, pitch ? firstWords(pitch, 5) : 'bedrijf diensten nieuws'].filter(Boolean).join(' ');
    const context = (await searchContext(q, { detail: 'detailed', log })).slice(0, 6000);
    const usedSearch = !!context;

    const resp = await runner.chatOnce(mc, [
        { role: 'system', content: EMAIL_SYSTEM },
        { role: 'user', content: buildEmailUserPrompt({ lead, campaign, locatie, pitch, context, extraInstructions, tone }) },
    ], { maxTokens: 1200, temperature: 0.6 }, { orgId: effectiveOrg, userId });

    const { subject, body } = parseEmail(typeof resp.content === 'string' ? resp.content : '');

    let saved = null;
    if (save) {
        saved = await leadStudioStore.saveEmailDraft(leadId, { subject, body, userId });
        try {
            require('../stores/leadCrmStore').logActivity({
                leadId, organizationId: effectiveOrg, type: 'email', actorUserId: userId,
                body: `AI-conceptmail opgesteld: ${subject}`, metadata: { subject },
            }).catch(() => {});
        } catch (_) { /* timeline is non-critical */ }
    }
    return { subject, body, usedSearch, lead: saved || lead };
}

module.exports = {
    researchLead,
    draftEmail,
    // exported for tests
    _internals: { cityFromAddress, companyFromLead, leadLocatie, parseEmail, buildEmailUserPrompt },
};
