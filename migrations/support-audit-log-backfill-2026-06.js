/**
 * Migration: backfill support_audit_log from the legacy support_thread_events.
 *
 * The unified audit log (support_audit_log) is the superset the tenant Support
 * studio reads from: it carries org/inbox scope and the PRECISE actor kind
 * (incl. 'ai'/'automation'), whereas the legacy support_thread_events only had
 * staff/system/requester and no org/inbox columns. New events dual-write to both
 * tables; this one-shot copies historical rows so the new Audit view isn't empty
 * on existing installs.
 *
 * Derivations:
 *   - organization_id / inbox_id: joined from support_threads.
 *   - actor_kind: legacy 'system' rows whose action looks like an AI action
 *     (action LIKE 'ai\_%', or a resolve marked by:'ai') become 'ai'; the
 *     classifier/SLA actions become 'automation'; everything else keeps its
 *     original kind.
 *
 * Idempotent: rows are keyed by the SAME id as the source event and inserted
 * only WHERE NOT EXISTS, so re-runs copy nothing.
 */

const { exec } = require('../db');

async function up() {
    const res = await exec(`
        DO $$
        DECLARE copied integer := 0;
        BEGIN
            IF to_regclass('public.support_thread_events') IS NOT NULL
               AND to_regclass('public.support_audit_log') IS NOT NULL THEN
                INSERT INTO support_audit_log
                    (id, organization_id, inbox_id, thread_id, actor_kind, actor_user_id, action, payload, created_at)
                SELECT e.id, t.organization_id, t.inbox_id, e.thread_id,
                       CASE
                           WHEN e.actor_kind = 'system'
                                AND (e.action LIKE 'ai\\_%' OR (e.action = 'resolved' AND e.payload->>'by' = 'ai'))
                               THEN 'ai'
                           WHEN e.actor_kind = 'system'
                                AND e.action IN ('classified_not_support', 'sla_breach')
                               THEN 'automation'
                           ELSE e.actor_kind
                       END,
                       e.actor_user_id, e.action, e.payload, e.created_at
                FROM support_thread_events e
                LEFT JOIN support_threads t ON t.id = e.thread_id
                WHERE NOT EXISTS (SELECT 1 FROM support_audit_log a WHERE a.id = e.id);
                GET DIAGNOSTICS copied = ROW_COUNT;
                RAISE NOTICE 'support-audit-log-backfill: % event(s) copied', copied;
            ELSE
                RAISE NOTICE 'support-audit-log-backfill: support tables absent, nothing to do';
            END IF;
        END $$;
    `);

    console.log('[Migration] support-audit-log-backfill-2026-06 applied', res?.rowCount != null ? `(rowCount=${res.rowCount})` : '');
}

module.exports = { up };
