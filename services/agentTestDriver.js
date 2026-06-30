/**
 * Agent Test Driver — an LLM drives Playwright step-by-step.
 *
 * The user picks a YouTrack issue, GitHub issue/PR, or pastes a spec; the
 * worker resolves the source body and hands it to runAgentMode() as the
 * instruction. We then run a provider-agnostic tool-use loop through the
 * unified adapter layer (core/providers): the model the "thinking" tier
 * resolves to — Claude, Mistral/Devstral, OpenAI, Google, whatever serves it —
 * emits one pw_* tool call at a time, we execute it against a live Chromium
 * page, stream a JPEG frame + structured action log over SSE, and feed the
 * tool result back into the next turn. The loop speaks the OpenAI tool-calling
 * shape; each adapter translates to its own wire format, so there is no
 * Claude-only gate.
 *
 * The loop ends when the model calls `pw_done`, when MAX_STEPS is reached,
 * or when the worker is timed out by the parent.
 *
 * No new npm deps — the unified adapter layer (and the @anthropic-ai/sdk it
 * wraps for the Claude path) plus the existing `playwright` package already
 * ship with the app.
 */

const fs = require('fs');
const path = require('path');

const testRunStore = require('../stores/testRunStore');
const { resolveModelForTier } = require('../core/modelResolver');

const EXPLORER_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'test-explorer-prompt.md');
const DEFAULT_MAX_STEPS = parseInt(process.env.PLAYWRIGHT_AGENT_MAX_STEPS || '25', 10);
const MAX_STEPS_CEILING = parseInt(process.env.PLAYWRIGHT_AGENT_MAX_STEPS_CEILING || '200', 10);
const MIN_FRAME_INTERVAL_MS = parseInt(process.env.PLAYWRIGHT_AGENT_MIN_FRAME_INTERVAL_MS || '180', 10); // ~5 FPS cap
const STEP_TIMEOUT_MS = 15_000;
const FALLBACK_MODEL = 'claude-sonnet-4-6';

function _loadPrompt() {
    try { return fs.readFileSync(EXPLORER_PROMPT_PATH, 'utf-8'); }
    catch (_) { return ''; }
}

// Tool schemas exposed to Claude. Names are namespaced with pw_ so they
// never collide with anything else in our agent runtime.
const TOOLS = [
    {
        name: 'pw_navigate',
        description: 'Navigate the browser to a URL. Must stay on the same origin as the initial target — cross-origin requests are blocked and recorded as a skipped finding.',
        input_schema: {
            type: 'object',
            properties: { url: { type: 'string', description: 'Absolute URL to navigate to.' } },
            required: ['url'],
        },
    },
    {
        name: 'pw_click',
        description: 'Click an element. Prefer role+name over CSS — uses Playwright getByRole when both are provided, otherwise falls back to the CSS selector.',
        input_schema: {
            type: 'object',
            properties: {
                role: { type: 'string', description: 'ARIA role (e.g. button, link, textbox).' },
                name: { type: 'string', description: 'Accessible name of the element.' },
                selector: { type: 'string', description: 'CSS selector — only when role+name cannot identify the element.' },
            },
        },
    },
    {
        name: 'pw_type',
        description: 'Type text into an input. Mark placeholder values clearly (e.g. "test@example.invalid") so the report can flag them. Never type real credentials.',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector for the input — fallback when role+name are not enough.' },
                role: { type: 'string' },
                name: { type: 'string' },
                text: { type: 'string', description: 'Text to type.' },
                submit: { type: 'boolean', description: 'Press Enter after typing.' },
            },
            required: ['text'],
        },
    },
    {
        name: 'pw_snapshot',
        description: 'Get a compact accessibility-tree snapshot of the current page. Use this before deciding where to click — it is far cheaper than a screenshot.',
        input_schema: { type: 'object', properties: {} },
    },
    {
        name: 'pw_get_text',
        description: 'Read visible text of the page (or a specific element). Use to verify assertions like "page shows X".',
        input_schema: {
            type: 'object',
            properties: { selector: { type: 'string', description: 'CSS selector — omit to read the whole <body>.' } },
        },
    },
    {
        name: 'pw_record_finding',
        description: 'Append a finding (matches json-test-report.tests[]) to the report. Call after every meaningful observation — pass, fail, warning, or skip.',
        input_schema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                status: { type: 'string', enum: ['passed', 'failed', 'skipped', 'warning'] },
                category: { type: 'string', enum: ['functionality', 'ui', 'performance', 'accessibility', 'security'] },
                severity: { type: 'string', enum: ['critical', 'major', 'minor', 'cosmetic'] },
                description: { type: 'string' },
                steps: { type: 'array', items: { type: 'string' } },
                error: { type: 'string' },
            },
            required: ['name', 'status', 'category'],
        },
    },
    {
        name: 'pw_done',
        description: 'End the exploration. Call when the ticket is verified, reproduced, or after determining no further actions help.',
        input_schema: {
            type: 'object',
            properties: { summary: { type: 'string', description: 'One-paragraph summary of what was observed.' } },
        },
    },
];

