// Wipe SaaS-side state for the local NC sandbox so the next connector boot
// starts from scratch: org gone, tenant key gone, pending bindings gone,
// pairing codes gone, all sessions gone. Invoked by scripts/dev-nc.sh reset.

const u = require('./stores/userStore');
const db = require('./db');

(async () => {
    try {
        const ncInstanceId = process.env.NC_INSTANCE_ID || '32.0.9:Nextcloud';
        const org = await u.getOrganizationByNcInstanceId(ncInstanceId);
        if (org) {
            await u.deleteOrganization(org.id);
            console.log('deleted org', org.id, '(cascades to pending_nc_bindings + tenant key)');
        } else {
            console.log('no org found for ncInstance=' + ncInstanceId);
        }

        // Pending bindings + pairing codes for orgs we already deleted are
        // gone via ON DELETE CASCADE; but rows that never made it to an
        // existing org (e.g. an aborted bootstrap) still linger. Sweep them.
        try {
            const { rowCount } = await db.run(`
                DELETE FROM pending_nc_bindings
                WHERE nc_instance_id = $1
                   OR (pairing_code IS NOT NULL AND pairing_code_consumed_at IS NULL)
            `, [ncInstanceId]);
            if (rowCount > 0) console.log(`wiped ${rowCount} stale pending_nc_bindings row(s)`);
        } catch (e) { console.warn('pending-binding sweep skipped:', e.message); }

        // Wipe all server-side sessions so a stale cookie can't keep
        // referencing a session for the deleted user/org.
        try {
            const { rowCount } = await db.run('DELETE FROM user_sessions');
            console.log(`wiped ${rowCount} session(s)`);
        } catch (e) {
            console.warn('session wipe skipped:', e.message);
        }

        process.exit(0);
    } catch (e) { console.error('ERR', e.message); process.exit(1); }
})();
