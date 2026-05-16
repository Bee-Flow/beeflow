/**
 * Tweede Kamer Open Data — kamerstukken search & retrieval
 *
 * Wraps the parliamentary data warehouse at gegevensmagazijn.tweedekamer.nl.
 * Anonymous, no API key. Two entry points:
 *
 *   - Search via OData v4:
 *       /OData/v4/2.0/Document?$filter=...&$top=N&$format=json
 *       /OData/v4/2.0/Zaak?$filter=...&$expand=Document(...)
 *   - Content download (PDF/Word/HTML):
 *       /OData/v4/2.0/Document/{id}/resource
 *
 * Used to give a legal agent access to **wetsgeschiedenis** — memorie van
 * toelichting, amendementen, kamervragen — which is essential for citing
 * legislator intent in legal advice.
 *
 * Gated by the `dutch_legal_sources` beta feature at the integrationTools
 * layer; this file does not enforce that itself.
 */

const ODATA_BASE = 'https://gegevensmagazijn.tweedekamer.nl/OData/v4/2.0';

// Subset of Document.Soort values that map to drafting-relevant kamerstuk
// types. The agent should usually filter to these; passing a raw Soort
// from the response is also fine.
const KAMERSTUK_SOORTEN = [
    'Voorstel van wet',
    'Memorie van toelichting',
    'Nota naar aanleiding van het verslag',
    'Verslag',
    'Amendement',
    'Motie',
    'Antwoord schriftelijke vragen',
    'Kamervragen',
    'Advies Afdeling advisering Raad van State en Nader rapport',
    'Brief regering',
];

const KAMERSTUKKEN_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'kamerstukken_search',
            description: `Zoek Nederlandse parlementaire stukken (Tweede Kamer Open Data). Gebruik dit voor **wetsgeschiedenis**: MvT, amendementen, kamervragen, brieven regering. Geef minstens \`query\` (trefwoord in titel) of \`vergaderjaar\` op. Resultaten bevatten DocumentNummer (kamerstuk-citaat), Soort, Titel, Datum en de id voor \`kamerstuk_get\`.`,
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Trefwoord dat in de titel/onderwerp moet voorkomen, bv. "transitievergoeding", "AVG", "wijziging Boek 7".' },
                    soort: {
                        type: 'string',
                        enum: KAMERSTUK_SOORTEN,
                        description: 'Beperk tot één documentsoort. Veel gebruikt: "Memorie van toelichting" voor wetsgeschiedenis-citatie.',
                    },
                    vergaderjaar: { type: 'string', description: 'Vergaderjaar in formaat "YYYY-YYYY", bv. "2024-2025".' },
                    date_from: { type: 'string', description: 'Begindatum YYYY-MM-DD (filter op Document.Datum).' },
                    date_to: { type: 'string', description: 'Einddatum YYYY-MM-DD (filter op Document.Datum).' },
                    max_results: { type: 'integer', description: 'Aantal resultaten (1-25, standaard 10).' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'kamerstuk_get',
            description: 'Haal de tekst op van één kamerstuk via zijn GUID (`Id` veld uit een kamerstukken_search resultaat). Geeft platte tekst terug (PDF wordt geparsed via de bestaande documentParser). Gebruik dit voor het citeren van MvT of amendementen.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'GUID uit het `Id` veld van een kamerstukken_search resultaat, bv. "5cad673a-6a0d-4801-8f69-0f9d7072f5e2".' },
                },
                required: ['id'],
            },
        },
    },
];

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function escapeOdataString(s) {
    return String(s).replace(/'/g, "''");
}

async function kamerstukkenSearch(args) {
    const maxResults = clampInt(args.max_results, 1, 25, 10);

    const filters = [];
    if (args.query) {
        filters.push(`contains(Titel,'${escapeOdataString(args.query)}')`);
    }
    if (args.soort) {
        filters.push(`Soort eq '${escapeOdataString(args.soort)}'`);
    }
    if (args.vergaderjaar) {
        filters.push(`Vergaderjaar eq '${escapeOdataString(args.vergaderjaar)}'`);
    }
    if (args.date_from) {
        filters.push(`Datum ge ${escapeOdataString(args.date_from)}T00:00:00Z`);
    }
    if (args.date_to) {
        filters.push(`Datum le ${escapeOdataString(args.date_to)}T23:59:59Z`);
    }
    filters.push('Verwijderd eq false');

    if (filters.length === 1) {
        // Only the Verwijderd filter — too broad, would return millions.
        return {
            error: 'Geef minstens één filter op: query (titel-zoekterm), soort, vergaderjaar, of datumbereik.',
            hints: { soort: KAMERSTUK_SOORTEN },
        };
    }

    const params = new URLSearchParams();
    params.set('$filter', filters.join(' and '));
    params.set('$top', String(maxResults));
    params.set('$orderby', 'Datum desc');
    params.set('$format', 'json');

    const url = `${ODATA_BASE}/Document?${params.toString()}`;
    let data;
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Bee-Flow-AI/legal-research' },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            return { error: `Tweede Kamer search failed (${res.status}): ${txt.slice(0, 200)}` };
        }
        data = await res.json();
    } catch (err) {
        return { error: `Tweede Kamer search error: ${err.message}` };
    }

    const items = Array.isArray(data?.value) ? data.value : [];
    const results = items.map(r => ({
        id: r.Id,
        documentNummer: r.DocumentNummer,
        soort: r.Soort,
        titel: (r.Titel || '').trim(),
        onderwerp: r.Onderwerp,
        datum: r.Datum,
        vergaderjaar: r.Vergaderjaar,
        kamer: r.Kamer,
        contentType: r.ContentType,
        contentLength: r.ContentLength,
        // Public-website link by document number. The Tweede Kamer URL pattern
        // changed in 2024 — best to surface the OData download as the canonical
        // link so the agent can hand both to the user.
        downloadUrl: r.Id ? `${ODATA_BASE}/Document/${r.Id}/resource` : null,
    }));

    return {
        filters: {
            query: args.query || null,
            soort: args.soort || null,
            vergaderjaar: args.vergaderjaar || null,
            date_from: args.date_from || null,
            date_to: args.date_to || null,
        },
        count: results.length,
        results,
        source: url,
    };
}

