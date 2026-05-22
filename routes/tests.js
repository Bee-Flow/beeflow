/**
 * Tests Routes — CRUD for Playwright test suites + run lifecycle + SSE.
 *
 * Mounted in server/index.js behind:
 *   requireLicenseFeature('playwright_tests')
 *   requireBetaFeature('playwright_tests')
 *
 * Endpoints:
 *   GET    /suites
 *   POST   /suites
 *   GET    /suites/:id
 *   PUT    /suites/:id
 *   DELETE /suites/:id
 *   POST   /suites/:id/generate     — runs testGenerator, persists code + version
 *   GET    /suites/:id/versions
 *   POST   /suites/:id/restore/:versionId
 *   POST   /runs                    — body: { suiteId?, targetUrl, mode }
 *   GET    /runs/:id
 *   GET    /runs/:id/report
 *   GET    /runs/:id/events         — SSE
 *   GET    /runs/:id/artifacts
 *   GET    /runs/:id/artifacts/:artifactId
 *
 * Ownership: every endpoint filters by req.session.user.id. There's no
 * cross-user reading even within the same org for the beta; we'll add
 * org-admin escalation alongside the GA admin UI.
 */

const express = require('express');
const router = express.Router();

const testSuiteStore = require('../stores/testSuiteStore');
const testRunStore = require('../stores/testRunStore');
const testGenerator = require('../services/testGenerator');
const testRunner = require('../workers/testRunner');

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

router.use(requireAuth);

// ── Suites ─────────────────────────────────────────────────────────

router.get('/suites', async (req, res) => {
    try {
        const suites = await testSuiteStore.listSuites(req.session.user.id);
        res.json({ suites });
    } catch (err) {
        console.error('[Tests] list suites failed:', err);
        res.status(500).json({ error: 'Failed to list test suites' });
    }
});

router.post('/suites', async (req, res) => {
    try {
        const { name, description } = req.body || {};
        const suite = await testSuiteStore.createSuite({
            userId: req.session.user.id,
            organizationId: req.session.user.organizationId || null,
            name,
            description,
        });
        res.json({ suite });
    } catch (err) {
        console.error('[Tests] create suite failed:', err);
        res.status(500).json({ error: 'Failed to create test suite' });
    }
});

router.get('/suites/:id', async (req, res) => {
    try {
        const suite = await testSuiteStore.getSuite(req.params.id, req.session.user.id);
        if (!suite) return res.status(404).json({ error: 'Suite not found' });
        const runs = suite.id ? await testRunStore.listRunsForSuite(suite.id, req.session.user.id, { limit: 20 }) : [];
        res.json({ suite, runs });
    } catch (err) {
        console.error('[Tests] get suite failed:', err);
        res.status(500).json({ error: 'Failed to get test suite' });
    }
});

router.put('/suites/:id', async (req, res) => {
    try {
        const ok = await testSuiteStore.updateSuite(req.params.id, req.session.user.id, req.body || {});
        if (!ok) return res.status(404).json({ error: 'Suite not found' });
        const suite = await testSuiteStore.getSuite(req.params.id, req.session.user.id);
        res.json({ suite });
    } catch (err) {
        console.error('[Tests] update suite failed:', err);
        res.status(500).json({ error: 'Failed to update test suite' });
    }
});

router.delete('/suites/:id', async (req, res) => {
    try {
        const deleted = await testSuiteStore.deleteSuite(req.params.id, req.session.user.id);
        if (!deleted) return res.status(404).json({ error: 'Suite not found' });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Tests] delete suite failed:', err);
        res.status(500).json({ error: 'Failed to delete test suite' });
    }
});

