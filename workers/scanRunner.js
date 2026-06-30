/**
 * Security Scan Runner worker — drains security_scan_jobs and executes one or
 * more security engines against a target URL inside throwaway, network-isolated
 * containers.
 *
 * A scan selects one or more engines (zap / nuclei / testssl). Each engine runs
 * in its OWN short-lived container with its OWN sub-workdir; we read that
 * engine's report.json back, normalize it, and aggregate every engine's
 * findings into a single security report. The report is rendered to a hosted
 * webpage so the user can share/read it, and the structured findings +
 * severity summary are persisted on the scan row.
 *
 * Pattern mirrors workers/testRunner.js — claim outbox rows under
 * SELECT … FOR UPDATE SKIP LOCKED, process, mark delivered. Each scan row gets
 * a single in-flight attempt; transient errors bump attempt_count and the
 * backoff retries on the next tick.
 *
 * Unlike the test runner there is NO host fallback: security scanners are
 * untrusted, heavy, and must never run in the API/worker process. If a docker
 * socket is not reachable the scan hard-errors.
 */

const crypto = require('crypto');

const securityScanStore = require('../stores/securityScanStore');
const scanRunner = require('../services/scanRunner');

// SSRF guard is shared with the test runner — block targets that resolve into
// RFC1918, loopback, link-local, or private IPv6 ranges. Defence in depth: a
// malicious user could otherwise drive a scanner against an internal service
// from our own host.
const { isPrivateTarget } = require('./testRunner');

