/**
 * Security Scan Routes — scan run lifecycle + SSE + cancel + artifacts.
 *
 * Mounted in server/index.js behind:
 *   requireLicenseFeature('security_scan')
 *   requireBetaFeature('security_scan')
 *
 * Endpoints:
 *   POST   /scans                    — body: { targetUrl, engines:[{engine,intensity?}], authorized:true }
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
 * authorizes (authorized:true) and that pass the SSRF guard. ZAP/Nuclei
 * "active" (full) scans are gated behind SECURITY_ALLOW_ACTIVE_SCAN so a
 * default install can only run passive baseline checks.
 */

const express = require('express');
const router = express.Router();

const securityScanStore = require('../stores/securityScanStore');
const scanRunner = require('../workers/scanRunner');
const { checkSubscriptionLimits } = require('../core/limits');

// Engines the worker knows how to run, and the intensities each accepts.
const VALID_ENGINES = ['zap', 'nuclei', 'testssl'];
const ZAP_INTENSITIES = ['baseline', 'full'];

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

router.use(requireAuth);

// ── Scans ──────────────────────────────────────────────────────────

router.post('/scans', async (req, res) => {
    try {
        const { targetUrl, engines, authorized = false, metadata = null } = req.body || {};
        if (!targetUrl || typeof targetUrl !== 'string') {
            return res.status(400).json({ error: 'targetUrl is required' });
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

        // Validate the engine selection up-front so the worker never has to
        // reason about a malformed descriptor.
        if (!Array.isArray(engines) || engines.length === 0) {
            return res.status(400).json({ error: 'engines must be a non-empty array' });
        }
        const normalizedEngines = [];
        for (const e of engines) {
            if (!e || typeof e !== 'object' || typeof e.engine !== 'string') {
                return res.status(400).json({ error: 'each engine must be an object with an engine field' });
            }
            if (!VALID_ENGINES.includes(e.engine)) {
                return res.status(400).json({ error: `invalid engine: ${e.engine}` });
            }
            const descriptor = { engine: e.engine };
            if (e.engine === 'zap') {
                const intensity = e.intensity || 'baseline';
                if (!ZAP_INTENSITIES.includes(intensity)) {
                    return res.status(400).json({ error: `invalid zap intensity: ${intensity}` });
                }
                // A full (active) scan sends attack traffic — only allow it
                // when the operator has opted the install in. Default installs
                // are limited to the passive baseline.
                if (intensity === 'full' && process.env.SECURITY_ALLOW_ACTIVE_SCAN !== 'true') {
                    return res.status(403).json({
                        error: 'active_scan_disabled',
                        message: 'Active (full) ZAP scans are disabled on this install. Contact your administrator.',
                    });
                }
                descriptor.intensity = intensity;
            }
            normalizedEngines.push(descriptor);
        }

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
            metadata,
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
