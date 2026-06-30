/**
 * Test Runner worker — drains test_run_jobs and executes Playwright suites.
 *
 * Two modes:
 *   • 'suite'   — write the suite's playwright_code to a tempdir and spawn
 *                 `npx playwright test --reporter=json`. Parse the JSON
 *                 reporter output into the json-test-report shape.
 *   • 'explore' — launch Chromium directly via the playwright API and run an
 *                 LLM-driven exploration loop. The LLM emits a small action
 *                 vocabulary (navigate / click / type / record_finding) and
 *                 we execute it against a live page. Findings are aggregated
 *                 into the same json-test-report shape so the renderer
 *                 doesn't have to care which mode produced the report.
 *
 * Pattern mirrors workers/paygDrain.js — claim outbox rows under
 * SELECT … FOR UPDATE SKIP LOCKED, process, mark delivered. Each run row gets
 * a single in-flight attempt; transient errors bump attempt_count and the
 * backoff retries on the next tick.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const testRunStore = require('../stores/testRunStore');
const testSuiteStore = require('../stores/testSuiteStore');
const pwtRunner = require('../services/pwtRunner');
const browserProvider = require('../services/browserProvider');

// ── Per-run secrets (in-memory only) ──────────────────────────────
// Credentials for agent runs live here for the run's lifetime and are
// deleted when the run finishes. They are NEVER persisted: not in
// test_runs.metadata, not in test_run_jobs, not in any log. The route
// stashes them via stashRunSecrets() right after createRun() and the
// worker consumes them via takeRunSecrets() inside processRun().
const _runSecrets = new Map();
function stashRunSecrets(runId, secrets) {
    if (!secrets || typeof secrets !== 'object') return;
    _runSecrets.set(runId, secrets);
    // Aggressive TTL — a queued run that never gets picked up shouldn't
    // hold credentials in memory forever.
    setTimeout(() => _runSecrets.delete(runId), 30 * 60_000).unref?.();
}
function takeRunSecrets(runId) {
    const s = _runSecrets.get(runId) || null;
    _runSecrets.delete(runId);
    return s;
}

const HARD_FAIL_DAYS = 14;
const PLAYWRIGHT_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_TEST_TIMEOUT_MS || '300000', 10); // 5 min
const EXPLORE_MAX_STEPS = parseInt(process.env.PLAYWRIGHT_EXPLORE_MAX_STEPS || '25', 10);
const WORKER_ID = `tr-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

// ── Concurrency caps ───────────────────────────────────────────────
// Runs that would exceed a cap stay `queued` and are claimed once a slot
// frees. The global cap doubles as the container-pool size.
const MAX_PER_USER = parseInt(process.env.PLAYWRIGHT_MAX_CONCURRENT_PER_USER || '3', 10);
const MAX_PER_ORG = parseInt(process.env.PLAYWRIGHT_MAX_CONCURRENT_PER_ORG || '5', 10);
const MAX_GLOBAL = parseInt(process.env.PLAYWRIGHT_MAX_CONCURRENT_GLOBAL || '6', 10);

// ── Execution mode ─────────────────────────────────────────────────
// 'container' → each run in a throwaway, network-isolated docker container.
// 'host'      → legacy in-process / spawn execution (unsandboxed fallback).
// 'auto'      → container if a docker socket is present; else host on
//               self-hosted, hard error on cloud (never run untrusted
//               browsers in the API/worker process on cloud).
const RUNNER_MODE = (process.env.PLAYWRIGHT_RUNNER_MODE || 'auto').toLowerCase();
const DEPLOYMENT_MODE = (process.env.DEPLOYMENT_MODE || 'cloud').toLowerCase();

async function resolveExecMode() {
    const dockerOk = await pwtRunner.dockerAvailable();
    if (RUNNER_MODE === 'host') return 'host';
    if (RUNNER_MODE === 'container') return dockerOk ? 'container' : 'error';
    // auto
    if (dockerOk) return 'container';
    return DEPLOYMENT_MODE === 'cloud' ? 'error' : 'host';
}

// Base dir for the suite spec tempdir. When the worker is containerized the
// bind path must be valid on the HOST, so we use a workdir that compose mounts
// at an identical path on both sides. Native workers just use os.tmpdir().
function runnerWorkdirBase() {
    if (pwtRunner.isServerInContainer()) {
        return process.env.PLAYWRIGHT_RUNNER_WORKDIR || '/var/lib/beeflow/pwt';
    }
    return process.env.PLAYWRIGHT_RUNNER_WORKDIR || os.tmpdir();
}

function buildPlaywrightConfig({ baseURL, testDir, reportPath }) {
    return `import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: ${JSON.stringify(testDir)},
    timeout: 30_000,
    reporter: [['json', { outputFile: ${JSON.stringify(reportPath)} }]],
    use: {
        baseURL: ${JSON.stringify(baseURL)},
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    workers: 1,
});
`;
}

// ── SSRF guard: block targets that resolve into RFC1918, loopback, link-
//    local, or private IPv6 ranges. Defence in depth — a malicious user
//    could otherwise drive Chromium against an internal service from our
//    own host. Two layers: the shared utils/ssrfGuard literal screen
//    (localhost, metadata hostnames, canonical private IPs), then the
//    numeric canonicalizer from core/customIntegrations/ssrfGuard so every
//    exotic IPv4 spelling — short-form (127.1), decimal (2130706433), hex
//    (0x7f000001), octal (0177.0.0.1), ::ffff: mapped, 0.0.0.0/8, CGNAT
//    100.64/10, broadcast — is treated as an IP, never as a DNS name.
//    Deliberately sync/DNS-less: this is a literal-host pre-filter; the
//    async assertPublicHttpsTarget() is the full resolver-backed check.
const { isPrivateHostname } = require('../utils/ssrfGuard');
const { isForbiddenAddress, normalizeHostname } = require('../core/customIntegrations/ssrfGuard');

function isPrivateTarget(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return true; }
    if (!/^https?:$/.test(parsed.protocol)) return true;
    if (isPrivateHostname(parsed.hostname)) return true;
    const { kind, canonical } = normalizeHostname(parsed.hostname);
    if (kind === 'name') return false;
    // Numeric-looking hosts that fail to canonicalize are blocked outright.
    return canonical === null || isForbiddenAddress(canonical);
}

function isHardFailed(ageMs) {
    return ageMs > HARD_FAIL_DAYS * 86_400_000;
}

// ── Suite-mode execution ──────────────────────────────────────────

const SPEC_HEADER = `import { test, expect } from '@playwright/test';\n\n`;

function ensureImports(code) {
    if (/^\s*import\s+\{\s*test\s*,/m.test(code)) return code;
    return SPEC_HEADER + code;
}

async function runSuiteMode({ runId, suiteId, targetUrl, userId, execMode = 'host', credentials = null }) {
    if (!suiteId) {
        return { status: 'error', error: 'Suite run requested without a suiteId.' };
    }
    const suite = await testSuiteStore.getSuite(suiteId, userId);
    if (!suite) {
        return { status: 'error', error: 'Suite not found.' };
    }
    if (!suite.playwrightCode || suite.playwrightCode.trim().length === 0) {
        return { status: 'error', error: 'Suite has no Playwright code. Generate the suite first.' };
    }

    if (execMode === 'container') {
        return runSuiteModeContainer({ runId, targetUrl, code: suite.playwrightCode, userId, credentials });
    }
    return runSuiteModeHost({ runId, targetUrl, code: suite.playwrightCode, credentials });
}

// Map per-run credentials to BF_*-prefixed env the Playwright code can read.
// Never logged; passed straight to the container/child env.
function credentialEnv(credentials) {
    if (!credentials || typeof credentials !== 'object') return {};
    const env = {};
    if (credentials.username) env.BF_USERNAME = String(credentials.username);
    if (credentials.email) env.BF_EMAIL = String(credentials.email);
    if (credentials.password) env.BF_PASSWORD = String(credentials.password);
    if (credentials.totp) env.BF_TOTP = String(credentials.totp);
    return env;
}

// Collect Playwright JSON-report attachments (screenshots / traces / videos)
// and persist them as run artifacts so the UI can render them in the failure
// view. `tmpRoot` is the host-side workdir; container paths are rooted at /work,
// which maps to tmpRoot. Best-effort: never fails the run.
async function uploadSuiteArtifacts({ runId, userId, report, tmpRoot }) {
    if (!report || !userId) return;
    let storageStore;
    try { storageStore = require('../stores/storageStore'); } catch (_) { return; }
    if (typeof storageStore.isAvailable === 'function' && !storageStore.isAvailable()) return;

    const attachments = [];
    const visit = (s) => {
        if (!s) return;
        for (const spec of (s.specs || [])) {
            for (const tcase of (spec.tests || [])) {
                for (const r of (tcase.results || [])) {
                    for (const a of (r.attachments || [])) {
                        if (a?.path) attachments.push(a);
                    }
                }
            }
        }
        (s.suites || []).forEach(visit);
    };
    (report.suites || []).forEach(visit);

    const kindFor = (a) => {
        const ct = a.contentType || '';
        if (a.name === 'trace' || /zip/.test(ct)) return 'trace';
        if (/video/.test(ct)) return 'video';
        return 'screenshot';
    };

    for (const a of attachments.slice(0, 20)) {
        try {
            // Map the container path (/work/...) onto the host workdir.
            const rel = a.path.startsWith('/work/') ? a.path.slice('/work/'.length) : path.basename(a.path);
            const filePath = path.join(tmpRoot, rel);
            const buf = await fs.promises.readFile(filePath);
            const kind = kindFor(a);
            const key = storageStore.buildKey(userId, 'test-artifacts', `${runId}-${path.basename(a.path)}`);
            await storageStore.uploadFile(key, buf, a.contentType || 'application/octet-stream');
            await testRunStore.addArtifact(runId, { kind, storageKey: key, mimeType: a.contentType || null, sizeBytes: buf.length });
        } catch (_) { /* skip this attachment */ }
    }
}

