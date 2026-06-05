/**
 * Security Scan Driver — Claude drives an authorized security scan step-by-step.
 *
 * This is the AGENT mode of the Security Scan feature. Modelled on
 * services/agentTestDriver.js: we run an Anthropic tool-use loop where Claude
 * emits one tool call at a time, we execute it against a live ZAP daemon
 * (via zapClient), a tools sandbox (terminal.exec → Nuclei/testssl/etc.), or
 * the report builder, stream structured SSE events + human log lines, and feed
 * the tool_result back into the next turn.
 *
 * The loop ends when Claude calls `done`, when MAX_STEPS is reached, or when
 * the route layer requests cancellation (securityScanStore.isCancelRequested).
 *
 * The infra (ZAP daemon, tools sandbox, engine runners) is provisioned by the
 * worker and injected here as `zap`, `terminal.exec`, and `runEngine` — this
 * module never spawns containers and never holds credentials beyond the ZAP
 * api.key it forwards through zapClient. That api.key is NEVER logged.
 *
 * No new npm deps — uses the @anthropic-ai/sdk we already ship.
 */

const fs = require('fs');
const path = require('path');

const securityScanStore = require('../stores/securityScanStore');
const securityReportBuilder = require('./securityReportBuilder');
const configStore = require('../stores/configStore');
const usageStore = require('../stores/usageStore');
const { makeZapClient } = require('./zapClient');
const { resolveModelForTier } = require('../core/modelResolver');

const SCAN_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'security-scan-prompt.md');

const DEFAULT_MAX_STEPS = parseInt(process.env.SECURITY_AGENT_MAX_STEPS || '40', 10);
const MAX_STEPS_CEILING = 200;
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const SEVERITIES = ['high', 'medium', 'low', 'informational'];

// Active (attack) scanning is destructive — gated behind an explicit env flag
// so a misconfigured deploy can never let the agent fire ZAP's active scanner.
const ALLOW_ACTIVE = () => process.env.SECURITY_ALLOW_ACTIVE_SCAN === 'true';

const TERMINAL_TIMEOUT_MS = () => parseInt(process.env.SECURITY_TERMINAL_TIMEOUT_MS || '30000', 10);

function _loadPrompt() {
    try { return fs.readFileSync(SCAN_PROMPT_PATH, 'utf-8'); }
    catch (_) { return ''; }
}

function isClaude(m) {
    return typeof m === 'string' && /^claude/i.test(m);
}

