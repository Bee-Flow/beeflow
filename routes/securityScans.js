/**
 * Security Scan Routes — scan run lifecycle + SSE + cancel + artifacts.
 *
 * Mounted in server/index.js behind:
 *   requireLicenseFeature('security_scan')
 *   requireBetaFeature('security_scan')
 *
 * Every scan is AI-agent driven: Claude drives the full toolbox inside one
 * isolated container. The legacy deterministic 'quick' pipeline is gone.
 *
 * Endpoints:
 *   GET    /scans/policy             — aggression levels + ceiling + netRaw flag
 *   POST   /scans                    — body: { targetUrl, engines?, authorized:true, modelTier?, aggression? }
 *   GET    /scans/active
 *   GET    /scans/:id
 *   GET    /scans/:id/report
 *   GET    /scans/:id/events         — SSE
 *   POST   /scans/:id/cancel
 *   GET    /scans/:id/artifacts
 *   GET    /scans/:id/artifacts/:artifactId
 *
 * Ownership: every endpoint filters by req.session.user.id. There's no
 * cross-user reading even within the same org for the beta; we'll add
 * org-admin escalation alongside the GA admin UI.
 *
 * Safety: scans only ever run against targets the requester explicitly
 * authorizes (authorized:true) and that pass the SSRF guard. Intrusive/attack
 * behaviour is governed by a graded aggression level (recon/passive/active/
 * offensive) clamped to the server ceiling SECURITY_MAX_AGGRESSION — see
 * core/securityAggression.js.
 */

const express = require('express');
const router = express.Router();

const securityScanStore = require('../stores/securityScanStore');
const scanRunner = require('../workers/scanRunner');
const scanRunnerSvc = require('../services/scanRunner');
const { checkSubscriptionLimits } = require('../core/limits');
const aggression = require('../core/securityAggression');

// Engines that seed the report header. In agent mode the agent drives the full
// toolbox inside one container, so this is metadata + a ZAP default rather than
// a fixed pipeline.
const VALID_ENGINES = ['zap', 'nuclei', 'testssl'];
const ZAP_INTENSITIES = ['baseline', 'full'];
const MODEL_TIER_RE = /^[a-zA-Z0-9_:-]{1,64}$/;

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

router.use(requireAuth);

// ── Policy ─────────────────────────────────────────────────────────
// Lets the New-scan UI know which aggression levels are available (so it can
// disable any above the server ceiling) and whether raw-socket tooling is on.
router.get('/scans/policy', (req, res) => {
    res.json({
        aggression: {
            levels: aggression.LEVELS,
            default: aggression.DEFAULT_AGGRESSION,
            ceiling: aggression.ceiling(),
        },
        netRaw: process.env.SECURITY_TOOLBOX_NET_RAW !== 'false',
    });
});

// ── Pre-warm ───────────────────────────────────────────────────────
// The New-scan dialog calls prewarm on open so a toolbox + ZAP boot in the
// background; the scan then adopts it for an instant start. Best-effort: a null
// prewarmId just means the scan cold-starts.
router.post('/scans/prewarm', async (req, res) => {
    try {
        if (!(await scanRunnerSvc.dockerAvailable())) return res.json({ prewarmId: null });
        const prewarmId = scanRunnerSvc.prewarmToolbox({ userId: req.session.user.id });
        res.json({ prewarmId });
    } catch (err) {
        console.warn('[Security] prewarm failed:', err.message);
        res.json({ prewarmId: null });
    }
});

router.post('/scans/prewarm/:id/release', async (req, res) => {
    try { await scanRunnerSvc.releasePrewarm(req.params.id); } catch (_) { /* idempotent */ }
    res.json({ ok: true });
});

// ── Scans ──────────────────────────────────────────────────────────

