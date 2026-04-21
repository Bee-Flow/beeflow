/**
 * Compliance Scheduler — periodic runAll invocation for the default org.
 *
 * For multi-tenant installs, the primary refresh mechanism is the on-demand
 * auto-run in routes/compliance.js (/overview triggers a sync run for the
 * caller's org on first visit, and a fire-and-forget refresh when data is
 * older than 6 hours). This scheduler is a belt-and-braces fallback for
 * single-tenant installs (orgId='default') where users may never open the
 * Compliance Hub but we still want fresh scan results in the background.
 *
 * To extend to per-tenant scheduling, iterate user organizations via
 * userStore and call runner.runAll(orgId) for each.
 */

const runner = require('./runner');

const SCHEDULER_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let _timer = null;

function start(orgId = 'default') {
    if (_timer) return;
    // Initial delayed run (90s after boot so PII/Guard services come up first)
    const initial = setTimeout(() => runner.runAll(orgId).catch(e =>
        console.warn('[ComplianceScheduler] initial run failed:', e.message)
    ), 90 * 1000);
    if (initial.unref) initial.unref();

    _timer = setInterval(() => {
        runner.runAll(orgId).catch(e =>
            console.warn('[ComplianceScheduler] scheduled run failed:', e.message)
        );
    }, SCHEDULER_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    console.log(`[ComplianceScheduler] Started for org="${orgId}" — interval ${SCHEDULER_INTERVAL_MS / 60000} min`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop };
