#!/usr/bin/env node
/**
 * Cleanup duplicate Azure AD SSO users.
 *
 * Background:
 *   Before the OAuth callback was fixed to match existing synced users via
 *   azureUserId/email, every first-time SSO login created a second user row
 *   keyed by the Azure AD object id (a raw GUID). That left tenants with
 *   pairs like:
 *       canonical: id="john.doe"          azureUserId=<guid>  (from sync)
 *       orphan:    id="<guid>"            azureUserId=NULL    (from SSO)
 *
 *   This script finds those orphans, backfills missing azureUserId values on
 *   the canonical record, and deletes the orphan when it is safe to do so.
 *
 * Usage:
 *   node server/scripts/cleanupAzureDuplicates.js            # dry-run (default)
 *   node server/scripts/cleanupAzureDuplicates.js --apply    # actually mutate
 *   node server/scripts/cleanupAzureDuplicates.js --apply --force
 *       # delete orphans even when they hold data (chats, memories, etc.).
 *       # Canonical keeps its own data; orphan's data is discarded.
 *
 * Safety:
 *   - Dry-run by default.
 *   - Refuses to delete an orphan that has chat/memory/execution history
 *     unless --force is supplied.
 *   - Re-running is a no-op.
 */

const path = require('path');
const { pool } = require(path.join(__dirname, '..', 'db'));
const userStore = require(path.join(__dirname, '..', 'stores', 'userStore'));
const { isAzureOid } = require(path.join(__dirname, '..', 'auth', 'ssoUserResolver'));

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

// Tables that store per-user rows. Used to decide whether an orphan is "empty"
// and safe to drop, or holds content that a human needs to review first.
const USER_DATA_TABLES = [
    { table: 'user_memories',        column: 'user_id' },
    { table: 'agent_conversations',  column: 'user_id' },
    { table: 'direct_conversations', column: 'user_id' },
    { table: 'execution_history',    column: 'user_id' },
];

async function countUserRows(userId) {
    const counts = {};
    let total = 0;
    for (const { table, column } of USER_DATA_TABLES) {
        try {
            const { rows } = await pool.query(
                `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${column} = $1`,
                [userId],
            );
            const n = rows[0]?.n || 0;
            if (n > 0) counts[table] = n;
            total += n;
        } catch (_) {
            // Table may not exist in this deployment — treat as zero.
        }
    }
    return { counts, total };
}

function pickCanonical(a, b) {
    // Prefer the non-GUID id; if both look canonical or both look like GUIDs,
    // prefer the one with azureUserId set (more authoritative), then the
    // earliest createdAt, then the one with more profile data filled in.
    const aIsOid = isAzureOid(a.id);
    const bIsOid = isAzureOid(b.id);
    if (aIsOid && !bIsOid) return { canonical: b, orphan: a };
    if (bIsOid && !aIsOid) return { canonical: a, orphan: b };

    if (a.azureUserId && !b.azureUserId) return { canonical: a, orphan: b };
    if (b.azureUserId && !a.azureUserId) return { canonical: b, orphan: a };

    const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
    const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
    if (aCreated !== bCreated) {
        return aCreated < bCreated
            ? { canonical: a, orphan: b }
            : { canonical: b, orphan: a };
    }

    return { canonical: a, orphan: b };
}

