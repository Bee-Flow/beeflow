/**
 * Compliance Scheduler — periodic runAll invocation.
 *
 * Runs every SCHEDULER_INTERVAL_MS (default 6 hours) against the default
 * organization. Multi-tenant deployments should override with per-org
 * scheduling driven by a tenant list.
 */

const runner = require('./runner');

const SCHEDULER_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let _timer = null;

function start(orgId = 'default') {
    if (_timer) return;
    // Initial delayed run (90s after boot so PII/Guard services come up first)
    const initial = setTimeout(() => runner.runAll(orgId).catch(e =>
        console.error('[ComplianceScheduler] initial run failed:', e.message)
    ), 90 * 1000);
    if (initial.unref) initial.unref();

    _timer = setInterval(() => {
        runner.runAll(orgId).catch(e =>
            console.error('[ComplianceScheduler] scheduled run failed:', e.message)
        );
    }, SCHEDULER_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    console.log(`[ComplianceScheduler] Started — interval ${SCHEDULER_INTERVAL_MS / 60000} min`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop };
