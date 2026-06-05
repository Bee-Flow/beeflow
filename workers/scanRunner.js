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

const fs = require('fs');
const os = require('os');
const path = require('path');
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

// Base dir for the per-engine sub-workdirs. When the worker is containerized the
// bind path must be valid on the HOST, so we use a workdir that compose mounts
// at an identical path on both sides. Native workers just use os.tmpdir().
function runnerWorkdirBase() {
    if (scanRunner.isServerInContainer && scanRunner.isServerInContainer()) {
        return process.env.SECURITY_SCANNER_WORKDIR || '/var/lib/beeflow/scan';
    }
    return process.env.SECURITY_SCANNER_WORKDIR || os.tmpdir();
}

function isHardFailed(ageMs) {
    return ageMs > HARD_FAIL_DAYS * 86_400_000;
}

// Stable, filesystem-safe slug for an engine descriptor so each engine gets its
// own sub-workdir (zap-baseline / zap-full / nuclei / testssl).
function engineSlug(descriptor, idx) {
    const parts = [descriptor.engine];
    if (descriptor.engine === 'zap' && descriptor.intensity) parts.push(descriptor.intensity);
    const slug = parts.join('-').replace(/[^a-zA-Z0-9_-]/g, '');
    return `${idx}-${slug || 'engine'}`;
}

// ── Scan execution ─────────────────────────────────────────────────

/**
 * Run every selected engine in its own container + sub-workdir, read each
 * engine's report.json (tolerating a missing/corrupt file from an OOM, timeout
 * or crash), and return the raw per-engine reports keyed by engine name. The
 * worker hands these to the report builder for normalization/aggregation.
 */
async function runEngines({ scanId, engines, targetUrl, tmpRoot }) {
    const rawReports = []; // { engine, json|null, exitCode, timedOut }
    let cancelled = false;

    for (let i = 0; i < engines.length; i++) {
        const descriptor = engines[i];
        // Bail out of the remaining engines if the user cancelled mid-scan.
        // isCancelRequested is synchronous (in-memory Set) — no .catch().
        if (securityScanStore.isCancelRequested(scanId)) {
            cancelled = true;
            break;
        }

        const subWorkdir = path.join(tmpRoot, engineSlug(descriptor, i));
        await fs.promises.mkdir(subWorkdir, { recursive: true }).catch(() => {});
        // The API/worker runs as root but the scanner images run as a non-root
        // user (e.g. ZAP = uid 1000). The engine bind-mounts this dir at its
        // report path and must be able to WRITE report.json + its own working
        // files there, so open the mounted dir up to the container's user.
        await fs.promises.chmod(subWorkdir, 0o777).catch(() => {});

        await securityScanStore.appendProgress(scanId, `[scan] starting engine ${descriptor.engine}${descriptor.intensity ? ` (${descriptor.intensity})` : ''}`).catch(() => {});

        let result;
        try {
            result = await scanRunner.runEngineContainer({
                scanId,
                engine: descriptor.engine,
                intensity: descriptor.intensity || null,
                workdir: subWorkdir,
                targetUrl,
                onLine: (line) => securityScanStore.appendProgress(scanId, line).catch(() => {}),
                timeoutMs: ENGINE_TIMEOUT_MS,
            });
        } catch (e) {
            // A failed engine doesn't sink the whole scan — record it and carry
            // on so the other engines still produce findings.
            await securityScanStore.appendProgress(scanId, `[scan] engine ${descriptor.engine} failed: ${e.message}`).catch(() => {});
            rawReports.push({ engine: descriptor.engine, json: null, exitCode: 1, timedOut: false, error: e.message });
            continue;
        }

        // Every engine in the contract writes its report to <workdir>/report.json.
        let json = null;
        try {
            json = JSON.parse(await fs.promises.readFile(path.join(subWorkdir, 'report.json'), 'utf-8'));
        } catch (_) { /* OOM / timeout / crash / no findings — no report */ }

        if (result.timedOut) {
            await securityScanStore.appendProgress(scanId, `[scan] engine ${descriptor.engine} exceeded ${ENGINE_TIMEOUT_MS}ms and was stopped`).catch(() => {});
        }
        rawReports.push({ engine: descriptor.engine, json, exitCode: result.exitCode, timedOut: result.timedOut });
    }

    return { rawReports, cancelled };
}