router.post('/suites/:id/generate', async (req, res) => {
    try {
        const suite = await testSuiteStore.getSuite(req.params.id, req.session.user.id);
        if (!suite) return res.status(404).json({ error: 'Suite not found' });

        const { sources = [], hints = {} } = req.body || {};
        const result = await testGenerator.generate(req.session.user.id, sources, hints);
        if (!result.ok) {
            // missing_integration / no_sources / llm_error / parse_error all
            // map to 422 so the UI can show a structured CTA instead of a
            // generic 500.
            return res.status(422).json(result);
        }

        await testSuiteStore.updateSuite(suite.id, req.session.user.id, {
            playwrightCode: result.playwrightCode,
            sourceManifest: result.sourceSummary,
        });
        await testSuiteStore.snapshotVersion(suite.id, 'Generated from sources');

        const updated = await testSuiteStore.getSuite(suite.id, req.session.user.id);
        res.json({ suite: updated, manifest: result.manifest, modelUsed: result.modelUsed });
    } catch (err) {
        console.error('[Tests] generate failed:', err);
        res.status(500).json({ error: 'Failed to generate test suite' });
    }
});

router.get('/suites/:id/versions', async (req, res) => {
    try {
        const versions = await testSuiteStore.listVersions(req.params.id, req.session.user.id);
        res.json({ versions });
    } catch (err) {
        console.error('[Tests] versions failed:', err);
        res.status(500).json({ error: 'Failed to list versions' });
    }
});

router.post('/suites/:id/restore/:versionId', async (req, res) => {
    try {
        const suite = await testSuiteStore.restoreVersion(req.params.versionId, req.session.user.id);
        if (!suite) return res.status(404).json({ error: 'Version not found' });
        res.json({ suite });
    } catch (err) {
        console.error('[Tests] restore failed:', err);
        res.status(500).json({ error: 'Failed to restore version' });
    }
});

// ── Runs ───────────────────────────────────────────────────────────

router.post('/runs', async (req, res) => {
    try {
        const { suiteId = null, targetUrl, mode = 'suite', source = null, credentials = null, maxSteps = null } = req.body || {};
        if (!targetUrl || typeof targetUrl !== 'string') {
            return res.status(400).json({ error: 'targetUrl is required' });
        }
        if (testRunner.isPrivateTarget(targetUrl)) {
            return res.status(400).json({
                error: 'unsafe_target',
                message: 'Target URL points to a private/internal address.',
            });
        }
        if (!['suite', 'explore', 'agent'].includes(mode)) {
            return res.status(400).json({ error: `invalid mode: ${mode}` });
        }
        if (mode === 'suite' && !suiteId) {
            return res.status(400).json({ error: 'suiteId is required for suite mode' });
        }
        if (mode === 'agent' && !source) {
            return res.status(400).json({ error: 'source is required for agent mode' });
        }
        if (suiteId) {
            const suite = await testSuiteStore.getSuite(suiteId, req.session.user.id);
            if (!suite) return res.status(404).json({ error: 'Suite not found' });
        }

        if (await testRunStore.hasActiveRunForUser(req.session.user.id)) {
            return res.status(409).json({
                error: 'concurrent_run_limit',
                message: 'You already have a test run in progress. Wait for it to finish before starting another.',
            });
        }

        // Resolve agent-mode source into a single instruction string before
        // the worker picks the row up. Doing it here keeps the worker simple
        // and lets the user see integration errors (missing GitHub / YouTrack
        // token) immediately via 422 instead of inside a streamed run.
        let metadata = null;
        if (mode === 'agent') {
            const resolved = await _resolveAgentSource(source, req.session.user.id);
            if (!resolved.ok) {
                return res.status(422).json(resolved);
            }
            metadata = {
                sourceMeta: { type: source.type, label: resolved.label },
                instructions: resolved.instructions,
            };
            const parsedSteps = parseInt(maxSteps, 10);
            if (Number.isFinite(parsedSteps) && parsedSteps > 0) {
                metadata.maxSteps = Math.min(parsedSteps, 200);
            }
        }

        const runId = await testRunStore.createRun({
            suiteId,
            userId: req.session.user.id,
            organizationId: req.session.user.organizationId || null,
            targetUrl,
            mode,
            metadata,
        });

        // Per-run credentials live in worker memory only — never in `metadata`,
        // never in the DB, never echoed back. Sanitise to whitelisted fields
        // and toss the original object reference immediately.
        if (mode === 'agent' && credentials && typeof credentials === 'object') {
            const safe = {};
            for (const k of ['username', 'email', 'password', 'totp']) {
                if (typeof credentials[k] === 'string' && credentials[k].length > 0) {
                    safe[k] = credentials[k];
                }
            }
            if (Object.keys(safe).length > 0) testRunner.stashRunSecrets(runId, safe);
        }

        // Fast-path: kick the worker once for this row so users don't wait
        // for the periodic tick. Errors are absorbed — the tick picks it up.
        testRunner.drainOne(runId).catch(err => console.warn('[Tests] drainOne failed:', err.message));

        res.json({ runId });
    } catch (err) {
        console.error('[Tests] create run failed:', err);
        res.status(500).json({ error: 'Failed to start test run' });
    }
});

