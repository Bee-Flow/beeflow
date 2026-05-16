/**
 * Officiële Bekendmakingen — KOOP SRU search & retrieval
 *
 * Same SRU endpoint as our BWB ingest (repository.overheid.nl/sru), different
 * collection filter:
 *
 *   c.product-area==officielepublicaties
 *   AND w.publicatienaam==<Staatsblad|Staatscourant|Tractatenblad>
 *
 * Used to find:
 *   - Vastgestelde wetten + AMvB's (Staatsblad)
 *   - Ministeriële regelingen, beleidsregels, AP-besluiten, AVV CAOs (Staatscourant)
 *   - Internationale verdragen (Tractatenblad)
 *
 * Anonymous, no API key. Gated by the `dutch_legal_sources` beta feature at
 * the integrationTools layer.
 */

const SRU_BASE = 'https://repository.overheid.nl/sru';

const PUBLICATIES = {
    Staatsblad: 'Staatsblad',
    Staatscourant: 'Staatscourant',
    Tractatenblad: 'Tractatenblad',
};

const BEKENDMAKINGEN_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'bekendmakingen_search',
            description: 'Zoek in de Officiële Bekendmakingen van de Nederlandse overheid: Staatsblad (vastgestelde wetten en AMvB), Staatscourant (ministeriële regelingen, AP-boetebesluiten, AVV-CAO\'s), Tractatenblad (verdragen). Resultaten bevatten identifier (bv. stcrt-2024-1234), titel, datum en een directe link. Roep `bekendmaking_get` aan voor de volledige tekst.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Trefwoord dat in de titel moet voorkomen, bv. "Autoriteit Persoonsgegevens", "transitievergoeding", "boete AVG".' },
                    publicatie: {
                        type: 'string',
                        enum: ['Staatsblad', 'Staatscourant', 'Tractatenblad'],
                        description: 'Welke bekendmakingsreeks. Staatsblad = wetten, Staatscourant = regelingen en besluiten, Tractatenblad = verdragen.',
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
            name: 'bekendmaking_get',
            description: 'Haal de tekst van één bekendmaking op aan de hand van de identifier (bv. "stcrt-2024-1234", "stb-2024-238", "trb-2024-100"). Gebruik dit nadat `bekendmakingen_search` een relevant document heeft opgeleverd.',
            parameters: {
                type: 'object',
                properties: {
                    identifier: { type: 'string', description: 'Identifier zoals teruggegeven door bekendmakingen_search, bv. "stcrt-2024-1234".' },
                },
                required: ['identifier'],
            },
        },
    },
];

const ID_RE = /^(stb|stcrt|trb|ah-tk|kst|h-tk|h-ek|h-vv|nds-tk)-\d{4}-\d+$/i;

