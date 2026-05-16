/**
 * EUR-Lex — EU law and CJEU case law search (Dutch language preference)
 *
 * Uses EUR-Lex's "Cellar" SPARQL-driven REST search endpoint. Anonymous and
 * free. Returns CELEX identifiers (e.g. `32016R0679` = AVG / GDPR;
 * `62019CJ0311` = CJEU Schrems II); the get-tool resolves a CELEX to an
 * HTML rendering of the document.
 *
 * Gated by the `dutch_legal_sources` beta feature in integrationTools.
 */

const SEARCH_URL = 'https://eur-lex.europa.eu/search.html';
const CELLAR_API = 'https://publications.europa.eu/webapi/rdf/sparql';
const HTML_URL = (celex, lang = 'NL') => `https://eur-lex.europa.eu/legal-content/${lang}/TXT/?uri=CELEX:${encodeURIComponent(celex)}`;

const EURLEX_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'eurlex_search',
            description: 'Zoek EU-recht en HvJEU-arresten in EUR-Lex (Nederlandse taalvoorkeur). Bruikbaar voor verordeningen (zoals de AVG), richtlijnen, en uitspraken van het Hof van Justitie van de EU. Geeft CELEX-identifiers, titel, type document en publicatiedatum.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Zoekterm of trefwoord, bv. "general data protection regulation", "schrems II", "arbeidstijdenrichtlijn".' },
                    doc_type: {
                        type: 'string',
                        enum: ['regulation', 'directive', 'decision', 'case_law', 'all'],
                        description: 'Beperk tot een documenttype: "regulation" (verordening), "directive" (richtlijn), "decision" (besluit), "case_law" (jurisprudentie HvJEU), of "all" (standaard).',
                    },
                    max_results: { type: 'integer', description: 'Aantal resultaten (1-20, standaard 8).' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'eurlex_get',
            description: 'Haal de tekst van één EU-rechtsbron op aan de hand van het CELEX-nummer (bv. "32016R0679" voor de AVG, of "62019CJ0311" voor een HvJEU-arrest). Standaard wordt de Nederlandse versie opgevraagd.',
            parameters: {
                type: 'object',
                properties: {
                    celex: { type: 'string', description: 'CELEX-identifier, bv. "32016R0679".' },
                    language: { type: 'string', description: 'ISO-639-1-code (twee letters), standaard "NL". Bv. "EN" voor Engels.' },
                },
                required: ['celex'],
            },
        },
    },
];

const CELEX_RE = /^[0-9][A-Z0-9]+$/i;

function clampInt(v, min, max, fallback) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

// Map our doc_type enum onto EUR-Lex resource-type URIs (cdm:work_has_resource-type).
const DOC_TYPE_URIS = {
    regulation: 'http://publications.europa.eu/resource/authority/resource-type/REG',
    directive: 'http://publications.europa.eu/resource/authority/resource-type/DIR',
    decision: 'http://publications.europa.eu/resource/authority/resource-type/DEC',
    case_law: 'http://publications.europa.eu/resource/authority/resource-type/JUDG',
};

function buildSparql(query, docType, maxResults) {
    const safe = query.replace(/[\\"]/g, '');
    const typeFilter = docType && DOC_TYPE_URIS[docType]
        ? `?work cdm:work_has_resource-type <${DOC_TYPE_URIS[docType]}> .`
        : '';
    return `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT DISTINCT ?celex ?title ?date ?type WHERE {
  ?work cdm:work_id_document ?celexLit ;
        cdm:work_date_document ?date .
  BIND(STR(?celexLit) AS ?celex)
  ${typeFilter}
  ?expr cdm:expression_belongs_to_work ?work ;
        cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/NLD> ;
        cdm:expression_title ?title .
  FILTER(CONTAINS(LCASE(STR(?title)), LCASE("${safe}")))
  OPTIONAL { ?work cdm:work_has_resource-type ?type . }
} ORDER BY DESC(?date) LIMIT ${maxResults}`.trim();
}

async function eurlexSearch(args) {
    const query = String(args.query || '').trim();
    if (!query) return { error: 'query is required' };
    const maxResults = clampInt(args.max_results, 1, 20, 8);
    const docType = args.doc_type && DOC_TYPE_URIS[args.doc_type] ? args.doc_type : 'all';

    const sparql = buildSparql(query, docType === 'all' ? null : docType, maxResults);
    const url = `${CELLAR_API}?query=${encodeURIComponent(sparql)}&format=application%2Fsparql-results%2Bjson`;

    let data;
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/sparql-results+json' },
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            return { error: `EUR-Lex search failed (${res.status}): ${txt.slice(0, 200)}` };
        }
        data = await res.json();
    } catch (err) {
        return { error: `EUR-Lex search error: ${err.message}` };
    }

    const bindings = data?.results?.bindings || [];
    const results = bindings.map(b => {
        const celex = b.celex?.value || null;
        const title = b.title?.value || null;
        const date = b.date?.value || null;
        return {
            celex,
            title,
            date,
            type: b.type?.value?.split('/').pop() || null,
            link: celex ? HTML_URL(celex, 'NL') : null,
        };
    }).filter(r => r.celex);

    return { query, doc_type: docType, count: results.length, results };
}

async function eurlexGet(args) {
    const celex = String(args.celex || '').trim();
    if (!celex) return { error: 'celex is required' };
    if (!CELEX_RE.test(celex)) return { error: `Invalid CELEX format: ${celex}` };
    const language = String(args.language || 'NL').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(language)) return { error: `Invalid language code: ${language}` };

    const url = HTML_URL(celex, language);
    let html;
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'text/html', 'User-Agent': 'Bee-Flow-AI/legal-research' },
            signal: AbortSignal.timeout(15000),
            redirect: 'follow',
        });
        if (!res.ok) {
            return { error: `EUR-Lex fetch failed (${res.status})` };
        }
        html = await res.text();
    } catch (err) {
        return { error: `EUR-Lex fetch error: ${err.message}` };
    }

    // Pull the main <div id="document1"> or the first <p>-rich block. Fall back
    // to all <p> tags when the structure isn't there (EUR-Lex layouts vary by
    // document type).
    let bodyHtml = '';
    const main = html.match(/<div[^>]+id=["']document1["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/main>/i)
        || html.match(/<div[^>]+class=["'][^"']*eli-main-title[^"']*["'][\s\S]*?<\/div>([\s\S]*?)<footer/i)
        || html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (main) bodyHtml = main[1];

    let text = bodyHtml
        ? bodyHtml.replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/\s+/g, ' ')
            .trim()
        : '';

    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s*-\s*EUR-Lex\s*$/i, '').trim() : null;

    const TEXT_CAP = 40000;
    const truncated = text.length > TEXT_CAP;
    text = truncated ? text.slice(0, TEXT_CAP) : text;

    return {
        celex,
        language,
        title,
        text,
        truncated,
        link: url,
    };
}

async function executeEurlexTool(toolName, args) {
    if (toolName === 'eurlex_search') return eurlexSearch(args || {});
    if (toolName === 'eurlex_get') return eurlexGet(args || {});
    return { error: `Unknown EUR-Lex tool: ${toolName}` };
}

function isEurlexTool(toolName) {
    return toolName === 'eurlex_search' || toolName === 'eurlex_get';
}

module.exports = { EURLEX_TOOLS, executeEurlexTool, isEurlexTool };
