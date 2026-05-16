/**
 * Tuchtrecht — KOOP SRU search & retrieval
 *
 * Same SRU endpoint as bekendmakingen + BWB ingest, different product area:
 *
 *   c.product-area==tuchtrecht
 *   AND w.instantieDomein==<Advocaten|Notarissen|Accountants|Gerechtsdeurwaarders|Gezondheidszorg>
 *
 * Covers ~47k tuchtuitspraken — Raad/Hof van Discipline (advocaten),
 * Kamer voor het notariaat, Accountantskamer, Kamer voor Gerechtsdeurwaarders,
 * Regionaal/Centraal Tuchtcollege voor de Gezondheidszorg (BIG-beroepen).
 *
 * Anonymous, no API key. Gated by the `dutch_legal_sources` beta feature at
 * the integrationTools layer.
 */

const SRU_BASE = 'https://repository.overheid.nl/sru';

const BEROEPSGROEPEN = {
    advocaat: 'Advocaten',
    notaris: 'Notarissen',
    accountant: 'Accountants',
    deurwaarder: 'Gerechtsdeurwaarders',
    medisch: 'Gezondheidszorg',
};

const TUCHTRECHT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'tuchtrecht_search',
            description: 'Zoek in Nederlandse tuchtuitspraken: advocaten (Raad/Hof van Discipline), notarissen (Kamer voor het notariaat), accountants (Accountantskamer), gerechtsdeurwaarders (Kamer voor Gerechtsdeurwaarders) en BIG-beroepen (Regionaal/Centraal Tuchtcollege voor de Gezondheidszorg). Resultaten bevatten een ECLI-identifier (bv. ECLI:NL:TADRARL:2016:108), titel, beslissing en datum. Roep `tuchtrecht_get` aan voor de volledige tekst.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Trefwoord dat in de titel moet voorkomen, bv. "geheimhouding", "declaratie", "valsheid in geschrifte".' },
                    beroepsgroep: {
                        type: 'string',
                        enum: Object.keys(BEROEPSGROEPEN),
                        description: 'Welke beroepsgroep: advocaat, notaris, accountant, deurwaarder of medisch (BIG).',
                    },
                    date_from: { type: 'string', description: 'Begindatum YYYY-MM-DD (filter op dt.modified).' },
                    date_to: { type: 'string', description: 'Einddatum YYYY-MM-DD (filter op dt.modified).' },
                    max_results: { type: 'integer', description: 'Aantal resultaten (1-25, standaard 10).' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'tuchtrecht_get',
            description: 'Haal de volledige tekst van één tuchtuitspraak op aan de hand van de ECLI (bv. "ECLI:NL:TADRARL:2016:108"). Gebruik dit nadat `tuchtrecht_search` een relevante uitspraak heeft opgeleverd.',
            parameters: {
                type: 'object',
                properties: {
                    identifier: { type: 'string', description: 'ECLI zoals teruggegeven door tuchtrecht_search.' },
                },
                required: ['identifier'],
            },
        },
    },
];

const ECLI_RE = /^ECLI:[A-Z]{2}:[A-Z]+:\d{4}:\d+$/i;

