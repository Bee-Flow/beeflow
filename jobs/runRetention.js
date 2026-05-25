/**
 * Run-history retention job (§13 scaffolding).
 *
 * Daily cron: archive automation_runs older than `org.runRetentionDays`
 * (default 30) into automation_runs_archive, aggregate counts/durations
 * into automation_run_daily_stats, then DELETE archived rows from the
 * hot table. Keeps run-list queries fast as orgs accumulate executions.
 *
 * Phase 2 work: implements the archive table + aggregate inserts + job
 * scheduler hook. This file is the entry point so the cron registry has
 * something to import once those land.
 */

async function runRetentionPass() {
    // Phase 2: query org settings, batch-move rows older than retention
    // window into automation_runs_archive, build per-day aggregates.
    // For now this is a no-op marker — wiring in next iteration.
    return { archived: 0, aggregated: 0, ts: new Date().toISOString() };
}

module.exports = { runRetentionPass };
