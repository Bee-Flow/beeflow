/**
 * Migration: Stripe subscription cancel-at-period-end + period tracking (2026-05).
 *
 * Adds, on both organization_subscriptions and consumer_subscriptions:
 *   - cancel_at_period_end BOOLEAN — mirror of Stripe's flag; when true the
 *     sub stays 'active' until cancel_at, then transitions via the
 *     subscription.deleted webhook
 *   - cancel_at TIMESTAMPTZ — the scheduled cancellation moment (Stripe's
 *     cancel_at). NULL when no cancel is scheduled
 *   - current_period_end TIMESTAMPTZ — mirrors Stripe's current_period_end so
 *     the UI can render a "cancels on …" countdown without an extra Stripe call
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 */

const { exec } = require('../db');

async function up() {
    await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE`);
    await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ`);
    await exec(`ALTER TABLE organization_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ`);

    await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE`);
    await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS cancel_at TIMESTAMPTZ`);
    await exec(`ALTER TABLE consumer_subscriptions ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ`);

    console.log('[Migration] stripe-cancel-and-period-end-2026-05 applied');
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