// Container path: write spec to a shared-workdir tempdir, run it in a
// throwaway runner container, read report.json back. No host env leaks in.
async function runSuiteModeContainer({ runId, targetUrl, code, userId, credentials = null }) {
    const base = runnerWorkdirBase();
    await fs.promises.mkdir(base, { recursive: true }).catch(() => {});
    const tmpRoot = await fs.promises.mkdtemp(path.join(base, 'bf-pwt-'));
    const specDir = path.join(tmpRoot, 'tests');
    await fs.promises.mkdir(specDir, { recursive: true });
    await fs.promises.writeFile(path.join(specDir, 'generated.spec.ts'), ensureImports(code), 'utf-8');
    await fs.promises.writeFile(
        path.join(tmpRoot, 'playwright.config.ts'),
        buildPlaywrightConfig({ baseURL: targetUrl, testDir: '/work/tests', reportPath: '/work/report.json' }),
        'utf-8',
    );

    // Poll for cancellation and kill the container if the user cancels.
    const cancelPoll = setInterval(() => {
        if (testRunStore.isCancelRequested(runId)) pwtRunner.killRun(runId).catch(() => {});
    }, 2000);
    cancelPoll.unref?.();

    let result;
    try {
        result = await pwtRunner.runSuiteContainer({
            runId,
            workdir: tmpRoot,
            baseUrl: targetUrl,
            secretEnv: credentialEnv(credentials),
            onLine: (line) => testRunStore.appendProgress(runId, line).catch(() => {}),
            timeoutMs: PLAYWRIGHT_TIMEOUT_MS,
        });
    } catch (e) {
        fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
        return { status: 'error', error: `runner_failed: ${e.message}` };
    }

    let report = null;
    try {
        report = JSON.parse(await fs.promises.readFile(path.join(tmpRoot, 'report.json'), 'utf-8'));
    } catch (_) { /* OOM / timeout / crash — no report */ }

    // Persist failure artifacts (screenshots/traces) before cleaning up.
    await uploadSuiteArtifacts({ runId, userId, report, tmpRoot }).catch(() => {});
    fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

    const json = buildReportFromPlaywright({
        report,
        targetUrl,
        stdoutTail: '',
        exitCode: result.exitCode,
    });
    if (result.timedOut) {
        return { status: 'error', error: `Run exceeded ${PLAYWRIGHT_TIMEOUT_MS}ms and was stopped.`, reportJson: json };
    }
    const failed = json.summary.failed || 0;
    const passed = json.summary.passed || 0;
    const status = result.exitCode === 0 && failed === 0 && passed >= 0 ? 'passed' :
                   (failed > 0 ? 'failed' : 'error');
    return { status, reportJson: json };
}

