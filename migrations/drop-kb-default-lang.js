#!/usr/bin/env node
/**
 * Migration: drop the per-KB `default_lang` column from `knowledge_bases`.
 *
 * The Knowledge Base UI no longer exposes a default language — the chunker
 * detects language at ingest time and stores it on `kb_chunks.lang`. The
 * KB-level field has been dead state for a while; drop it so it can't
 * leak through API responses or be referenced by future code.
 *
 * Idempotent: `DROP COLUMN IF EXISTS` is a no-op once applied. Also runs
 * automatically on server start through `stores/knowledgeBases.js initDB()`,
 * so a normal deploy applies it without operator action.
 *
 * Manual usage: `node server/migrations/drop-kb-default-lang.js`
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS default_lang`);
    console.log('[Migration] drop-kb-default-lang applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