/**
 * Resolve an agent-mode `source` payload into a single instruction string
 * the driver can hand to Claude. Mirrors the source shapes accepted by
 * testGenerator.fetchSources() but returns just one body (the agent flow
 * is single-source by design — picking one ticket at a time keeps the
 * intent unambiguous for the live tester to follow).
 */
async function _resolveAgentSource(source, userId) {
    if (!source || typeof source !== 'object' || typeof source.type !== 'string') {
        return { ok: false, error: 'invalid_source', message: 'source must be an object with a type field' };
    }
    if (source.type === 'text') {
        const body = String(source.body || '').slice(0, 6000).trim();
        if (!body) return { ok: false, error: 'empty_source', message: 'Pasted spec is empty.' };
        return { ok: true, label: source.label || 'Pasted spec', instructions: body };
    }
    if (source.type === 'youtrack') {
        if (!source.issueId) return { ok: false, error: 'invalid_source', message: 'youtrack source requires issueId' };
        const { executeYouTrackTool } = require('../integrations/youtrackTools');
        const r = await executeYouTrackTool('youtrack_get_issue', { issueId: source.issueId }, userId);
        if (r?.error) {
            if (/not configured/i.test(r.error)) {
                return { ok: false, error: 'missing_integration', integration: 'youtrack', message: r.error };
            }
            return { ok: false, error: 'fetch_failed', message: r.error };
        }
        return {
            ok: true,
            label: `YouTrack ${source.issueId}`,
            instructions: JSON.stringify(r).slice(0, 6000),
        };
    }
    if (source.type === 'github') {
        if (!source.owner || !source.repo || !source.number) {
            return { ok: false, error: 'invalid_source', message: 'github source requires owner, repo, number' };
        }
        const configStore = require('../stores/configStore');
        const token = await configStore.getSecret(`github_token_user_${userId}`);
        if (!token) {
            return {
                ok: false,
                error: 'missing_integration',
                integration: 'github',
                message: 'GitHub not connected. Set your Personal Access Token in Settings → Integrations.',
            };
        }
        try {
            const url = `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/issues/${encodeURIComponent(source.number)}`;
            const r = await fetch(url, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                signal: AbortSignal.timeout(15000),
            });
            if (!r.ok) {
                const text = await r.text().catch(() => '');
                return { ok: false, error: 'fetch_failed', message: `GitHub ${r.status}: ${text.slice(0, 200)}` };
            }
            const data = await r.json();
            const body = [
                `Title: ${data.title || ''}`,
                `URL: ${data.html_url || ''}`,
                `State: ${data.state || ''}`,
                `Labels: ${(data.labels || []).map(l => l.name || l).join(', ')}`,
                '',
                data.body || '(no description)',
            ].join('\n').slice(0, 6000);
            return {
                ok: true,
                label: `${source.owner}/${source.repo}#${source.number}`,
                instructions: body,
            };
        } catch (e) {
            return { ok: false, error: 'fetch_failed', message: e.message };
        }
    }
    return { ok: false, error: 'invalid_source', message: `Unknown source type: ${source.type}` };
}