// Host path: legacy in-process spawn. Used only when no docker socket is
// available on a self-hosted install. Inherits the worker env (unsandboxed) —
// container mode is strongly preferred.
async function runSuiteModeHost({ runId, targetUrl, code, credentials = null }) {
    // No Chromium is baked into the image, so `npx playwright test` (which
    // launches its own local browser) cannot run here unless a dev explicitly
    // installed one. Suite runs need docker (container mode); fail explicitly
    // rather than producing a cryptic "Executable doesn't exist" deep in the
    // spawned process.
    if (process.env.BROWSER_ALLOW_LOCAL_LAUNCH !== 'true') {
        return {
            status: 'error',
            error: 'suite_host_no_browser: Suite runs require container mode (a docker socket) because the '
                + 'server image ships no local browser. Enable Docker, or for native dev install a browser and '
                + 'set BROWSER_ALLOW_LOCAL_LAUNCH=true.',
        };
    }
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bf-pwt-'));
    const specDir = path.join(tmpRoot, 'tests');
    await fs.promises.mkdir(specDir, { recursive: true });
    const specPath = path.join(specDir, 'generated.spec.ts');
    await fs.promises.writeFile(specPath, ensureImports(code), 'utf-8');

    const configPath = path.join(tmpRoot, 'playwright.config.ts');
    await fs.promises.writeFile(
        configPath,
        buildPlaywrightConfig({ baseURL: targetUrl, testDir: './tests', reportPath: 'report.json' }),
        'utf-8',
    );

    return await new Promise((resolve) => {
        const child = spawn('npx', ['playwright', 'test', '--config', configPath], {
            cwd: tmpRoot,
            env: { ...process.env, CI: '1', ...credentialEnv(credentials) },
            shell: false,
        });

        let stdoutBuf = '';
        let stderrBuf = '';
        const onStdout = (chunk) => {
            const s = chunk.toString();
            stdoutBuf += s;
            for (const line of s.split('\n')) {
                if (line.trim()) testRunStore.appendProgress(runId, line.trim()).catch(() => {});
            }
        };
        const onStderr = (chunk) => {
            const s = chunk.toString();
            stderrBuf += s;
            for (const line of s.split('\n')) {
                if (line.trim()) testRunStore.appendProgress(runId, line.trim()).catch(() => {});
            }
        };
        child.stdout.on('data', onStdout);
        child.stderr.on('data', onStderr);

        const killTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
        }, PLAYWRIGHT_TIMEOUT_MS);
        killTimer.unref();

        child.on('error', (err) => {
            clearTimeout(killTimer);
            resolve({ status: 'error', error: `spawn_failed: ${err.message}` });
        });

        child.on('close', async (code) => {
            clearTimeout(killTimer);
            let report = null;
            try {
                const raw = await fs.promises.readFile(path.join(tmpRoot, 'report.json'), 'utf-8');
                report = JSON.parse(raw);
            } catch (_) { /* fall through */ }

            const json = buildReportFromPlaywright({
                report,
                targetUrl,
                stdoutTail: (stdoutBuf + stderrBuf).slice(-4000),
                exitCode: code,
            });

            // Clean up tempdir best-effort; PII never leaves the host but we still
            // don't want disk to grow.
            fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

            const failed = json.summary.failed || 0;
            const passed = json.summary.passed || 0;
            const status = code === 0 && failed === 0 && passed >= 0 ? 'passed' :
                           (failed > 0 ? 'failed' : 'error');
            resolve({ status, reportJson: json });
        });
    });
}

