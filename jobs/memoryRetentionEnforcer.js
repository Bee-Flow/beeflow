/**
 * Memory Retention Enforcer — implements GDPR Art. 5(1)(e) "storage limitation"
 * for the user_memories table.
 *
 * Runs every 24 hours:
 *   1. UPDATE active memories whose `expires_at` is in the past → status='expired'.
 *   2. Stamp a heartbeat on `compliance_settings.last_retention_run_at` so the
 *      Art-5(1)(e) compliance check can verify the job is alive.
 *
 * Iterates every organization so multi-tenant installs aren't silently broken.
 * Sequential execution to avoid pool contention.
 */

const { run } = require('../db');
const complianceStore = require('../stores/complianceStore');
const userStore = require('../stores/userStore');

const INTERVAL_MS = 24 * 60 * 60 * 1000;
let _timer = null;
let _running = false;

async function _expireMemories() {
    try {
        const { rowCount } = await run(`
            UPDATE user_memories
            SET status = 'expired', updated_at = NOW()
            WHERE status = 'active'
              AND expires_at IS NOT NULL
              AND expires_at < NOW()
        `);
        return rowCount || 0;
    } catch (e) {
        console.warn('[MemoryRetentionEnforcer] expire query failed:', e.message);
        return 0;
    }
}

async function _stampHeartbeats() {
    const orgIds = new Set(['default']);
    try {
        const orgs = await userStore.getAllOrganizations();
        for (const o of orgs || []) {
            if (o?.id) orgIds.add(o.id);
        }
    } catch (e) {
        console.warn('[MemoryRetentionEnforcer] could not list orgs:', e.message);
    }
    for (const orgId of orgIds) {
        try { await complianceStore.markRetentionRun(orgId); }
        catch (e) { console.warn(`[MemoryRetentionEnforcer] heartbeat for "${orgId}" failed:`, e.message); }
    }
}

async function runOnce() {
    if (_running) return;
    _running = true;
    const started = Date.now();
    try {
        const expired = await _expireMemories();
        await _stampHeartbeats();
        console.log(`[MemoryRetentionEnforcer] swept in ${Date.now() - started} ms — expired ${expired} memories`);
    } finally {
        _running = false;
    }
}

function start() {
    if (_timer) return;
    // First sweep 2 minutes after boot so the DB is fully initialised.
    const initial = setTimeout(() => runOnce().catch(e =>
        console.warn('[MemoryRetentionEnforcer] initial sweep failed:', e.message)
    ), 120 * 1000);
    if (initial.unref) initial.unref();

    _timer = setInterval(() => {
        runOnce().catch(e =>
            console.warn('[MemoryRetentionEnforcer] scheduled sweep failed:', e.message)
        );
    }, INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    console.log(`[MemoryRetentionEnforcer] Started — interval ${INTERVAL_MS / 3600000} h`);
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop, runOnce };
