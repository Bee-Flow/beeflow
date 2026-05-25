/**
 * Engine self-observability (§12 scaffolding).
 *
 * Exposes `/api/automation/_health` with the runner's internal vitals
 * so an org admin or the ops dashboard can see if the engine itself
 * is healthy. Phase 2 wires the ring buffers (claim wait p50/p95,
 * runs in-flight, queue depth, reaper tick age); Phase 1 returns a
 * minimal heartbeat so monitoring can already key alerts off it.
 */

const express = require('express');
const router = express.Router();

router.get('/_health', (req, res) => {
    res.json({
        ok: true,
        ts: new Date().toISOString(),
        // Phase 2: scheduler.tickAgeMs, reaper.tickAgeMs,
        // runsInFlight, queueDepth, claimWaitP50, claimWaitP95,
        // stuckCandidates, advisoryLockCount.
        version: 1,
    });
});

module.exports = router;
