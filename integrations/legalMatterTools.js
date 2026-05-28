/**
 * Legal Matter tools — give the matter chat AI the bronnenlijst-management and
 * verification actions that the Legal Studio GUI exposes, so it can do roughly
 * everything a lawyer can do by hand:
 *   - legal_bronnenlijst_add     → add an authority to the Table of Authorities
 *   - legal_bronnenlijst_list    → see what's already on the list
 *   - legal_bronnenlijst_remove  → remove an authority
 *   - legal_verify_citations     → the AI equivalent of "Verifieer alle bronnen"
 *
 * These are context-bound (they need the matter/notebook id + current draft),
 * so — like notebook_doc_* / notebook_add_source — they're executed inline in
 * notebookChat.js rather than via the stateless central dispatcher.
 *
 * Only wired in for notebooks of type 'legal_matter' with the dutch_legal_sources
 * beta enabled (gated in notebookChat.js).
 */

const legalCitationStore = require('../stores/legalCitationStore');

const KIND_ENUM = ['jurisprudentie', 'wet', 'eu', 'tuchtrecht', 'kamerstuk', 'bekendmaking', 'literatuur'];

const LEGAL_MATTER_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'legal_bronnenlijst_add',
            description: 'Voeg een bron toe aan de bronnenlijst (Table of Authorities) van dit dossier. Gebruik dit wanneer je in het stuk naar een uitspraak, wetsartikel of EU-bron verwijst, zodat de bron ook in de bronnenlijst verschijnt. Geef bij jurisprudentie het volledige ECLI, bij EU-recht het CELEX-nummer, bij wetgeving het BWB-id of artikel. Verzin nooit een identifier.',
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: KIND_ENUM, description: 'Soort bron: jurisprudentie | wet | eu | tuchtrecht | kamerstuk | bekendmaking | literatuur.' },
                    identifier: { type: 'string', description: 'Vindplaats-identifier: ECLI (jurisprudentie/tuchtrecht), CELEX (eu), BWB-id (wet) of kamerstuknummer. Laat leeg voor literatuur.' },
                    title: { type: 'string', description: 'Titel of korte omschrijving van de bron.' },
                    pinpoint: { type: 'string', description: 'Exacte vindplaats binnen de bron, bv. "art. 6:162 BW", "r.o. 3.4" of "punt 42".' },
                    url: { type: 'string', description: 'Optionele directe link naar de bron.' },
                },
                required: ['kind'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'legal_bronnenlijst_list',
            description: 'Toon de huidige bronnenlijst (Table of Authorities) van dit dossier, inclusief verificatiestatus per bron. Gebruik dit om te zien wat al is toegevoegd (voorkom dubbele vermeldingen) of om een bronnenlijst samen te stellen.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'legal_bronnenlijst_remove',
            description: 'Verwijder een bron uit de bronnenlijst van dit dossier, op basis van de identifier (bv. een ECLI of CELEX) of het interne id (uit legal_bronnenlijst_list).',
            parameters: {
                type: 'object',
                properties: {
                    identifier: { type: 'string', description: 'De identifier van de te verwijderen bron (bv. "ECLI:NL:HR:2024:719").' },
                    id: { type: 'string', description: 'Het interne id van de bron (zoals teruggegeven door legal_bronnenlijst_list).' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'legal_verify_citations',
            description: 'Controleer ALLE juridische verwijzingen (ECLI, CELEX, BWB-id) in het huidige conceptdocument tegen de officiële bronnen en werk de bronnenlijst bij. Gebruik dit voordat je een stuk afrondt. Geeft terug welke verwijzingen geverifieerd, niet gevonden, of niet te verifiëren zijn. Dit is hetzelfde als de knop "Verifieer alle bronnen" in de interface.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
];

const LEGAL_MATTER_TOOL_NAMES = new Set(LEGAL_MATTER_TOOLS.map(t => t.function.name));
function isLegalMatterTool(name) { return LEGAL_MATTER_TOOL_NAMES.has(name); }

async function executeLegalMatterTool(toolName, args = {}, ctx = {}) {
    const notebookId = ctx.notebookId;
    if (!notebookId) return { error: 'Geen dossier-context beschikbaar.' };

    if (toolName === 'legal_bronnenlijst_add') {
        if (!args.kind) return { error: 'kind is verplicht.' };
        const citation = await legalCitationStore.upsertCitation({
            notebookId,
            kind: args.kind,
            identifier: args.identifier || null,
            title: args.title || null,
            pinpoint: args.pinpoint || null,
            url: args.url || null,
            verified: false,
            verificationMethod: 'ai_added',
        });
        return {
            ok: true,
            message: 'Bron toegevoegd aan de bronnenlijst (nog niet geverifieerd — gebruik legal_verify_citations om te bevestigen).',
            citation: citation ? { id: citation.id, kind: citation.kind, identifier: citation.identifier, title: citation.title, verified: citation.verified } : null,
        };
    }

    if (toolName === 'legal_bronnenlijst_list') {
        const list = await legalCitationStore.listCitations(notebookId);
        return {
            count: list.length,
            authorities: list.map(c => ({
                id: c.id, kind: c.kind, identifier: c.identifier, title: c.title,
                pinpoint: c.pinpoint, verified: c.verified,
                status: c.verified ? 'geverifieerd' : (c.verificationMethod === 'not_found' ? 'niet gevonden' : 'niet geverifieerd'),
            })),
        };
    }

    if (toolName === 'legal_bronnenlijst_remove') {
        let id = args.id || null;
        if (!id && args.identifier) {
            const list = await legalCitationStore.listCitations(notebookId);
            const want = String(args.identifier).trim().toLowerCase();
            const match = list.find(c => (c.identifier || '').toLowerCase() === want);
            id = match ? match.id : null;
        }
        if (!id) return { ok: false, error: 'Bron niet gevonden — geef een geldig id of identifier op.' };
        const removed = await legalCitationStore.deleteCitation(id, notebookId);
        return removed ? { ok: true, message: 'Bron verwijderd uit de bronnenlijst.' } : { ok: false, error: 'Bron niet gevonden.' };
    }

    if (toolName === 'legal_verify_citations') {
        const { verifyText } = require('../core/legalCitationVerifier');
        const report = await verifyText(ctx.documentContent || '', { notebookId });
        return {
            total: report.total,
            verified: report.verified.map(e => e.token),
            notFound: report.notFound.map(e => e.token),
            unverified: report.unverified.map(e => e.token),
            message: report.total === 0
                ? 'Geen verwijzingen (ECLI/CELEX/BWB) in het document gevonden.'
                : `${report.verified.length}/${report.total} geverifieerd, ${report.notFound.length} niet gevonden, ${report.unverified.length} niet te verifiëren. De bronnenlijst is bijgewerkt.`,
        };
    }

    return { error: `Onbekende tool: ${toolName}` };
}

module.exports = { LEGAL_MATTER_TOOLS, isLegalMatterTool, executeLegalMatterTool };