// Convert the Anthropic-style TOOLS schema (name/description/input_schema) to
// the provider-agnostic OpenAI function-calling shape the unified adapter layer
// expects. The Claude adapter converts it back to input_schema internally;
// OpenAI/Mistral/Google use it as-is. Derived from TOOLS so the schema stays a
// single source of truth (and the test keeps asserting on TOOLS).
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

// ── Tool dispatcher ──────────────────────────────────────────────

async function _resolveLocator(page, { role, name, selector }) {
    if (role && name) return page.getByRole(role, { name });
    if (role) return page.getByRole(role);
    if (selector) return page.locator(selector);
    throw new Error('locator requires role+name or selector');
}

// ── Credential placeholders ─────────────────────────────────────
// Claude is instructed to type {{USERNAME}} / {{PASSWORD}} into login
// fields. The dispatcher swaps placeholders for real values *immediately*
// before page.fill(), so the real secret is never in Claude's context,
// never in the SSE action log, and never in the progress log.
//
// Placeholders are intentionally explicit + bracketed so a typo'd token
// (e.g. {{password}} lowercase) won't accidentally leak as literal text.
const PLACEHOLDER_RX = /\{\{(USERNAME|PASSWORD|EMAIL|TOTP)\}\}/g;

function _substitutePlaceholders(text, credentials) {
    if (typeof text !== 'string' || !credentials) return text;
    return text.replace(PLACEHOLDER_RX, (_, key) => {
        const k = key.toLowerCase();
        const v = credentials[k];
        return (typeof v === 'string' && v.length > 0) ? v : `{{${key}}}`;
    });
}

function _redactInputForLogs(input, credentials) {
    // Build a sanitised copy of the tool input that's safe to push into the
    // SSE action stream and the progress log. The agent only ever sees and
    // emits placeholders, but defence-in-depth: if a real secret somehow
    // ends up in `text` (e.g. operator pre-fills the form by mistake), we
    // still mask it before broadcasting.
    if (!input || typeof input !== 'object') return input;
    const out = { ...input };
    if (typeof out.text === 'string' && credentials) {
        let masked = out.text;
        for (const [k, v] of Object.entries(credentials)) {
            if (typeof v === 'string' && v.length > 2 && masked.includes(v)) {
                masked = masked.split(v).join(`{{${k.toUpperCase()}}}`);
            }
        }
        out.text = masked;
    }
    return out;
}

