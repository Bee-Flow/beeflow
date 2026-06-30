#!/usr/bin/env node
/**
 * Migration: repair org founders/owners stuck in the approval limbo.
 *
 * The login approval gate (loginRoutes.finalizeLogin) flags any user whose
 * status is 'pending' or 'waitlist' as awaiting approval. An org founder
 * (orgRole = 'org_admin') is the org's own admin/owner — there is no one above
 * them to approve, so they should always be 'active'. Some founder rows were
 * left at 'pending'/'waitlist' by an earlier signup-path bug; those users hit
 * the "Awaiting Approval" gate on every login (a dead end — a 'pending' founder
 * isn't even listed in the admin waitlist panel, which filters 'waitlist' only).
 *
 * This is a one-shot data repair: promote those rows back to 'active'. The
 * login gate now also exempts org_admins at runtime, so this can't recur.
 *
 * Idempotent — re-runs affect 0 rows once repaired. Auto-runs from server boot
 * (server/index.js). Manual usage:
 *   node server/migrations/fix-org-admin-approval-status.js
 */

const { run } = require('../db');

async function up() {
    const res = await run(
        `UPDATE users
            SET status = 'active'
          WHERE "orgRole" = 'org_admin'
            AND status IN ('pending', 'waitlist')`
    );
    const n = res?.rowCount || 0;
    if (n > 0) {
        console.log(`[Migration] fix-org-admin-approval-status promoted ${n} founder row(s) to active`);
    }
    return n;
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