function buildReportFromPlaywright({ report, targetUrl, stdoutTail, exitCode }) {
    const tests = [];
    let passed = 0, failed = 0, skipped = 0, warnings = 0;
    let durationMs = 0;

    function visitSuite(suite) {
        if (!suite) return;
        if (Array.isArray(suite.specs)) {
            for (const spec of suite.specs) {
                for (const t of (spec.tests || [])) {
                    for (const r of (t.results || [])) {
                        const status = mapPlaywrightStatus(r.status);
                        if (status === 'passed') passed++;
                        else if (status === 'failed') failed++;
                        else if (status === 'skipped') skipped++;
                        else if (status === 'warning') warnings++;
                        durationMs += Number(r.duration || 0);
                        tests.push({
                            name: spec.title || t.title || 'test',
                            status,
                            duration: formatDuration(r.duration),
                            category: 'functionality',
                            description: spec.file || '',
                            steps: Array.isArray(r.steps) ? r.steps.map(s => s.title).filter(Boolean) : [],
                            error: r.error?.message || r.errors?.[0]?.message || null,
                            severity: status === 'failed' ? 'major' : undefined,
                        });
                    }
                }
            }
        }
        if (Array.isArray(suite.suites)) suite.suites.forEach(visitSuite);
    }

    if (report) {
        if (Array.isArray(report.suites)) report.suites.forEach(visitSuite);
        else if (report.config) {
            // some reporter versions wrap differently; best-effort
            visitSuite(report);
        }
    }

    return {
        title: `Playwright run — ${targetUrl}`,
        url: targetUrl,
        timestamp: new Date().toISOString(),
        duration: formatDuration(durationMs || 0),
        summary: { passed, failed, skipped, warnings },
        tests,
        notes: tests.length === 0
            ? `Playwright exited ${exitCode}. No test results were produced — see stdout tail below.\n\n\`\`\`\n${stdoutTail || '(empty)'}\n\`\`\``
            : '',
        recommendations: [],
    };
}

