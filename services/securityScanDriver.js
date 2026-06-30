/**
 * Security Scan Driver — Claude drives an authorized security scan step-by-step.
 *
 * This is the AGENT mode of the Security Scan feature. We run a provider-
 * agnostic tool-use loop through the unified adapter layer (core/providers): the
 * model picked in the tier selector — Claude, Mistral/Devstral, OpenAI, Google,
 * whatever serves it — emits one tool call at a time, we execute it against a
 * live ZAP daemon (via zapClient), a tools sandbox (terminal.exec →
 * Nuclei/testssl/etc.), or the report builder, stream structured SSE events +
 * human log lines, and feed the tool result back into the next turn. The loop
 * speaks the OpenAI tool-calling shape; each adapter translates to its own wire
 * format, so there is no Claude-only gate.
 *
 * The loop ends when the model calls `done`, when MAX_STEPS is reached, or when
 * the route layer requests cancellation (securityScanStore.isCancelRequested).
 *
 * The infra (ZAP daemon, tools sandbox, engine runners) is provisioned by the
 * worker and injected here as `zap`, `terminal.exec`, and `runEngine` — this
 * module never spawns containers and never holds credentials beyond the ZAP
 * api.key it forwards through zapClient. That api.key is NEVER logged.
 *
 * No new npm deps — the unified adapter layer (and the @anthropic-ai/sdk it
 * wraps for the Claude path) already ships with the app.
 */

const fs = require('fs');
const path = require('path');

const securityScanStore = require('../stores/securityScanStore');
const securityReportBuilder = require('./securityReportBuilder');
const configStore = require('../stores/configStore');
const usageStore = require('../stores/usageStore');
const { makeZapClient } = require('./zapClient');
const { resolveModelForTier } = require('../core/modelResolver');
const aggressionPolicy = require('../core/securityAggression');

const SCAN_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'security-scan-prompt.md');

const DEFAULT_MAX_STEPS = parseInt(process.env.SECURITY_AGENT_MAX_STEPS || '60', 10);
const MAX_STEPS_CEILING = parseInt(process.env.SECURITY_AGENT_MAX_STEPS_CEILING || '300', 10);
const FALLBACK_MODEL = 'claude-sonnet-4-6';
const SEVERITIES = ['high', 'medium', 'low', 'informational'];
const FALLBACK_TIER = 'tier:thinking';

// The agent works in this one writable dir inside the toolbox container. The
// file_read/file_write tools are scoped to it.
const WORK_DIR = '/home/scanner/work';

const TERMINAL_TIMEOUT_MS = () => parseInt(process.env.SECURITY_TERMINAL_TIMEOUT_MS || '120000', 10);
const TERMINAL_MAX_TIMEOUT_MS = () => parseInt(process.env.SECURITY_TERMINAL_MAX_TIMEOUT_MS || '600000', 10);
const TERMINAL_OUTPUT_CAP = parseInt(process.env.SECURITY_TERMINAL_OUTPUT_CAP || '16000', 10);

