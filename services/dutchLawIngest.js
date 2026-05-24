/**
 * Dutch Law Ingest Service
 *
 * Seeds and refreshes the "Nederlandse juridische bronnen" system KB by
 * fetching consolidated statutes from KOOP / wetten.overheid.nl and
 * converting them to article-chunked Markdown.
 *
 * Three entry points:
 *   - seedIfMissing()  — called on server boot; runs only if the KB doesn't
 *                        exist yet or contains no documents. Always async.
 *   - refresh(force)   — admin-triggered re-ingest. Async; status is held
 *                        in-process via getStatus() so the admin UI can
 *                        poll for progress.
 *   - seedAll(force)   — synchronous full run; used by the CLI shim and by
 *                        refresh() under the hood. Returns a summary.
 *
 * All paths are idempotent — content_hash check skips unchanged statutes,
 * source_uri-based purge handles re-ingest after edits.
 */

const kbStore = require('../stores/knowledgeBases');
const { ingestDocument, deleteDocumentChunks } = require('../core/kbIngestionHelpers');

const SYSTEM_TENANT_ID = 'system';
const SYSTEM_SLUG = 'dutch_legal_sources';
const KB_NAME = 'Nederlandse juridische bronnen';
const KB_DESCRIPTION = 'Geconsolideerde Nederlandse wetgeving — alle wetboeken (BW, Sr, Sv, Rv, Wvk, Awb), kaderwetten en uitvoeringswetten — als één systeem-KB. Beheerd door Bee Flow; alleen-lezen voor organisaties. Activeer via beta-feature "Dutch Legal Sources". Aanvullen: voeg een BWB-id toe aan STATUTES in server/services/dutchLawIngest.js en herstart, of trigger een refresh vanuit het admin-paneel.';