router.post('/scans', async (req, res) => {
    try {
        const body = req.body || {};
        const { targetUrl, authorized = false, metadata = null } = body;
        // Every scan is now AI-agent driven — Claude drives the full toolbox
        // inside one container. (The legacy deterministic 'quick' pipeline has
        // been removed.)
        const mode = 'agent';
        let engines = body.engines;
        if (!targetUrl || typeof targetUrl !== 'string') {
            return res.status(400).json({ error: 'targetUrl is required' });
        }
        // The agent drives a ZAP daemon by default and treats every other tool
        // as something it may invoke, so a missing engine list is fine — default
        // to ZAP so the report header has something concrete.
        if (!Array.isArray(engines) || engines.length === 0) {
            engines = [{ engine: 'zap' }];
        }
        if (scanRunner.isPrivateTarget(targetUrl)) {
            return res.status(400).json({
                error: 'unsafe_target',
                message: 'Target URL points to a private/internal address.',
            });
        }
        // Hard consent gate — we never scan a target the requester didn't
        // explicitly attest they own / are authorized to test.
        if (authorized !== true) {
            return res.status(403).json({
                error: 'authorization_required',
                message: 'You must confirm you are authorized to scan this target.',
            });
        }

        // Validate the engine descriptors (report header only — no quick-mode
        // pipeline behind them any more, and ZAP active scanning is governed by
        // the aggression level, not a per-engine intensity flag).
        const normalizedEngines = [];
        for (const e of engines) {
            if (!e || typeof e !== 'object' || typeof e.engine !== 'string') {
                return res.status(400).json({ error: 'each engine must be an object with an engine field' });
            }
            if (!VALID_ENGINES.includes(e.engine)) {
                return res.status(400).json({ error: `invalid engine: ${e.engine}` });
            }
            const descriptor = { engine: e.engine };
            if (e.engine === 'zap' && e.intensity && ZAP_INTENSITIES.includes(e.intensity)) {
                descriptor.intensity = e.intensity;
            }
            normalizedEngines.push(descriptor);
        }

        // Model tier (which Claude tier drives the agent). Opaque key resolved
        // server-side at run time; validate shape only. The driver falls back to
        // a Claude model if the tier resolves to a non-Claude provider.
        let modelTier = typeof body.modelTier === 'string' ? body.modelTier.trim() : null;
        if (modelTier && !MODEL_TIER_RE.test(modelTier)) {
            return res.status(400).json({ error: 'invalid_model_tier' });
        }

        // Aggression level — validated and CLAMPED to the server ceiling so the
        // selector can later be plan-gated by lowering SECURITY_MAX_AGGRESSION.
        const chosenAggression = aggression.isValid(body.aggression) ? body.aggression : aggression.DEFAULT_AGGRESSION;
        const effectiveAggression = aggression.clamp(chosenAggression);

        // Pre-warmed toolbox handle (the dialog warmed one on open). Validated by
        // shape; the worker adopts it if the in-process registry still has it,
        // else cold-starts. Round-tripped via metadata so the worker receives it.
        let prewarmId = typeof body.prewarmId === 'string' ? body.prewarmId.trim() : null;
        if (prewarmId && !/^[a-f0-9]{8,64}$/i.test(prewarmId)) prewarmId = null;
        const mergedMetadata = prewarmId
            ? { ...(metadata && typeof metadata === 'object' ? metadata : {}), prewarmId }
            : metadata;

        // Subscription / plan gate (billed under the 'security' agent type).
        const orgId = req.session.user.organizationId || null;
        const limitError = await checkSubscriptionLimits(orgId, 'security', req.session.user.id);
        if (limitError) {
            return res.status(403).json({ error: 'limit_reached', message: limitError });
        }

        const scanId = await securityScanStore.createScan({
            userId: req.session.user.id,
            organizationId: orgId,
            targetUrl,
            engines: normalizedEngines,
            authorized: true,
            metadata: mergedMetadata,
            mode,
            modelTier,
            aggression: effectiveAggression,
        });

        // Fast-path: kick the worker once for this row so users don't wait
        // for the periodic tick. Errors are absorbed — the tick picks it up.
        // When a dedicated worker owns draining (SECURITY_DRAIN_IN_API=false)
        // the API must not run scan work itself; the worker's short tick
        // picks the row up promptly instead.
        if (process.env.SECURITY_DRAIN_IN_API !== 'false') {
            require('../workers/scanRunner').drainOne(scanId).catch(err => console.warn('[Security] drainOne failed:', err.message));
        }

        // Tell the UI whether this scan will start now or wait for a free slot.
        let queued = false;
        try {
            const caps = {
                perUser: parseInt(process.env.SECURITY_MAX_CONCURRENT_PER_USER || '1', 10),
                org: parseInt(process.env.SECURITY_MAX_CONCURRENT_PER_ORG || '2', 10),
                global: parseInt(process.env.SECURITY_MAX_CONCURRENT_GLOBAL || '3', 10),
            };
            const active = await securityScanStore.countActiveByScope({ userId: req.session.user.id, organizationId: orgId });
            queued = active.user >= caps.perUser || active.org >= caps.org || active.global >= caps.global;
        } catch (_) { /* best-effort hint */ }

        res.json({ scanId, queued });
    } catch (err) {
        console.error('[Security] create scan failed:', err);
        res.status(500).json({ error: 'Failed to start security scan' });
    }
});