// ── Tool schemas exposed to Claude ───────────────────────────────────────
// Names map 1:1 to the dispatcher below. Active scan is always advertised so
// the model can reason about it, but the dispatcher hard-refuses when the gate
// is off — defence in depth against a prompt that ignores the gate state.
const TOOLS = [
    {
        name: 'zap_spider',
        description: 'Crawl the target with the ZAP spider to discover URLs and build attack surface. Run this first. Returns the spider id and the number of URLs crawled.',
        input_schema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'Seed URL to spider — defaults to the scan target.' } },
        },
    },
    {
        name: 'zap_list_urls',
        description: 'List the URLs ZAP has discovered for the target so far (from the spider + passive observation).',
        input_schema: {
            type: 'object',
            properties: { baseurl: { type: 'string', description: 'Base URL to filter by — defaults to the scan target.' } },
        },
    },
    {
        name: 'zap_passive_status',
        description: 'Wait for ZAP passive scanning to drain its queue, then report. Passive scanning runs automatically on every request ZAP sees; this blocks until the queue is empty.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'zap_list_alerts',
        description: 'List the security alerts ZAP has raised for the target. Use riskFilter to narrow to a single risk band. Returns a compact, capped list.',
        input_schema: {
            type: 'object',
            properties: {
                baseurl: { type: 'string', description: 'Base URL to filter by — defaults to the scan target.' },
                riskFilter: { type: 'string', enum: ['High', 'Medium', 'Low', 'Informational'], description: 'Only return alerts at this risk level.' },
            },
        },
    },
    {
        name: 'zap_active_scan',
        description: 'Run ZAP active (attack) scanning against a URL. DESTRUCTIVE — sends crafted payloads. Only available when active scanning has been explicitly authorized for this deployment; otherwise it returns an error.',
        input_schema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'URL to actively scan.' } },
            required: ['url'],
        },
    },
    {
        name: 'nuclei_run',
        description: 'Run Nuclei template-based scanning against the target. Optionally narrow by tags (e.g. "cve,exposure") or specific template paths. Returns compact severity counts.',
        input_schema: {
            type: 'object',
            properties: {
                tags: { type: 'string', description: 'Comma-separated Nuclei tags to run.' },
                templates: { type: 'string', description: 'Comma-separated template paths/ids to run.' },
            },
        },
    },
    {
        name: 'testssl_run',
        description: 'Run testssl.sh against the target to assess TLS/SSL configuration, certificate health and protocol weaknesses.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'terminal_exec',
        description: 'Run a shell command inside the isolated tools sandbox (curl, nmap, openssl, dig, etc.). Output is streamed and truncated. Use for targeted reconnaissance the dedicated tools do not cover.',
        input_schema: {
            type: 'object',
            properties: { command: { type: 'string', description: 'Shell command to execute in the sandbox.' } },
            required: ['command'],
        },
    },
    {
        name: 'record_finding',
        description: 'Record a manually-derived security finding (one you concluded yourself, e.g. from terminal output). Engine findings are captured automatically — only record what the engines did not.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                severity: { type: 'string', enum: ['high', 'medium', 'low', 'informational'] },
                description: { type: 'string' },
                solution: { type: 'string' },
                evidence: { type: 'string' },
            },
            required: ['name', 'severity'],
        },
    },
    {
        name: 'done',
        description: 'End the scan. Call when the engines have run, alerts have been reviewed, and there are no further useful actions.',
        input_schema: {
            type: 'object',
            properties: { summary: { type: 'string', description: 'One-paragraph summary of the scan and its conclusions.' } },
        },
    },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function _clampSeverity(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (s === 'high' || s === 'critical') return 'high';
    if (s === 'medium' || s === 'moderate') return 'medium';
    if (s === 'low') return 'low';
    return 'informational';
}

// One-line, log-safe summary of a tool input. Never surfaces secrets — the
// only secret in play (the ZAP api.key) lives inside zapClient and is never in
// a tool input.
function _summarizeInput(input) {
    if (!input || typeof input !== 'object') return '';
    const parts = [];
    if (input.url) parts.push(String(input.url));
    if (input.baseurl) parts.push(String(input.baseurl));
    if (input.riskFilter) parts.push(`risk=${input.riskFilter}`);
    if (input.tags) parts.push(`tags=${input.tags}`);
    if (input.templates) parts.push(`templates=${input.templates}`);
    if (input.command) parts.push(`$ ${String(input.command).slice(0, 120)}`);
    if (input.name) parts.push(String(input.name).slice(0, 80));
    if (input.severity) parts.push(`[${input.severity}]`);
    if (input.summary) parts.push(`— ${String(input.summary).slice(0, 80)}`);
    return parts.join(' ').slice(0, 200);
}

// Compact ZAP alert payload for the tool_result — drop the heavy HTML fields
// (we keep those in the normalized findings) and cap the list so a noisy target
// can't blow up the context window.
function _compactAlerts(alerts, cap = 40) {
    const arr = Array.isArray(alerts) ? alerts : [];
    return arr.slice(0, cap).map(a => ({
        name: a?.name || a?.alert || 'Unnamed alert',
        risk: a?.risk || 'Informational',
        confidence: a?.confidence || undefined,
        url: a?.url || undefined,
    }));
}

// ── Public entry point ────────────────────────────────────────────────────

/**
 * Run the agentic security-scan tool-use loop.
 *
 * @param {object} args
 * @param {string}  args.scanId
 * @param {string}  args.targetUrl
 * @param {Array}   args.engines          — engine descriptors for the report header
 * @param {string}  args.userId
 * @param {string|null} [args.organizationId]
 * @param {number|null} [args.maxSteps]
 * @param {{baseUrl:string, apiKey:string}} args.zap   — ZAP daemon endpoint
 * @param {{exec:Function}} args.terminal              — tools-sandbox exec(command,{onChunk,timeoutMs})
 * @param {Function} [args.onLine]                     — optional human-log sink (in addition to appendProgress)
 * @param {Function} args.runEngine                    — runEngine('nuclei'|'testssl') -> { json? }
 * @returns {Promise<{status:'completed'|'cancelled'|'error', reportJson?:object, reportWebpageId?:string|null, severitySummary?:object, error?:string}>}
 */
