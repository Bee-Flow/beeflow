#!/usr/bin/env node
/**
 * Sync the canonical legal markdown into the server build context.
 *
 * The authoritative English markdown lives at agent-hub/src/marketing/legal/
 * (so the frontend can ?raw-import privacy/terms as an offline fallback). That
 * tree is OUTSIDE the server's Docker build context (./server), so the built
 * server image cannot read it. This script mirrors the *.md files into
 * server/legal/docs/ — which IS in the build context and shipped in the image —
 * so getLegalSource()/getLegalDefault() resolve a real body in production.
 *
 * Run this whenever you edit a canonical doc, BEFORE building the server image:
 *   node scripts/sync-legal-docs.js          (from server/)
 *   npm run sync:legal                         (from server/)
 *
 * Note: after launch most edits go through the admin Legal tab and persist as
 * runtime overrides in configStore (legalStore) — the disk mirror is only the
 * first-deploy seed / fallback.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'agent-hub', 'src', 'marketing', 'legal');
const DEST = path.join(__dirname, '..', 'legal', 'docs');

function main() {
    if (!fs.existsSync(SRC)) {
        console.error(`[sync-legal-docs] Canonical source dir not found: ${SRC}`);
        process.exit(1);
    }
    fs.mkdirSync(DEST, { recursive: true });

    const files = fs.readdirSync(SRC).filter(f => f.endsWith('.md'));
    if (!files.length) {
        console.error(`[sync-legal-docs] No .md files found in ${SRC}`);
        process.exit(1);
    }

    let copied = 0;
    for (const f of files) {
        const from = path.join(SRC, f);
        const to = path.join(DEST, f);
        const next = fs.readFileSync(from, 'utf-8');
        const prev = fs.existsSync(to) ? fs.readFileSync(to, 'utf-8') : null;
        if (prev !== next) {
            fs.writeFileSync(to, next, 'utf-8');
            console.log(`  updated ${f}`);
            copied++;
        }
    }
    console.log(`[sync-legal-docs] ${copied} file(s) updated, ${files.length} total → ${path.relative(process.cwd(), DEST)}`);
}

main();
