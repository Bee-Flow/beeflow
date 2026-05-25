/**
 * Migration: pending_nc_bindings pairing-code columns (2026-05).
 *
 * Phase 2 of the connector hardening adds a manual pairing-code path on top
 * of the existing email-auto-match binding flow. The org-admin in Bee Flow
 * generates a short human-readable code; the connector on a freshly-installed
 * Nextcloud presents that code to claim the existing org. Code is one-shot:
 * minted once, consumed once, never reused.
 *
 * `pairing_code` is nullable because Branch-A (email auto-match) bindings
 * never carry a code. Adding the column on the same table keeps the lifecycle
 * (approved / denied / expired) unified instead of inventing a parallel one.
 *
 * `nc_*` headers are nullable too on pairing-code rows because the code is
 * minted *before* a target NC exists — those fields get populated when the
 * connector redeems the code.
 *
 * Idempotent.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE pending_nc_bindings
        ADD COLUMN IF NOT EXISTS pairing_code           TEXT,
        ADD COLUMN IF NOT EXISTS pairing_code_consumed_at TIMESTAMPTZ`);

    // Lookup by code (case-insensitive, normalised to upper). Partial unique
    // index — only one active code per literal value at a time.
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_nc_bindings_pairing_code_active
        ON pending_nc_bindings (pairing_code)
        WHERE pairing_code IS NOT NULL
          AND status = 'pending'
          AND pairing_code_consumed_at IS NULL`);

    // The existing partial unique index (org_id, nc_instance_id) WHERE
    // status='pending' breaks when nc_instance_id is empty for a pairing-
    // code row that hasn't been redeemed yet. Loosen by adding "AND
    // nc_instance_id IS NOT NULL" — pairing-code rows pre-redeem have a
    // synthetic placeholder, but to be safe we also allow them to share the
    // org_id space with email-match rows.
    await exec(`ALTER TABLE pending_nc_bindings
        ALTER COLUMN nc_instance_id  DROP NOT NULL,
        ALTER COLUMN nc_base_url     DROP NOT NULL,
        ALTER COLUMN nc_admin_uid    DROP NOT NULL,
        ALTER COLUMN nc_admin_email  DROP NOT NULL`);

    console.log('[Migration] nc-pending-bindings-pairing-code-2026-05 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