async function runAgentScan({
    scanId,
    targetUrl,
    engines,
    userId,
    organizationId = null,
    maxSteps = null,
    zap,
    terminal,
    onLine = null,
    runEngine,
}) {
    const stepCap = Math.min(
        Math.max(parseInt(maxSteps, 10) || DEFAULT_MAX_STEPS, 1),
        MAX_STEPS_CEILING,
    );

    // Single clock read at entry — keeps timestamps reproducible-ish and avoids
    // sprinkling Date.now() through the loop (mirrors securityReportBuilder's
    // "timestamps are passed in" contract).
    const startedAt = new Date().toISOString();

    const log = async (line) => {
        if (!line) return;
        try { await securityScanStore.appendProgress(scanId, line); } catch (_) {}
        if (typeof onLine === 'function') { try { onLine(line); } catch (_) {} }
    };

    let Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); }
    catch (_) {
        return { status: 'error', error: 'anthropic_sdk_not_installed' };
    }

    const apiKey = await configStore.getSecret('claude_api_key').catch(() => null);
    if (!apiKey) {
        return {
            status: 'error',
            error: 'claude_api_key_not_configured',
        };
    }

    // The agent loop talks to Claude via the Anthropic SDK directly — it only
    // speaks to Claude models. If tier:thinking resolves to OpenAI/Gemini/etc.
    // the SDK 404s or returns non-tool-use output and the loop does nothing.
    // Validate and fall back, exactly like agentTestDriver.
    const resolved = await resolveModelForTier('tier:thinking', { userOrgId: organizationId, userId });
    const modelId = isClaude(resolved) ? resolved : FALLBACK_MODEL;
    if (resolved && !isClaude(resolved)) {
        await log(`[agent] tier:thinking resolved to "${resolved}" which is not a Claude model — falling back to ${FALLBACK_MODEL}`);
    }

    const client = new Anthropic({ apiKey });
    const zapClient = makeZapClient(zap);

    // Per-engine finding arrays — fed to securityReportBuilder.aggregate() at
    // the end. ZAP alerts are normalized from the final listAlerts snapshot;
    // nuclei/testssl push as their engines run; agent record_finding pushes its
    // own bucket.
    const findingArrays = [];
    const zapFindings = [];      // rebuilt from the latest listAlerts result
    findingArrays.push(zapFindings);

    // Running alert tally surfaced via the 'scanstat' SSE event so the UI's
    // counters update live as ZAP raises alerts.
    const alertCounts = { high: 0, medium: 0, low: 0, informational: 0 };

    let stepCount = 0;
    let doneRequested = false;
    let doneSummary = '';
    let cancelled = false;
    let erroredOut = false;

    // ── Tool dispatcher ───────────────────────────────────────────────────
    async function dispatch(name, input) {
        switch (name) {
            case 'zap_spider': {
                const url = String(input?.url || targetUrl);
                const spiderId = await zapClient.spiderScan(url);
                const res = await zapClient.awaitSpider(spiderId, {
                    isCancelled: () => securityScanStore.isCancelRequested(scanId),
                    onProgress: ({ crawled, status }) => {
                        securityScanStore.publishEvent(scanId, 'scanstat', {
                            phase: 'spider',
                            crawledUrls: crawled,
                            current: status != null ? `crawl ${status}%` : undefined,
                        });
                    },
                });
                return { ok: true, spiderId, crawled: res?.crawled ?? 0, status: res?.status };
            }

            case 'zap_list_urls': {
                const baseurl = String(input?.baseurl || targetUrl);
                const urls = await zapClient.listUrls(baseurl);
                const list = Array.isArray(urls) ? urls : [];
                return { ok: true, count: list.length, urls: list.slice(0, 200) };
            }

            case 'zap_passive_status': {
                const res = await zapClient.awaitPassive({
                    isCancelled: () => securityScanStore.isCancelRequested(scanId),
                    onProgress: ({ records }) => {
                        securityScanStore.publishEvent(scanId, 'scanstat', {
                            phase: 'passive',
                            current: records != null ? `${records} records queued` : undefined,
                        });
                    },
                });
                return { ok: true, recordsToScan: res?.records ?? 0 };
            }

            case 'zap_list_alerts': {
                const baseurl = String(input?.baseurl || targetUrl);
                const alerts = await zapClient.listAlerts({ baseurl, riskFilter: input?.riskFilter || undefined });
                const list = Array.isArray(alerts) ? alerts : [];

                // Rebuild the ZAP finding bucket (in place) from the latest
                // snapshot so the report never accumulates duplicates across
                // repeated calls. listAlerts returns the COMPACT alert shape
                // (a `risk` string, not ZAP's native `riskcode`), so map it
                // directly rather than via normalizeZap (which expects the
                // native site[].alerts[] riskcode shape — the quick-mode path).
                zapFindings.length = 0;
                for (const a of list) {
                    zapFindings.push({
                        engine: 'zap',
                        name: a.name,
                        severity: _clampSeverity(a.risk),
                        confidence: a.confidence,
                        description: a.description,
                        solution: a.solution,
                        reference: a.reference,
                        instanceCount: 1,
                        sampleInstances: a.url ? [a.url] : [],
                    });
                }

                // Refresh the running tally + push it to the UI.
                alertCounts.high = 0; alertCounts.medium = 0; alertCounts.low = 0; alertCounts.informational = 0;
                for (const a of list) {
                    const sev = _clampSeverity(a?.risk);
                    alertCounts[sev] += 1;
                }
                securityScanStore.publishEvent(scanId, 'scanstat', {
                    phase: 'analyze',
                    alerts: { ...alertCounts },
                });

                return { ok: true, total: list.length, alerts: _compactAlerts(list) };
            }

            case 'zap_active_scan': {
                if (!ALLOW_ACTIVE()) {
                    return { ok: false, error: 'active_scan_disabled' };
                }
                const url = String(input?.url || '').trim();
                if (!url) return { ok: false, error: 'url is required' };
                const ascanId = await zapClient.ascanScan(url);
                await zapClient.awaitActive(ascanId, {
                    isCancelled: () => securityScanStore.isCancelRequested(scanId),
                    onProgress: ({ status }) => {
                        securityScanStore.publishEvent(scanId, 'scanstat', {
                            phase: 'active',
                            current: status != null ? `${status}%` : undefined,
                        });
                    },
                });
                return { ok: true, ascanId };
            }

            case 'nuclei_run': {
                securityScanStore.publishEvent(scanId, 'scanstat', { phase: 'nuclei' });
                const r = await runEngine('nuclei', {
                    tags: input?.tags ? String(input.tags) : undefined,
                    templates: input?.templates ? String(input.templates) : undefined,
                });
                if (r && r.json) {
                    const normalized = securityReportBuilder.normalizeNuclei(r.json);
                    findingArrays.push(normalized);
                    const counts = { high: 0, medium: 0, low: 0, informational: 0 };
                    for (const f of normalized) counts[_clampSeverity(f.severity)] += 1;
                    return { ok: true, findings: normalized.length, counts };
                }
                return { ok: true, findings: 0, note: 'nuclei produced no parseable report' };
            }

            case 'testssl_run': {
                securityScanStore.publishEvent(scanId, 'scanstat', { phase: 'testssl' });
                const r = await runEngine('testssl', {});
                if (r && r.json) {
                    const normalized = securityReportBuilder.normalizeTestssl(r.json);
                    findingArrays.push(normalized);
                    const counts = { high: 0, medium: 0, low: 0, informational: 0 };
                    for (const f of normalized) counts[_clampSeverity(f.severity)] += 1;
                    return { ok: true, findings: normalized.length, counts };
                }
                return { ok: true, findings: 0, note: 'testssl produced no parseable report' };
            }

            case 'terminal_exec': {
                const command = String(input?.command || '').trim();
                if (!command) return { ok: false, error: 'command is required' };
                securityScanStore.publishEvent(scanId, 'terminal', { command });

                let captured = '';
                let result;
                try {
                    result = await terminal.exec(command, {
                        onChunk: (c) => {
                            const chunk = c?.chunk != null ? String(c.chunk) : '';
                            const stream = c?.stream === 'stderr' ? 'stderr' : 'stdout';
                            // Keep a capped local copy for the tool_result; stream
                            // the rest straight to the UI terminal.
                            if (captured.length < 6000) captured += chunk;
                            securityScanStore.publishEvent(scanId, 'terminal', { chunk, stream });
                        },
                        timeoutMs: TERMINAL_TIMEOUT_MS(),
                    });
                } catch (e) {
                    securityScanStore.publishEvent(scanId, 'terminal', { exitCode: -1, done: true });
                    await log(`[agent] terminal_exec failed: ${e.message}`);
                    return { ok: false, error: e.message };
                }

                const exitCode = result?.exitCode != null ? result.exitCode : null;
                const timedOut = !!result?.timedOut;
                securityScanStore.publishEvent(scanId, 'terminal', { exitCode, done: true });
                await log(`[agent] $ ${command.slice(0, 120)} → exit ${exitCode}${timedOut ? ' (timed out)' : ''}`);

                return { ok: true, exitCode, timedOut, output: captured.slice(0, 6000) };
            }

            case 'record_finding': {
                const finding = {
                    engine: 'agent',
                    name: String(input?.name || 'Unnamed finding').slice(0, 200),
                    severity: _clampSeverity(input?.severity),
                    description: input?.description ? String(input.description).slice(0, 2000) : undefined,
                    solution: input?.solution ? String(input.solution).slice(0, 2000) : undefined,
                    evidence: input?.evidence ? String(input.evidence).slice(0, 2000) : undefined,
                    instanceCount: 1,
                };
                findingArrays.push([finding]);
                return { ok: true };
            }

            case 'done': {
                doneRequested = true;
                doneSummary = String(input?.summary || '').slice(0, 800);
                return { ok: true, done: true, summary: doneSummary };
            }

            default:
                return { ok: false, error: `unknown_tool: ${name}` };
        }
    }

    // ── The loop ──────────────────────────────────────────────────────────
    const systemPrompt = _loadPrompt();
    const messages = [{ role: 'user', content: _buildSeedMessage({ targetUrl, engines, activeAllowed: ALLOW_ACTIVE() }) }];

    let stopReason = null;

    try {
        while (stepCount < stepCap && !doneRequested) {
            if (securityScanStore.isCancelRequested(scanId)) {
                cancelled = true;
                await log('[agent] cancelled by user');
                break;
            }
            stepCount += 1;

            let response;
            try {
                response = await client.messages.create({
                    model: modelId,
                    max_tokens: 4096,
                    system: systemPrompt,
                    tools: TOOLS,
                    messages,
                });
            } catch (e) {
                await log(`[agent] llm error: ${e.message}`);
                erroredOut = true;
                break;
            }

            // Usage logging — best effort, never blocks the scan. The native
            // Anthropic SDK reports input_tokens/output_tokens; map to the
            // prompt/completion shape logUsage expects.
            try {
                const u = response.usage || {};
                await usageStore.logUsage({
                    user_id: userId,
                    organization_id: organizationId,
                    agent_type: 'security',
                    source: 'security_agent',
                    model: modelId,
                    prompt_tokens: u.input_tokens || 0,
                    completion_tokens: u.output_tokens || 0,
                    cached_tokens: u.cache_read_input_tokens || 0,
                    cache_creation_tokens: u.cache_creation_input_tokens || 0,
                    stop_reason: response.stop_reason || null,
                }).catch(() => {});
            } catch (_) { /* best effort */ }

            stopReason = response.stop_reason;
            messages.push({ role: 'assistant', content: response.content });

            const toolUses = (response.content || []).filter(b => b?.type === 'tool_use');
            const textBlocks = (response.content || []).filter(b => b?.type === 'text').map(b => b.text).filter(Boolean);
            for (const t of textBlocks) {
                if (t.trim()) await log(`[agent] ${t.trim().slice(0, 400)}`);
            }

            if (toolUses.length === 0) {
                // No tool call. On the first turn this means the model never
                // engaged the scanner (wrong model / prompt misread); later
                // turns it's just Claude signalling it's finished via text.
                if (stepCount === 1) {
                    await log(`[agent] model ${modelId} returned no tool_use on the first turn (stop_reason=${stopReason}). Aborting.`);
                    erroredOut = true;
                } else {
                    await log(`[agent] no further actions (stop_reason=${stopReason})`);
                }
                break;
            }

            const toolResults = [];
            for (const tu of toolUses) {
                if (securityScanStore.isCancelRequested(scanId)) { cancelled = true; break; }

                const summary = _summarizeInput(tu.input);
                securityScanStore.publishEvent(scanId, 'action', {
                    step: stepCount,
                    tool: tu.name,
                    input: tu.input || {},
                    summary,
                });
                await log(`[agent] ${tu.name} ${summary}`);

                let result;
                try {
                    result = await dispatch(tu.name, tu.input || {});
                } catch (e) {
                    result = { ok: false, error: e.message };
                }

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: JSON.stringify(result).slice(0, 8000),
                    is_error: !result?.ok,
                });
            }

            if (cancelled) break;
            messages.push({ role: 'user', content: toolResults });
        }

        if (!cancelled && !erroredOut && stepCount >= stepCap && !doneRequested) {
            await log(`[agent] reached MAX_STEPS=${stepCap}, ending`);
        }
    } catch (e) {
        await log(`[agent] session aborted: ${e.message}`);
        erroredOut = true;
    }

    // ── Build + persist the report ──────────────────────────────────────────
    const finishedAt = new Date().toISOString();
    const { findings, severitySummary } = securityReportBuilder.aggregate(findingArrays);

    let reportWebpageId = null;
    let html, css;
    try {
        ({ html, css } = securityReportBuilder.renderReportHtml({
            targetUrl,
            engines,
            findings,
            severitySummary,
            startedAt,
            finishedAt,
        }));
    } catch (e) {
        await log(`[agent] report render failed: ${e.message}`);
    }

    if (html != null) {
        reportWebpageId = await securityReportBuilder
            .persistReportWebpage({ userId, targetUrl, html, css })
            .catch(async (e) => {
                await log(`[agent] report webpage persist failed: ${e.message}`);
                return null;
            });
    }

    const status = cancelled ? 'cancelled' : (erroredOut ? 'error' : 'completed');

    const reportJson = {
        targetUrl,
        engines,
        mode: 'agent',
        startedAt,
        finishedAt,
        severitySummary,
        findings,
        stepCount,
        ...(doneSummary ? { summary: doneSummary } : {}),
        ...(status === 'error' ? { stopReason } : {}),
    };

    return {
        status,
        reportJson,
        reportWebpageId,
        severitySummary,
        ...(status === 'error' ? { error: 'agent_scan_failed' } : {}),
    };
}