router.get('/runs/active', async (req, res) => {
    try {
        const r = await testRunStore.getActiveRunForUser(req.session.user.id);
        res.json({ run: r || null });
    } catch (err) {
        console.error('[Tests] get active run failed:', err);
        res.status(500).json({ error: 'Failed to fetch active run' });
    }
});

router.post('/runs/:id/cancel', async (req, res) => {
    try {
        const result = await testRunStore.markCancelled(req.params.id, req.session.user.id);
        if (!result.ok) {
            const code = result.error === 'not_found' ? 404
                : result.error === 'forbidden' ? 403
                : result.error === 'already_terminal' ? 409 : 500;
            return res.status(code).json(result);
        }
        res.json({ ok: true });
    } catch (err) {
        console.error('[Tests] cancel failed:', err);
        res.status(500).json({ error: 'Failed to cancel run' });
    }
});

router.get('/runs/:id', async (req, res) => {
    try {
        const r = await testRunStore.getRun(req.params.id, req.session.user.id);
        if (!r) return res.status(404).json({ error: 'Run not found' });
        res.json({ run: r });
    } catch (err) {
        console.error('[Tests] get run failed:', err);
        res.status(500).json({ error: 'Failed to fetch run' });
    }
});

router.get('/runs/:id/report', async (req, res) => {
    try {
        const r = await testRunStore.getRun(req.params.id, req.session.user.id);
        if (!r) return res.status(404).json({ error: 'Run not found' });
        res.json({ report: r.reportJson || null, status: r.status });
    } catch (err) {
        console.error('[Tests] get report failed:', err);
        res.status(500).json({ error: 'Failed to fetch report' });
    }
});

router.get('/runs/:id/events', async (req, res) => {
    const runId = req.params.id;
    const r = await testRunStore.getRun(runId, req.session.user.id);
    if (!r) return res.status(404).json({ error: 'Run not found' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // Initial snapshot so a late subscriber sees the current state.
    send('snapshot', { status: r.status, stdoutTail: r.stdoutTail, reportJson: r.reportJson });
    if (r.status && ['passed', 'failed', 'error', 'cancelled'].includes(r.status)) {
        send('done', { status: r.status, reportJson: r.reportJson, error: r.error });
        return res.end();
    }

    const unsubscribe = testRunStore.subscribe(runId, ({ type, data }) => {
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

router.get('/runs/:id/artifacts', async (req, res) => {
    try {
        const r = await testRunStore.getRun(req.params.id, req.session.user.id);
        if (!r) return res.status(404).json({ error: 'Run not found' });
        const artifacts = await testRunStore.listArtifacts(r.id);
        res.json({ artifacts });
    } catch (err) {
        console.error('[Tests] artifacts failed:', err);
        res.status(500).json({ error: 'Failed to list artifacts' });
    }
});

router.get('/runs/:id/artifacts/:artifactId', async (req, res) => {
    try {
        const r = await testRunStore.getRun(req.params.id, req.session.user.id);
        if (!r) return res.status(404).json({ error: 'Run not found' });
        const artifact = await testRunStore.getArtifact(req.params.artifactId);
        if (!artifact || artifact.runId !== r.id) return res.status(404).json({ error: 'Artifact not found' });
        if (!artifact.storageKey) return res.status(404).json({ error: 'Artifact has no storage key' });
        // Proxy through storageStore — the run owner gets a presigned URL.
        const storageStore = require('../stores/storageStore');
        const url = await storageStore.getPresignedUrl(artifact.storageKey);
        res.json({ url, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes });
    } catch (err) {
        console.error('[Tests] artifact url failed:', err);
        res.status(500).json({ error: 'Failed to resolve artifact' });
    }
});

module.exports = router;