// ── Agent mode ─────────────────────────────────────────────────────
//
// AI-driven scan: Claude drives a long-lived ZAP daemon (REST API) + a
// free-form tools sandbox step-by-step, streaming each action/scanstat/terminal
// event live. The daemon + sandbox carry this scan's bf.scanId label, so the
// cancel poll's killScan() and the reaper tear them down too; we also cleanup()
// explicitly in finally. Returns the same outcome shape as quick mode.
async function runAgentMode({ scanId, targetUrl, engines, userId, organizationId, tmpRoot, startedAt }) {
    const securityScanDriver = require('../services/securityScanDriver');
    const onLine = (line) => securityScanStore.appendProgress(scanId, line).catch(() => {});
    let daemon = null;
    let sandbox = null;
    try {
        await securityScanStore.appendProgress(scanId, '[scan] starting ZAP daemon (this can take ~30s)…').catch(() => {});
        daemon = await scanRunner.startZapDaemon({ scanId, onLine });
        await securityScanStore.appendProgress(scanId, '[scan] starting tools sandbox…').catch(() => {});
        sandbox = await scanRunner.startToolsSandbox({ scanId, onLine });

        // Adapter the driver calls for its nuclei_run / testssl_run tools. opts
        // is ignored for these engines (no intensity); the engine writes its
        // report into a per-engine sub-workdir (chmod 0777 so the non-root
        // scanner image can write it) which we read back.
        const runEngine = async (engine /*, opts */) => {
            const sub = path.join(tmpRoot, `agent-${engine}`);
            await fs.promises.mkdir(sub, { recursive: true }).catch(() => {});
            await fs.promises.chmod(sub, 0o777).catch(() => {});
            const r = await scanRunner.runEngineContainer({
                scanId, engine, intensity: null, workdir: sub, targetUrl,
                onLine,
                timeoutMs: ENGINE_TIMEOUT_MS,
            });
            let json = null;
            try { json = JSON.parse(await fs.promises.readFile(path.join(sub, 'report.json'), 'utf-8')); } catch (_) { /* missing/corrupt */ }
            return { json, exitCode: r.exitCode, timedOut: r.timedOut };
        };

        return await securityScanDriver.runAgentScan({
            scanId, targetUrl, engines, userId, organizationId,
            maxSteps: null,
            zap: { baseUrl: daemon.baseUrl, apiKey: daemon.apiKey },
            terminal: { exec: sandbox.exec },
            // NOTE: do NOT pass onLine here — the driver's log() already writes
            // every line to the store via appendProgress; passing appendProgress
            // again as onLine would double every line in the progress stream.
            runEngine,
        });
    } finally {
        if (daemon) { try { await daemon.cleanup(); } catch (_) {} }
        if (sandbox) { try { await sandbox.cleanup(); } catch (_) {} }
    }
}

// ── Drain loop ────────────────────────────────────────────────────

async function processScan(claim) {
    const { scan_id: scanId, user_id: userId, organization_id: organizationId, target_url: targetUrl, engines: rawEngines, metadata: rawMetadata, mode: rawMode } = claim;
    const mode = rawMode === 'agent' ? 'agent' : 'quick';

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

    const startedAt = new Date().toISOString();
    const base = runnerWorkdirBase();
    await fs.promises.mkdir(base, { recursive: true }).catch(() => {});
    const tmpRoot = await fs.promises.mkdtemp(path.join(base, 'bf-scan-'));

    // Poll for cancellation and kill any in-flight engine container. runEngines
    // also checks the flag between engines so we stop launching new ones.
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
      if (mode === 'agent') {
        outcome = await runAgentMode({ scanId, targetUrl, engines, userId, organizationId, tmpRoot, startedAt });
      } else {
        const { rawReports, cancelled } = await runEngines({ scanId, engines, targetUrl, tmpRoot });

        if (cancelled) {
            outcome = { status: 'cancelled', error: 'cancelled' };
        } else {
            // Normalize each engine's raw report, aggregate into a single findings
            // set + severity summary, render the report page, and host it.
            const reportBuilder = require('../services/securityReportBuilder');

            const findingArrays = [];
            for (const r of rawReports) {
                if (!r.json) continue;
                try {
                    if (r.engine === 'zap') findingArrays.push(reportBuilder.normalizeZap(r.json));
                    else if (r.engine === 'nuclei') findingArrays.push(reportBuilder.normalizeNuclei(r.json));
                    else if (r.engine === 'testssl') findingArrays.push(reportBuilder.normalizeTestssl(r.json));
                } catch (e) {
                    await securityScanStore.appendProgress(scanId, `[scan] could not parse ${r.engine} report: ${e.message}`).catch(() => {});
                }
            }

            const { findings, severitySummary } = reportBuilder.aggregate(findingArrays);
            const finishedAt = new Date().toISOString();

            const { html, css } = reportBuilder.renderReportHtml({
                targetUrl,
                engines,
                findings,
                severitySummary,
                startedAt,
                finishedAt,
            });

            // Persist the rendered report as a hosted webpage. Best-effort: a
            // storage hiccup shouldn't sink an otherwise-complete scan, so we
            // still finish with the structured findings even if hosting fails.
            let reportWebpageId = null;
            try {
                reportWebpageId = await reportBuilder.persistReportWebpage({ userId, targetUrl, html, css });
            } catch (e) {
                await securityScanStore.appendProgress(scanId, `[scan] report page could not be hosted: ${e.message}`).catch(() => {});
            }

            const reportJson = {
                targetUrl,
                engines,
                startedAt,
                finishedAt,
                severitySummary,
                findings,
            };

            outcome = { status: 'completed', reportJson, reportWebpageId, severitySummary };
        }
      }
    } catch (e) {
        outcome = { status: 'error', error: `worker_exception: ${e.message}` };
    } finally {
        clearInterval(cancelPoll);
        // Clean up the workdir tree best-effort. Reports have already been read
        // back into memory by this point; we still don't want disk to grow.
        fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
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
    _internals: { runEngines, engineSlug, resolveExecMode, runnerWorkdirBase, processScan },
};
