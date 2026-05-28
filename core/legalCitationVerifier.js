/**
 * Legal citation verifier — the anti-hallucination core of Legal Studio.
 *
 * Extracts every legal citation token from a piece of generated/drafted text
 * and validates each against an authoritative source, returning a three-state
 * result per token and persisting it into the matter's bronnenlijst:
 *
 *   verified   (emerald) — confirmed to exist via rechtspraak.nl / EUR-Lex / the
 *                          seeded statute KB.
 *   notFound   (red)     — we queried the authoritative registry and it does NOT
 *                          exist → a likely-hallucinated ECLI/CELEX. ONLY ECLI
 *                          and CELEX can reach this state, because only they hit
 *                          the live registry.
 *   unverified (amber)   — we couldn't check (unsupported type, statute not in
 *                          the KB, upstream temporarily down). Neutral: "check
 *                          manually" — never a fraud signal.
 *
 * The verifier NEVER rewrites the lawyer's text; it only reports + records.
 *
 * NB: the token patterns MUST stay in sync with
 *     agent-hub/src/utils/legalCitations.js (CITATION_PATTERNS), so a citation
 *     that auto-links in the editor is the same one we verify here.
 */

const { executeRechtspraakTool } = require('../integrations/rechtspraakTools');
const { executeEurlexTool } = require('../integrations/eurlexTools');
const { executeTuchtrechtTool } = require('../integrations/tuchtrechtTools');
const { findDocumentBySourceUri } = require('./kbIngestionHelpers');
const kbStore = require('../stores/knowledgeBases');
const legalCitationStore = require('../stores/legalCitationStore');
const cache = require('./legalSourceCache');

// Mirror of agent-hub/src/utils/legalCitations.js CITATION_PATTERNS — keep in sync.
const PATTERNS = [
    { name: 'ecli', kind: 'jurisprudentie', regex: /\bECLI:[A-Z]{2}:[A-Z]+:\d{4}:\d+\b/gi },
    { name: 'celex', kind: 'eu', regex: /\b3\d{4}[RLDH]\d{4}\b/g },
    { name: 'bwb', kind: 'wet', regex: /\bBWB[RVA]\d{7,8}\b/g },
    { name: 'kamerstuk', kind: 'kamerstuk', regex: /\b\d{5,6}[,\s]+nr\.?\s*\d+\b/g },
];

// An error string that clearly signals "this record does not exist" (vs. a
// transient network/parse failure, which must stay neutral/amber).
function isDefinitiveAbsence(err) {
    return /\b404\b|not[\s.]?found|geen\s+result|no\s+result|invalid\s+(ecli|celex)/i.test(String(err || ''));
}

function classifyToolResult(result, kind, method) {
    if (result && !result.error && (result.ecli || result.celex || result.title || result.text || result.inhoudsindicatie)) {
        return { status: 'verified', kind, method, title: result.title || null, url: result.link || result.url || null };
    }
    if (result && result.error && isDefinitiveAbsence(result.error)) {
        return { status: 'notFound', kind, method };
    }
    return { status: 'unverified', kind, method };
}

async function verifyEcli(ecli) {
    const parts = ecli.split(':'); // ECLI:NL:HR:2024:123
    const country = (parts[1] || '').toUpperCase();
    const court = (parts[2] || '').toUpperCase();
    // CJEU/EU ECLIs and other jurisdictions aren't covered by rechtspraak.nl.
    if (country !== 'NL') return { status: 'unverified', kind: 'jurisprudentie' };
    // Dutch tuchtrecht ECLIs start the court segment with 'T' (TADR…, TGZ…, TNO…).
    if (court.startsWith('T')) {
        const r = await executeTuchtrechtTool('tuchtrecht_get', { identifier: ecli }).catch(e => ({ error: e.message }));
        return classifyToolResult(r, 'tuchtrecht', 'tuchtrecht_get');
    }
    const r = await executeRechtspraakTool('rechtspraak_get', { ecli }).catch(e => ({ error: e.message }));
    return classifyToolResult(r, 'jurisprudentie', 'rechtspraak_get');
}

async function verifyCelex(celex) {
    const r = await executeEurlexTool('eurlex_get', { celex }).catch(e => ({ error: e.message }));
    return classifyToolResult(r, 'eu', 'eurlex_get');
}

// A BWB-id is verified only if the statute is in our seeded system KB. A miss is
// NOT proof of absence (we seed ~68 statutes, not all of them), so a miss is
// amber/unverified — never red.
async function verifyBwb(bwbId, systemKbId) {
    if (!systemKbId) return { status: 'unverified', kind: 'wet' };
    try {
        const doc = await findDocumentBySourceUri(systemKbId, `https://wetten.overheid.nl/${bwbId}`);
        if (doc) return { status: 'verified', kind: 'wet', method: 'kb', title: doc.title || null, url: `https://wetten.overheid.nl/${bwbId}` };
    } catch (_) { /* fall through to unverified */ }
    return { status: 'unverified', kind: 'wet' };
}

async function verifyToken(t, systemKbId) {
    if (t.name === 'ecli') return verifyEcli(t.token);
    if (t.name === 'celex') return verifyCelex(t.token);
    if (t.name === 'bwb') return verifyBwb(t.token, systemKbId);
    // kamerstuk: no reliable single-document existence check via the open data —
    // stays neutral so the lawyer verifies the dossier reference manually.
    return { status: 'unverified', kind: t.kind };
}

function extractTokens(text) {
    const plain = String(text || '').replace(/<[^>]+>/g, ' ');
    const found = new Map(); // token -> { name, kind }
    for (const p of PATTERNS) {
        p.regex.lastIndex = 0;
        let m;
        while ((m = p.regex.exec(plain)) !== null) {
            const token = m[0].trim();
            if (token && !found.has(token)) found.set(token, { name: p.name, kind: p.kind });
        }
    }
    return [...found.entries()].map(([token, meta]) => ({ token, ...meta }));
}

/**
 * Verify every citation token in `text`, persisting outcomes into the matter's
 * bronnenlijst. Returns { total, verified[], notFound[], unverified[] }.
 */
async function verifyText(text, { notebookId } = {}) {
    const tokens = extractTokens(text);
    if (tokens.length === 0) return { total: 0, verified: [], notFound: [], unverified: [] };

    let systemKbId = null;
    try { const kb = await kbStore.getSystemKBBySlug('dutch_legal_sources'); systemKbId = kb?.id || null; } catch (_) {}

    const verified = [], notFound = [], unverified = [];

    for (const t of tokens) {
        const cacheKey = `verify:${t.token}`;
        let outcome = cache.get(cacheKey);
        if (outcome === undefined) {
            outcome = await verifyToken(t, systemKbId);
            // Only cache stable outcomes — a transient "unverified" must be retried.
            if (outcome.status === 'verified' || outcome.status === 'notFound') cache.set(cacheKey, outcome);
        }

        if (notebookId) {
            const method = outcome.status === 'verified'
                ? (outcome.method || 'verified')
                : (outcome.status === 'notFound' ? 'not_found' : 'pending');
            try {
                await legalCitationStore.upsertCitation({
                    notebookId,
                    kind: outcome.kind || t.kind,
                    identifier: t.token,
                    title: outcome.title || null,
                    url: outcome.url || null,
                    verified: outcome.status === 'verified',
                    verificationMethod: method,
                });
            } catch (e) { /* persistence best-effort */ }
        }

        const entry = { token: t.token, kind: outcome.kind || t.kind, status: outcome.status };
        if (outcome.status === 'verified') verified.push(entry);
        else if (outcome.status === 'notFound') notFound.push(entry);
        else unverified.push(entry);
    }

    return { total: tokens.length, verified, notFound, unverified };
}

module.exports = { verifyText, extractTokens, PATTERNS };