const HARD_FAIL_DAYS = 14;
const ENGINE_TIMEOUT_MS = parseInt(process.env.SECURITY_SCANNER_TIMEOUT_MS || '900000', 10); // 15 min
const WORKER_ID = `sc-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

// ── Concurrency caps ───────────────────────────────────────────────
// Scans that would exceed a cap stay `queued` and are claimed once a slot
// frees. The global cap doubles as the container-pool size. Security scans are
// far heavier than test runs, so the defaults are deliberately tight.
const MAX_PER_USER = parseInt(process.env.SECURITY_MAX_CONCURRENT_PER_USER || '1', 10);
const MAX_PER_ORG = parseInt(process.env.SECURITY_MAX_CONCURRENT_PER_ORG || '2', 10);
const MAX_GLOBAL = parseInt(process.env.SECURITY_MAX_CONCURRENT_GLOBAL || '3', 10);

// ── Execution mode ─────────────────────────────────────────────────
// Always 'container' — there is no host fallback. Either a docker socket is
// reachable and we run each engine in an isolated container, or we hard-error.
// Never run untrusted security scanners in the API/worker process.
async function resolveExecMode() {
    const dockerOk = await scanRunner.dockerAvailable();
    return dockerOk ? 'container' : 'error';
}

function isHardFailed(ageMs) {
    return ageMs > HARD_FAIL_DAYS * 86_400_000;
}

// ── Agent mode ─────────────────────────────────────────────────────
//
// AI-driven scan: Claude drives ONE container (the Kali toolbox) that holds the
// full arsenal AND runs the ZAP daemon inside itself. The agent steps through
// the scan live, streaming each action/scanstat/terminal event. The toolbox
// carries this scan's bf.scanId label, so the cancel poll's killScan() and the
// reaper tear it down too; we also cleanup() explicitly in finally.

// Shell-quote a value for safe interpolation into a single in-container command.
function shQuote(v) {
    return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

async function runAgentMode({ scanId, targetUrl, engines, userId, organizationId, modelTier, aggression, maxSteps, prewarmId }) {
    const securityScanDriver = require('../services/securityScanDriver');
    const onLine = (line) => securityScanStore.appendProgress(scanId, line).catch(() => {});
    let toolbox = null;
    try {
        // Adopt the pre-warmed toolbox if the dialog warmed one and it's still in
        // the in-process registry; otherwise cold-start.
        if (prewarmId) {
            toolbox = await scanRunner.adoptToolbox(prewarmId);
            if (toolbox) await securityScanStore.appendProgress(scanId, '[scan] using pre-warmed toolbox + ZAP daemon').catch(() => {});
        }
        if (!toolbox) {
            await securityScanStore.appendProgress(scanId, '[scan] starting toolbox container + ZAP daemon (this can take ~60s)…').catch(() => {});
            toolbox = await scanRunner.startAgentToolbox({ scanId, onLine });
        }
        scanRunner.registerActiveToolbox(scanId, toolbox);

        // Capture full stdout from an in-container command (for reading reports).
        const capture = async (command, timeoutMs) => {
            let out = '';
            const r = await toolbox.exec(command, {
                onChunk: (c) => { if (c?.stream === 'stdout' && out.length < 4_000_000) out += String(c.chunk); },
                timeoutMs,
            });
            return { out, exitCode: r.exitCode, timedOut: r.timedOut };
        };

        // Adapter the driver calls for its nuclei_run / testssl_run convenience
        // tools. The binaries are baked into the toolbox, so we run them via
        // in-container exec (writing JSON into the workdir) and read it back —
        // no throwaway containers, no bind mounts.
        const runEngine = async (engine, opts = {}) => {
            const outFile = `/home/scanner/work/agent-${engine}.json`;
            let cmd;
            if (engine === 'nuclei') {
                const tags = opts.tags ? ` -tags ${shQuote(opts.tags)}` : '';
                const templates = opts.templates ? ` -t ${shQuote(opts.templates)}` : '';
                cmd = `nuclei -u ${shQuote(targetUrl)} -je ${outFile} -silent${tags}${templates}`;
            } else if (engine === 'testssl') {
                cmd = `testssl.sh --jsonfile ${outFile} --quiet ${shQuote(targetUrl)}`;
            } else {
                return { json: null, exitCode: 1, timedOut: false };
            }
            const r = await toolbox.exec(`rm -f ${outFile}; ${cmd}`, { onChunk: onLine ? (c) => {} : undefined, timeoutMs: ENGINE_TIMEOUT_MS });
            const read = await capture(`cat ${outFile} 2>/dev/null || true`, 30000);
            let json = null;
            try { json = JSON.parse(read.out); } catch (_) { /* missing/corrupt/no findings */ }
            return { json, exitCode: r.exitCode, timedOut: r.timedOut };
        };

        return await securityScanDriver.runAgentScan({
            scanId, targetUrl, engines, userId, organizationId,
            modelTier, aggression, maxSteps,
            zap: toolbox.zap,
            terminal: { exec: toolbox.exec },
            // NOTE: do NOT pass onLine here — the driver's log() already writes
            // every line to the store via appendProgress; passing appendProgress
            // again as onLine would double every line in the progress stream.
            runEngine,
        });
    } finally {
        scanRunner.unregisterActiveToolbox(scanId);
        if (toolbox) { try { await toolbox.cleanup(); } catch (_) {} }
    }
}

// ── Drain loop ────────────────────────────────────────────────────

async function processScan(claim) {
    const { scan_id: scanId, user_id: userId, organization_id: organizationId, target_url: targetUrl, engines: rawEngines, metadata: rawMetadata, model_tier: rawModelTier, aggression: rawAggression } = claim;
    // Every scan is AI-agent driven now.
    const modelTier = rawModelTier || null;
    const aggression = rawAggression || null;
    // Optional autonomy/step budget + pre-warmed toolbox handle from metadata.
    let stepBudget = null;
    let prewarmId = null;
    try {
        const md = typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : (rawMetadata || null);
        if (md && Number.isFinite(Number(md.stepBudget))) stepBudget = Number(md.stepBudget);
        if (md && typeof md.prewarmId === 'string') prewarmId = md.prewarmId;
    } catch (_) { /* metadata optional */ }

    // Re-check the SSRF guard at claim time — the row may have sat queued long
    // enough for DNS to start resolving to a private address, and the guard is
    // cheap to re-run.
    if (isPrivateTarget(targetUrl)) {
        await securityScanStore.markFinished(scanId, {
            status: 'error',
            error: 'target_url resolves to a private/internal address; blocked for safety.',
        });
        return { ok: true, status: 'error' };
    }

    const execMode = await resolveExecMode();
    if (execMode === 'error') {
        await securityScanStore.markFinished(scanId, {
            status: 'error',
            error: 'docker_unavailable: security scans require an isolated container.',
        });
        return { ok: true, status: 'error' };
    }

    // engines is stored as JSONB; the claim may hand it back as a string or an
    // already-parsed array depending on the driver.
    let engines = [];
    try { engines = typeof rawEngines === 'string' ? JSON.parse(rawEngines) : (rawEngines || []); } catch (_) {}
    if (!Array.isArray(engines) || engines.length === 0) {
        await securityScanStore.markFinished(scanId, {
            status: 'error',
            error: 'no_engines: the scan was created without any engines selected.',
        });
        return { ok: true, status: 'error' };
    }

    await securityScanStore.markRunning(scanId);

    // Poll for cancellation and tear down the toolbox container if the user
    // cancels mid-scan (killScan removes every container with this bf.scanId).
    const cancelPoll = setInterval(() => {
        if (securityScanStore.isCancelRequested) {
            Promise.resolve(securityScanStore.isCancelRequested(scanId))
                .then((c) => { if (c) scanRunner.killScan(scanId).catch(() => {}); })
                .catch(() => {});
        }
    }, 2000);
    cancelPoll.unref?.();

    let outcome;
    try {
        outcome = await runAgentMode({
            scanId, targetUrl, engines, userId, organizationId,
            modelTier, aggression, maxSteps: stepBudget, prewarmId,
        });
    } catch (e) {
        outcome = { status: 'error', error: `worker_exception: ${e.message}` };
    } finally {
        clearInterval(cancelPoll);
    }

    if (outcome.status === 'cancelled') {
        await securityScanStore.markCancelled(scanId, userId).catch(async () => {
            await securityScanStore.markFinished(scanId, { status: 'cancelled', error: 'cancelled' });
        });
    } else if (outcome.status === 'error') {
        await securityScanStore.markFinished(scanId, { status: 'error', error: outcome.error || 'unknown_error' });
    } else {
        await securityScanStore.markFinished(scanId, {
            status: outcome.status,
            reportJson: outcome.reportJson,
            reportWebpageId: outcome.reportWebpageId || null,
            severitySummary: outcome.severitySummary || null,
        });
    }

    return { ok: true, status: outcome.status };
}

async function drainOnce(targetScanId = null) {
    const claimed = await securityScanStore.claimDueJobs({
        batchSize: MAX_GLOBAL,
        perUserCap: MAX_PER_USER,
        orgCap: MAX_PER_ORG,
        globalCap: MAX_GLOBAL,
        targetScanId,
        workerId: WORKER_ID,
    });
    if (claimed.length === 0) return { processed: 0 };

    let processed = 0;
    for (const claim of claimed) {
        const ageMs = Date.now() - (claim.created_at ? new Date(claim.created_at).getTime() : Date.now());
        if (isHardFailed(ageMs)) {
            await securityScanStore.markFinished(claim.scan_id, {
                status: 'error',
                error: `hard_failed_after_${HARD_FAIL_DAYS}_days`,
            });
            continue;
        }
        try {
            await processScan(claim);
            processed++;
        } catch (e) {
            await securityScanStore.markRetryable(claim.scan_id, e.message);
        }
    }
    return { processed };
}

async function drainOne(scanId) {
    if (!scanId) return null;
    return drainOnce(scanId);
}

// Remove orphaned runner containers. A scan is "active" if its row is still
// queued/running — anything else is safe to reap. Called on worker boot and
// on an interval.
async function reapRunners() {
    return scanRunner.reapStaleRunners(async (scanId) => {
        try {
            const s = await securityScanStore.getScan(scanId);
            return !!s && (s.status === 'queued' || s.status === 'running');
        } catch (_) {
            return false;
        }
    });
}

module.exports = {
    drainOnce,
    drainOne,
    reapRunners,
    isPrivateTarget,
    // exported for tests
    _internals: { resolveExecMode, processScan, shQuote },
};
