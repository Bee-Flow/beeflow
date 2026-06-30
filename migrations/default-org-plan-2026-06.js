#!/usr/bin/env node
/**
 * Migration: ensure exactly one default org subscription plan exists (BFSF-226).
 *
 * seed-plans.js inserts the paid plans with is_default=false and the initDB
 * Free seed is skipped whenever any €0 org plan already exists, so production
 * could end up with NO is_default=TRUE row. createOrganization's default-plan
 * lookup then finds nothing, new orgs get no organization_subscriptions row,
 * getEffectiveLimits() returns null and every usage/seat/cost cap is
 * unenforced ("unlimited"), with the admin UI showing "No plan (custom)".
 *
 * This migration promotes the Free €0 org plan to is_default=TRUE (creating
 * it with the same column set/values as the initDB seed when missing), so
 * every NEW cloud org lands on a capped Free plan. NC-provisioned orgs still
 * get overridden right after creation by connectorBootstrap's nc_recommended
 * plan — no connector changes needed or made.
 *
 * EXISTING orgs without a subscription are deliberately NOT migrated (no
 * silent downgrade): they are only reported via a census console.warn so the
 * super-admin can assign plans explicitly per-org through the OrgEditor.
 *
 * Idempotent — skips when any default plan already exists (never clobbers an
 * operator's choice). Cloud-only: self-hosted never consults subscriptions.
 * Auto-runs from server boot (server/index.js). Manual usage:
 *   node server/migrations/default-org-plan-2026-06.js
 */

const crypto = require('crypto');
const { run, getOne, getAll } = require('../db');

async function up() {
    // (a) Cloud-only guard — matches the subscriptionsEnabled gate in
    // createOrganization; self-hosted resolves tiers without subscriptions.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') !== 'cloud') return null;

    // (b) Never clobber an operator's choice: if any default exists, only
    // run the report-only census below.
    const existingDefault = await getOne(
        'SELECT id FROM subscription_plans WHERE is_default = TRUE LIMIT 1'
    );
    if (existingDefault) {
        console.log(`[default-org-plan] default plan already set (${existingDefault.id}) — skipping promotion`);
    } else {
        // (c) Promote the Free org plan when one exists (prefer the row
        // actually named 'Free', else the oldest €0 org plan).
        const free = await getOne(
            `SELECT id FROM subscription_plans
              WHERE (plan_type = 'organization' OR plan_type IS NULL)
                AND (name = 'Free' OR price = 0)
              ORDER BY (name = 'Free') DESC, created_at ASC
              LIMIT 1`
        );
        if (free) {
            // Preserve the single-default invariant the admin CRUD enforces.
            await run('UPDATE subscription_plans SET is_default = FALSE WHERE is_default = TRUE');
            await run('UPDATE subscription_plans SET is_default = TRUE, updated_at = NOW() WHERE id = $1', [free.id]);
            console.log(`[default-org-plan] promoted Free org plan ${free.id} to default`);
        } else {
            // (d) No Free plan at all — create one, mirroring the initDB seed
            // in userStore.js (same columns/values, but is_default=TRUE here).
            const freeId = crypto.randomUUID();
            await run(
                `INSERT INTO subscription_plans (
                    id, name, plan_type, description, price, currency, billing_interval, billing_model,
                    markup_percent, trial_days, max_cost_per_month, max_users, max_agents, max_knowledge_sources,
                    allowed_features, allowed_models, allowed_integrations, allowed_beta_features,
                    is_public, is_default, nc_recommended, sort_order, created_at, updated_at
                 ) VALUES (
                    $1, 'Free', 'organization', 'Free tier — limited AI usage, no payment required.', 0, 'EUR', 'monthly', 'fixed',
                    0, 0, 5, 3, 1, 5,
                    '[]', '[]', '[]', '[]',
                    FALSE, TRUE, FALSE, 0, NOW(), NOW()
                 )`,
                [freeId]
            );
            console.log(`[default-org-plan] created default Free org plan ${freeId}`);
        }
    }

    // (e) Census of EXISTING no-plan orgs — report-only, NO writes. These
    // orgs keep their (unenforced) state until the super-admin assigns a
    // plan explicitly; auto-assigning here would be a silent downgrade.
    const orphans = await getAll(
        `SELECT o.id, o.name, o.nc_instance_id
           FROM organizations o
           LEFT JOIN organization_subscriptions s ON s.organization_id = o.id
          WHERE s.organization_id IS NULL`
    );
    if (orphans.length > 0) {
        console.warn(`[default-org-plan] ${orphans.length} org(s) without subscription (NOT auto-assigned — assign explicitly via Admin → Subscriptions → Organizations)`);
        for (const o of orphans) {
            console.warn(`[default-org-plan] org without subscription (NOT auto-assigned — assign explicitly via Admin → Subscriptions → Organizations): ${o.id} '${o.name}'${o.nc_instance_id ? ` nc=${o.nc_instance_id}` : ''}`);
        }
    }
    return orphans.length;
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