function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function cqlEscape(s) {
    // CQL string literal: wrap in double quotes, escape any internal double quotes.
    return '"' + String(s).replace(/"/g, '\\"') + '"';
}

function extractTagText(xml, tag) {
    if (!xml) return null;
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = xml.match(re);
    return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
}

function extractAllTagText(xml, tag) {
    if (!xml) return [];
    const out = [];
    const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let m;
    while ((m = re.exec(xml)) !== null) {
        const t = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (t) out.push(t);
    }
    return out;
}

function parseSruRecords(xml) {
    const records = [];
    const recordRe = /<sru:record\b[\s\S]*?<\/sru:record>/gi;
    let rm;
    while ((rm = recordRe.exec(xml)) !== null) {
        const rec = rm[0];
        const identifier = extractTagText(rec, 'dcterms:identifier');
        const title = extractTagText(rec, 'dcterms:title');
        const date = extractTagText(rec, 'dcterms:date') || extractTagText(rec, 'dcterms:modified');
        const creator = extractTagText(rec, 'dcterms:creator');
        const publicatienaam = extractTagText(rec, 'overheidwetgeving:publicatienaam');
        const publicatienummer = extractTagText(rec, 'overheidwetgeving:publicatienummer');
        const types = extractAllTagText(rec, 'dcterms:type');
        const preferredUrl = (rec.match(/<gzd:preferredUrl[^>]*>([^<]+)<\/gzd:preferredUrl>/i) || [, null])[1];
        const xmlUrl = (rec.match(/<gzd:url[^>]*>([^<]+)<\/gzd:url>/i) || [, null])[1];
        const htmlItemMatch = rec.match(/<gzd:itemUrl manifestation="html"[^>]*>([^<]+)<\/gzd:itemUrl>/i);
        const htmlUrl = htmlItemMatch ? htmlItemMatch[1] : null;
        records.push({
            identifier,
            title,
            date,
            creator,
            publicatienaam,
            publicatienummer,
            type: types[0] || null,
            preferredUrl,
            xmlUrl,
            htmlUrl,
        });
    }
    return records;
}

async function bekendmakingenSearch(args) {
    const maxResults = clampInt(args.max_results, 1, 25, 10);

    const clauses = ['c.product-area==officielepublicaties'];
    if (args.publicatie && PUBLICATIES[args.publicatie]) {
        clauses.push(`w.publicatienaam==${cqlEscape(PUBLICATIES[args.publicatie])}`);
    }
    if (args.query) {
        clauses.push(`dt.title=${cqlEscape(args.query)}`);
    }
    if (args.date_from) {
        clauses.push(`dt.modified>=${args.date_from}`);
    }
    if (args.date_to) {
        clauses.push(`dt.modified<=${args.date_to}`);
    }

    // Need at least one filter beyond product-area, otherwise the result set
    // is millions of records and the SRU server returns an error.
    if (clauses.length === 1) {
        return {
            error: 'Geef minstens één filter op: query, publicatie of een datumbereik.',
            hints: { publicatie: Object.keys(PUBLICATIES) },
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
            return { error: `Bekendmakingen search failed (${res.status}): ${txt.slice(0, 200)}` };
        }
        xml = await res.text();
    } catch (err) {
        return { error: `Bekendmakingen search error: ${err.message}` };
    }

    const totalMatch = xml.match(/<sru:numberOfRecords>(\d+)<\/sru:numberOfRecords>/i);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : null;

    // Surface SRU diagnostic messages (invalid index, etc.) to the model.
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
            publicatie: args.publicatie || null,
            date_from: args.date_from || null,
            date_to: args.date_to || null,
        },
        totalMatchingFeed: total,
        count: results.length,
        results,
        source: url,
    };
}

async function bekendmakingGet(args) {
    const identifier = String(args.identifier || '').trim().toLowerCase();
    if (!identifier) return { error: 'identifier is required' };
    if (!ID_RE.test(identifier)) {
        return { error: `Invalid identifier format: ${identifier} (expected e.g. "stcrt-2024-1234")` };
    }

    // Re-use the SRU search to retrieve the single matching record, then
    // download its HTML manifestation and strip the markup. The repository's
    // FRBR /html/ endpoint is a static, predictable URL but pulling via SRU
    // gives us the metadata in one call.
    const url = `${SRU_BASE}?query=${encodeURIComponent(`c.product-area==officielepublicaties AND dt.identifier=${cqlEscape(identifier)}`)}&maximumRecords=1`;
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
        return { error: `No bekendmaking found for identifier ${identifier}` };
    }
    const meta = records[0];

    // Fetch the HTML manifestation and strip tags. If unavailable, try the XML.
    let text = '';
    const fetchUrl = meta.htmlUrl || meta.xmlUrl;
    if (!fetchUrl) {
        return { ...meta, error: 'No downloadable manifestation listed by SRU' };
    }
    try {
        const res = await fetch(fetchUrl, {
            headers: { 'Accept': 'text/html, application/xml' },
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
        link: meta.preferredUrl || meta.htmlUrl,
    };
}

async function executeBekendmakingenTool(toolName, args) {
    if (toolName === 'bekendmakingen_search') return bekendmakingenSearch(args || {});
    if (toolName === 'bekendmaking_get') return bekendmakingGet(args || {});
    return { error: `Unknown bekendmakingen tool: ${toolName}` };
}

function isBekendmakingenTool(toolName) {
    return toolName === 'bekendmakingen_search' || toolName === 'bekendmaking_get';
}

module.exports = { BEKENDMAKINGEN_TOOLS, executeBekendmakingenTool, isBekendmakingenTool };