async function findDuplicatePairs() {
    const users = await userStore.getAllUsers();
    const pairs = [];
    const seen = new Set();

    // Index by lowercase email for fast pairing.
    const byEmail = new Map();
    for (const u of users) {
        if (!u.email) continue;
        const key = u.email.toLowerCase();
        if (!byEmail.has(key)) byEmail.set(key, []);
        byEmail.get(key).push(u);
    }

    // Any email shared by >= 2 rows is a duplicate cluster.
    for (const [email, cluster] of byEmail.entries()) {
        if (cluster.length < 2) continue;

        // Pick the best canonical, then pair every other row in the cluster
        // against it. This handles the rare case where a user has been
        // duplicated more than twice.
        let canonical = cluster[0];
        for (let i = 1; i < cluster.length; i++) {
            canonical = pickCanonical(canonical, cluster[i]).canonical;
        }
        for (const other of cluster) {
            if (other.id === canonical.id) continue;
            const sig = `${canonical.id}::${other.id}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
            pairs.push({ canonical, orphan: other, email });
        }
    }

    // Also catch rows whose id is an Azure OID but whose email is missing
    // (no email column means the cluster-by-email pass above skipped them).
    // Match by azureUserId instead.
    for (const u of users) {
        if (!isAzureOid(u.id)) continue;
        if (u.email) continue; // already handled above
        if (!u.azureUserId && !isAzureOid(u.id)) continue;
        const azureId = u.azureUserId || u.id;
        const canonical = users.find(v =>
            v.id !== u.id &&
            !isAzureOid(v.id) &&
            (v.azureUserId === azureId),
        );
        if (canonical) {
            const sig = `${canonical.id}::${u.id}`;
            if (seen.has(sig)) continue;
            seen.add(sig);
            pairs.push({ canonical, orphan: u, email: u.email || '' });
        }
    }

    return pairs;
}

async function main() {
    console.log('─'.repeat(72));
    console.log(`Azure AD duplicate-user cleanup — ${APPLY ? 'APPLY' : 'DRY-RUN'}${FORCE ? ' (force)' : ''}`);
    console.log('─'.repeat(72));

    const pairs = await findDuplicatePairs();

    if (pairs.length === 0) {
        console.log('No duplicate users detected. ✅');
        await pool.end();
        return;
    }

    console.log(`Found ${pairs.length} duplicate pair(s):\n`);

    let deleted = 0;
    let backfilled = 0;
    let skipped = 0;

    for (const { canonical, orphan, email } of pairs) {
        const { counts, total } = await countUserRows(orphan.id);
        const refsStr = total === 0
            ? 'no downstream data'
            : `refs: ${Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(', ')}`;

        console.log(`• ${email || '(no email)'}`);
        console.log(`    canonical: id=${canonical.id}  azureUserId=${canonical.azureUserId || 'NULL'}  org=${canonical.organizationId || 'NULL'}`);
        console.log(`    orphan:    id=${orphan.id}  azureUserId=${orphan.azureUserId || 'NULL'}  org=${orphan.organizationId || 'NULL'}  (${refsStr})`);

        // 1. Backfill canonical.azureUserId if it's missing and the orphan
        //    (or its id) supplies one.
        const azureIdFromOrphan = orphan.azureUserId || (isAzureOid(orphan.id) ? orphan.id : null);
        if (!canonical.azureUserId && azureIdFromOrphan) {
            if (APPLY) {
                await userStore.updateUser(canonical.id, { azureUserId: azureIdFromOrphan });
                console.log(`    ↻ backfilled canonical.azureUserId = ${azureIdFromOrphan}`);
            } else {
                console.log(`    ↻ would backfill canonical.azureUserId = ${azureIdFromOrphan}`);
            }
            backfilled++;
        }

        // 2. Delete orphan unless it holds data without --force.
        if (total > 0 && !FORCE) {
            console.log(`    ⚠ orphan holds ${total} row(s) of user data — skipping delete (re-run with --force to discard)`);
            skipped++;
        } else if (APPLY) {
            const ok = await userStore.deleteUser(orphan.id);
            if (ok) {
                console.log(`    ✖ deleted orphan ${orphan.id}`);
                deleted++;
            } else {
                console.log(`    ! delete failed for ${orphan.id}`);
            }
        } else {
            console.log(`    ✖ would delete orphan ${orphan.id}${total > 0 ? ` (${total} row(s) would be discarded with --force)` : ''}`);
            deleted++;
        }
        console.log('');
    }

    console.log('─'.repeat(72));
    console.log(`Summary: ${pairs.length} pair(s) — ${APPLY ? 'applied' : 'planned'}: ${backfilled} backfill(s), ${deleted} delete(s), ${skipped} skipped`);
    if (!APPLY) {
        console.log('Run again with --apply to commit these changes.');
    }
    console.log('─'.repeat(72));

    await pool.end();
}

main().catch(err => {
    console.error('cleanupAzureDuplicates failed:', err);
    pool.end().catch(() => {});
    process.exit(1);
});
