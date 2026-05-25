/**
 * Sub-minute scheduler for enterprise-tier orgs (§27b scaffolding).
 *
 * Separate 10-second tick that only picks up automations whose org has
 * `tier='enterprise'` AND `definition.trigger.intervalMs < 60_000`.
 * Cron's resolution floor is 1 minute; this runs alongside the main
 * cron scheduler instead of replacing it so a misbehaving fast-tier
 * row can't slow the rest of the fleet down.
 *
 * Phase 2 work: implements the picker, the new `interval` trigger
 * kind, and the per-tier validate.js floor (free=15min, pro=5min,
 * enterprise=10s).
 */

let started = false;
let interval = null;

function start() {
    if (started) return;
    started = true;
    // Phase 2 wiring point — for now we mount the loop but no-op.
    interval = setInterval(() => {
        // tick(); — Phase 2: claim due fast-tier rows from
        // automation_run_queue or a dedicated interval table.
    }, 10_000);
}

function stop() {
    if (interval) clearInterval(interval);
    interval = null;
    started = false;
}

module.exports = { start, stop };
