#!/usr/bin/env node
/**
 * CLI shim for the Dutch-law seed.
 *
 * The seeding logic now lives in server/services/dutchLawIngest.js and runs
 * automatically on server boot (when the system KB is empty) plus on
 * admin-triggered "Refresh now" from the System Knowledge Bases panel.
 *
 * This script is retained as an ops convenience — useful when you need to
 * seed without booting the full server, or when a particular statute needs
 * to be forced-reingested without going through the admin UI.
 *
 * Usage:
 *   node server/scripts/ingestDutchLaw.js                       # all statutes
 *   node server/scripts/ingestDutchLaw.js BWBR0005291,BWBR0001854  # subset
 *   node server/scripts/ingestDutchLaw.js --force               # re-embed unchanged
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { seedAll, STATUTES } = require('../services/dutchLawIngest');

async function main() {
    const argv = process.argv.slice(2);
    const force = argv.includes('--force');
    const idsArg = argv.find(a => !a.startsWith('--'));
    const bwbIds = idsArg
        ? idsArg.split(',').map(s => s.trim()).filter(Boolean)
        : null;

    if (bwbIds && bwbIds.length > 0) {
        const known = new Set(STATUTES.map(s => s.bwbId));
        const unknown = bwbIds.filter(id => !known.has(id));
        if (unknown.length > 0) {
            console.error(`[ingestDutchLaw] Unknown BWB-id(s): ${unknown.join(', ')}`);
            console.error(`  Catalogue: ${STATUTES.map(s => s.bwbId).join(', ')}`);
            process.exit(1);
        }
    }

    console.log(`[ingestDutchLaw] Starting seed (${bwbIds ? bwbIds.length : STATUTES.length} statute(s), force=${force})...`);
    const result = await seedAll({ force, bwbIds });
    if (result.error) {
        console.error(`[ingestDutchLaw] ${result.error}`);
        process.exit(1);
    }
    console.log(`[ingestDutchLaw] Done — ${result.ok} ok, ${result.failed} failed of ${result.total}.`);
    if (result.failed > 0) process.exitCode = 1;
}

main().catch(err => {
    console.error('[ingestDutchLaw] Fatal:', err);
    process.exit(1);
});