function mapPlaywrightStatus(s) {
    switch ((s || '').toLowerCase()) {
        case 'passed': return 'passed';
        case 'failed': case 'timedout': case 'interrupted': return 'failed';
        case 'skipped': return 'skipped';
        case 'flaky': return 'warning';
        default: return 'warning';
    }
}

function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0s';
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${s}s`;
}

// ── Explore-mode execution ────────────────────────────────────────

async function runExploreMode({ runId, targetUrl, userId, execMode = 'host' }) {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch (e) {
        return { status: 'error', error: 'playwright_not_installed' };
    }

    const findings = [];
    let browser, ctx, page, serve = null;
    try {
        if (execMode === 'container') {
            serve = await pwtRunner.startServeContainer({
                runId,
                onLine: (line) => testRunStore.appendProgress(runId, line).catch(() => {}),
            });
            browser = await chromium.connect(serve.wsEndpoint);
            ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        } else {
            // Host fallback: no Chromium is baked into the image, so drive the
            // shared singleton browser. Only the context is ours to close — the
            // shared browser/connection is owned by browserProvider.
            ctx = await browserProvider.newSharedContext({ viewport: { width: 1280, height: 800 } });
        }
        page = await ctx.newPage();
        page.setDefaultTimeout(15_000);

        await testRunStore.appendProgress(runId, `[explore] navigating to ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });

        // v1 explore: a deterministic baseline sweep — no LLM loop yet, so the
        // beta release can ship without a back-and-forth tool dispatcher that
        // would need its own evaluation harness. The sweep covers the heaviest
        // first-pass QA checks (basic responsiveness, console errors, broken
        // links, missing alt-text, form interactability) and reports them in
        // the json-test-report shape. The LLM-driven loop is the next iteration.
        await sweepBasics(page, findings, runId);

    } catch (e) {
        findings.push({
            name: 'Explore session aborted',
            status: 'failed',
            category: 'functionality',
            severity: 'critical',
            description: 'The exploration session ended unexpectedly.',
            error: e.message,
        });
    } finally {
        try { await page?.close(); } catch (_) {}
        try { await ctx?.close(); } catch (_) {}
        try { await browser?.close(); } catch (_) {}
        if (serve) { try { await serve.cleanup(); } catch (_) {} }
    }

    const summary = { passed: 0, failed: 0, skipped: 0, warnings: 0 };
    for (const f of findings) {
        if (f.status === 'passed') summary.passed++;
        else if (f.status === 'failed') summary.failed++;
        else if (f.status === 'skipped') summary.skipped++;
        else summary.warnings++;
    }

    return {
        status: summary.failed > 0 ? 'failed' : 'passed',
        reportJson: {
            title: `Exploration — ${targetUrl}`,
            url: targetUrl,
            timestamp: new Date().toISOString(),
            duration: '—',
            summary,
            tests: findings,
            notes: 'Exploration is a baseline sweep in beta — no test cases were generated. Connect an AI provider and enable the LLM-driven explorer in a future release.',
            recommendations: [],
        },
    };
}

