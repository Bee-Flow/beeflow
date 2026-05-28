/**
 * Dedicated test-runner worker process.
 *
 * Runs ONLY the Playwright test-run drain + the orphaned-container reaper —
 * no Express, no HTTP, no other schedulers. Deploying this as its own service
 * keeps headless-browser work out of the API process and makes it the single
 * owner of the outbox drain (so the concurrency-cap accounting is unambiguous).
 *
 * Start with: `node workers/testRunnerProcess.js`
 * When this is deployed, set PLAYWRIGHT_DRAIN_IN_API=false on the API service
 * so the API stops draining and this process is the only claimer.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const testRunner = require('./testRunner');

const DRAIN_INTERVAL_MS = parseInt(process.env.PLAYWRIGHT_DRAIN_TICK_INTERVAL_MS || '15000', 10);
const REAP_INTERVAL_MS = parseInt(process.env.PLAYWRIGHT_REAP_INTERVAL_MS || '120000', 10); // 2 min

let draining = false;
async function tick() {
    if (draining) return; // never overlap drains in a single process
    draining = true;
    try {
        const r = await testRunner.drainOnce();
        if (r?.processed) console.log(`[TestRunnerWorker] processed=${r.processed}`);
    } catch (e) {
        console.error('[TestRunnerWorker] drain tick error:', e.message);
    } finally {
        draining = false;
    }
}

async function reapTick() {
    try {
        const r = await testRunner.reapRunners();
        if (r?.reaped) console.log(`[TestRunnerWorker] reaped=${r.reaped} stale container(s)`);
    } catch (e) {
        console.error('[TestRunnerWorker] reap tick error:', e.message);
    }
}

async function main() {
    console.log(`[TestRunnerWorker] starting (drain=${DRAIN_INTERVAL_MS}ms, reap=${REAP_INTERVAL_MS}ms)`);
    // Reap orphans left behind by a previously crashed worker BEFORE we start
    // claiming, so stale containers don't count against the global cap.
    await reapTick();

    setInterval(tick, DRAIN_INTERVAL_MS);
    setInterval(reapTick, REAP_INTERVAL_MS);
    // Kick once at boot so a queued run doesn't wait a full tick.
    tick();
}

main().catch((e) => {
    console.error('[TestRunnerWorker] fatal:', e);
    process.exit(1);
});
