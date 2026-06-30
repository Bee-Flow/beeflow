/**
 * Migration: add the missing FK + ON DELETE CASCADE to automation child tables (§WS3.2).
 *
 * automation_versions / runs / run_steps / webhooks / event_subscriptions all
 * declare `automation_id ... REFERENCES automations(id) ON DELETE CASCADE`, but
 * the Phase-2 scaffolding tables were created with plain `TEXT NOT NULL` columns
 * and NO foreign key. deleteAutomation() relies purely on FK cascade, so once the
 * Phase-2 writers ship, deleting an automation would leave orphaned rows that
 * accumulate forever. This adds the constraints so deletes cascade correctly.
 *
 * Each constraint is added inside a guarded DO block that:
 *   1. skips if the table doesn't exist yet (to_regclass),
 *   2. skips if the constraint already exists (idempotent re-run),
 *   3. deletes any pre-existing orphan rows first (else ADD CONSTRAINT errors).
 * The Phase-2 writers are still stubs today, so in practice there are no orphans
 * to clean — but the guard makes the migration safe on any data state.
 */

const { exec } = require('../db');

async function addFk({ table, column, refTable, constraint }) {
    await exec(`
        DO $$
        BEGIN
            IF to_regclass('public.${table}') IS NOT NULL
               AND to_regclass('public.${refTable}') IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${constraint}') THEN
                DELETE FROM ${table} c
                 WHERE c.${column} IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM ${refTable} r WHERE r.id = c.${column});
                ALTER TABLE ${table}
                    ADD CONSTRAINT ${constraint}
                    FOREIGN KEY (${column}) REFERENCES ${refTable}(id) ON DELETE CASCADE;
            END IF;
        END $$;
    `);
}

async function up() {
    await addFk({ table: 'automation_trigger_samples', column: 'automation_id', refTable: 'automations', constraint: 'fk_trigger_samples_automation' });
    await addFk({ table: 'automation_approval_audit', column: 'run_id', refTable: 'automation_runs', constraint: 'fk_approval_audit_run' });
    await addFk({ table: 'automation_alert_rules', column: 'automation_id', refTable: 'automations', constraint: 'fk_alert_rules_automation' });
    await addFk({ table: 'automation_alert_events', column: 'automation_id', refTable: 'automations', constraint: 'fk_alert_events_automation' });
    await addFk({ table: 'automation_alert_events', column: 'rule_id', refTable: 'automation_alert_rules', constraint: 'fk_alert_events_rule' });

    console.log('[Migration] automation-fk-cascade-2026-06 applied');
}

module.exports = { up };