// Curated catalogue. BWB-ids are stable identifiers used by KOOP. Each entry
// becomes one `documents` row; the article-level structure is preserved
// inside the Markdown body so the hybrid retrieval can surface a single
// artikel. ingestOne is fail-tolerant — if a BWB-id is missing from the
// repository (HTTP 404) it logs and the run continues with the rest.
//
// To add a statute: look up its BWB-id on wetten.overheid.nl (it's in the
// URL: `wetten.overheid.nl/BWBR0001234`) and append an entry below. The
// boot auto-seed picks it up the next time the KB needs to be filled, or
// click "Refresh now" in the admin panel to ingest immediately.
const STATUTES = [
    // ── Burgerlijk Wetboek (alle boeken) ─────────────────────────────
    { bwbId: 'BWBR0002761', title: 'Burgerlijk Wetboek Boek 1 (Personen- en familierecht)' },
    { bwbId: 'BWBR0003045', title: 'Burgerlijk Wetboek Boek 2 (Rechtspersonen)' },
    { bwbId: 'BWBR0005291', title: 'Burgerlijk Wetboek Boek 3 (Vermogensrecht algemeen)' },
    { bwbId: 'BWBR0002762', title: 'Burgerlijk Wetboek Boek 4 (Erfrecht)' },
    { bwbId: 'BWBR0005288', title: 'Burgerlijk Wetboek Boek 5 (Zakelijke rechten)' },
    { bwbId: 'BWBR0005289', title: 'Burgerlijk Wetboek Boek 6 (Verbintenissenrecht)' },
    { bwbId: 'BWBR0005290', title: 'Burgerlijk Wetboek Boek 7 (Bijzondere overeenkomsten)' },
    { bwbId: 'BWBR0005292', title: 'Burgerlijk Wetboek Boek 7A (Bijzondere overeenkomsten oud)' },
    { bwbId: 'BWBR0017874', title: 'Burgerlijk Wetboek Boek 10 (Internationaal privaatrecht)' },

    // ── Procesrecht & rechterlijke organisatie ──────────────────────
    { bwbId: 'BWBR0001827', title: 'Wetboek van Burgerlijke Rechtsvordering (Rv)' },
    { bwbId: 'BWBR0001830', title: 'Wet op de rechterlijke organisatie' },
    { bwbId: 'BWBR0001834', title: 'Algemene termijnenwet' },

    // ── Strafrecht ──────────────────────────────────────────────────
    { bwbId: 'BWBR0001854', title: 'Wetboek van Strafrecht (Sr)' },
    { bwbId: 'BWBR0001903', title: 'Wetboek van Strafvordering (Sv)' },

    // ── Bestuursrecht ───────────────────────────────────────────────
    { bwbId: 'BWBR0005537', title: 'Algemene wet bestuursrecht (Awb)' },
    { bwbId: 'BWBR0045754', title: 'Wet open overheid (Woo)' },

    // ── Ondernemings- en handelsrecht ───────────────────────────────
    { bwbId: 'BWBR0001838', title: 'Wetboek van Koophandel (Wvk)' },
    { bwbId: 'BWBR0001860', title: 'Faillissementswet (Fw)' },
    { bwbId: 'BWBR0008691', title: 'Mededingingswet' },
    { bwbId: 'BWBR0033181', title: 'Handelsregisterwet 2007' },

    // ── Arbeidsrecht (BW7 Titel 10 = arbeidsovereenkomst) ───────────
    { bwbId: 'BWBR0007471', title: 'Arbeidsomstandighedenwet (Arbowet)' },
    { bwbId: 'BWBR0007679', title: 'Arbeidstijdenwet (ATW)' },
    { bwbId: 'BWBR0011352', title: 'Wet aanpassing arbeidsduur (Waa)' },
    { bwbId: 'BWBR0014049', title: 'Wet arbeid en zorg (Wazo)' },
    { bwbId: 'BWBR0035024', title: 'Wet werk en zekerheid (WWZ)' },
    { bwbId: 'BWBR0041627', title: 'Wet arbeidsmarkt in balans (WAB)' },

    // ── Sociale zekerheid ───────────────────────────────────────────
    { bwbId: 'BWBR0001888', title: 'Werkloosheidswet (WW)' },
    { bwbId: 'BWBR0002221', title: 'Ziektewet (ZW)' },
    { bwbId: 'BWBR0019057', title: 'Wet werk en inkomen naar arbeidsvermogen (WIA)' },
    { bwbId: 'BWBR0002232', title: 'Algemene Ouderdomswet (AOW)' },
    { bwbId: 'BWBR0015703', title: 'Participatiewet' },

    // ── Belastingrecht ──────────────────────────────────────────────
    { bwbId: 'BWBR0002320', title: 'Algemene wet inzake rijksbelastingen (AWR)' },
    { bwbId: 'BWBR0011353', title: 'Wet inkomstenbelasting 2001' },
    { bwbId: 'BWBR0002471', title: 'Wet op de loonbelasting 1964' },
    { bwbId: 'BWBR0002672', title: 'Wet op de vennootschapsbelasting 1969' },
    { bwbId: 'BWBR0002629', title: 'Wet op de omzetbelasting 1968' },
    { bwbId: 'BWBR0004770', title: 'Invorderingswet 1990' },

    // ── Privacy, telecom & ICT ──────────────────────────────────────
    { bwbId: 'BWBR0040940', title: 'Uitvoeringswet Algemene verordening gegevensbescherming (UAVG)' },
    { bwbId: 'BWBR0009950', title: 'Telecommunicatiewet' },

    // ── Vreemdelingen ───────────────────────────────────────────────
    { bwbId: 'BWBR0011823', title: 'Vreemdelingenwet 2000 (Vw 2000)' },

    // ── Financieel toezicht ────────────────────────────────────────
    { bwbId: 'BWBR0020368', title: 'Wet op het financieel toezicht (Wft)' },

    // ── Intellectueel eigendom ──────────────────────────────────────
    { bwbId: 'BWBR0001886', title: 'Auteurswet' },
    { bwbId: 'BWBR0007118', title: 'Rijksoctrooiwet 1995' },

    // ── Grondwet ────────────────────────────────────────────────────
    { bwbId: 'BWBR0001840', title: 'Grondwet voor het Koninkrijk der Nederlanden' },
];