async function kamerstukGet(args) {
    const id = String(args.id || '').trim();
    if (!id) return { error: 'id is required' };
    if (!GUID_RE.test(id)) return { error: `Invalid id format (expected GUID): ${id}` };

    // First fetch metadata so we know the content type before downloading.
    let meta;
    try {
        const metaRes = await fetch(`${ODATA_BASE}/Document/${id}?$format=json`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });
        if (!metaRes.ok) {
            return { error: `Metadata fetch failed (${metaRes.status})` };
        }
        meta = await metaRes.json();
    } catch (err) {
        return { error: `Metadata fetch error: ${err.message}` };
    }

    // Then fetch the resource. documentParser handles PDF, DOCX, plain text.
    let buffer;
    let contentType;
    try {
        const res = await fetch(`${ODATA_BASE}/Document/${id}/resource`, {
            headers: { 'Accept': '*/*' },
            signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
            return { error: `Resource fetch failed (${res.status})` };
        }
        contentType = res.headers.get('content-type') || meta.ContentType || 'application/octet-stream';
        const ab = await res.arrayBuffer();
        buffer = Buffer.from(ab);
    } catch (err) {
        return { error: `Resource fetch error: ${err.message}` };
    }

    let text = '';
    let parseNote = null;
    const filename = `${meta.DocumentNummer || id}.${contentType.includes('pdf') ? 'pdf' : contentType.includes('word') ? 'docx' : 'bin'}`;
    try {
        const { extractFileContent } = require('../core/kbIngestionHelpers');
        text = await extractFileContent(buffer, contentType, filename);
    } catch (err) {
        parseNote = `Could not parse content (${err.message}). Raw download available at downloadUrl.`;
    }

    // Cap at 40k chars — MvTs can be very long.
    const TEXT_CAP = 40000;
    const truncated = text.length > TEXT_CAP;
    if (truncated) text = text.slice(0, TEXT_CAP);

    return {
        id,
        documentNummer: meta.DocumentNummer,
        soort: meta.Soort,
        titel: (meta.Titel || '').trim(),
        onderwerp: meta.Onderwerp,
        datum: meta.Datum,
        vergaderjaar: meta.Vergaderjaar,
        contentType,
        text: text || null,
        truncated,
        parseNote,
        downloadUrl: `${ODATA_BASE}/Document/${id}/resource`,
    };
}

async function executeKamerstukkenTool(toolName, args) {
    if (toolName === 'kamerstukken_search') return kamerstukkenSearch(args || {});
    if (toolName === 'kamerstuk_get') return kamerstukGet(args || {});
    return { error: `Unknown kamerstukken tool: ${toolName}` };
}

function isKamerstukkenTool(toolName) {
    return toolName === 'kamerstukken_search' || toolName === 'kamerstuk_get';
}

module.exports = { KAMERSTUKKEN_TOOLS, executeKamerstukkenTool, isKamerstukkenTool };