async function _executeTool(page, name, input, { findings, sameOriginGuard, credentials }) {
    switch (name) {
        case 'pw_navigate': {
            const url = String(input?.url || '').trim();
            if (!url) return { ok: false, error: 'url is required' };
            if (!sameOriginGuard(url)) {
                findings.push({
                    name: `Blocked off-origin navigation to ${url}`,
                    status: 'skipped',
                    category: 'security',
                    description: 'Agent attempted to leave the initial target origin. Blocked by sandbox.',
                });
                return { ok: false, error: 'navigation_blocked: cross_origin' };
            }
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT_MS });
            return { ok: true, url: page.url(), title: await page.title().catch(() => '') };
        }
        case 'pw_click': {
            const loc = await _resolveLocator(page, input || {});
            await loc.first().click({ timeout: STEP_TIMEOUT_MS });
            return { ok: true };
        }
        case 'pw_type': {
            const rawText = String(input?.text || '');
            // Substitute {{USERNAME}}/{{PASSWORD}}/{{EMAIL}}/{{TOTP}} with the
            // real values right before .fill() so secrets stay out of every
            // log path. If the placeholder doesn't match a credential it
            // passes through unchanged so a typo doesn't silently write
            // an empty string.
            const text = _substitutePlaceholders(rawText, credentials);
            const usedPlaceholder = text !== rawText;
            const loc = input?.role || input?.selector
                ? await _resolveLocator(page, input)
                : page.locator('input:visible, textarea:visible').first();
            await loc.first().fill(text, { timeout: STEP_TIMEOUT_MS });
            if (input?.submit) await loc.first().press('Enter');
            return { ok: true, typed: text.length, usedCredential: usedPlaceholder };
        }
        case 'pw_snapshot': {
            const snap = await page.accessibility.snapshot({ interestingOnly: true }).catch(() => null);
            // Compact YAML-ish flattening so Claude doesn't choke on raw JSON.
            return { ok: true, tree: _flattenA11y(snap).slice(0, 6000) };
        }
        case 'pw_get_text': {
            const sel = String(input?.selector || '').trim();
            const txt = sel
                ? await page.locator(sel).first().innerText({ timeout: STEP_TIMEOUT_MS }).catch(() => '')
                : await page.locator('body').innerText({ timeout: STEP_TIMEOUT_MS }).catch(() => '');
            return { ok: true, text: String(txt).slice(0, 4000) };
        }
        case 'pw_record_finding': {
            const f = {
                name: String(input?.name || 'Unnamed finding').slice(0, 200),
                status: ['passed', 'failed', 'skipped', 'warning'].includes(input?.status) ? input.status : 'warning',
                category: ['functionality', 'ui', 'performance', 'accessibility', 'security'].includes(input?.category) ? input.category : 'functionality',
                severity: ['critical', 'major', 'minor', 'cosmetic'].includes(input?.severity) ? input.severity : undefined,
                description: input?.description ? String(input.description).slice(0, 1000) : undefined,
                steps: Array.isArray(input?.steps) ? input.steps.slice(0, 10).map(s => String(s).slice(0, 200)) : undefined,
                error: input?.error ? String(input.error).slice(0, 800) : undefined,
            };
            findings.push(f);
            return { ok: true };
        }
        case 'pw_done': {
            return { ok: true, done: true, summary: String(input?.summary || '').slice(0, 800) };
        }
        default:
            return { ok: false, error: `unknown_tool: ${name}` };
    }
}

function _flattenA11y(node, depth = 0, lines = []) {
    if (!node || depth > 8) return lines.join('\n');
    const indent = '  '.repeat(depth);
    const role = node.role || 'generic';
    const name = node.name ? ` "${String(node.name).slice(0, 80)}"` : '';
    const focusable = node.focusable ? ' [focusable]' : '';
    const checked = node.checked != null ? ` [checked=${node.checked}]` : '';
    lines.push(`${indent}- ${role}${name}${focusable}${checked}`);
    for (const c of (node.children || [])) _flattenA11y(c, depth + 1, lines);
    return lines.join('\n');
}

// ── Live-frame emitter ───────────────────────────────────────────

function _makeFrameEmitter(runId, page) {
    let lastSent = 0;
    let step = 0;
    return async function emitFrame(action) {
        step += 1;
        const now = Date.now();
        if (now - lastSent < MIN_FRAME_INTERVAL_MS) return; // throttle
        lastSent = now;
        try {
            const buf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false, timeout: 5000 });
            const b64 = buf.toString('base64');
            testRunStore.publishEvent(runId, 'frame', { b64, step, action });
        } catch (_) { /* page may have navigated — drop the frame */ }
    };
}

// ── Public entry point ──────────────────────────────────────────

/**
 * Run the agentic tool-use loop.
 *
 * @param {object} args
 * @param {string} args.runId
 * @param {string} args.targetUrl
 * @param {string} args.instructions  — resolved ticket body / spec
 * @param {string} args.userId
 * @param {string|null} [args.organizationId]
 * @param {object} [args.sourceMeta]  — { type, label } for the report header
 * @returns {Promise<{status:'passed'|'failed'|'error', reportJson:object, error?:string}>}
 */