router.get('/scans/active', async (req, res) => {
    try {
        const scans = await securityScanStore.listActiveScansForUser(req.session.user.id);
        // `scan` (most-recent single) retained for backward compatibility.
        res.json({ scans, scan: scans[0] || null });
    } catch (err) {
        console.error('[Security] get active scans failed:', err);
        res.status(500).json({ error: 'Failed to fetch active scans' });
    }
});

router.post('/scans/:id/cancel', async (req, res) => {
    try {
        const result = await securityScanStore.markCancelled(req.params.id, req.session.user.id);
        if (!result.ok) {
            const code = result.error === 'not_found' ? 404
                : result.error === 'forbidden' ? 403
                : result.error === 'already_terminal' ? 409 : 500;
            return res.status(code).json(result);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[Security] cancel failed:', err);
        res.status(500).json({ error: 'Failed to cancel scan' });
    }
});

router.get('/scans/:id', async (req, res) => {
    try {
        const s = await securityScanStore.getScan(req.params.id, req.session.user.id);
        if (!s) return res.status(404).json({ error: 'Scan not found' });
        res.json({ scan: s });
    } catch (err) {
        console.error('[Security] get scan failed:', err);
        res.status(500).json({ error: 'Failed to fetch scan' });
    }
});

router.get('/scans/:id/report', async (req, res) => {
    try {
        const s = await securityScanStore.getScan(req.params.id, req.session.user.id);
        if (!s) return res.status(404).json({ error: 'Scan not found' });
        res.json({
            report: s.reportJson || null,
            status: s.status,
            reportWebpageId: s.reportWebpageId || null,
            severitySummary: s.severitySummary || null,
        });
    } catch (err) {
        console.error('[Security] get report failed:', err);
        res.status(500).json({ error: 'Failed to fetch report' });
    }
});

router.get('/scans/:id/events', async (req, res) => {
    const scanId = req.params.id;
    const s = await securityScanStore.getScan(scanId, req.session.user.id);
    if (!s) return res.status(404).json({ error: 'Scan not found' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // Initial snapshot so a late subscriber sees the current state.
    send('snapshot', { status: s.status, stdoutTail: s.stdoutTail, reportJson: s.reportJson });
    if (s.status && ['completed', 'error', 'cancelled'].includes(s.status)) {
        send('done', { status: s.status, reportJson: s.reportJson, error: s.error });
        return res.end();
    }

    const unsubscribe = securityScanStore.subscribe(scanId, ({ type, data }) => {
        try { send(type, data || {}); }
        catch (_) { /* socket gone — cleanup runs on close */ }
        if (type === 'done' || type === 'close') {
            try { res.end(); } catch (_) {}
        }
    });

    // Keep-alive pings so proxies don't reap the connection.
    const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) { /* swallow */ }
    }, 25000);
    ping.unref?.();

    req.on('close', () => {
        clearInterval(ping);
        try { unsubscribe(); } catch (_) {}
    });
});

router.get('/scans/:id/artifacts', async (req, res) => {
    try {
        const s = await securityScanStore.getScan(req.params.id, req.session.user.id);
        if (!s) return res.status(404).json({ error: 'Scan not found' });
        const artifacts = await securityScanStore.listArtifacts(s.id);
        res.json({ artifacts });
    } catch (err) {
        console.error('[Security] artifacts failed:', err);
        res.status(500).json({ error: 'Failed to list artifacts' });
    }
});

router.get('/scans/:id/artifacts/:artifactId', async (req, res) => {
    try {
        const s = await securityScanStore.getScan(req.params.id, req.session.user.id);
        if (!s) return res.status(404).json({ error: 'Scan not found' });
        const artifact = await securityScanStore.getArtifact(s.id, req.params.artifactId);
        if (!artifact || artifact.scanId !== s.id) return res.status(404).json({ error: 'Artifact not found' });
        if (!artifact.storageKey) return res.status(404).json({ error: 'Artifact has no storage key' });
        // Proxy through storageStore — the scan owner gets a presigned URL.
        const storageStore = require('../stores/storageStore');
        const url = await storageStore.getPresignedUrl(artifact.storageKey);
        res.json({ url, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes });
    } catch (err) {
        console.error('[Security] artifact url failed:', err);
        res.status(500).json({ error: 'Failed to resolve artifact' });
    }
});

module.exports = router;
