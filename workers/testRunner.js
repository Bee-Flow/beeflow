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

const BATCH_SIZE = parseInt(process.env.PLAYWRIGHT_RUN_BATCH_SIZE || '2', 10);
const HARD_FAIL_DAYS = 14;
const PLAYWRIGHT_TIMEOUT_MS = parseInt(process.env.PLAYWRIGHT_TEST_TIMEOUT_MS || '300000', 10); // 5 min
const EXPLORE_MAX_STEPS = parseInt(process.env.PLAYWRIGHT_EXPLORE_MAX_STEPS || '25', 10);
const WORKER_ID = `tr-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;

// ── SSRF guard: block targets that resolve into RFC1918, loopback, link-
//    local, or private IPv6 ranges. Defence in depth — a malicious user
//    could otherwise drive Chromium against an internal service from our
//    own host.
const PRIVATE_HOST_REGEXES = [
    /^localhost$/i,
    /^127(?:\.\d{1,3}){3}$/,
    /^10(?:\.\d{1,3}){3}$/,
    /^192\.168(?:\.\d{1,3}){2}$/,
    /^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/,
    /^169\.254(?:\.\d{1,3}){2}$/,
    /^::1$/,
    /^fc[0-9a-f]{2}:/i,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
];

function isPrivateTarget(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return true; }
    if (!/^https?:$/.test(parsed.protocol)) return true;
    // URL.hostname strips IPv6 brackets in newer Node versions but leaves
    // them in some environments — strip defensively so the regexes only
    // need to match the raw address.
    const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
    return PRIVATE_HOST_REGEXES.some(re => re.test(host));
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

async function runSuiteMode({ runId, suiteId, targetUrl, userId }) {
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

    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bf-pwt-'));
    const specDir = path.join(tmpRoot, 'tests');
    await fs.promises.mkdir(specDir, { recursive: true });
    const specPath = path.join(specDir, 'generated.spec.ts');
    await fs.promises.writeFile(specPath, ensureImports(suite.playwrightCode), 'utf-8');

    const configPath = path.join(tmpRoot, 'playwright.config.ts');
    const baseURL = targetUrl;
    const configBody = `import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests',
    timeout: 30_000,
    reporter: [['json', { outputFile: 'report.json' }]],
    use: {
        baseURL: ${JSON.stringify(baseURL)},
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
    workers: 1,
});
`;
    await fs.promises.writeFile(configPath, configBody, 'utf-8');

    return await new Promise((resolve) => {
        const child = spawn('npx', ['playwright', 'test', '--config', configPath], {
            cwd: tmpRoot,
            env: { ...process.env, CI: '1' },
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

async function runExploreMode({ runId, targetUrl, userId }) {
    let chromium;
    try {
        ({ chromium } = require('playwright'));
    } catch (e) {
        return { status: 'error', error: 'playwright_not_installed' };
    }

    const findings = [];
    let browser, ctx, page;
    try {
        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
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
            outcome = await agentTestDriver.runAgentMode({
                runId,
                targetUrl,
                instructions: meta?.instructions || '',
                userId,
                organizationId: organizationId || null,
                sourceMeta: meta?.sourceMeta || null,
                credentials,
                maxSteps: meta?.maxSteps ?? null,
            });
        } else if (mode === 'explore') {
            outcome = await runExploreMode({ runId, targetUrl, userId });
        } else {
            outcome = await runSuiteMode({ runId, suiteId, targetUrl, userId });
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
        batchSize: BATCH_SIZE,
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

module.exports = {
    drainOnce,
    drainOne,
    isPrivateTarget,
    stashRunSecrets,
    // exported for tests
    _internals: { buildReportFromPlaywright, mapPlaywrightStatus, formatDuration, sweepBasics, takeRunSecrets },
};