async function runAgentMode({ runId, targetUrl, instructions, userId, organizationId = null, sourceMeta = null, credentials = null, maxSteps = null, cdpEndpoint = null }) {
    const stepCap = Math.min(
        Math.max(parseInt(maxSteps, 10) || DEFAULT_MAX_STEPS, 1),
        MAX_STEPS_CEILING,
    );
    let playwright;
    try { playwright = require('playwright'); }
    catch (_) { return { status: 'error', error: 'playwright_not_installed' }; }

    // Resolve the configured "thinking" tier to a concrete model, then route it
    // to whichever provider actually serves it (Claude, Mistral/Devstral, OpenAI,
    // Google, …) through the unified adapter layer. The loop below is provider-
    // agnostic: it speaks the OpenAI tool-calling shape and each adapter
    // translates to its own wire format (the Claude adapter converts the
    // tool_calls ⇆ tool_use blocks internally), so the model the tier points at
    // is the model that drives the browser — no Claude-only gate.
    const { getAdapter } = require('../core/providers');
    const { getProviderForModel } = require('../core/aiAgent');

    const resolved = await resolveModelForTier('tier:thinking', { userOrgId: organizationId, userId });
    let modelId = resolved || FALLBACK_MODEL;
    let provider = null;
    try {
        provider = await getProviderForModel(modelId);
    } catch (e) {
        // The tier points at a model no configured provider serves — fall back to
        // the known-good Claude model rather than failing the run.
        await testRunStore.appendProgress(runId, `[agent] model "${modelId}" is not served by any configured provider — falling back to ${FALLBACK_MODEL}`);
        modelId = FALLBACK_MODEL;
        try { provider = await getProviderForModel(modelId); }
        catch (_) {
            return {
                status: 'error',
                error: 'no_provider_for_model: Agent mode needs a configured model provider. Set one under Admin → AI Config.',
            };
        }
    }
    if (!provider || (!provider.apiKey && !provider.serviceAccountKey)) {
        return {
            status: 'error',
            error: 'provider_api_key_not_configured: Agent mode requires a model provider with credentials. Set one under Admin → AI Config.',
        };
    }
    const adapter = getAdapter(provider.providerType, provider.url);
    await testRunStore.appendProgress(runId, `[agent] using model ${modelId} via ${provider.providerName || provider.providerType || 'provider'}`);
    const findings = [];
    const stepLog = [];
    let browser, ctx, page;

    const targetOrigin = (() => {
        try { return new URL(targetUrl).origin; } catch { return null; }
    })();
    const sameOriginGuard = (rawUrl) => {
        if (!targetOrigin) return false;
        try { return new URL(rawUrl, targetUrl).origin === targetOrigin; }
        catch { return false; }
    };

    try {
        // When a cdpEndpoint is supplied the browser runs inside a per-run
        // isolated runner container and we drive it remotely — the untrusted
        // target site never touches this process. Host mode falls back to the
        // shared singleton browser (also remote, never in-process).
        if (cdpEndpoint) {
            browser = await playwright.chromium.connect(cdpEndpoint);
            ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        } else {
            // Host fallback: no Chromium is baked into the image, so drive the
            // shared singleton browser. Only the context is ours to close — the
            // shared browser/connection is owned by browserProvider.
            const browserProvider = require('./browserProvider');
            ctx = await browserProvider.newSharedContext({ viewport: { width: 1280, height: 800 } });
        }

        // Block cross-origin navigation requests defensively at the network
        // layer — the per-tool guard catches pw_navigate, this catches the
        // case where a click triggers a same-domain navigation that then
        // 30x-redirects somewhere else.
        await ctx.route('**/*', (route, req) => {
            if (req.isNavigationRequest() && !sameOriginGuard(req.url())) {
                findings.push({
                    name: `Blocked cross-origin nav to ${new URL(req.url()).origin}`,
                    status: 'skipped',
                    category: 'security',
                    description: 'Request was blocked because it left the initial target origin.',
                });
                return route.abort();
            }
            return route.continue();
        });

        page = await ctx.newPage();
        page.setDefaultTimeout(STEP_TIMEOUT_MS);

        // Visual redaction: blur every password field on every load so the
        // typed secret never appears as recognisable pixels in the frame
        // stream that goes to the UI (and would also be visible to Claude
        // if vision mode were ever enabled).
        if (credentials) {
            await ctx.addInitScript(() => {
                try {
                    const style = document.createElement('style');
                    style.setAttribute('data-bf-redact', '1');
                    style.textContent = `
                      input[type="password"] {
                        filter: blur(6px) !important;
                        -webkit-text-security: disc !important;
                      }
                    `;
                    (document.head || document.documentElement).appendChild(style);
                } catch (_) { /* page may not be ready yet — retried on next nav */ }
            });
        }

        const emitFrame = _makeFrameEmitter(runId, page);

        // Seed: navigate to the target URL first so the agent doesn't waste
        // a turn on the obvious opening move.
        await testRunStore.appendProgress(runId, `[agent] navigating to ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await emitFrame({ tool: 'pw_navigate', input: { url: targetUrl } });

        const systemPrompt = _loadPrompt();
        const availablePlaceholders = credentials
            ? Object.keys(credentials).filter(k => typeof credentials[k] === 'string' && credentials[k].length > 0).map(k => k.toUpperCase())
            : [];
        const userMessage = _buildSeedMessage({ targetUrl, instructions, sourceMeta, availablePlaceholders });
        // OpenAI-style history: a leading system message (the Claude adapter
        // extracts it into the `system` param; OpenAI/Mistral pass it through)
        // plus the seed user turn.
        const messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        messages.push({ role: 'user', content: userMessage });

        let stopReason = null;
        let stepCount = 0;
        let doneRequested = false;
        let cancelled = false;

        while (stepCount < stepCap && !doneRequested) {
            if (testRunStore.isCancelRequested(runId)) {
                cancelled = true;
                await testRunStore.appendProgress(runId, '[agent] cancelled by user');
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
                await testRunStore.appendProgress(runId, `[agent] llm error: ${e.message}`);
                findings.push({
                    name: 'Agent run aborted',
                    status: 'failed',
                    category: 'functionality',
                    severity: 'critical',
                    description: `Claude call failed at step ${stepCount}: ${e.message}`,
                });
                break;
            }

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

            const textBlocks = (typeof response.content === 'string' && response.content.trim())
                ? [response.content.trim()]
                : [];
            for (const t of textBlocks) {
                if (t.trim()) await testRunStore.appendProgress(runId, `[agent] ${t.trim().slice(0, 400)}`);
            }

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
                // Two cases land here:
                //   1) Claude said "I'm done" via text — legitimate, just stop.
                //   2) Claude returned text-only reasoning without invoking a tool
                //      (most common cause: the model isn't following the tool-use
                //      contract, or the prompt isn't making the tools obvious).
                // On step 1 with no tool_use, treat it as an error so the user
                // sees that the agent never actually drove the browser, instead
                // of a misleading "passed" report.
                if (stepCount === 1) {
                    await testRunStore.appendProgress(runId, `[agent] model ${modelId} returned no tool_use on the first turn (stop_reason=${stopReason}). Aborting.`);
                    findings.push({
                        name: 'Agent never invoked Playwright',
                        status: 'failed',
                        category: 'functionality',
                        severity: 'critical',
                        description: `The model (${modelId}) returned only text on the first turn and never called a pw_* tool. The site was not exercised. This usually means the model doesn't support Anthropic tool-use, or the prompt was misinterpreted.`,
                        error: textBlocks.join('\n').slice(0, 800) || `stop_reason=${stopReason}`,
                    });
                } else {
                    await testRunStore.appendProgress(runId, `[agent] no further actions (stop_reason=${stopReason})`);
                }
                break;
            }

            const toolMessages = [];
            for (const tu of toolUses) {
                if (testRunStore.isCancelRequested(runId)) { cancelled = true; break; }
                // The tool input that *goes to Claude* and to logs always uses
                // placeholders. We only ever materialise the real secret
                // inside _executeTool() right before page.fill().
                const safeInput = _redactInputForLogs(tu.input, credentials);
                const action = { tool: tu.name, input: safeInput };
                stepLog.push(action);
                await testRunStore.appendProgress(runId, `[agent] ${tu.name} ${_summarizeInput(safeInput)}`);
                testRunStore.publishEvent(runId, 'action', { tool: tu.name, input: safeInput, step: stepCount });

                let result;
                try {
                    result = await _executeTool(page, tu.name, tu.input || {}, { findings, sameOriginGuard, credentials });
                } catch (e) {
                    result = { ok: false, error: e.message };
                }

                if (result?.done) doneRequested = true;

                // OpenAI tool-result shape; the Claude adapter maps each
                // role:'tool' message to a Claude tool_result block (paired by
                // tool_call_id). The prompt keeps the agent to one tool per turn.
                toolMessages.push({
                    role: 'tool',
                    tool_call_id: tu.id,
                    content: JSON.stringify(result).slice(0, 8000),
                });

                await emitFrame(action);
            }

            if (cancelled) break;
            messages.push(...toolMessages);
        }

        if (cancelled) {
            return {
                status: 'cancelled',
                reportJson: _buildReport({ targetUrl, findings, stepLog, sourceMeta }).reportJson,
                cancelled: true,
            };
        }

        if (stepCount >= stepCap && !doneRequested) {
            await testRunStore.appendProgress(runId, `[agent] reached MAX_STEPS=${stepCap}, ending`);
            findings.push({
                name: 'Agent reached step cap',
                status: 'warning',
                category: 'functionality',
                severity: 'minor',
                description: `Exploration ended after ${stepCap} steps without an explicit pw_done.`,
            });
        }

    } catch (e) {
        findings.push({
            name: 'Agent session aborted',
            status: 'failed',
            category: 'functionality',
            severity: 'critical',
            description: 'The agent session ended unexpectedly.',
            error: e.message,
        });
    } finally {
        try { await page?.close(); } catch (_) {}
        try { await ctx?.close(); } catch (_) {}
        try { await browser?.close(); } catch (_) {}
    }

    return _buildReport({ targetUrl, findings, stepLog, sourceMeta });
}

