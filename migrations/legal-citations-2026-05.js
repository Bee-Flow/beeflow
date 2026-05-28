/**
 * Migration: Legal Studio — verified Table of Authorities (bronnenlijst).
 *
 * A legal matter is stored as a notebook row (type = 'legal_matter'), so all
 * source/version/chat/export plumbing is reused. The ONE genuinely new
 * subsystem is the citation ledger: every wet/jurisprudentie/EU source a
 * lawyer relies on, with a verified lifecycle. That's relational + dedup'd +
 * filtered, so it gets a real table rather than living in notebooks.settings.
 *
 * Idempotent: every statement is IF NOT EXISTS, so re-running is safe.
 * Invoked from server/stores/legalCitationStore.js initDB() (try/catch), the
 * same convention automationStore + knowledgeBases use.
 *
 *   node server/migrations/legal-citations-2026-05.js   (manual run)
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS legal_citations (
            id TEXT PRIMARY KEY,
            notebook_id TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            identifier TEXT,
            title TEXT,
            pinpoint TEXT,
            url TEXT,
            verified BOOLEAN NOT NULL DEFAULT FALSE,
            verification_method TEXT,
            verified_at TIMESTAMPTZ,
            source_id TEXT REFERENCES notebook_sources(id) ON DELETE SET NULL,
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    // Dedupe an authority within a matter by (kind, identifier) so re-running
    // verification upserts in place instead of piling duplicates. NULL
    // identifiers (manual literatuur) are distinct in Postgres → never collide,
    // which is the behaviour we want for free-text authorities.
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_legal_citations_unique
                    ON legal_citations(notebook_id, kind, identifier)
                    WHERE identifier IS NOT NULL`);

    // The bronnenlijst panel filters verified vs unverified per matter.
    await exec(`CREATE INDEX IF NOT EXISTS idx_legal_citations_matter
                    ON legal_citations(notebook_id, verified)`);

    console.log('[Migration] legal-citations-2026-05 applied');
}

module.exports = { up };

// Allow standalone CLI execution for ops/manual runs.
if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error('[Migration] legal-citations-2026-05 failed:', err);
        process.exit(1);
    });
}
