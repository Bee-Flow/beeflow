/**
 * Compliance Scheduler — periodic runAll across every organization.
 *
 * Behaviour:
 *   - 90 s after boot, kicks off the first sweep (lets PII / Guardrails come up first).
 *   - Every 6 hours thereafter, iterates `userStore.getAllOrganizations()` and
 *     runs all registered checks for each org sequentially. Sequential is
 *     intentional — concurrent runs across many orgs would saturate the DB
 *     pool (40 connections) and starve user-facing queries.
 *   - Always includes orgId='default' so single-tenant installs and shared
 *     fallbacks still get a scan.
 */

const runner = require('./runner');
const userStore = require('../stores/userStore');

const SCHEDULER_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let _timer = null;
let _running = false;

async function _runAllOrgs() {
    if (_running) {
        console.log('[ComplianceScheduler] previous sweep still running — skipping');
        return;
    }
    _running = true;
    const started = Date.now();
    try {
        // Always include 'default' so single-tenant installs are covered.
        const orgIds = new Set(['default']);
        try {
            const orgs = await userStore.getAllOrganizations();
            for (const o of orgs || []) {
                if (o?.id) orgIds.add(o.id);
            }
        } catch (e) {
            console.warn('[ComplianceScheduler] could not list organizations:', e.message);
        }
        for (const orgId of orgIds) {
            try {
                await runner.runAll(orgId, { runType: 'scheduled' });
            } catch (e) {
                console.warn(`[ComplianceScheduler] org="${orgId}" run failed:`, e.message);
            }
        }
        const ms = Date.now() - started;
        console.log(`[ComplianceScheduler] sweep complete — ${orgIds.size} org(s) in ${ms} ms`);
    } finally {
        _running = false;
    }
}

function start() {
    if (_timer) return;
    const initial = setTimeout(() => {
        _runAllOrgs().catch(e =>
            console.warn('[ComplianceScheduler] initial sweep failed:', e.message)
        );
    }, 90 * 1000);
    if (initial.unref) initial.unref();

    _timer = setInterval(() => {
        _runAllOrgs().catch(e =>
            console.warn('[ComplianceScheduler] scheduled sweep failed:', e.message)
        );
    }, SCHEDULER_INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    console.log(`[ComplianceScheduler] Started — interval ${SCHEDULER_INTERVAL_MS / 60000} min, multi-tenant`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, _runAllOrgs };
