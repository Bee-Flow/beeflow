/**
 * Legal Citation Store — the verified Table of Authorities (bronnenlijst).
 *
 * One row per source a lawyer relies on in a matter (a notebook with
 * type='legal_matter'). A row is `verified` once we've actually retrieved it
 * from an authoritative endpoint (rechtspraak.nl / EUR-Lex / the statute KB) or
 * the lawyer added it by hand. The drafting layer never invents citations; this
 * ledger is what lets the UI mark each one verified / unverified / not-found.
 *
 * Schema lives in migrations/legal-citations-2026-05.js, applied lazily here
 * (same convention as automationStore / knowledgeBases).
 */

const crypto = require('crypto');
const { run, getOne, getAll } = require('../db');

let initialized = false;

async function initDB() {
    if (initialized) return;
    try {
        await require('../migrations/legal-citations-2026-05').up();
    } catch (e) {
        console.error('[LegalCitationStore] Init error:', e.message);
    }
    initialized = true;
}

initDB().catch(err => console.error('[LegalCitationStore] Init error:', err.message));

const VALID_KINDS = new Set(['jurisprudentie', 'wet', 'eu', 'tuchtrecht', 'kamerstuk', 'bekendmaking', 'literatuur']);

/**
 * Insert or upgrade an authority. Dedup'd by (notebook_id, kind, identifier);
 * re-finding the same ECLI just refreshes metadata and never downgrades a row
 * that was already verified.
 */
async function upsertCitation({ notebookId, kind, identifier, title, pinpoint, url, verified, verificationMethod, sourceId, metadata }) {
    await initDB();
    const safeKind = VALID_KINDS.has(kind) ? kind : 'literatuur';
    const id = crypto.randomUUID();
    const isVerified = !!verified;
    const verifiedAt = isVerified ? new Date().toISOString() : null;
    const ident = identifier || null;

    // NULL identifiers (free-text literatuur) aren't covered by the partial
    // unique index, so ON CONFLICT can't fire — plain insert in that case.
    if (!ident) {
        await run(
            `INSERT INTO legal_citations (id, notebook_id, kind, identifier, title, pinpoint, url, verified, verification_method, verified_at, source_id, metadata)
             VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [id, notebookId, safeKind, title || null, pinpoint || null, url || null,
             isVerified, verificationMethod || null, verifiedAt, sourceId || null, JSON.stringify(metadata || {})]
        );
        return getCitation(id);
    }

    const r = await getOne(
        `INSERT INTO legal_citations (id, notebook_id, kind, identifier, title, pinpoint, url, verified, verification_method, verified_at, source_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (notebook_id, kind, identifier) WHERE identifier IS NOT NULL
         DO UPDATE SET
            title = COALESCE(EXCLUDED.title, legal_citations.title),
            pinpoint = COALESCE(EXCLUDED.pinpoint, legal_citations.pinpoint),
            url = COALESCE(EXCLUDED.url, legal_citations.url),
            verified = legal_citations.verified OR EXCLUDED.verified,
            verification_method = CASE WHEN EXCLUDED.verified THEN EXCLUDED.verification_method ELSE legal_citations.verification_method END,
            verified_at = CASE WHEN EXCLUDED.verified AND legal_citations.verified_at IS NULL THEN NOW() ELSE legal_citations.verified_at END,
            source_id = COALESCE(EXCLUDED.source_id, legal_citations.source_id),
            metadata = legal_citations.metadata || EXCLUDED.metadata
         RETURNING *`,
        [id, notebookId, safeKind, ident, title || null, pinpoint || null, url || null,
         isVerified, verificationMethod || null, verifiedAt, sourceId || null, JSON.stringify(metadata || {})]
    );
    return r ? mapCitationRow(r) : null;
}

async function getCitation(id) {
    await initDB();
    const r = await getOne('SELECT * FROM legal_citations WHERE id = $1', [id]);
    return r ? mapCitationRow(r) : null;
}

async function listCitations(notebookId, { verifiedOnly = false } = {}) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM legal_citations
          WHERE notebook_id = $1 ${verifiedOnly ? 'AND verified = TRUE' : ''}
          ORDER BY kind ASC, created_at ASC`,
        [notebookId]
    );
    return rows.map(mapCitationRow);
}

async function setVerified(id, notebookId, verified, verificationMethod) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE legal_citations
            SET verified = $3,
                verification_method = $4,
                verified_at = CASE WHEN $3 THEN NOW() ELSE NULL END
          WHERE id = $1 AND notebook_id = $2`,
        [id, notebookId, !!verified, verificationMethod || null]
    );
    return rowCount > 0;
}

async function deleteCitation(id, notebookId) {
    await initDB();
    const { rowCount } = await run(
        'DELETE FROM legal_citations WHERE id = $1 AND notebook_id = $2',
        [id, notebookId]
    );
    return rowCount > 0;
}

/** Drop every authority for a matter (used when re-deriving the list wholesale). */
async function clearCitations(notebookId) {
    await initDB();
    const { rowCount } = await run('DELETE FROM legal_citations WHERE notebook_id = $1', [notebookId]);
    return rowCount || 0;
}

function parseJSON(v, fallback) {
    if (typeof v === 'object' && v !== null) return v;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return fallback; } }
    return v || fallback;
}

function mapCitationRow(r) {
    return {
        id: r.id,
        notebookId: r.notebook_id,
        kind: r.kind,
        identifier: r.identifier || null,
        title: r.title || null,
        pinpoint: r.pinpoint || null,
        url: r.url || null,
        verified: !!r.verified,
        verificationMethod: r.verification_method || null,
        verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
        sourceId: r.source_id || null,
        metadata: parseJSON(r.metadata, {}),
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

module.exports = {
    VALID_KINDS,
    upsertCitation,
    getCitation,
    listCitations,
    setVerified,
    deleteCitation,
    clearCitations,
};