function _buildSeedMessage({ targetUrl, engines, activeAllowed }) {
    const engineList = Array.isArray(engines) ? engines : [];
    const engineNames = engineList.map(e => (e && e.engine) ? e.engine : String(e)).filter(Boolean);
    const origin = (() => { try { return new URL(targetUrl).origin; } catch { return targetUrl; } })();

    const activeLine = activeAllowed
        ? 'Active (attack) scanning IS authorized for this run — you may use zap_active_scan against in-scope URLs after spidering and reviewing passive alerts.'
        : 'Active (attack) scanning is NOT authorized for this run — zap_active_scan will be refused. Rely on the spider, passive scanning, Nuclei, testssl and reconnaissance only.';

    return `You are running an authorized security scan of ${targetUrl}.

Scope: stay on ${origin}. This scan was explicitly authorized by the requester.

Available engines / tools:
- ZAP: zap_spider, zap_list_urls, zap_passive_status, zap_list_alerts${activeAllowed ? ', zap_active_scan' : ''}
- Engine runners: ${engineNames.length ? engineNames.join(', ') : '(none preselected)'} via nuclei_run / testssl_run
- Sandbox: terminal_exec (curl, openssl, nmap, dig, …)
- Reporting: record_finding (for conclusions the engines miss), done

${activeLine}

A sensible flow: zap_spider → zap_passive_status → zap_list_alerts, then run nuclei_run / testssl_run as appropriate, use terminal_exec for targeted checks, record any manual findings, then call done with a summary. Engine findings are captured automatically — only record_finding for what the engines did not surface.`;
}

module.exports = {
    runAgentScan,
    _internals: {
        TOOLS,
        DEFAULT_MAX_STEPS,
        MAX_STEPS_CEILING,
        FALLBACK_MODEL,
        SEVERITIES,
        ALLOW_ACTIVE,
        isClaude,
        _clampSeverity,
        _summarizeInput,
        _compactAlerts,
        _buildSeedMessage,
        _loadPrompt,
    },
};