async function sweepBasics(page, findings, runId) {
    const consoleErrors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    // 1. Page loads
    findings.push({
        name: 'Page loads',
        status: 'passed',
        category: 'functionality',
        description: `Navigated to ${page.url()}`,
        steps: ['goto', 'domcontentloaded'],
    });
    await testRunStore.appendProgress(runId, `[explore] page loaded`);

    // 2. Title present
    const title = await page.title().catch(() => '');
    findings.push({
        name: 'Page has a non-empty <title>',
        status: title && title.trim().length > 0 ? 'passed' : 'failed',
        category: 'accessibility',
        severity: 'minor',
        description: `Document title: "${title || '(empty)'}"`,
    });

    // 3. Images have alt text
    const missingAlt = await page.$$eval('img:not([alt])', els => els.length).catch(() => 0);
    findings.push({
        name: 'Images have alt attributes',
        status: missingAlt === 0 ? 'passed' : 'warning',
        category: 'accessibility',
        severity: missingAlt > 5 ? 'major' : 'minor',
        description: missingAlt === 0
            ? 'All <img> elements declared an alt attribute.'
            : `${missingAlt} image(s) missing alt — screen readers cannot describe them.`,
    });

    // 4. Console errors
    await page.waitForTimeout(2000);
    findings.push({
        name: 'No console errors',
        status: consoleErrors.length === 0 ? 'passed' : 'failed',
        category: 'functionality',
        severity: consoleErrors.length > 0 ? 'major' : undefined,
        description: consoleErrors.length === 0
            ? 'No console errors emitted during load.'
            : `Captured ${consoleErrors.length} console error(s).`,
        error: consoleErrors.slice(0, 3).join('\n') || undefined,
    });

    // 5. Forms have labels
    const inputsNoLabel = await page.$$eval(
        'input:not([type=hidden]):not([type=submit])',
        els => els.filter(el => !el.labels || el.labels.length === 0).length
    ).catch(() => 0);
    findings.push({
        name: 'Form inputs have associated labels',
        status: inputsNoLabel === 0 ? 'passed' : 'warning',
        category: 'accessibility',
        severity: 'minor',
        description: inputsNoLabel === 0
            ? 'Every visible input is tied to a <label>.'
            : `${inputsNoLabel} input(s) lack a label association.`,
    });
}

// ── Drain loop ────────────────────────────────────────────────────

