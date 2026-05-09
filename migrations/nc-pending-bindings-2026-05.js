/**
 * Migration: pending_nc_bindings (2026-05).
 *
 * Splits the connector-bootstrap trust model: brand-new orgs still bootstrap
 * one-click, but binding to an *existing* Bee Flow org now requires an
 * authenticated approval from that org's admin in the SaaS UI. The pending
 * row carries the proposed binding until the admin approves or denies it
 * (or it expires).
 *
 * Idempotent — uses CREATE TABLE / INDEX IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        CREATE TABLE IF NOT EXISTS pending_nc_bindings (
            id              TEXT PRIMARY KEY,
            org_id          TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            nc_instance_id  TEXT NOT NULL,
            nc_base_url     TEXT NOT NULL,
            nc_admin_uid    TEXT NOT NULL,
            nc_admin_email  TEXT NOT NULL,
            nc_admin_display_name TEXT,
            connector_callback_url TEXT,
            theming_name    TEXT,
            nc_version      TEXT,
            status          TEXT NOT NULL DEFAULT 'pending',
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at      TIMESTAMPTZ NOT NULL,
            approved_at     TIMESTAMPTZ,
            approved_by_user_id TEXT
        )
    `);
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_nc_bindings_active
        ON pending_nc_bindings (org_id, nc_instance_id) WHERE status = 'pending'`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_pending_nc_bindings_org_status
        ON pending_nc_bindings (org_id, status)`);
    console.log('[Migration] nc-pending-bindings-2026-05 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