function _buildSeedMessage({ targetUrl, instructions, sourceMeta, availablePlaceholders = [] }) {
    const header = sourceMeta?.label ? `Source: ${sourceMeta.label}\n` : '';
    const credLine = availablePlaceholders.length > 0
        ? `\nLogin credentials are available as placeholder tokens: ${availablePlaceholders.map(p => `{{${p}}}`).join(', ')}. ` +
          `When a form needs them, call pw_type with the literal placeholder string (e.g. text: "{{USERNAME}}") — the worker substitutes the real value before typing. ` +
          `Never invent or guess credentials, and never echo a real value in any tool input or finding.\n`
        : '';
    return `You are testing a live website. The browser is already open at ${targetUrl}.

${header}Ticket / spec:
${'```'}
${(instructions || '(no instructions provided — perform a baseline QA sweep)').slice(0, 6000)}
${'```'}
${credLine}
Drive the browser using the pw_* tools to verify or reproduce the described behaviour. Stay on origin ${new URL(targetUrl).origin} only — off-origin navigations will be blocked. Record findings as you go, then call pw_done.`;
}

function _summarizeInput(input) {
    if (!input || typeof input !== 'object') return '';
    const parts = [];
    if (input.url) parts.push(input.url);
    if (input.role || input.name) parts.push(`${input.role || ''}:${input.name || ''}`.trim());
    if (input.selector) parts.push(input.selector);
    if (input.text) parts.push(`"${String(input.text).slice(0, 40)}"`);
    if (input.summary) parts.push(`— ${String(input.summary).slice(0, 80)}`);
    return parts.join(' ').slice(0, 200);
}

function _buildReport({ targetUrl, findings, stepLog, sourceMeta }) {
    const summary = { passed: 0, failed: 0, skipped: 0, warnings: 0 };
    for (const f of findings) {
        if (f.status === 'passed') summary.passed++;
        else if (f.status === 'failed') summary.failed++;
        else if (f.status === 'skipped') summary.skipped++;
        else summary.warnings++;
    }
    // Status rules, in priority order:
    //   1. Any failure → 'failed'
    //   2. At least one pass and no failures → 'passed'
    //   3. Anything else (only warnings/skips, or no findings at all) → 'error'
    // Rule #3 catches the "agent never actually did anything" case so we
    // don't mislead the user with a green checkmark.
    let status;
    if (summary.failed > 0) status = 'failed';
    else if (summary.passed > 0) status = 'passed';
    else status = 'error';
    return {
        status,
        reportJson: {
            title: `Agent run — ${targetUrl}`,
            url: targetUrl,
            timestamp: new Date().toISOString(),
            duration: '—',
            summary,
            tests: findings,
            notes: sourceMeta?.label
                ? `Driven by Claude from source: ${sourceMeta.label}. Total agent steps: ${stepLog.length}.`
                : `Total agent steps: ${stepLog.length}.`,
            recommendations: [],
            metadata: { sourceMeta, stepCount: stepLog.length },
        },
    };
}

module.exports = {
    runAgentMode,
    _internals: { TOOLS, _executeTool, _flattenA11y, _buildReport, _buildSeedMessage },
};
