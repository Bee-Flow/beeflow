/**
 * Rechtspraak.nl — Dutch case law search & retrieval
 *
 * The public JSON keyword endpoint behind uitspraken.rechtspraak.nl is now
 * blocked against scraping. The only stable public contract is the
 * Raad-voor-de-Rechtspraak Open Data feed at data.rechtspraak.nl, which is
 * **metadata-driven**, not free-text:
 *
 *   - Search feed : https://data.rechtspraak.nl/uitspraken/zoeken
 *                    Atom XML. Query params: subject= (controlled-vocabulary
 *                    URI from psi.rechtspraak.nl), creator= (instantie URI),
 *                    type=Uitspraak|Conclusie, date= (single date or range,
 *                    repeated), from=YYYY-MM-DD&to=YYYY-MM-DD bounds on
 *                    dcterms:modified, max= page size, return=DOC for
 *                    published-with-text only.
 *   - ECLI item   : https://data.rechtspraak.nl/uitspraken/content?id=<ECLI>
 *                    Full XML body + metadata (inhoudsindicatie, body).
 *
 * Strategy: list candidate ECLIs by rechtsgebied + instantie + date window,
 * then enrich the top N with their `inhoudsindicatie` so the agent can decide
 * which ones to read in full via `rechtspraak_get`.
 *
 * Anonymous, no API key — gated only by the `dutch_legal_sources` beta feature
 * at the integrationTools layer.
 */

const SEARCH_URL = 'https://data.rechtspraak.nl/uitspraken/zoeken';
const CONTENT_URL = 'https://data.rechtspraak.nl/uitspraken/content';

// Curated mapping of common rechtsgebied keywords → the controlled-vocabulary
// URIs that the open-data feed accepts. The full taxonomy is huge; this
// covers the practice areas the lawyer-drafting agent typically touches.
const RECHTSGEBIED_URIS = {
    civiel: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht',
    'civiel-personen-familie': 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_personenEnFamilierecht',
    arbeidsrecht: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_arbeidsrecht',
    ondernemingsrecht: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_ondernemingsrecht',
    insolventierecht: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_insolventierecht',
    huurrecht: 'http://psi.rechtspraak.nl/rechtsgebied#civielRecht_verbintenissenrecht',
    bestuursrecht: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht',
    belastingrecht: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_belastingrecht',
    socialezekerheidsrecht: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_socialezekerheidsrecht',
    vreemdelingenrecht: 'http://psi.rechtspraak.nl/rechtsgebied#bestuursrecht_vreemdelingenrecht',
    strafrecht: 'http://psi.rechtspraak.nl/rechtsgebied#strafrecht',
    europees: 'http://psi.rechtspraak.nl/rechtsgebied#europeesRecht',
};

const INSTANTIE_URIS = {
    'Hoge Raad': 'http://standaarden.overheid.nl/owms/terms/Hoge_Raad_der_Nederlanden',
    'Raad van State': 'http://standaarden.overheid.nl/owms/terms/Raad_van_State',
    'Centrale Raad van Beroep': 'http://standaarden.overheid.nl/owms/terms/Centrale_Raad_van_Beroep',
    'College van Beroep voor het bedrijfsleven': 'http://standaarden.overheid.nl/owms/terms/College_van_Beroep_voor_het_bedrijfsleven',
    'Gerechtshof Amsterdam': 'http://standaarden.overheid.nl/owms/terms/Gerechtshof_Amsterdam',
    'Gerechtshof Den Haag': 'http://standaarden.overheid.nl/owms/terms/Gerechtshof_Den_Haag',
    'Gerechtshof Arnhem-Leeuwarden': 'http://standaarden.overheid.nl/owms/terms/Gerechtshof_Arnhem-Leeuwarden',
    'Gerechtshof \'s-Hertogenbosch': 'http://standaarden.overheid.nl/owms/terms/Gerechtshof_\'s-Hertogenbosch',
};