// Shell-quote a value for safe single-command interpolation.
function _shq(v) {
    return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

// Resolve an agent-supplied path under WORK_DIR; null if it escapes the sandbox
// dir (defence in depth — the container is already isolated, but file tools
// shouldn't wander outside the scratch dir).
function _safeWorkPath(p) {
    const raw = String(p || '').trim();
    if (!raw) return null;
    const resolved = path.posix.normalize(path.posix.isAbsolute(raw) ? raw : path.posix.join(WORK_DIR, raw));
    if (resolved !== WORK_DIR && !resolved.startsWith(WORK_DIR + '/')) return null;
    return resolved;
}

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
        description: 'Run ZAP active (attack) scanning against a URL. DESTRUCTIVE — sends crafted payloads. Available only when this run\'s aggression level is "active" or higher; otherwise it returns an error.',
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
        description: 'Run ANY command in the isolated toolbox container — a full Kali pentest box. Every tool is available: nmap, masscan, nuclei, sqlmap, nikto, whatweb, wafw00f, wpscan, ffuf, feroxbuster, gobuster, httpx, subfinder, dnsx, katana, dalfox, testssl.sh, openssl, curl, wget, dig, jq, python3, git, and the SecLists wordlists under /usr/share/seclists. The container is network-isolated (egress-only, can reach the target, shares nothing with the host) and you have full control. Output is streamed and truncated to ~16KB. Long-running tools should be given a higher timeoutMs.',
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command to execute in the toolbox container.' },
                timeoutMs: { type: 'integer', description: 'Optional per-command timeout in ms (default 120000, max 600000). Raise it for slow scans (sqlmap, ffuf, masscan).' },
            },
            required: ['command'],
        },
    },
    {
        name: 'file_write',
        description: 'Write a file into the toolbox scratch dir (/home/scanner/work) — stage a payload/wordlist, a custom nuclei template, or a python/bash script to run via terminal_exec. Paths are scoped to the scratch dir.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path under /home/scanner/work (absolute or relative to it).' },
                content: { type: 'string', description: 'File contents.' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'file_read',
        description: 'Read back a file from the toolbox scratch dir (/home/scanner/work) — e.g. a tool report you wrote earlier. Returns up to ~20KB.',
        input_schema: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Path under /home/scanner/work.' } },
            required: ['path'],
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
        description: 'End the scan. Call when the tools have run, alerts have been reviewed, and there are no further useful actions. Provide BOTH a short `summary` and a full written `report` (markdown) — the report becomes the "Assessment" narrative in the final report alongside the structured findings.',
        input_schema: {
            type: 'object',
            properties: {
                summary: { type: 'string', description: 'One short paragraph (2-4 sentences) of the scan and its conclusions — shown in the run console.' },
                report: { type: 'string', description: 'A thorough written assessment in MARKDOWN: executive summary, methodology/scope tested, discussion of the key findings with context + exploitability, overall risk posture, and prioritized remediation. This is the narrative readers see in the report.' },
            },
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

// Convert the Anthropic-style TOOLS schema (name/description/input_schema) to
// the provider-agnostic OpenAI function-calling shape the unified adapter layer
// expects. The Claude adapter converts it back to input_schema internally;
// OpenAI/Mistral/Google use it as-is. Kept as a derived copy so TOOLS stays the
// single source of truth (and the helpers test keeps asserting on it).
function _toUnifiedTools(tools) {
    return (Array.isArray(tools) ? tools : []).map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            description: t.description || '',
            parameters: t.input_schema || { type: 'object', properties: {} },
        },
    }));
}
const UNIFIED_TOOLS = _toUnifiedTools(TOOLS);

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
    modelTier = null,
    aggression = null,
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

    // Effective aggression = the chosen level clamped to the server ceiling.
    // Active (attack) scanning unlocks at 'active'; the structured zap_active_scan
    // tool is hard-gated on it (defence in depth alongside the prompt steering).
    const effectiveAggression = aggressionPolicy.clamp(aggression || aggressionPolicy.DEFAULT_AGGRESSION);
    const activeAllowed = aggressionPolicy.atLeast(effectiveAggression, 'active');

    // Single clock read at entry — keeps timestamps reproducible-ish and avoids
    // sprinkling Date.now() through the loop (mirrors securityReportBuilder's
    // "timestamps are passed in" contract).
    const startedAt = new Date().toISOString();

    const log = async (line) => {
        if (!line) return;
        try { await securityScanStore.appendProgress(scanId, line); } catch (_) {}
        if (typeof onLine === 'function') { try { onLine(line); } catch (_) {} }
    };

    // Resolve the user-selected model tier to a concrete model id, then route it
    // to whichever provider actually serves it (Claude, Mistral/Devstral, OpenAI,
    // Google, …) through the unified adapter layer. The agent loop below is
    // provider-agnostic: it speaks the OpenAI tool-calling shape and each adapter
    // translates to its own wire format (the Claude adapter converts the
    // tool_calls ⇆ tool_use blocks internally), so the model the user picked in
    // the tier selector is the model that drives the scan — no Claude-only gate.
    const { getAdapter } = require('../core/providers');
    const { getProviderForModel } = require('../core/aiAgent');

    const tierRef = modelTier ? `tier:${modelTier}` : FALLBACK_TIER;
    const resolved = await resolveModelForTier(tierRef, { userOrgId: organizationId, userId });

    let modelId = resolved || FALLBACK_MODEL;
    let provider = null;
    try {
        provider = await getProviderForModel(modelId);
    } catch (e) {
        // The chosen tier points at a model no configured provider serves — fall
        // back to the known-good Claude model rather than failing the scan.
        await log(`[agent] model "${modelId}" is not served by any configured provider — falling back to ${FALLBACK_MODEL}`);
        modelId = FALLBACK_MODEL;
        try { provider = await getProviderForModel(modelId); }
        catch (_) { return { status: 'error', error: 'no_provider_for_model' }; }
    }
    if (!provider || (!provider.apiKey && !provider.serviceAccountKey)) {
        await log(`[agent] no credentials configured for the provider serving ${modelId}`);
        return { status: 'error', error: 'provider_api_key_not_configured' };
    }

    const adapter = getAdapter(provider.providerType, provider.url);
    await log(`[agent] using model ${modelId}${modelTier ? ` (tier:${modelTier})` : ''} via ${provider.providerName || provider.providerType || 'provider'} · aggression: ${effectiveAggression}`);
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
    let doneReport = '';
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
                if (!activeAllowed) {
                    return { ok: false, error: `active_scan_requires_aggression_active (current level: ${effectiveAggression})` };
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
                const reqTimeout = parseInt(input?.timeoutMs, 10);
                const timeoutMs = Number.isFinite(reqTimeout)
                    ? Math.min(Math.max(reqTimeout, 1000), TERMINAL_MAX_TIMEOUT_MS())
                    : TERMINAL_TIMEOUT_MS();
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
                            if (captured.length < TERMINAL_OUTPUT_CAP) captured += chunk;
                            securityScanStore.publishEvent(scanId, 'terminal', { chunk, stream });
                        },
                        timeoutMs,
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

                return { ok: true, exitCode, timedOut, output: captured.slice(0, TERMINAL_OUTPUT_CAP) };
            }

            case 'file_write': {
                const p = _safeWorkPath(input?.path);
                if (!p) return { ok: false, error: 'path must be within /home/scanner/work' };
                const content = String(input?.content ?? '');
                const b64 = Buffer.from(content, 'utf8').toString('base64');
                const dir = p.replace(/\/[^/]*$/, '') || WORK_DIR;
                // base64 round-trip keeps arbitrary content (quotes, newlines, binary) intact.
                const cmd = `mkdir -p ${_shq(dir)} && printf %s ${_shq(b64)} | base64 -d > ${_shq(p)}`;
                let result;
                try {
                    result = await terminal.exec(cmd, { onChunk: () => {}, timeoutMs: 20000 });
                } catch (e) {
                    return { ok: false, error: e.message };
                }
                const ok = result?.exitCode === 0;
                await log(`[agent] file_write ${p} (${content.length} bytes)${ok ? '' : ' — failed'}`);
                return ok ? { ok: true, path: p, bytes: content.length } : { ok: false, error: `write failed (exit ${result?.exitCode})` };
            }

            case 'file_read': {
                const p = _safeWorkPath(input?.path);
                if (!p) return { ok: false, error: 'path must be within /home/scanner/work' };
                let out = '';
                let result;
                try {
                    result = await terminal.exec(`cat ${_shq(p)} 2>/dev/null | head -c 20000`, {
                        onChunk: (c) => { if (c?.stream === 'stdout') out += c?.chunk != null ? String(c.chunk) : ''; },
                        timeoutMs: 20000,
                    });
                } catch (e) {
                    return { ok: false, error: e.message };
                }
                if (result?.exitCode !== 0 && !out) return { ok: false, error: 'file not found or unreadable' };
                return { ok: true, path: p, content: out.slice(0, 20000) };
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
                doneReport = String(input?.report || '').slice(0, 12000);
                return { ok: true, done: true, summary: doneSummary };
            }

            default:
                return { ok: false, error: `unknown_tool: ${name}` };
        }
    }

    // ── The loop ──────────────────────────────────────────────────────────
    // OpenAI-style message history: a leading system message (the Claude adapter
    // extracts it into the `system` param; OpenAI/Mistral pass it through) plus
    // the seed user turn.
    const systemPrompt = _loadPrompt();
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: _buildSeedMessage({ targetUrl, engines, aggression: effectiveAggression, activeAllowed }) });

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
                response = await adapter.chat(provider.apiKey, provider.url, modelId, messages, {
                    maxTokens: 4096,
                    tools: UNIFIED_TOOLS,
                    toolChoice: 'auto',
                });
            } catch (e) {
                await log(`[agent] llm error: ${e.message}`);
                erroredOut = true;
                break;
            }

            // Usage logging — best effort, never blocks the scan. Usage shape
            // differs by provider: Anthropic reports input_tokens/output_tokens,
            // OpenAI-compatible providers report prompt_tokens/completion_tokens.
            // Accept either and map to the shape logUsage expects.
            try {
                const u = response.usage || {};
                await usageStore.logUsage({
                    user_id: userId,
                    organization_id: organizationId,
                    agent_type: 'security',
                    source: 'security_agent',
                    model: modelId,
                    prompt_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
                    completion_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
                    cached_tokens: u.cache_read_input_tokens ?? u.cached_tokens ?? 0,
                    cache_creation_tokens: u.cache_creation_input_tokens ?? u.cache_creation_tokens ?? 0,
                    stop_reason: response.stopReason ?? response.raw?.choices?.[0]?.finish_reason ?? null,
                }).catch(() => {});
            } catch (_) { /* best effort */ }

            stopReason = response.stopReason ?? response.raw?.choices?.[0]?.finish_reason ?? null;

            // Replay the assistant turn in the OpenAI tool-calling shape. The
            // Claude adapter converts tool_calls → tool_use blocks on the next
            // request; OpenAI/Mistral consume it natively.
            const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
            messages.push({
                role: 'assistant',
                content: typeof response.content === 'string' ? response.content : '',
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            });

            const assistantText = typeof response.content === 'string' ? response.content.trim() : '';
            if (assistantText) await log(`[agent] ${assistantText.slice(0, 400)}`);

            // Normalize each tool call to { id, name, input } regardless of
            // provider — arguments arrive as a JSON string in the OpenAI shape.
            const toolUses = toolCalls.map((tc) => {
                const fn = tc.function || tc;
                let input = {};
                try {
                    input = typeof fn.arguments === 'string'
                        ? JSON.parse(fn.arguments || '{}')
                        : (fn.arguments || fn.input || {});
                } catch (_) { input = {}; }
                return { id: tc.id, name: fn.name, input };
            });

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

            const toolMessages = [];
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

                // OpenAI tool-result shape; the Claude adapter maps each
                // role:'tool' message to a Claude tool_result block (paired by
                // tool_call_id). The prompt keeps the agent to one tool per turn.
                toolMessages.push({
                    role: 'tool',
                    tool_call_id: tu.id,
                    content: JSON.stringify(result).slice(0, 8000),
                });
            }

            if (cancelled) break;
            messages.push(...toolMessages);
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
            narrative: doneReport,
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
        model: modelId,
        modelTier: modelTier || 'thinking',
        aggression: effectiveAggression,
        startedAt,
        finishedAt,
        severitySummary,
        findings,
        stepCount,
        ...(doneSummary ? { summary: doneSummary } : {}),
        ...(doneReport ? { narrative: doneReport } : {}),
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