async function processRun(claim) {
    const { run_id: runId, suite_id: suiteId, user_id: userId, organization_id: organizationId, target_url: targetUrl, mode, metadata: rawMetadata } = claim;

    if (isPrivateTarget(targetUrl)) {
        await testRunStore.markFinished(runId, {
            status: 'error',
            error: 'target_url resolves to a private/internal address; blocked for safety.',
        });
        return { ok: true, status: 'error' };
    }

    const execMode = await resolveExecMode();
    if (execMode === 'error') {
        await testRunStore.markFinished(runId, {
            status: 'error',
            error: 'docker_unavailable: test runs require an isolated container but the Docker socket is not reachable. Set PLAYWRIGHT_RUNNER_MODE=host to allow unsandboxed execution (self-hosted only).',
        });
        return { ok: true, status: 'error' };
    }

    await testRunStore.markRunning(runId);

    let outcome;
    try {
        if (mode === 'agent') {
            const agentTestDriver = require('../services/agentTestDriver');
            let meta = null;
            try { meta = typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : rawMetadata; } catch (_) {}
            // Pull credentials from the in-process stash (set by the route)
            // and clear them in one step so a retry doesn't keep them.
            const credentials = takeRunSecrets(runId);
            // If the run was created expecting credentials but they expired from
            // the in-memory stash (e.g. it sat queued past the TTL), fail loudly
            // rather than silently attempting a broken login.
            if (meta?.expectsCredentials && !credentials) {
                outcome = { status: 'error', error: 'credentials_expired: this run waited in the queue longer than credentials are held in memory. Re-run it.' };
            } else {
                // Agent + explore drive a remote browser in a serve container.
                let serve = null;
                if (execMode === 'container') {
                    serve = await pwtRunner.startServeContainer({
                        runId,
                        onLine: (line) => testRunStore.appendProgress(runId, line).catch(() => {}),
                    });
                }
                try {
                    outcome = await agentTestDriver.runAgentMode({
                        runId,
                        targetUrl,
                        instructions: meta?.instructions || '',
                        userId,
                        organizationId: organizationId || null,
                        sourceMeta: meta?.sourceMeta || null,
                        credentials,
                        maxSteps: meta?.maxSteps ?? null,
                        cdpEndpoint: serve?.wsEndpoint || null,
                    });
                } finally {
                    if (serve) { try { await serve.cleanup(); } catch (_) {} }
                }
            }
        } else if (mode === 'explore') {
            outcome = await runExploreMode({ runId, targetUrl, userId, execMode });
        } else {
            let meta = null;
            try { meta = typeof rawMetadata === 'string' ? JSON.parse(rawMetadata) : rawMetadata; } catch (_) {}
            // Suite runs may carry credentials, exposed to the Playwright code as
            // BF_USERNAME / BF_PASSWORD / BF_EMAIL / BF_TOTP. Same in-memory,
            // never-persisted handling as agent mode.
            const credentials = takeRunSecrets(runId);
            if (meta?.expectsCredentials && !credentials) {
                outcome = { status: 'error', error: 'credentials_expired: this run waited in the queue longer than credentials are held in memory. Re-run it.' };
            } else {
                outcome = await runSuiteMode({ runId, suiteId, targetUrl, userId, execMode, credentials });
            }
        }
    } catch (e) {
        outcome = { status: 'error', error: `worker_exception: ${e.message}` };
    }

    if (outcome.status === 'error') {
        await testRunStore.markFinished(runId, { status: 'error', error: outcome.error || 'unknown_error', reportJson: outcome.reportJson || null });
    } else {
        await testRunStore.markFinished(runId, { status: outcome.status, reportJson: outcome.reportJson });
    }

    // Stamp latest_run_id on the suite so the list view can surface the most
    // recent outcome at a glance.
    if (suiteId) {
        try { await testSuiteStore.updateSuite(suiteId, userId, { latestRunId: runId }); } catch (_) {}
    }

    return { ok: true, status: outcome.status };
}

async function drainOnce(targetRunId = null) {
    const claimed = await testRunStore.claimDueJobs({
        batchSize: MAX_GLOBAL,
        perUserCap: MAX_PER_USER,
        orgCap: MAX_PER_ORG,
        globalCap: MAX_GLOBAL,
        targetRunId,
        workerId: WORKER_ID,
    });
    if (claimed.length === 0) return { processed: 0 };

    let processed = 0;
    for (const claim of claimed) {
        const ageMs = Date.now() - (claim.created_at ? new Date(claim.created_at).getTime() : Date.now());
        if (isHardFailed(ageMs)) {
            await testRunStore.markFinished(claim.run_id, {
                status: 'error',
                error: `hard_failed_after_${HARD_FAIL_DAYS}_days`,
            });
            continue;
        }
        try {
            await processRun(claim);
            processed++;
        } catch (e) {
            await testRunStore.markRetryable(claim.run_id, e.message);
        }
    }
    return { processed };
}

async function drainOne(runId) {
    if (!runId) return null;
    return drainOnce(runId);
}

// Remove orphaned runner containers. A run is "active" if its row is still
// queued/running — anything else is safe to reap. Called on worker boot and
// on an interval.
async function reapRunners() {
    return pwtRunner.reapStaleRunners(async (runId) => {
        try {
            const r = await testRunStore.getRun(runId);
            return !!r && (r.status === 'queued' || r.status === 'running');
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
    stashRunSecrets,
    // exported for tests
    _internals: { buildReportFromPlaywright, mapPlaywrightStatus, formatDuration, sweepBasics, takeRunSecrets, resolveExecMode },
};