// KOOP's "toestand" repository — returns the consolidated (current state)
// XML for a BWB-id. URL pattern documented at
// https://www.overheid.nl/help/wet-en-regelgeving/een-eigen-kopie-van-het-basiswettenbestand-opbouwen
// (the older /frbr/.../bwb/.../1/xml/ path was retired). The endpoint serves
// a 301 to the dated current toestand; Node's fetch follows redirects.
const BWB_XML_URL = (bwbId) => `https://repository.officiele-overheidspublicaties.nl/bwb/${bwbId}.xml`;
const BWB_DEEPLINK = (bwbId) => `https://wetten.overheid.nl/${bwbId}`;

// ── XML → Markdown ─────────────────────────────────────────────────
// Tiny ad-hoc parser. KOOP's schema is shallow enough that regex extraction
// over a buffered string gives clean Markdown without pulling in an XML lib.

function stripTags(s) {
    return String(s || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function decode(s) {
    return String(s || '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x2013;/g, '–')
        .replace(/&#x2014;/g, '—');
}

function articleToMarkdown(xml, statuteTitle) {
    const nrMatch = xml.match(/<nr[^>]*>([\s\S]*?)<\/nr>/i);
    const titelMatch = xml.match(/<titel[^>]*>([\s\S]*?)<\/titel>/i);
    const nr = nrMatch ? stripTags(nrMatch[1]) : '';
    const titel = titelMatch ? stripTags(titelMatch[1]) : '';
    const heading = `## Artikel ${nr}${titel ? ` — ${titel}` : ''}`;

    const lines = [heading, `*${statuteTitle}*`, ''];

    const lidRegex = /<lid[^>]*>([\s\S]*?)<\/lid>/gi;
    let lidMatch;
    let hadLid = false;
    while ((lidMatch = lidRegex.exec(xml)) !== null) {
        hadLid = true;
        const inner = lidMatch[1];
        const lidnr = (inner.match(/<lidnr[^>]*>([\s\S]*?)<\/lidnr>/i) || [, ''])[1];
        const body = decode(stripTags(inner.replace(/<lidnr[^>]*>[\s\S]*?<\/lidnr>/i, '')));
        if (body) lines.push(`${stripTags(lidnr) ? stripTags(lidnr) + '. ' : ''}${body}`);
    }
    if (!hadLid) {
        const alRegex = /<al[^>]*>([\s\S]*?)<\/al>/gi;
        let alMatch;
        while ((alMatch = alRegex.exec(xml)) !== null) {
            const body = decode(stripTags(alMatch[1]));
            if (body) lines.push(body);
        }
    }
    return lines.join('\n');
}

function xmlToMarkdown(xml, statuteTitle, bwbId) {
    const articleRegex = /<artikel\b[\s\S]*?<\/artikel>/gi;
    const matches = xml.match(articleRegex) || [];
    if (matches.length === 0) {
        const stripped = decode(stripTags(xml));
        return `# ${statuteTitle}\n\nBron: ${BWB_DEEPLINK(bwbId)}\n\n${stripped}`;
    }
    const header = [
        `# ${statuteTitle}`,
        '',
        `Bron: ${BWB_DEEPLINK(bwbId)}  `,
        `BWB-id: \`${bwbId}\``,
        '',
        '---',
        '',
    ].join('\n');
    return header + matches.map(a => articleToMarkdown(a, statuteTitle)).join('\n\n');
}

// ── Pipeline ───────────────────────────────────────────────────────

async function ensureSystemKB() {
    const existing = await kbStore.getSystemKBBySlug(SYSTEM_SLUG);
    if (existing) return existing;
    const kb = await kbStore.createKB(
        SYSTEM_TENANT_ID,
        KB_NAME,
        KB_DESCRIPTION,
        null,
        {
            sourceKind: 'system_managed',
            systemSlug: SYSTEM_SLUG,
            usageContexts: ['agent', 'direct_chat'],
            icon: '⚖️',
        }
    );
    console.log(`[dutchLawIngest] Created system KB id=${kb.id}`);
    return kb;
}

async function fetchStatute(bwbId) {
    const url = BWB_XML_URL(bwbId);
    const res = await fetch(url, {
        headers: {
            'Accept': 'application/xml',
            'User-Agent': 'Bee-Flow-AI/legal-ingest (https://beeflow.nl)',
        },
        signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`Fetch ${bwbId} failed: HTTP ${res.status}`);
    return res.text();
}

async function ingestOne(kb, statute, force = false) {
    const { bwbId, title } = statute;

    // Cheap pre-check BEFORE the HTTP fetch: if a document with this source_uri
    // (the BWB deeplink) already exists in the KB, skip entirely. Avoids
    // re-downloading 1-4MB XML for already-ingested statutes on every boot
    // or "Refresh now" click. Mandatory after we observed seed crashes mid-
    // run (SIGINT during deploy) leaving partial state that the previous
    // logic re-fetched in full on the next boot.
    let priorDocs = [];
    if (!force) {
        try {
            const { getAll } = require('../db');
            priorDocs = await getAll(
                `SELECT id FROM documents WHERE knowledge_base_id = $1 AND source_uri = $2`,
                [kb.id, BWB_DEEPLINK(bwbId)]
            );
            if (priorDocs.length > 0) {
                return { ok: true, action: 'skipped-existing', documentId: priorDocs[0].id };
            }
        } catch (_) { /* tolerate — fall through to fetch */ }
    }

    let xml;
    try {
        xml = await fetchStatute(bwbId);
    } catch (e) {
        console.error(`[dutchLawIngest] ${bwbId} ✗ fetch: ${e.message}`);
        return { ok: false, reason: e.message };
    }
    const markdown = xmlToMarkdown(xml, title, bwbId);
    if (markdown.length < 200) {
        console.warn(`[dutchLawIngest] ${bwbId} ⚠ parsed content too small (${markdown.length} chars)`);
        return { ok: false, reason: 'parsed content too small' };
    }

    // Content-hash fallback: catches the case where source_uri pre-check was
    // bypassed (force=true) but the content is byte-identical.
    const hash = kbStore.hashContent(markdown);
    const existing = await kbStore.hasContentHash(kb.id, hash);
    if (existing && !force) {
        return { ok: true, action: 'skipped-hash', documentId: existing };
    }

    // Force-mode: load prior docs now (we skipped the lookup above) and drop
    // their chunks before re-ingesting.
    if (force && priorDocs.length === 0) {
        try {
            const { getAll } = require('../db');
            priorDocs = await getAll(
                `SELECT id FROM documents WHERE knowledge_base_id = $1 AND source_uri = $2`,
                [kb.id, BWB_DEEPLINK(bwbId)]
            );
        } catch (_) { /* tolerate */ }
    }
    for (const row of priorDocs) {
        try { await deleteDocumentChunks(kb.id, row.id, SYSTEM_TENANT_ID); }
        catch (e) { console.warn(`[dutchLawIngest] ${bwbId} ⚠ delete prior doc ${row.id}: ${e.message}`); }
    }

    try {
        const result = await ingestDocument(
            SYSTEM_TENANT_ID,
            kb.id,
            markdown,
            title,
            'system_legal',
            BWB_DEEPLINK(bwbId),
            { lang: 'nl', metadata: { bwbId, kind: 'dutch_statute' }, skipDedup: true }
        );
        console.log(`[dutchLawIngest] ${bwbId} ✓ ${result.chunks} chunk(s)`);
        return { ok: true, action: 'ingested', chunks: result.chunks };
    } catch (e) {
        console.error(`[dutchLawIngest] ${bwbId} ✗ ingest: ${e.message}`);
        return { ok: false, reason: e.message };
    }
}

// ── Job tracking — in-process. Survives until server restart. ────────
const status = {
    running: false,
    startedAt: null,
    finishedAt: null,
    total: 0,
    done: 0,
    okCount: 0,
    failCount: 0,
    lastError: null,
    lastResults: null, // [{ bwbId, title, ok, action, reason, chunks }]
};

function getStatus() { return { ...status }; }

async function seedAll({ force = false, bwbIds = null } = {}) {
    if (status.running) {
        return { error: 'A seed is already running', status: getStatus() };
    }
    const targets = Array.isArray(bwbIds) && bwbIds.length > 0
        ? STATUTES.filter(s => bwbIds.includes(s.bwbId))
        : STATUTES;
    if (targets.length === 0) {
        return { error: 'No matching BWB-ids in catalogue', known: STATUTES.map(s => s.bwbId) };
    }

    status.running = true;
    status.startedAt = new Date().toISOString();
    status.finishedAt = null;
    status.total = targets.length;
    status.done = 0;
    status.okCount = 0;
    status.failCount = 0;
    status.lastError = null;
    status.lastResults = [];

    let kb;
    try {
        kb = await ensureSystemKB();
    } catch (e) {
        status.running = false;
        status.lastError = `ensureSystemKB failed: ${e.message}`;
        status.finishedAt = new Date().toISOString();
        throw e;
    }

    for (const statute of targets) {
        const r = await ingestOne(kb, statute, force);
        status.done++;
        if (r.ok) status.okCount++; else status.failCount++;
        status.lastResults.push({ ...statute, ...r });
    }

    status.running = false;
    status.finishedAt = new Date().toISOString();
    console.log(`[dutchLawIngest] Done — ${status.okCount} ok, ${status.failCount} failed.`);
    return { ok: status.okCount, failed: status.failCount, total: targets.length, results: status.lastResults };
}

/**
 * Boot helper. Safe to call from server start-up:
 *   - Async / non-blocking — kicks off the seed in the background and returns.
 *   - Runs seedAll only when the KB has zero documents. Any non-zero state
 *     (including partial seeds where a statute permanently fails to parse) is
 *     left alone so deploys don't repeatedly re-attempt the same fetches.
 *     Use admin "Refresh now" to resume a partial seed or re-ingest.
 *   - Logs progress; never throws.
 */
function seedIfMissing() {
    setImmediate(async () => {
        try {
            const kb = await kbStore.getSystemKBBySlug(SYSTEM_SLUG);
            if (kb) {
                const all = await kbStore.listSystemKBs();
                const found = all.find(k => k.id === kb.id);
                const docCount = Number(found?.document_count || 0);
                if (docCount > 0) {
                    console.log(`[dutchLawIngest] Boot: KB already has ${docCount}/${STATUTES.length} docs; skipping auto-seed. Use admin "Refresh now" to resume or re-ingest.`);
                    return;
                }
                console.log('[dutchLawIngest] Boot: KB empty, seeding in background...');
            } else {
                console.log('[dutchLawIngest] Boot: seeding system KB in background...');
            }
            await seedAll({ force: false });
        } catch (e) {
            console.error('[dutchLawIngest] Boot auto-seed failed:', e.message);
        }
    });
}

/**
 * Admin-triggered refresh. Returns immediately; status is observable via
 * getStatus(). `force=true` re-embeds even unchanged statutes.
 */
function refresh({ force = false, bwbIds = null } = {}) {
    if (status.running) return { running: true, status: getStatus() };
    setImmediate(() => {
        seedAll({ force, bwbIds }).catch(e => {
            status.lastError = e.message;
            status.running = false;
            status.finishedAt = new Date().toISOString();
            console.error('[dutchLawIngest] Refresh failed:', e.message);
        });
    });
    return { running: true, status: getStatus() };
}

module.exports = {
    SYSTEM_SLUG,
    SYSTEM_TENANT_ID,
    STATUTES,
    ensureSystemKB,
    ingestOne,
    xmlToMarkdown,
    seedAll,
    seedIfMissing,
    refresh,
    getStatus,
};