function resolveRechtsgebied(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (/^https?:\/\//.test(s)) return s;
    const key = s.toLowerCase().replace(/[\s_]+/g, '-');
    return RECHTSGEBIED_URIS[key] || null;
}

function resolveInstantie(input) {
    if (!input) return null;
    const s = String(input).trim();
    if (/^https?:\/\//.test(s)) return s;
    return INSTANTIE_URIS[s] || null;
}

const RECHTSGEBIED_KEYS = Object.keys(RECHTSGEBIED_URIS);
const INSTANTIE_KEYS = Object.keys(INSTANTIE_URIS);

const RECHTSPRAAK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'rechtspraak_search',
            description: `Zoek Nederlandse jurisprudentie via rechtspraak.nl Open Data. **Belangrijk**: dit is een metadata-filter (rechtsgebied + instantie + datumbereik), GEEN vrije-tekst-zoekopdracht. Geef minstens één van rechtsgebied of instantie op, plus bij voorkeur een datumbereik (from/to). Resultaten bevatten ECLI, instantie, datum en (voor de top-N) de \`inhoudsindicatie\` (gerechtelijke samenvatting). Filter de resultaten daarna op trefwoord in de inhoudsindicatie en roep \`rechtspraak_get\` aan voor de volledige tekst.`,
            parameters: {
                type: 'object',
                properties: {
                    rechtsgebied: {
                        type: 'string',
                        enum: RECHTSGEBIED_KEYS,
                        description: `Praktijkgebied. Kies één van: ${RECHTSGEBIED_KEYS.join(', ')}. Voor familierecht (echtscheiding/alimentatie/gezag) gebruik "civiel-personen-familie".`,
                    },
                    instantie: {
                        type: 'string',
                        enum: INSTANTIE_KEYS,
                        description: `Beperk tot één instantie (optioneel maar aanbevolen voor relevantie). Een van: ${INSTANTIE_KEYS.join(', ')}.`,
                    },
                    from: { type: 'string', description: 'Begindatum YYYY-MM-DD — filtert op registratiedatum (dcterms:modified).' },
                    to: { type: 'string', description: 'Einddatum YYYY-MM-DD — filtert op registratiedatum (dcterms:modified).' },
                    max_results: { type: 'integer', description: 'Aantal resultaten (1-25, standaard 10).' },
                    enrich: { type: 'boolean', description: 'Inhoudsindicatie ophalen voor elke hit (standaard true). Zet uit als je alleen ECLIs nodig hebt voor batch-werk.' },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'rechtspraak_get',
            description: 'Haal de volledige tekst van één uitspraak op aan de hand van het ECLI-nummer (bv. ECLI:NL:HR:2024:1234). Gebruik dit nadat `rechtspraak_search` een relevante ECLI heeft opgeleverd.',
            parameters: {
                type: 'object',
                properties: {
                    ecli: { type: 'string', description: 'Volledig ECLI-identifier, bv. "ECLI:NL:HR:2024:1234".' },
                },
                required: ['ecli'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'format_citation',
            description: 'Zet een losse jurisprudentie-verwijzing om naar een canoniek ECLI. Gebruik dit als de gebruiker een citaat als "HR 17 mei 2024, 23/02169" of "hof Amsterdam 2023, 200.123.456" opgeeft — verzin nooit zelf een ECLI, laat deze tool de juiste ophalen. De tool herkent instantie-afkortingen (HR, RvS, CRvB, CBb, hof Amsterdam/Den Haag/Arnhem-Leeuwarden/Den Bosch) plus jaar en optioneel een exacte datum + zaaknummer, en zoekt het canonieke ECLI bij rechtspraak.nl.',
            parameters: {
                type: 'object',
                properties: {
                    citation: { type: 'string', description: 'Losse citatie zoals de gebruiker hem aanlevert, bv. "HR 17 mei 2024, 23/02169" of "hof Amsterdam 2023, 200.123.456".' },
                },
                required: ['citation'],
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

function parseAtomEntries(xml) {
    if (!xml) return [];
    const entries = [];
    const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
    let m;
    while ((m = entryRe.exec(xml)) !== null) {
        const inner = m[1];
        const get = (tag) => {
            const r = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(inner);
            return r ? r[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
        };
        const linkMatch = /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(inner);
        entries.push({
            id: get('id'),
            title: get('title'),
            updated: get('updated'),
            summary: get('summary'),
            link: linkMatch ? linkMatch[1] : null,
        });
    }
    return entries;
}

function ecliFromAtomId(id) {
    if (!id) return null;
    // Atom ids look like "ECLI:NL:HR:2024:1234" or "https://.../id/ECLI:..."
    const m = /(ECLI:[A-Z]{2}:[A-Z]+:\d{4}:\d+)/i.exec(id);
    return m ? m[1] : null;
}

async function rechtspraakSearch(args) {
    const maxResults = clampInt(args.max_results, 1, 25, 10);
    const enrich = args.enrich !== false;

    const subjectUri = resolveRechtsgebied(args.rechtsgebied);
    const creatorUri = resolveInstantie(args.instantie);

    if (!subjectUri && !creatorUri && !args.from && !args.to) {
        return {
            error: 'Geef minstens één filter op: rechtsgebied, instantie of een datumbereik (from/to). De rechtspraak-feed is metadata-gebaseerd, geen vrije-tekstzoekmachine.',
            hints: {
                rechtsgebied: RECHTSGEBIED_KEYS,
                instantie: INSTANTIE_KEYS,
            },
        };
    }

    const qs = new URLSearchParams();
    qs.set('max', String(maxResults));
    qs.set('return', 'DOC');
    qs.set('type', 'Uitspraak');
    if (subjectUri) qs.set('subject', subjectUri);
    if (creatorUri) qs.set('creator', creatorUri);
    // The feed expects repeated `date=YYYY-MM-DD` params for a range — first
    // is the from-bound, second is the to-bound (inclusive on both sides).
    if (args.from) qs.append('date', String(args.from));
    if (args.to) qs.append('date', String(args.to));

    const url = `${SEARCH_URL}?${qs.toString()}`;
    let xml;
    try {
        const res = await fetch(url, {
            headers: {
                'Accept': 'application/atom+xml, application/xml, text/xml',
                'User-Agent': 'Bee-Flow-AI/legal-research',
            },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            return { error: `Rechtspraak search failed (${res.status}): ${txt.slice(0, 200)}` };
        }
        xml = await res.text();
    } catch (err) {
        return { error: `Rechtspraak search error: ${err.message}` };
    }

    const totalMatch = /<subtitle[^>]*>[^<]*?Aantal gevonden ECLI's:\s*(\d+)/i.exec(xml);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : null;

    const entries = parseAtomEntries(xml);
    let results = entries.slice(0, maxResults).map(e => {
        const ecli = ecliFromAtomId(e.id);
        // Atom summaries often carry the inhoudsindicatie inline already.
        // Treat "-" (the feed's placeholder for "no summary published") as null.
        const inlineSummary = (e.summary && e.summary.trim() && e.summary.trim() !== '-')
            ? e.summary.trim() : null;
        return {
            ecli,
            title: e.title,
            date: e.updated,
            inhoudsindicatie: inlineSummary,
            link: ecli ? `https://uitspraken.rechtspraak.nl/details?id=${encodeURIComponent(ecli)}` : e.link,
        };
    }).filter(r => r.ecli);

    // Backfill inhoudsindicatie via the content endpoint for hits where the
    // Atom summary was missing/empty. Skipped when enrich=false (batch use).
    if (enrich && results.length > 0) {
        const needs = results.map((r, i) => (r.inhoudsindicatie ? null : i)).filter(i => i !== null);
        if (needs.length > 0) {
            const filled = await Promise.all(needs.map(i => fetchInhoudsindicatie(results[i].ecli).catch(() => null)));
            needs.forEach((i, k) => { if (filled[k]) results[i].inhoudsindicatie = filled[k]; });
        }
    }

    return {
        filters: {
            rechtsgebied: args.rechtsgebied || null,
            instantie: args.instantie || null,
            from: args.from || null,
            to: args.to || null,
        },
        totalMatchingFeed: total,
        count: results.length,
        results,
        source: url,
        note: 'Resultaten zijn een metadata-listing. Filter op trefwoord in `inhoudsindicatie` en roep `rechtspraak_get` aan voor de volledige uitspraaktekst.',
    };
}

async function fetchInhoudsindicatie(ecli) {
    if (!ecli || !ECLI_RE.test(ecli)) return null;
    try {
        const res = await fetch(`${CONTENT_URL}?id=${encodeURIComponent(ecli)}`, {
            headers: { 'Accept': 'application/xml,text/xml,*/*' },
            signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) return null;
        const xml = await res.text();
        return extractXmlText(xml, 'inhoudsindicatie');
    } catch (_) {
        return null;
    }
}

function extractXmlText(xml, tag) {
    if (!xml) return null;
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
    const m = xml.match(re);
    if (!m) return null;
    return m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function rechtspraakGet(args) {
    const ecli = String(args.ecli || '').trim();
    if (!ecli) return { error: 'ecli is required' };
    if (!ECLI_RE.test(ecli)) return { error: `Invalid ECLI format: ${ecli}` };

    const url = `${CONTENT_URL}?id=${encodeURIComponent(ecli)}`;
    let xml;
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/xml,text/xml,*/*' },
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
            return { error: `Rechtspraak fetch failed (${res.status})` };
        }
        xml = await res.text();
    } catch (err) {
        return { error: `Rechtspraak fetch error: ${err.message}` };
    }

    // The content endpoint returns LIDO/RDF-XML for metadata + an <uitspraak> body.
    // We strip tags inside <uitspraak> to give the model clean Dutch prose; the
    // metadata fields are pulled separately to surface the ECLI, datum, instantie.
    const body = (xml.match(/<uitspraak[\s\S]*?>([\s\S]*?)<\/uitspraak>/i)
        || xml.match(/<conclusie[\s\S]*?>([\s\S]*?)<\/conclusie>/i)
        || [, ''])[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const title = extractXmlText(xml, 'dcterms:title') || extractXmlText(xml, 'title');
    const date = extractXmlText(xml, 'dcterms:date');
    const instantie = extractXmlText(xml, 'dcterms:creator');
    const inhoudsindicatie = extractXmlText(xml, 'inhoudsindicatie');

    // 30k char cap — full HR arresten run long and would blow the agent's
    // context. The model can always re-call with a sharper query if truncated.
    const TEXT_CAP = 30000;
    const truncated = body.length > TEXT_CAP;
    const text = truncated ? body.slice(0, TEXT_CAP) : body;

    return {
        ecli,
        title,
        date,
        instantie,
        inhoudsindicatie,
        text,
        truncated,
        link: `https://uitspraken.rechtspraak.nl/details?id=${encodeURIComponent(ecli)}`,
    };
}

// ─── format_citation — loose input → canonical ECLI ──────────────
//
// The Atom feed entry titles are formatted as:
//   "<ECLI>, <Instantie>, <DD-MM-YYYY>, <zaaknummer>"
// We exploit that: parse loose input → query the feed with creator + date
// (single day if date known, else the full year) → match the entry whose
// title contains the same zaaknummer → return that ECLI. No new endpoint
// needed.

// Court keyword → INSTANTIE_URIS key. Order matters: longer phrases first
// (so "Hoge Raad" wins over "Raad").
const COURT_HINTS = [
    [/\bhoge\s*raad\b|^\s*hr\b|\bH\.?R\.?\b/i, 'Hoge Raad'],
    [/\bcentrale\s*raad\s*van\s*beroep\b|\bCRv?B\b/i, 'Centrale Raad van Beroep'],
    [/\bcollege\s*van\s*beroep\s*voor\s*het\s*bedrijfsleven\b|\bCBb\b/i, 'College van Beroep voor het bedrijfsleven'],
    [/\braad\s*van\s*state\b|\bRvS\b|\bAB?RvS\b/i, 'Raad van State'],
    [/\bhof\s+amsterdam\b|gerechtshof\s+amsterdam/i, 'Gerechtshof Amsterdam'],
    [/\bhof\s+(?:'s[-\s]*)?gravenhage\b|hof\s+den\s+haag|gerechtshof\s+den\s+haag/i, 'Gerechtshof Den Haag'],
    [/\bhof\s+arnhem(?:[-\s]+leeuwarden)?\b|gerechtshof\s+arnhem/i, 'Gerechtshof Arnhem-Leeuwarden'],
    [/\bhof\s+(?:'s[-\s]*)?(?:hertogenbosch|den\s*bosch)\b|gerechtshof\s+'s[-\s]*hertogenbosch/i, 'Gerechtshof \'s-Hertogenbosch'],
];

const NL_MONTHS = {
    jan: 1, januari: 1,
    feb: 2, februari: 2,
    mrt: 3, maart: 3,
    apr: 4, april: 4,
    mei: 5,
    jun: 6, juni: 6,
    jul: 7, juli: 7,
    aug: 8, augustus: 8,
    sep: 9, september: 9,
    okt: 10, oktober: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
};

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }

function parseCitation(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;

    let instantie = null;
    for (const [re, key] of COURT_HINTS) {
        if (re.test(s)) { instantie = key; break; }
    }

    // Day-month-year ("17 mei 2024" / "17-05-2024" / "17/05/2024")
    let date = null, year = null;
    let m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(s);
    if (m && NL_MONTHS[m[2].toLowerCase()]) {
        const d = parseInt(m[1], 10);
        const mo = NL_MONTHS[m[2].toLowerCase()];
        const y = parseInt(m[3], 10);
        date = `${y}-${pad2(mo)}-${pad2(d)}`;
        year = y;
    } else if ((m = /(\d{1,2})[-./](\d{1,2})[-./](\d{4})/.exec(s))) {
        date = `${m[3]}-${pad2(parseInt(m[2], 10))}-${pad2(parseInt(m[1], 10))}`;
        year = parseInt(m[3], 10);
    } else if ((m = /\b(19|20)\d{2}\b/.exec(s))) {
        year = parseInt(m[0], 10);
    }

    // Zaaknummer formats: 23/02169, 12-345, 200.123.456, C/13/12345/HA-ZA-22-123
    let zaaknummer = null;
    const zaakPatterns = [
        /\b\d{2}\/\d{4,6}\b/,
        /\b\d{3}\.\d{3}\.\d{3}\b/,
        /\bC\/\d{2}\/\d+(?:\/[A-Z]+-?[A-Z]*-?\d*-?\d*)?\b/,
        /\b\d{2,4}-\d{2,5}\b/,
    ];
    for (const re of zaakPatterns) {
        const zm = re.exec(s);
        if (zm) { zaaknummer = zm[0]; break; }
    }

    if (!instantie && !zaaknummer && !date) return null;
    return { instantie, date, year, zaaknummer, raw: s };
}

function normalizeZaaknr(z) {
    return String(z || '').replace(/\s+/g, '').toLowerCase();
}

async function formatCitation(args) {
    const parsed = parseCitation(args.citation);
    if (!parsed) {
        return { ok: false, reason: 'could_not_parse', citation: args.citation };
    }

    if (!parsed.instantie || (!parsed.year && !parsed.date)) {
        return {
            ok: false,
            reason: 'missing_required_fields',
            parsed,
            hint: 'Geef minimaal de instantie + het jaar mee (en bij voorkeur de uitspraakdatum + het zaaknummer).',
        };
    }

    const creatorUri = INSTANTIE_URIS[parsed.instantie];
    if (!creatorUri) {
        return { ok: false, reason: 'unknown_instantie', parsed };
    }

    // Date window: single day if we have the date, else full year.
    const from = parsed.date || `${parsed.year}-01-01`;
    const to = parsed.date || `${parsed.year}-12-31`;

    // The Atom feed paginates at max=1000 — for a single HR-day that's plenty;
    // for a full year × one court it may not fit (HR ~1000/yr, hoven 5000+/yr).
    // We cap at 1000 and fall back to "narrow your date" guidance.
    const qs = new URLSearchParams();
    qs.set('max', '1000');
    qs.set('return', 'DOC');
    qs.set('type', 'Uitspraak');
    qs.set('creator', creatorUri);
    qs.append('date', from);
    qs.append('date', to);
    const url = `${SEARCH_URL}?${qs.toString()}`;

    let xml;
    try {
        const res = await fetch(url, {
            headers: { 'Accept': 'application/atom+xml', 'User-Agent': 'Bee-Flow-AI/legal-research' },
            signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) {
            return { ok: false, reason: 'upstream_error', status: res.status, parsed };
        }
        xml = await res.text();
    } catch (err) {
        return { ok: false, reason: 'fetch_error', message: err.message, parsed };
    }

    const entries = parseAtomEntries(xml);
    if (entries.length === 0) {
        return { ok: false, reason: 'not_found', parsed, hint: 'Geen uitspraken van deze instantie in het opgegeven datumbereik.' };
    }

    // Each title looks like "ECLI:NL:HR:2024:719, Hoge Raad, 17-05-2024, 23/02169".
    // Extract ECLI + zaaknummer per entry and match.
    const candidates = entries.map(e => {
        const ecli = ecliFromAtomId(e.id) || (e.title ? (e.title.match(/ECLI:[A-Z]{2}:[A-Z]+:\d{4}:\d+/i) || [null])[0] : null);
        const fields = (e.title || '').split(',').map(p => p.trim());
        const zaak = fields.length >= 4 ? fields[fields.length - 1] : null;
        const datum = fields.length >= 3 ? fields[fields.length - 2] : null;
        return { ecli, title: e.title, zaak, datum };
    }).filter(c => c.ecli);

    if (parsed.zaaknummer) {
        const want = normalizeZaaknr(parsed.zaaknummer);
        const hits = candidates.filter(c => normalizeZaaknr(c.zaak) === want);
        if (hits.length === 1) {
            return {
                ok: true,
                ecli: hits[0].ecli,
                title: hits[0].title,
                url: `https://uitspraken.rechtspraak.nl/details?id=${encodeURIComponent(hits[0].ecli)}`,
                confidence: 'high',
                parsed,
            };
        }
        if (hits.length > 1) {
            return {
                ok: true,
                ecli: hits[0].ecli,
                title: hits[0].title,
                url: `https://uitspraken.rechtspraak.nl/details?id=${encodeURIComponent(hits[0].ecli)}`,
                confidence: 'medium',
                alternatives: hits.slice(1, 5).map(h => ({ ecli: h.ecli, title: h.title })),
                parsed,
                note: 'Meerdere uitspraken op dit zaaknummer; top-hit teruggegeven, alternatieven in alternatives.',
            };
        }
        // Zaaknummer requested but no match in the window.
        return {
            ok: false,
            reason: 'zaaknummer_not_found',
            parsed,
            checked: candidates.length,
            hint: parsed.date
                ? 'Controleer of de datum of het zaaknummer klopt — geen ECLI gevonden in het feed voor deze combinatie.'
                : 'Geef de exacte uitspraakdatum mee om de zoekruimte te verkleinen.',
        };
    }

    // No zaaknummer: return the first hit but mark confidence low so the
    // agent knows it must verify before quoting.
    return {
        ok: true,
        ecli: candidates[0].ecli,
        title: candidates[0].title,
        url: `https://uitspraken.rechtspraak.nl/details?id=${encodeURIComponent(candidates[0].ecli)}`,
        confidence: 'low',
        alternatives: candidates.slice(1, 5).map(h => ({ ecli: h.ecli, title: h.title })),
        parsed,
        note: 'Geen zaaknummer in de input — neem de top-hit niet over zonder verificatie. Vraag de gebruiker om een datum en/of zaaknummer.',
    };
}

async function executeRechtspraakTool(toolName, args) {
    if (toolName === 'rechtspraak_search') return rechtspraakSearch(args || {});
    if (toolName === 'rechtspraak_get') return rechtspraakGet(args || {});
    if (toolName === 'format_citation') return formatCitation(args || {});
    return { error: `Unknown rechtspraak tool: ${toolName}` };
}

function isRechtspraakTool(toolName) {
    return toolName === 'rechtspraak_search'
        || toolName === 'rechtspraak_get'
        || toolName === 'format_citation';
}

module.exports = { RECHTSPRAAK_TOOLS, executeRechtspraakTool, isRechtspraakTool };
