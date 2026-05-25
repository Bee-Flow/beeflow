/**
 * Per-automation + per-org quota gate (§12 scaffolding).
 *
 * Token-bucket-style consumer the runner consults before kicking off
 * each run. When a bucket is exhausted, the request is enqueued on
 * `automation_run_queue` and a drain job (cron tick) replays them as
 * capacity returns.
 *
 * Phase 1 contract — backed by a Redis-or-Postgres token bucket in
 * Phase 2. Today this is an inert pass-through so the runner code can
 * already call it without conditionals.
 *
 * Public:
 *   tryConsume({ automationId, orgId }) → { allowed, retryAfterMs? }
 *
 * Phase 2 work: read limits from automation_quota_limits, track
 * counters in automation_quota_counters (or Redis), implement the
 * queue drain.
 */

async function tryConsume(/* { automationId, orgId } */) {
    return { allowed: true };
}

module.exports = { tryConsume };
