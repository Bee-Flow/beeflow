/**
 * Migration: convert automations.shared_groups from TEXT to JSONB (§WS3.6).
 *
 * shared_groups was created as `TEXT NOT NULL DEFAULT '[]'` (a JSON string),
 * while the sibling array columns kb_ids/skill_ids are real JSONB. That forced a
 * manual JSON.parse on every read and blocked jsonb containment queries
 * (shared_groups @> ...) for group-scoped catalog lookups. The store's readers
 * already accept both a string and an array, and the writer passes a
 * JSON.stringify'd value (which JSONB accepts), so this conversion is safe with
 * the existing code.
 *
 * Idempotent: only runs when the column exists and is not already jsonb.
 */

const { exec } = require('../db');

async function up() {
    await exec(`
        DO $$
        BEGIN
            IF to_regclass('public.automations') IS NOT NULL
               AND EXISTS (
                   SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'automations'
                      AND column_name = 'shared_groups'
                      AND data_type <> 'jsonb'
               ) THEN
                ALTER TABLE automations ALTER COLUMN shared_groups DROP DEFAULT;
                ALTER TABLE automations
                    ALTER COLUMN shared_groups TYPE JSONB
                    USING (
                        CASE
                            WHEN shared_groups IS NULL OR btrim(shared_groups) = '' THEN '[]'::jsonb
                            ELSE shared_groups::jsonb
                        END
                    );
                ALTER TABLE automations ALTER COLUMN shared_groups SET DEFAULT '[]'::jsonb;
                ALTER TABLE automations ALTER COLUMN shared_groups SET NOT NULL;
            END IF;
        END $$;
    `);

    console.log('[Migration] automation-shared-groups-jsonb-2026-06 applied');
}

module.exports = { up };