function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function cqlEscape(s) {
    return '"' + String(s).replace(/"/g, '\\"') + '"';
}

function extractTagText(xml, tag) {
    if (!xml) return null;
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = xml.match(re);
    return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
}

function parseSruRecords(xml) {
    const records = [];
    const recordRe = /<sru:record\b[\s\S]*?<\/sru:record>/gi;
    let rm;
    while ((rm = recordRe.exec(xml)) !== null) {
        const rec = rm[0];
        const identifier = extractTagText(rec, 'dcterms:identifier');
        const title = extractTagText(rec, 'dcterms:title');
        const date = extractTagText(rec, 'overheidwetgeving:uitspraakdatum')
            || extractTagText(rec, 'dcterms:modified');
        const creator = extractTagText(rec, 'dcterms:creator');
        const description = extractTagText(rec, 'dcterms:description');
        const instantieDomein = extractTagText(rec, 'overheidwetgeving:instantieDomein');
        const zaaknummer = extractTagText(rec, 'overheidwetgeving:zaaknummer');
        const beslissing = extractTagText(rec, 'overheidwetgeving:beslissing');
        const subonderwerp = extractTagText(rec, 'overheidwetgeving:subonderwerp');
        const preferredUrl = (rec.match(/<gzd:preferredUrl[^>]*>([^<]+)<\/gzd:preferredUrl>/i) || [, null])[1];
        const xmlUrl = (rec.match(/<gzd:url[^>]*>([^<]+)<\/gzd:url>/i) || [, null])[1];
        records.push({
            identifier,
            title,
            date,
            creator,
            instantieDomein,
            zaaknummer,
            beslissing,
            subonderwerp,
            description,
            preferredUrl,
            xmlUrl,
        });
    }
    return records;
}

async function tuchtrechtSearch(args) {
    const maxResults = clampInt(args.max_results, 1, 25, 10);

    const clauses = ['c.product-area==tuchtrecht'];
    if (args.beroepsgroep && BEROEPSGROEPEN[args.beroepsgroep]) {
        clauses.push(`w.instantieDomein==${cqlEscape(BEROEPSGROEPEN[args.beroepsgroep])}`);
    }
    if (args.query) {
        // Tuchtrecht titles only carry "ECLI <instantie> <datum> <zaaknr>" —
        // the searchable text lives in dt.description (the inhoudsindicatie).
        clauses.push(`dt.description=${cqlEscape(args.query)}`);
    }
    if (args.date_from) clauses.push(`dt.modified>=${args.date_from}`);
    if (args.date_to) clauses.push(`dt.modified<=${args.date_to}`);

    if (clauses.length === 1) {
        return {
            error: 'Geef minstens één filter op: query, beroepsgroep of een datumbereik.',
            hints: { beroepsgroep: Object.keys(BEROEPSGROEPEN) },
        };
    }

    const cql = clauses.join(' AND ');
    const url = `${SRU_BASE}?query=${encodeURIComponent(cql)}&maximumRecords=${maxResults}`;

    let xml;
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/xml', 'User-Agent': 'Bee-Flow-AI/legal-research' },
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            return { error: `Tuchtrecht search failed (${res.status}): ${txt.slice(0, 200)}` };
        }
        xml = await res.text();
    } catch (err) {
        return { error: `Tuchtrecht search error: ${err.message}` };
    }

    const totalMatch = xml.match(/<sru:numberOfRecords>(\d+)<\/sru:numberOfRecords>/i);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : null;

    const diagMessage = (xml.match(/<diag:message[^>]*>([^<]+)<\/diag:message>/i)
        || xml.match(/<ns3:message[^>]*>([^<]+)<\/ns3:message>/i)
        || [, null])[1];
    if (diagMessage && (!total || total === 0)) {
        return { error: `SRU diagnostic: ${diagMessage}`, source: url };
    }

    const results = parseSruRecords(xml);
    return {
        filters: {
            query: args.query || null,
            beroepsgroep: args.beroepsgroep || null,
            date_from: args.date_from || null,
            date_to: args.date_to || null,
        },
        totalMatchingFeed: total,
        count: results.length,
        results,
        source: url,
    };
}

async function tuchtrechtGet(args) {
    const identifier = String(args.identifier || '').trim();
    if (!identifier) return { error: 'identifier is required' };
    if (!ECLI_RE.test(identifier)) {
        return { error: `Invalid ECLI format: ${identifier} (expected e.g. "ECLI:NL:TADRARL:2016:108")` };
    }

    const url = `${SRU_BASE}?query=${encodeURIComponent(`c.product-area==tuchtrecht AND dt.identifier=${cqlEscape(identifier)}`)}&maximumRecords=1`;
    let xml;
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/xml' },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return { error: `SRU lookup failed (${res.status})` };
        xml = await res.text();
    } catch (err) {
        return { error: `SRU lookup error: ${err.message}` };
    }

    const records = parseSruRecords(xml);
    if (records.length === 0) {
        return { error: `No tuchtuitspraak found for ECLI ${identifier}` };
    }
    const meta = records[0];

    let text = '';
    const fetchUrl = meta.xmlUrl;
    if (!fetchUrl) {
        return { ...meta, error: 'No downloadable manifestation listed by SRU' };
    }
    try {
        const res = await fetch(fetchUrl, {
            headers: { 'Accept': 'application/xml, text/html' },
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
            return { ...meta, error: `Content fetch failed (${res.status})`, url: fetchUrl };
        }
        const body = await res.text();
        text = body
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
    } catch (err) {
        return { ...meta, error: `Content fetch error: ${err.message}` };
    }

    const TEXT_CAP = 40000;
    const truncated = text.length > TEXT_CAP;
    if (truncated) text = text.slice(0, TEXT_CAP);

    return {
        ...meta,
        text,
        truncated,
        link: meta.preferredUrl,
    };
}

async function executeTuchtrechtTool(toolName, args) {
    if (toolName === 'tuchtrecht_search') return tuchtrechtSearch(args || {});
    if (toolName === 'tuchtrecht_get') return tuchtrechtGet(args || {});
    return { error: `Unknown tuchtrecht tool: ${toolName}` };
}

function isTuchtrechtTool(toolName) {
    return toolName === 'tuchtrecht_search' || toolName === 'tuchtrecht_get';
}

module.exports = { TUCHTRECHT_TOOLS, executeTuchtrechtTool, isTuchtrechtTool };