// Plain-language description of what each aggression level permits. Steers the
// agent's use of the free-form terminal (which can't be perfectly gated); the
// structured zap_active_scan tool is additionally hard-gated.
const AGGRESSION_GUIDANCE = {
    recon: 'RECON ONLY — discovery and passive reconnaissance (crawl, httpx, subfinder, whatweb, dig, curl, nmap TCP-connect). Do NOT send attack traffic, run ZAP active scan, fuzz, or run sqlmap.',
    passive: 'PASSIVE — recon plus non-intrusive scanning: ZAP passive alerts, safe Nuclei templates, testssl. Do NOT run ZAP active scan, fuzzing, or sqlmap attacks.',
    active: 'ACTIVE — passive plus active scanning: ZAP active scan, intrusive Nuclei tags, directory/parameter fuzzing (ffuf/feroxbuster), nmap -sS / masscan. Probe, do not exploit destructively.',
    offensive: 'OFFENSIVE — full authorized offensive testing: everything in ACTIVE plus sqlmap attacks and exploit-confirmation probes. Still no data destruction or exfiltration beyond what proves a finding.',
};

function _buildSeedMessage({ targetUrl, engines, aggression, activeAllowed }) {
    const engineList = Array.isArray(engines) ? engines : [];
    const engineNames = engineList.map(e => (e && e.engine) ? e.engine : String(e)).filter(Boolean);
    const origin = (() => { try { return new URL(targetUrl).origin; } catch { return targetUrl; } })();

    const level = aggression || 'passive';
    const aggressionLine = AGGRESSION_GUIDANCE[level] || AGGRESSION_GUIDANCE.passive;
    const activeLine = activeAllowed
        ? 'zap_active_scan IS available at this level — use it against in-scope URLs after spidering and reviewing passive alerts.'
        : 'zap_active_scan is DISABLED at this level and will be refused — rely on the spider, passive scanning, Nuclei, testssl and reconnaissance.';

    return `You are running an authorized security scan of ${targetUrl}.

Scope: stay on ${origin}. This scan was explicitly authorized by the requester.

Aggression level: ${level.toUpperCase()}. ${aggressionLine}
${activeLine}

You have FULL control of one isolated Kali toolbox container (egress-only; it can reach the target, shares nothing with the host). Tools:
- ZAP (structured, drives the live view): zap_spider, zap_list_urls, zap_passive_status, zap_list_alerts${activeAllowed ? ', zap_active_scan' : ''}
- Convenience engine runners: nuclei_run, testssl_run${engineNames.length ? ` (preselected: ${engineNames.join(', ')})` : ''}
- terminal_exec: run ANY tool in the container — nmap, masscan, nuclei, sqlmap, nikto, whatweb, wafw00f, wpscan, ffuf, feroxbuster, gobuster, httpx, subfinder, dnsx, katana, dalfox, testssl.sh, openssl, curl, dig, jq, python3, and the SecLists wordlists in /usr/share/seclists. Raise timeoutMs for slow scans.
- file_write / file_read: stage payloads/wordlists/scripts in /home/scanner/work and read tool output back.
- Reporting: record_finding (for conclusions the engines miss), done.

A sensible flow: zap_spider → zap_passive_status → zap_list_alerts, then run nuclei_run / testssl_run and use terminal_exec for whatever deeper testing the aggression level permits, record manual findings, then call done with a summary. Engine + ZAP findings are captured automatically — only record_finding for what they did not surface.`;
}

module.exports = {
    runAgentScan,
    _internals: {
        TOOLS,
        DEFAULT_MAX_STEPS,
        MAX_STEPS_CEILING,
        FALLBACK_MODEL,
        FALLBACK_TIER,
        SEVERITIES,
        WORK_DIR,
        isClaude,
        _clampSeverity,
        _summarizeInput,
        _compactAlerts,
        _buildSeedMessage,
        _loadPrompt,
        _safeWorkPath,
        _shq,
    },
};
