/**
 * Automation Builder — conversational SSE endpoint.
 *
 *   POST /api/automation/builder/stream  (mounted at /api/automation/builder)
 *
 * Body: { message, builderSessionId?, automationId?, modelTier?, history? }
 *
 * The builder owns a per-(userId, builderSessionId) draft kept in-memory
 * and persisted to the `automations` table (is_draft=TRUE) after every
 * mutation, so:
 *
 *   - a page refresh recovers the draft via /api/automation/:id
 *   - the user always sees a saved row in their list
 *
 * SSE events emitted:
 *   message        — assistant text token (streamed delta)
 *   thinking_start — { partId, redacted? } — a reasoning block opened
 *   thinking       — { partId, text } — reasoning delta (live)
 *   thinking_stop  — { partId, redacted? } — a reasoning block closed
 *   tool_call      — { name, arguments, result }
 *   draft          — full updated definition (debounced)
 *   summary       — plain-English summary
 *   dryrun        — { runId, status }
 *   finalized     — { automationId }
 *   done / error
 */

const express = require('express');
const router = express.Router();

const automationStore = require('../../stores/automationStore');
const configStore = require('../../stores/configStore');
const { getProviderForModel, getAIConfig } = require('../../core/aiAgent');
const { getAdapter } = require('../../core/providers');
const { getEUAwareTiers, isEUModeActive, resolveModelForTierName } = require('../../core/modelResolver');
const llmClient = require('../../core/llmClient');
const { TOOL_SCHEMAS, MUTATING_TOOLS, applyToolCall, emptyDefinition } = require('../../automation/builderTools');
const { runLayerAgent, runLayersInParallel, resolveLayerAgentModel } = require('../../automation/flowletAgent');
const { buildFullSystemPrompt, buildLeanSystemPrompt, buildFewShotMessages } = require('../../automation/builderPrompt');
const { summariseDefinition, renderAgentDraftState } = require('../../automation/summarise');
const { validateDefinition } = require('../../automation/validate');
const { getDeliverableEvents } = require('../../automation/deliverableEvents');
const { getProfileForModel, CORE_TOOL_NAMES } = require('../../automation/builderModelProfiles');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');

function requireAuth(req, res, next) {
    if (req.session?.user?.id) return next();
    res.status(401).json({ error: 'Not authenticated' });
}

// The AI may need: propose_trigger → multiple add_*  → summarise → dry_run
// → fix → dry_run → finalize. This is a ceiling; the per-model profile
// (server/automation/builderModelProfiles.js) chooses its own budget within
// this ceiling — small / reasoning models get more headroom because they
// take more turns to converge.
const MAX_ITERATIONS = 24;

// Catalog filter: when the resolved model profile asks for a trimmed
// catalog (small / Ministral-class models with tight context), reduce the
// list of apps the system prompt advertises. We keep apps whose id/label
// or any action name shares a token with the user message, plus apps
// already referenced in the existing draft. Hard cap so the prompt can't
// blow up on a verbose user message.
function filterCatalogForUser(catalog, userMessage, draft) {
    if (!catalog || !Array.isArray(catalog.apps)) return catalog;
    const text = String(userMessage || '').toLowerCase();
    const usedAppIds = new Set();
    for (const s of (draft?.steps || [])) {
        if (s.tool && typeof s.tool === 'string') {
            const head = s.tool.split('_')[0];
            if (head) usedAppIds.add(head);
        }
    }
    if (draft?.trigger?.appEvent?.provider) usedAppIds.add(String(draft.trigger.appEvent.provider).toLowerCase());

    const tokens = new Set(text.split(/[^a-z0-9]+/).filter(t => t.length > 2));
    const matches = (app) => {
        if (usedAppIds.has(String(app.id).toLowerCase())) return true;
        const hay = `${app.id} ${app.label || ''}`.toLowerCase();
        for (const t of tokens) if (hay.includes(t)) return true;
        for (const a of (app.actions || [])) {
            const ah = `${a.name} ${a.label || ''} ${a.description || ''}`.toLowerCase();
            for (const t of tokens) if (ah.includes(t)) return true;
        }
        return false;
    };
    const filtered = catalog.apps.filter(matches);
    // Always keep a small fallback if nothing matched, otherwise the
    // model has nothing to pick from and refuses.
    const final = filtered.length > 0 ? filtered.slice(0, 8) : catalog.apps.slice(0, 4);
    return { ...catalog, apps: final };
}

// Each builder turn is a multi-iteration LLM conversation that can chain
// many tool calls and a dry-run — i.e. expensive. Cap to 12/min/user so a
// runaway client (or a malicious script) can't burn through tokens.
const builderRateLimit = perUserRateLimit({ windowMs: 60_000, max: 12 });

// One cheap (fast-tier) completion per call. 20/min/user is plenty for a
// human clicking "Summarize" across a handful of flowlets and starves a
// script that tries to use it as a free LLM proxy.
const summariseLayerRateLimit = perUserRateLimit({ windowMs: 60_000, max: 20 });

// A flowlet-agent run is a full thinking-model tool loop — heavier than a
// chat turn. 8/min/user is plenty for clicking "Build a flowlet with AI" a
// few times and starves abuse.
const layerAgentRateLimit = perUserRateLimit({ windowMs: 60_000, max: 8 });

// A suggestion scan is a read-only tool loop (or a single forced synthesis when
// activity is dense) — the heaviest fast-path call here. 10/min/user comfortably
// covers a human clicking "Scan for ideas" / "Re-scan" while iterating, and the
// FE surfaces a friendly cooldown on 429 instead of a hard error.
const suggestRateLimit = perUserRateLimit({ windowMs: 60_000, max: 10 });

// Recording suggestion feedback (dismiss / built / asked) is a cheap DB upsert;
// 30/min/user is plenty for clicking through cards and starves abuse.
const feedbackRateLimit = perUserRateLimit({ windowMs: 60_000, max: 30 });

// Bounds for the read-only scan loop. The model must actually READ the user's
// recent data to find concrete repeating work — the activity digest only tells
// it which tools to prioritise, not what's in them. Keep enough rounds/reads
// for that; the efficiency win is the forced structured synthesis + the 4h
// cache, NOT skipping reads.
const SUGGEST_MAX_ROUNDS = 6;
const SUGGEST_MAX_TOOL_CALLS = 12;
const SUGGEST_MAX_SUGGESTIONS = 6;
// Per-integration read cap. A scan only needs a few samples of an app to see its
// repeating patterns; without this, the model fixates on its highest-volume tool
// (e.g. Gmail) and burns the whole budget re-searching one inbox while never
// looking at the other selected apps. Capping per app keeps the scan EFFICIENT
// and BROAD. Deterministic — it doesn't rely on the model obeying a prose hint.
const SUGGEST_MAX_READS_PER_INTEGRATION = 4;

const MAX_LAYER_STEPS_FOR_SUMMARY = 200;

/**
 * Validate a flowlet mini-definition submitted for AI summarisation.
 * Returns an error string when rejected, or null when acceptable.
 */
function validateLayerForSummary(layer) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer) || !Array.isArray(layer.steps)) {
        return 'A flowlet object with a steps array is required.';
    }
    if (layer.steps.length > MAX_LAYER_STEPS_FOR_SUMMARY) {
        return 'Flowlet is too large to summarise.';
    }
    return null;
}

/** Collapse whitespace, strip surrounding quotes, and cap a model summary. */
function sanitiseLayerSummary(raw) {
    return String(raw || '')
        .replace(/\s+/g, ' ')
        .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
        .slice(0, 280)
        .trim();
}

// GET the persisted builder-session snapshot for an automation. Used by
// the client on mount to rehydrate chat history + draft + last validation
// after a refresh or SSE drop. Mirror to the SSE `resume` event payload.
router.get('/session/:automationId', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const snapshot = await automationStore.getBuilderSession(req.params.automationId, userId);
        if (!snapshot) return res.status(404).json({ error: 'No builder session for this automation' });
        res.json({ snapshot });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /summarise-layer — generate a one-sentence, plain-language summary
 * of an automation flowlet (a reusable sub-flow).
 *
 * Body: { layer }  — the flowlet's mini-definition { title, trigger, steps, edges }.
 *
 * The client owns the draft (autosave + undo), so this endpoint is stateless:
 * it takes the flowlet the user is actually looking at (no lag against the
 * persisted row), feeds the deterministic summariseDefinition() rendering to
 * a fast-tier model for a friendly one-liner, and returns { summary }. The
 * client persists it into definition.layers[key].description itself.
 *
 * Opt-in only — the UI gates this behind an off-by-default checkbox — so no
 * tokens are spent unless the user explicitly asks.
 */
router.post('/summarise-layer', requireAuth, summariseLayerRateLimit, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        const hasFeature = await userHasBetaFeature(userId, 'automations', req.session);
        if (!hasFeature) {
            return res.status(403).json({ error: 'The Automations beta is not enabled for your organisation.' });
        }

        const layer = req.body?.layer;
        // Bound the work — a real flowlet is a handful of steps. Reject obviously
        // malformed/oversized payloads rather than feed them to the model.
        const invalid = validateLayerForSummary(layer);
        if (invalid) return res.status(400).json({ error: invalid });

        // Reuse the deterministic, side-effect-aware renderer the builder
        // already uses everywhere else; the model just makes it friendly.
        const { summary: deterministic } = summariseDefinition(layer);

        const userOrgId = req.session?.user?.organizationId || null;
        const modelId = await resolveModelForTierName('fast', { userOrgId, userId, fallback: 'gemini-2.0-flash-lite' });
        const sys = 'You summarise an automation flow in ONE plain-language sentence (max ~25 words) for a non-technical user. Describe what it accomplishes, not the step types. Output only the sentence — no preamble, no markdown, no quotes.';
        const name = String(layer.title || 'this automation').slice(0, 200);
        const userMsg = `Name: ${name}\n\n${deterministic}`;

        let result;
        try {
            result = await llmClient.chat(modelId, [
                { role: 'system', content: sys },
                { role: 'user', content: userMsg },
            ], { maxTokens: 80, temperature: 0.3, reasoningEffort: 'none', budgetTokens: 0 });
        } catch (e) {
            console.error('[automationBuilder/summarise-layer] inference failed:', e.message);
            return res.status(502).json({ error: 'Could not generate a summary right now. Please try again.' });
        }

        const summary = sanitiseLayerSummary(result?.content);
        return res.json({ summary });
    } catch (e) {
        console.error('[automationBuilder/summarise-layer] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Auto-label + auto-icon for steps ────────────────────────────────────────
// The builder asks the FAST tier to name each step (a short human label + a
// symbol) so a fresh flow reads cleanly without manual work. The client only
// calls this on a meaningful structural change (debounced), and never sends
// (nor applies to) a field the user set by hand — `labelManual` / `iconManual`
// on a step lock that field. Bounded so a huge flow can't fan out unboundedly.
const MAX_LABEL_STEPS = 60;

const LABEL_STEPS_TOOL = {
    type: 'function',
    function: {
        name: 'label_steps',
        description: 'Provide a short human label and a fitting symbol for each automation step.',
        parameters: {
            type: 'object',
            properties: {
                steps: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'The step id, copied verbatim from the list.' },
                            label: { type: 'string', description: '2–4 word Title Case label describing what the step accomplishes.' },
                            icon: { type: 'string', description: 'One icon name from the allowed list, or "" if none fits.' },
                        },
                        required: ['id', 'label'],
                    },
                },
            },
            required: ['steps'],
        },
    },
};

// Compact, deterministic one-liner describing a step's purpose for the namer.
function describeStepForLabel(s) {
    const bits = [`type=${s.type}`];
    if (s.tool) bits.push(`tool=${s.tool}`);
    if (s.appId) bits.push(`app=${s.appId}`);
    if (s.kind) bits.push(`kind=${s.kind}`);
    if (s.op) bits.push(`op=${s.op}`);
    if (s.blockId) bits.push('reusable-step');
    if (s.layerKey) bits.push(`flowlet=${s.layerKey}`);
    if (s.appEvent?.provider) bits.push(`event=${s.appEvent.provider}.${s.appEvent.event || ''}`);
    if (s.expr) bits.push(`expr=${String(s.expr).slice(0, 80)}`);
    if (typeof s.prompt === 'string' && s.prompt.trim()) bits.push(`prompt=${s.prompt.slice(0, 160)}`);
    if (typeof s.title === 'string' && s.title.trim()) bits.push(`title=${s.title.slice(0, 80)}`);
    if (typeof s.body === 'string' && s.body.trim()) bits.push(`body=${s.body.slice(0, 80)}`);
    return bits.join(' · ');
}

/**
 * POST /label-steps — name the steps in a flow with the FAST tier.
 *
 * Body: { definition, allowedIcons }
 *   - definition  : the draft the user is looking at (stateless, like
 *                   summarise-layer — no lag against the persisted row).
 *   - allowedIcons: the icon names the client can render; the model must pick
 *                   from these (single source of truth lives on the client).
 *
 * Returns { labels: { [stepId]: { label?, icon? } } } — only for steps whose
 * corresponding field is NOT locked (`labelManual` / `iconManual`). The client
 * applies them and never overwrites a manual edit.
 */
router.post('/label-steps', requireAuth, summariseLayerRateLimit, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        if (!await userHasBetaFeature(userId, 'automations', req.session)) {
            return res.status(403).json({ error: 'The Automations beta is not enabled for your organisation.' });
        }

        const def = req.body?.definition;
        if (!def || typeof def !== 'object' || !Array.isArray(def.steps)) {
            return res.status(400).json({ error: 'A definition with steps is required.' });
        }
        const allowedIcons = Array.isArray(req.body?.allowedIcons)
            ? req.body.allowedIcons.filter(s => typeof s === 'string').slice(0, 300)
            : [];
        const allowedSet = new Set(allowedIcons);

        // Collect non-output steps with at least one unlocked field.
        const { walkSteps } = require('../../automation/stepContract');
        const targets = [];
        walkSteps(def.steps, (s) => {
            if (!s.id || s.type === 'layer_output') return;
            // Only fill a field that is BOTH unlocked (not user-set) AND empty —
            // so we never overwrite a manual edit or churn an existing label.
            const needLabel = !s.labelManual && !(typeof s.label === 'string' && s.label.trim());
            const needIcon = !s.iconManual && !(typeof s.icon === 'string' && s.icon.trim());
            if (needLabel || needIcon) targets.push({ id: s.id, needLabel, needIcon, desc: describeStepForLabel(s) });
        });
        if (targets.length === 0) return res.json({ labels: {} });
        const bounded = targets.slice(0, MAX_LABEL_STEPS);

        const userOrgId = req.session?.user?.organizationId || null;
        const modelId = await resolveModelForTierName('fast', { userOrgId, userId, fallback: 'gemini-2.0-flash-lite' });

        const sys = 'You label steps in an automation flow for a non-technical user. For each step return: "label" — a 2–4 word Title Case name describing what the step accomplishes (not its technical type); and "icon" — the single best-fitting icon NAME chosen ONLY from the provided allowed list (or "" if none fits). Copy each step id verbatim. Keep labels concise and human.';
        const iconList = allowedIcons.length ? `Allowed icon names:\n${allowedIcons.join(', ')}\n\n` : '';
        const stepLines = bounded.map((t, i) => `${i + 1}. id=${t.id} · ${t.desc}`).join('\n');
        const userMsg = `${iconList}Steps to label:\n${stepLines}`;

        let structured;
        try {
            ({ structured } = await llmClient.chatForcedTool(modelId, [
                { role: 'system', content: sys },
                { role: 'user', content: userMsg },
            ], LABEL_STEPS_TOOL, { maxTokens: 1024, temperature: 0.2, reasoningEffort: 'none', budgetTokens: 0 }));
        } catch (e) {
            console.error('[automationBuilder/label-steps] inference failed:', e.message);
            return res.status(502).json({ error: 'Could not generate labels right now.' });
        }

        const targetById = new Map(bounded.map(t => [t.id, t]));
        const labels = {};
        for (const row of (structured?.steps || [])) {
            const t = row && row.id && targetById.get(row.id);
            if (!t) continue;
            const entry = {};
            if (t.needLabel && typeof row.label === 'string' && row.label.trim()) {
                entry.label = row.label.trim().slice(0, 60);
            }
            if (t.needIcon && typeof row.icon === 'string' && allowedSet.has(row.icon)) {
                entry.icon = row.icon;
            }
            if (Object.keys(entry).length) labels[t.id] = entry;
        }
        return res.json({ labels });
    } catch (e) {
        console.error('[automationBuilder/label-steps] error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * POST /suggest — "Find repeating work" automation suggestions (SSE).
 *
 * Body: { integrationIds?: string[], focus?: string }
 *
 * Streams a bounded, READ-ONLY agentic scan of the user's connected tools
 * (search recent emails, list recent files, …). Every tool result is guarded
 * through the org/user Privacy Shield (server/core/automationRunner/safety.js) —
 * tokenize/redact/block per policy — BEFORE the model sees it, and each read is
 * audit-logged. Returns specs only — no automation definition is built here; the
 * client feeds a chosen suggestion's `buildPrompt` into the existing /stream
 * builder ("build directly" or "ask for changes").
 *
 * SSE events:
 *   phase     — { phase: 'scanning' | 'synthesising' }
 *   model     — { eu: boolean }                          (transparency)
 *   scan_step — { tool, integration, phase: 'start' | 'done', ok?, piiCategories? }
 *   done      — { suggestions, reason?, summary: { integrations, toolCalls, piiCategories } }
 *   error     — { error }
 *
 * Model output is untrusted: complexity is re-derived and required integrations
 * are intersected with what the user can use (server/automation/suggestions.js).
 */
router.post('/suggest', requireAuth, suggestRateLimit, async (req, res) => {
    const userId = req.session.user.id;
    const session = req.session;
    const orgId = req.session?.user?.organizationId || null;

    // Beta gate BEFORE switching the response to SSE, so a 403 stays clean JSON.
    try {
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        const hasFeature = await userHasBetaFeature(userId, 'automations', session);
        if (!hasFeature) {
            return res.status(403).json({ error: 'The Automations beta is not enabled for your organisation.' });
        }
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }

    const { setupSSE, startSseHeartbeat } = require('../../core/sseHelpers');
    const { sendEvent, abortController, markEnded } = setupSSE(res);
    const stopHeartbeat = startSseHeartbeat(res);
    const finish = () => { stopHeartbeat(); markEnded(); try { res.end(); } catch (_) { /* already closed */ } };

    try {
        const {
            buildScanSystemPrompt, buildScanDigest, parseSuggestionsJson, extractSuggestionsFromToolCall,
            normaliseSuggestions, buildActivityIndex, computeScanCacheKey, resolveActivityFilter, SUGGESTIONS_TOOL,
        } = require('../../automation/suggestions');
        const suggestionScanCache = require('../../stores/suggestionScanCache');
        const suggestionFeedbackStore = require('../../stores/suggestionFeedbackStore');
        const integrationActivityStore = require('../../stores/integrationActivityStore');
        const { getIntegrationTools } = require('../../core/integrationTools');
        const { isSideEffect } = require('../../automation/sideEffectMap');
        const { resolveIntegration } = require('../../core/integrationToolMap');
        const { executeTool } = require('../../core/toolDispatcher');
        const safety = require('../../core/automationRunner/safety');

        // ── Inputs ──
        const rawIds = Array.isArray(req.body?.integrationIds) ? req.body.integrationIds : [];
        const selectedSet = new Set(rawIds.map(s => String(s || '').trim().toLowerCase()).filter(Boolean));
        const focus = typeof req.body?.focus === 'string'
            ? req.body.focus.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 280)
            : '';
        // Re-scan / Try-again bypasses the server-side cache.
        const force = req.body?.force === true || req.body?.force === 'true';

        const integOf = (toolName) => (resolveIntegration(toolName)?.integration || String(toolName).split('_')[0] || '').toLowerCase();

        // ── Build the user's tool sets ──
        let toolResult;
        try {
            toolResult = await getIntegrationTools({ userId, session, isAdmin: !!req.session?.isAdmin, routineStep: true });
        } catch (_) {
            toolResult = { tools: [] };
        }
        const allTools = Array.isArray(toolResult?.tools) ? toolResult.tools : [];

        // Full available integration set (read + write) — used to flag a
        // suggestion that references an app the user does not have at all.
        const availableIntegrationIds = new Set();
        for (const t of allTools) {
            const name = t?.function?.name;
            if (name) availableIntegrationIds.add(integOf(name));
        }
        if (availableIntegrationIds.size === 0) {
            sendEvent('done', { suggestions: [], reason: 'no_integrations' });
            return finish();
        }

        // Resolve which integrations to focus on (default: everything available).
        const focusInteg = selectedSet.size > 0
            ? [...availableIntegrationIds].filter(id => selectedSet.has(id))
            : [...availableIntegrationIds];
        if (focusInteg.length === 0) {
            sendEvent('done', { suggestions: [], reason: 'no_integrations' });
            return finish();
        }
        const focusSet = new Set(focusInteg);

        // Read-only tools within the focus set — what the model may actually call
        // while scanning. May be empty (e.g. a write-only app) → pure ideation.
        const scanTools = allTools.filter(t => {
            const name = t?.function?.name;
            return name && !isSideEffect(name) && focusSet.has(integOf(name));
        });

        // ── Cheap secondary signals (parallelised) ──
        const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
        const activityFilter = { ...resolveActivityFilter({ organizationId: orgId, userId }), startDate: since };
        const [activityRowsRaw, automationList, suppressedTitlesRaw] = await Promise.all([
            integrationActivityStore.getIntegrationByTool(activityFilter).catch(() => []),
            automationStore.getAutomationsForUser(userId).catch(() => []),
            suggestionFeedbackStore.getRecentSuppressedTitles({ organizationId: orgId, userId }).catch(() => []),
        ]);

        // Activity rows scoped to the focused integrations → grounding digest + scoring index.
        const activityByTool = (activityRowsRaw || []).filter(r =>
            r && r.tool_name && Number(r.total) > 0 && focusSet.has(String(r.integration_type || '').toLowerCase()));
        const activityIndex = buildActivityIndex(activityByTool);

        // Suppress ideas the user already automated AND ones they dismissed/built/asked about.
        const ownTitles = (automationList || []).map(a => a.title).filter(Boolean).slice(0, 50);
        const existingTitles = [...new Set([...ownTitles, ...(suppressedTitlesRaw || [])])];

        // ── Cache scope/key (the rate limiter already gated this request) ──
        const scopeKey = suggestionScanCache.deriveScopeKey({ organizationId: orgId, userId });
        const cacheKey = computeScanCacheKey({ focusInteg, focus, existingTitles });

        // EU routing transparency (mirrored into the cache row).
        let euActive = false;
        try { const eu = await isEUModeActive({ userOrgId: orgId, userId }); euActive = !!(eu && eu.isEU); } catch (_) { /* transparency only */ }

        // ── Cache read: a fresh hit returns instantly (no model call) unless force ──
        if (!force) {
            try {
                const hit = await suggestionScanCache.getCachedScan({ scopeKey, cacheKey });
                if (hit && Array.isArray(hit.suggestions)) {
                    sendEvent('model', { eu: euActive });
                    sendEvent('done', {
                        suggestions: hit.suggestions,
                        summary: hit.summary || { integrations: [], toolCalls: 0, piiCategories: [] },
                        reason: hit.reason || undefined,
                        cached: true,
                        scannedAt: hit.scannedAt,
                    });
                    return finish();
                }
            } catch (_) { /* cache miss / store hiccup → fall through to a live scan */ }
        }

        // ── Privacy Shield guard policy (same pipeline the routine runner uses) ──
        const guardCtx = { orgId, userId, automationId: null, automationTitle: 'Suggestion scan', runId: null };
        const policy = await safety.resolveAutomationPolicy(guardCtx);
        const auditBase = safety.buildAuditBase(guardCtx, { id: 'scan' });
        const guardMode = 'live';

        // ── Model: 'fast' tier — re-derives complexity itself. The model does
        // live reads to find concrete patterns; the activity digest below only
        // tells it which tools are worth reading first. (EU routing honoured by
        // the resolver.) ──
        const modelId = await resolveModelForTierName('fast', { userOrgId: orgId, userId, fallback: 'gemini-2.0-flash-lite' });
        sendEvent('model', { eu: euActive });

        // Compact, PII-safe digest of the user's recent tool activity — a priority
        // hint for which tools to sample first, NOT a replacement for live reads.
        const digest = buildScanDigest({ activityByTool, existingTitles: [], focus: '', toolShapes: {} });

        const sys = buildScanSystemPrompt({
            selectedIntegrations: focusInteg, activityHints: [], existingTitles, focus, maxSuggestions: SUGGEST_MAX_SUGGESTIONS,
        });
        const messages = [
            { role: 'system', content: sys },
            { role: 'user', content: `Recent tool activity (frequency signal):\n\n${digest}\n\nScan my connected tools for repeating work and call return_suggestions with up to ${SUGGEST_MAX_SUGGESTIONS} automation ideas.` },
        ];

        // ── Scan ──
        const scannedIntegrations = new Set();
        const allCategories = new Set();
        const readsByIntegration = new Map();
        // Apps the model can actually READ (have read-only tools in the focus set).
        // The breadth-first steer only ever points the model at apps it can sample.
        const readableIntegrations = new Set(
            scanTools.map(t => integOf(t?.function?.name)).filter(Boolean));
        let toolCalls = 0;

        const boundedExecute = async (name, args) => {
            if (abortController.signal.aborted) return 'Scan cancelled.';
            // Defence in depth: never run a side-effecting tool during the scan.
            if (isSideEffect(name)) {
                return `Error: ${name} is a write action and is not allowed during a read-only scan.`;
            }
            const integration = integOf(name);
            const usedForInteg = readsByIntegration.get(integration) || 0;

            // Breadth-first: before a SECOND read of any app, make sure every other
            // readable selected app has been sampled at least once. Without this the
            // model fixates on its highest-volume app (Gmail) and burns the whole
            // budget there, never looking at the others the user explicitly selected.
            // A steer is a redirect — no scan_step, no global-budget spend.
            if (usedForInteg >= 1) {
                const unsampled = [...readableIntegrations]
                    .filter(i => i !== integration && !readsByIntegration.has(i));
                if (unsampled.length > 0) {
                    return `You've already looked at ${integration}. Take ONE quick look at each selected app you haven't checked yet first: ${unsampled.join(', ')}. Read one of those now, then come back to ${integration} only if you still need more signal.`;
                }
            }
            // Per-app backstop: once breadth is done, don't re-search one inbox forever.
            if (usedForInteg >= SUGGEST_MAX_READS_PER_INTEGRATION) {
                return `You've sampled ${integration} enough (${usedForInteg} reads) to see its patterns. Read a different app, or if you have enough signal, stop and call return_suggestions now.`;
            }
            toolCalls++;
            if (toolCalls > SUGGEST_MAX_TOOL_CALLS) {
                return 'Tool-call budget reached — stop scanning and call return_suggestions now.';
            }
            // Mark sampled before executing so a failed read still counts (no retry
            // loop on a broken tool, and breadth-first moves on).
            readsByIntegration.set(integration, usedForInteg + 1);
            sendEvent('scan_step', { tool: name, integration, phase: 'start' });

            let out;
            try {
                out = await executeTool(name, args, { userId, session, orgId });
            } catch (e) {
                sendEvent('scan_step', { tool: name, integration, phase: 'done', ok: false });
                return `Error: ${e.message}`;
            }

            // Guard the tool OUTPUT through the Privacy Shield before the model
            // sees it. In 'block' mode guardToolOutput throws on PII — we keep the
            // content from the model but let the scan continue on what's allowed.
            let guardedText;
            let categories = [];
            let blocked = false;
            try {
                const g = await safety.guardToolOutput(out, policy, auditBase, guardMode);
                guardedText = typeof g.result === 'string' ? g.result : JSON.stringify(g.result);
                categories = g.categories || [];
            } catch (e) {
                blocked = true;
                categories = (e && e.categories) || [];
                guardedText = `[withheld: contains sensitive data${categories.length ? ` (${categories.join(', ')})` : ''}]`;
            }

            // Audit-log the read (records PII categories, not raw content).
            try {
                await safety.logEgress({ toolName: name, toolArgs: args, result: out, probe: null, policy, auditBase, mode: guardMode });
            } catch (_) { /* never fail the scan on logging */ }

            scannedIntegrations.add(integration);
            for (const c of categories) allCategories.add(c);
            sendEvent('scan_step', { tool: name, integration, phase: 'done', ok: !blocked, piiCategories: categories });
            return guardedText;
        };

        // The model must READ the user's actual data to find concrete repeating
        // work — the digest only says which tools to prioritise. So whenever there
        // are read-only tools, run the agentic loop (live reads) and force the
        // structured synthesis at the end. Only when there's NOTHING readable
        // (write-only apps) do we fall back to a single ideation call.
        let rounds = 0;
        let structuredOk = false;
        let rawSuggestions = [];

        sendEvent('phase', { phase: 'scanning' });
        if (scanTools.length === 0) {
            // 4096 (not 2500): the forced synthesis emits up to 6 suggestions, each
            // with a detailed buildPrompt (~1200 chars) — at 2500 the tool-call
            // JSON args can truncate mid-array and fail to parse (structured=null →
            // zero suggestions). The headroom is a ceiling, not a target.
            const { structured, content } = await llmClient.chatForcedTool(
                modelId, messages, SUGGESTIONS_TOOL, { maxTokens: 4096, temperature: 0.2 });
            structuredOk = !!structured;
            rawSuggestions = structured ? extractSuggestionsFromToolCall(structured) : parseSuggestionsJson(content);
        } else {
            const loop = await llmClient.runToolLoop(
                modelId, messages, scanTools,
                { maxTokens: 4096, temperature: 0.2, finalTool: SUGGESTIONS_TOOL },
                boundedExecute, SUGGEST_MAX_ROUNDS);
            rounds = loop?.toolCallRounds ?? 0;
            structuredOk = !!loop?.structured;
            rawSuggestions = loop?.structured
                ? extractSuggestionsFromToolCall(loop.structured)
                : parseSuggestionsJson(loop?.content);
        }
        sendEvent('phase', { phase: 'synthesising' });

        // Untrusted model output: re-derive complexity, clamp, dedupe, attach
        // server-computed evidence/value, and rank by value (activityIndex).
        const suggestions = normaliseSuggestions(rawSuggestions, {
            availableIntegrationIds, existingTitles, max: SUGGEST_MAX_SUGGESTIONS, activityIndex,
        });

        // Diagnostic: makes an empty result debuggable at a glance — raw=0 means
        // the model returned nothing; raw>0 but final=0 means suppression/repair
        // filtered everything.
        console.log('[automationBuilder/suggest] user=%s model=%s rounds=%s reads=%s raw=%s structured=%s final=%s existingTitles=%s',
            userId, modelId, rounds, toolCalls, Array.isArray(rawSuggestions) ? rawSuggestions.length : 0, structuredOk, suggestions.length, existingTitles.length);

        const summary = {
            integrations: [...scannedIntegrations],
            toolCalls,
            piiCategories: [...allCategories],
            rounds,
            structured: structuredOk,
        };
        const scannedAt = new Date().toISOString();
        const reason = suggestions.length ? undefined : 'no_patterns';

        // ── Cache write (best-effort; 4h TTL) ──
        try {
            await suggestionScanCache.upsertScan({
                scopeKey, cacheKey, userId, organizationId: orgId, focus,
                integrationIds: focusInteg, suggestions, summary,
                reason: reason || null, model: modelId, eu: euActive,
                expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
            });
        } catch (_) { /* cache write is best-effort */ }

        sendEvent('done', { suggestions, summary, reason, cached: false, scannedAt });
        finish();
    } catch (e) {
        console.error('[automationBuilder/suggest] error:', e.message);
        try { sendEvent('error', { error: 'Could not generate ideas right now. Please try again.' }); } catch (_) { /* stream gone */ }
        finish();
    }
});

/**
 * GET /suggest/last — the user's most recent cached scan (if any), so the
 * Routines studio can show "Last scanned X ago" + the prior results without
 * re-running the scan. 204 when there's no cached scan. Beta-gated.
 */
router.get('/suggest/last', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const orgId = req.session?.user?.organizationId || null;
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        const hasFeature = await userHasBetaFeature(userId, 'automations', req.session);
        if (!hasFeature) return res.status(204).end();
        const suggestionScanCache = require('../../stores/suggestionScanCache');
        const scopeKey = suggestionScanCache.deriveScopeKey({ organizationId: orgId, userId });
        const last = await suggestionScanCache.getLatestScan({ scopeKey });
        if (!last || !Array.isArray(last.suggestions)) return res.status(204).end();
        res.json({
            suggestions: last.suggestions,
            summary: last.summary || { integrations: [], toolCalls: 0, piiCategories: [] },
            reason: last.reason || undefined,
            scannedAt: last.scannedAt,
            eu: !!last.eu,
            cached: true,
        });
    } catch (_) {
        res.status(204).end();
    }
});

/**
 * POST /feedback — record a user's reaction to a suggestion (dismissed / built /
 * asked). Persisted as a title fingerprint so future scans suppress dismissed
 * ideas and don't re-suggest ones already acted on. Untrusted input — validated
 * + clamped. Beta-gated + rate-limited.
 */
router.post('/feedback', requireAuth, feedbackRateLimit, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const orgId = req.session?.user?.organizationId || null;
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        const hasFeature = await userHasBetaFeature(userId, 'automations', req.session);
        if (!hasFeature) return res.status(403).json({ error: 'The Automations beta is not enabled for your organisation.' });

        const suggestionFeedbackStore = require('../../stores/suggestionFeedbackStore');
        const { fingerprintTitle } = require('../../automation/suggestions');
        const action = String(req.body?.action || '').trim();
        if (!suggestionFeedbackStore.VALID_ACTIONS.includes(action)) {
            return res.status(400).json({ error: 'Invalid action.' });
        }
        const s = req.body?.suggestion || {};
        const title = typeof s.title === 'string' ? s.title.slice(0, 200) : '';
        if (!title) return res.status(400).json({ error: 'suggestion.title is required.' });
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : null;
        const buildPrompt = typeof s.buildPrompt === 'string' ? s.buildPrompt : '';
        const titleFingerprint = fingerprintTitle(title, buildPrompt);
        await suggestionFeedbackStore.saveSuggestionFeedback({
            userId, organizationId: orgId, action, reason,
            suggestion: { title, buildPrompt, complexity: s.complexity, requiredIntegrations: s.requiredIntegrations, groundedIn: s.groundedIn },
            titleFingerprint,
            ttlDays: action === 'dismissed' ? 30 : undefined,
        });

        // A "dismissed" reaction is the Delete action: also strip the suggestion
        // from the persisted scan rows so it doesn't resurface from getLatestScan
        // after a reload/restart (the feedback row above only suppresses it in
        // FUTURE scans). Best-effort — never fail the request on this.
        if (action === 'dismissed') {
            try {
                const suggestionScanCache = require('../../stores/suggestionScanCache');
                const scopeKey = suggestionScanCache.deriveScopeKey({ organizationId: orgId, userId });
                const delId = typeof s.id === 'string' ? s.id : null;
                await suggestionScanCache.removeSuggestionsFromScope({
                    scopeKey,
                    predicate: (stored) => {
                        if (!stored) return false;
                        if (delId && stored.id === delId) return true;
                        return fingerprintTitle(stored.title || '', stored.buildPrompt || '') === titleFingerprint;
                    },
                });
            } catch (_) { /* best-effort persisted-list cleanup */ }
        }
        res.json({ ok: true });
    } catch (e) {
        console.error('[automationBuilder/feedback] error:', e.message);
        res.status(500).json({ error: 'Could not record feedback.' });
    }
});

/**
 * POST /layer-agent — SSE. Build or refine ONE inline flowlet with a focused
 * thinking-model sub-agent, SEPARATE from the chat (no chat history touched).
 * Powers the Flowlets panel's "Build a flowlet with AI" / "Refine with AI".
 *
 * Body: { automationId, instruction, mode:'create'|'refine', layerKey?, title? }
 * Events: builder_session, layer_agent_start, tool_call (per sub-agent step),
 *         layer_agent_done, draft (final definition), done | error.
 */
router.post('/layer-agent', requireAuth, layerAgentRateLimit, async (req, res) => {
    const userId = req.session.user.id;
    const { automationId, instruction, mode = 'create', layerKey: existingKey, title } = req.body || {};

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {} };

    try {
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        if (!(await userHasBetaFeature(userId, 'automations', req.session))) {
            send('error', { error: 'The Automations beta is not enabled for your organisation.' });
            return res.end();
        }
        if (!instruction || !String(instruction).trim()) {
            send('error', { error: 'An instruction is required.' });
            return res.end();
        }
        // The flowlet agent operates on the SAVED automation — make sure one
        // exists (the panel calls ensureAutomationCreated first, but guard).
        const draftWrap = await loadOrCreateDraft({ userId, builderSessionId: null, automationId });
        if (!draftWrap.automationId) {
            send('error', { error: 'Save the automation first, then build a flowlet.' });
            return res.end();
        }
        draftWrap.orgId = req.session?.user?.organizationId || null;
        send('builder_session', { automationId: draftWrap.automationId });

        const userOrgForTiers = req.session?.user?.organizationId || null;
        const modelId = await resolveLayerAgentModel({ userOrgId: userOrgForTiers, userId });
        const catalog = await buildCatalogForUser(userId, req.session);

        let layerKey = existingKey;
        if (mode === 'refine') {
            if (!layerKey || !draftWrap.def?.layers?.[layerKey]) {
                send('error', { error: 'That flowlet no longer exists — refresh and try again.' });
                return res.end();
            }
        } else {
            const created = await applyToolCall('builder_create_layer', { title: title || 'New layer' }, draftWrap);
            if (created?.error) { send('error', { error: created.error }); return res.end(); }
            layerKey = created.layerKey;
        }

        send('layer_agent_start', { layerKey, mode });
        const r = await runLayerAgent({
            draftWrap, layerKey, instruction: String(instruction), mode,
            modelId, userId, userOrgId: userOrgForTiers, session: req.session, catalog, send,
        });
        await persistDraftWrap(draftWrap);
        send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
        send('layer_agent_done', { layerKey, outputFields: r.outputFields, summary: r.summary });
        send('done', { automationId: draftWrap.automationId, layerKey });
    } catch (e) {
        console.error('[automationBuilder/layer-agent] error:', e.message);
        send('error', { error: e.message });
    } finally {
        res.end();
    }
});

router.post('/stream', requireAuth, builderRateLimit, async (req, res) => {
    const userId = req.session.user.id;
    const {
        message,
        builderSessionId: clientSession,
        automationId,
        modelTier = 'auto',
        history = [],
        attachments = [],
        webSearchEnabled = true,
        disabledMedia = {},
        timezone,
        // WS2/WS3 — the canvas scope the user is currently drilled into
        // (a flowlet key, or absent for the root flow). Used purely as a
        // prompt hint so the model defaults its tool calls' `scope` there.
        canvasScope,
    } = req.body || {};
    // ?resume=1 — caller is reconnecting and wants the latest snapshot
    // re-emitted before the new message is processed. Additive: the regular
    // SSE flow continues exactly as before once the resume event lands.
    const wantsResume = req.query?.resume === '1' || req.query?.resume === 'true';

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };

    try {
        // Feature gate: 'automations' is a per-org beta feature.
        // Admins toggle it from the admin dashboard → Security → Beta.
        // Super admins always have access.
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        const hasFeature = await userHasBetaFeature(userId, 'automations', req.session);
        if (!hasFeature) {
            send('error', { error: 'The Automations beta is not enabled for your organisation. Ask an administrator to enable it under Security → Beta Features.' });
            return res.end();
        }
        const codeFlagRaw = await configStore.getConfig('automation_code_step_enabled');
        const codeStepEnabled = codeFlagRaw === true || codeFlagRaw === 'true';

        // Resolve / load the draft.
        let draftWrap = await loadOrCreateDraft({ userId, builderSessionId: clientSession, automationId });
        send('builder_session', { builderSessionId: draftWrap.builderSessionId, automationId: draftWrap.automationId });

        // Resume support — when the client asks (?resume=1), re-emit the
        // last persisted snapshot before processing the new turn. The
        // client uses this to rehydrate any chat history + draft +
        // validation state that was lost on a dropped SSE.
        if (wantsResume && draftWrap.automationId) {
            try {
                const snapshot = await automationStore.getBuilderSession(draftWrap.automationId, userId);
                if (snapshot) {
                    send('resume', { snapshot });
                    // Carry the prior to-do list forward + re-surface it.
                    if (Array.isArray(snapshot.todos) && snapshot.todos.length) {
                        draftWrap._todos = snapshot.todos;
                        send('plan', { todos: snapshot.todos });
                    }
                }
            } catch (_) { /* non-fatal */ }
        }

        // Build catalog for the prompt. (Prompt construction is deferred
        // until after the model is resolved, so we can pick full vs. lean
        // prompt + apply per-model catalog filtering — see Step 5 of the
        // multi-model optimization in the plan file.)
        const catalog = await buildCatalogForUser(userId, req.session);

        // §B progressive context: index every catalog action's input schema by
        // tool name so builder_inspect_tool can return exact params on demand
        // (the slim prompt catalog only advertises an input count), and the
        // add-action gate can require an inspect before binding non-trivial
        // params. `_inspectedTools` tracks what the agent inspected this turn.
        // Built from the FULL catalog so it covers every tool the user has.
        draftWrap._inputSchemasByTool = {};
        for (const app of (catalog?.apps || [])) {
            for (const act of (app.actions || [])) {
                if (act && act.name && act.inputSchema) draftWrap._inputSchemasByTool[act.name] = act.inputSchema;
            }
        }
        draftWrap._inspectedTools = new Set();

        // Human-readable summary — seeds `lastSummary` (the "What this
        // automation does" panel + builder_session snapshot). User-facing, so
        // it stays prose without raw step IDs.
        const summary = summariseDefinition(draftWrap.def).summary;
        // Agent context: a structured, ID-bearing view of the WHOLE draft
        // (main flow + every flowlet) with each step's settings and input
        // bindings, so the model reads real step IDs + current wiring instead
        // of asking the user for them. Rebuilt each turn from the live draft.
        const agentDraftState = renderAgentDraftState(draftWrap.def);

        // Resolve model — mirrors the direct-chat flow (server/routes/ai/directChat.js)
        // so the builder honours the same tier dropdown, EU overrides, custom
        // tiers, and 'auto' classification the user sees in direct chat.
        const userOrgForTiers = req.session?.user?.organizationId || null;
        let tiers = await getEUAwareTiers({ userOrgId: userOrgForTiers, userId });
        try {
            const { isEU } = await isEUModeActive({ userOrgId: userOrgForTiers, userId });
            const globalCustom = (await configStore.getConfig('custom_chat_model_tiers')) || [];
            const orgCustom = userOrgForTiers
                ? ((await configStore.getConfig(`custom_chat_model_tiers_org_${userOrgForTiers}`)) || [])
                : [];
            const byId = new Map();
            for (const t of (Array.isArray(globalCustom) ? globalCustom : [])) if (t?.id) byId.set(t.id, t);
            for (const t of (Array.isArray(orgCustom)    ? orgCustom    : [])) if (t?.id) byId.set(t.id, t);
            for (const t of byId.values()) {
                tiers[t.id] = {
                    modelId: isEU && t.euModelId ? t.euModelId : t.modelId,
                    label: t.label, icon: t.icon, description: t.description,
                    maxTokens: t.maxTokens, temperature: t.temperature,
                    reasoningEffort: t.reasoningEffort, reasoningSummary: t.reasoningSummary,
                    custom: true,
                };
            }
        } catch (_) { /* fall through without custom tiers */ }

        let resolvedTier = modelTier || 'fast';
        if (resolvedTier === 'auto') {
            try {
                const { classifyWithLLM } = require('../../core/promptClassifier');
                // Same exclusions direct chat applies: custom tiers and swarm
                // require explicit user choice and must never win auto.
                const classifyTiers = Object.fromEntries(
                    Object.entries(tiers).filter(([k]) => !k.startsWith('custom:') && k !== 'swarm'),
                );
                const result = await classifyWithLLM(message || '', classifyTiers, { userOrgId: userOrgForTiers, userId });
                resolvedTier = result.tier;
                console.log(`[AutomationBuilder] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
            } catch (err) {
                console.log(`[AutomationBuilder] Auto classification failed: ${err.message}, using fast`);
                resolvedTier = 'fast';
            }
        }

        const tier = tiers[resolvedTier] || {};
        let modelId = tier.modelId;
        if (!modelId) {
            const globalConfig = await getAIConfig();
            modelId = globalConfig?.model || null;
        }
        if (!modelId) {
            send('error', { error: `No model configured for tier ${resolvedTier}` });
            return res.end();
        }

        // Capability floor: assembling a typed DAG is far harder than chat, so
        // when the user left the builder on 'auto' we must not run on a
        // small/fast model — those emit malformed bindings and loop to the
        // iteration cap. Bump up to the first non-small tier. An explicit user
        // tier choice is always honoured. See builderModelProfiles.js.
        if (modelTier === 'auto' || !modelTier) {
            const floored = applyBuilderTierFloor(resolvedTier, modelId, tiers);
            if (floored.modelId !== modelId) {
                console.log(`[AutomationBuilder] Auto floor: bumped small "${resolvedTier}" → "${floored.tier}" (${floored.modelId})`);
                resolvedTier = floored.tier;
                modelId = floored.modelId;
            }
        }

        const cfg = await getProviderForModel(modelId);
        const adapter = getAdapter(cfg.providerType, cfg.url);

        // Mirror direct chat: only emit model_selected when the *user* picked
        // 'auto', so the message bubble can render "Auto → <real tier>".
        if (modelTier === 'auto') {
            send('model_selected', { tier: resolvedTier, modelId });
        }

        // Pick the capability profile for this model. Drives prompt
        // variant, tool surface, temperature, iteration budget,
        // first-turn toolChoice enforcement, catalogue filtering, and
        // few-shot count. See server/automation/builderModelProfiles.js.
        const profile = getProfileForModel(modelId);
        console.log(`[AutomationBuilder] model=${modelId} profile=${JSON.stringify(profile)}`);

        // Flowlet sub-agents (builder_generate_layer[s]) always run on the
        // THINKING tier regardless of which model is driving the main chat —
        // building a whole sub-flow benefits from reasoning. Resolved once
        // per turn (falls back to the chat model if no thinking tier exists).
        let thinkingModelId = modelId;
        try { thinkingModelId = (await resolveLayerAgentModel({ userOrgId: userOrgForTiers, userId })) || modelId; }
        catch (_) { thinkingModelId = modelId; }
        // Per-turn to-do list (builder_set_plan). Seeded from the snapshot so
        // it survives across turns; re-emitted to the client on resume.
        draftWrap._todos = draftWrap._todos || [];

        // Build the system prompt with the profile-appropriate variant
        // and (possibly filtered) catalogue.
        const promptCatalog = profile.catalogMode === 'filtered'
            ? filterCatalogForUser(catalog, message, draftWrap.def)
            : catalog;
        const buildPrompt = profile.promptVariant === 'lean' ? buildLeanSystemPrompt : buildFullSystemPrompt;
        let sys = buildPrompt({
            catalog: promptCatalog,
            codeStepEnabled,
            userTimezone: timezone || 'Europe/Amsterdam',
            existingDraftSummary: agentDraftState,
            webSearchEnabled: !!webSearchEnabled,
            disabledMedia: disabledMedia || {},
        });
        // Canvas scope hint: when the user is drilled into a flowlet, tell the
        // model so its builder tool calls default `scope` there when the
        // request is about that sub-flow. Validated against the flowlet-key
        // grammar so a malformed client value can't inject prompt text.
        if (typeof canvasScope === 'string' && /^[a-z][a-z0-9_]*$/.test(canvasScope)) {
            sys += `\n\nThe user is currently viewing flowlet '${canvasScope}' on the canvas. When they ask to add or change steps without naming a flow, default the builder tools' \`scope\` argument to "${canvasScope}" when sensible; omit \`scope\` for changes to the main flow.`;
        }

        // Filter the tool schema set: by feature flag AND by profile.
        // The 'core' subset shrinks the tool menu from 26 to 13 for small
        // models. The five legacy array tools are still listed in full
        // mode so existing chat histories keep validating; core mode
        // hides them in favour of the unified builder_add_array_op.
        let tools = TOOL_SCHEMAS.filter(t => codeStepEnabled || t.function.name !== 'builder_add_code_step');
        if (profile.toolset === 'core') {
            tools = tools.filter(t => CORE_TOOL_NAMES.has(t.function.name));
        }

        // Inspection tools: if the user has the webpages beta, expose the
        // same surface the direct-chat AI uses (schema/query/exec, file
        // read/write/replace/patch, set metadata, create, list). The builder
        // calls them while designing the automation so it can read the real
        // table columns before drafting an INSERT, etc.
        let webpageInspectorEnabled = false;
        let webpageInspectorCtx = null;
        try {
            const { userHasBetaFeature } = require('../../core/betaFeatures');
            webpageInspectorEnabled = await userHasBetaFeature(userId, 'webpages', req.session);
        } catch (_) { /* default false */ }
        if (webpageInspectorEnabled) {
            const { WEBPAGE_AUTOMATION_TOOLS } = require('../../integrations/webpageAutomationTools');
            const { resolveUserGroups } = require('../../auth/audience');
            const { resolveUserOrgIds } = require('../../auth/permissions');
            const userGroupIds = await resolveUserGroups(userId).catch(() => []);
            const orgIdsSet = await resolveUserOrgIds(req).catch(() => null);
            const userOrgIds = orgIdsSet instanceof Set ? [...orgIdsSet] : [];
            webpageInspectorCtx = {
                userId,
                organizationId: req.session?.user?.organizationId || null,
                userGroupIds,
                userOrgIds,
            };
            for (const tool of WEBPAGE_AUTOMATION_TOOLS) {
                if (!tools.find(t => t.function.name === tool.function.name)) tools.push(tool);
            }
        }
        const { isWebpageAutomationTool, executeWebpageAutomationTool } = require('../../integrations/webpageAutomationTools');

        // Compose messages.
        // Attachments are NOT actually executed (the Builder is a design-time
        // agent, not a runtime). We surface their names/types so the user can
        // reference them in the automation, e.g. "use this CSV as the contact list".
        const attachmentSummary = Array.isArray(attachments) && attachments.length
            ? `\n\n[User attached ${attachments.length} file(s) to this turn: ${attachments.map(a => a?.name || a?.filename || 'untitled').join(', ')}. They are not executed by the Builder, but you can refer to them when proposing steps.]`
            : '';
        // Few-shot examples are prepended ONLY for a fresh draft (no
        // history yet). Once the user has been chatting, the prior turns
        // are the real-world example the model should learn from — adding
        // canned examples on top would dilute that signal.
        // Gemini 3.x rejects any functionCall in the request whose part is
        // missing a thought_signature, and the synthetic few-shot tool_calls
        // can't carry one (signatures are cryptographic, model-issued).
        // Skip few-shots for these models — the rest of the system prompt
        // already documents the tool schema in detail.
        const isGemini3x = /gemini-3(\.\d+)?-(pro|flash)/i.test(modelId || '');
        const effectiveFewShots = isGemini3x ? 0 : (profile.fewShots || 0);
        const fewShotMessages = (!history || history.length === 0)
            ? buildFewShotMessages(effectiveFewShots)
            : [];
        const messages = [
            { role: 'system', content: sys },
            ...fewShotMessages,
            ...sanitizeHistory(history),
            { role: 'user', content: (message || '') + attachmentSummary },
        ];

        // The profile sets a higher cap than the legacy MAX_ITERATIONS
        // when needed (e.g. small models that take more turns to
        // converge). Clamp to the hard ceiling so a bad profile can't
        // burn unbounded tokens.
        const iterationBudget = Math.min(profile.maxIterations || 16, MAX_ITERATIONS);

        let lastFinalized = false;
        let lastValidation = null;
        let lastSummary = summary || null;
        let iter = 0;
        for (iter = 0; iter < iterationBudget; iter++) {
            // First iteration on small / reasoning profiles: force a
            // tool call so the model can't fall back to prose. From
            // iteration 2 onward it's 'auto' — the model legitimately
            // needs to emit text once it's done mutating the draft.
            // Forcing a specific tool is incompatible with extended thinking
            // (Anthropic rejects tool_choice other than auto/none when thinking
            // is on). It can't actually collide here — forceFirstToolCall is only
            // set on the 'small' profile, whose models aren't reasoning-capable so
            // buildThinking no-ops — but guard anyway for safety.
            const turnToolChoice = (iter === 0 && profile.forceFirstToolCall) ? 'required' : 'auto';
            let response;
            try {
                // Stream the turn so the chat panel shows reasoning + text + tool
                // calls live (parity with direct/agent chat) instead of one
                // batched dump. reasoningEffort enables extended thinking on
                // capable models (Opus/Sonnet); the adapter no-ops it otherwise.
                response = await streamWithRetry(adapter, cfg, modelId, messages, {
                    // 8192 (was 4096): a complex turn can chain several tool
                    // calls whose JSON arguments don't fit in 4k — truncation
                    // there produces invalid tool-call JSON. The extra headroom
                    // makes that rare; the parse guard below catches the rest.
                    maxTokens: 8192,
                    temperature: typeof profile.temperature === 'number' ? profile.temperature : 0.2,
                    tools,
                    toolChoice: turnToolChoice,
                    reasoningEffort: 'medium',
                }, { send });
            } catch (chatErr) {
                // Transient provider failures (429/5xx/timeout) that survived
                // the bounded retry. Don't crash the whole turn — the draft is
                // persisted after every mutation, so end gracefully and let the
                // user resend. Falls through to the snapshot-persist + `done`.
                console.error('[AutomationBuilder] chat failed after retries:', chatErr.message);
                send('error', { error: 'The AI provider had a temporary problem. Your draft is saved — please send your message again.', transient: true });
                break;
            }

            // Assistant text + thinking already streamed live via streamWithRetry.

            // Signed thinking blocks for replay: Anthropic requires the thinking
            // that preceded a turn's tool_use to be re-sent on the next request.
            const thinkingForReplay = (response.thinkingParts || [])
                .filter(p => p.signature && p.text && !p.redacted)
                .map(p => ({ text: p.text, signature: p.signature, redacted: p.redacted || undefined }));

            if (response.toolCalls && response.toolCalls.length) {
                messages.push({
                    role: 'assistant',
                    content: response.content || null,
                    ...(thinkingForReplay.length ? { thinking: thinkingForReplay } : {}),
                    tool_calls: response.toolCalls.map(tc => ({
                        id: tc.id, type: 'function',
                        function: {
                            name: tc.function.name,
                            arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
                        },
                        _thought_signature: tc._thought_signature || undefined,
                        _raw_content_parts: tc._raw_content_parts || undefined,
                    })),
                });
                let mutatedThisIter = false;
                for (const tc of response.toolCalls) {
                    const name = tc.function.name;
                    const { args, truncated } = parseToolArgs(tc.function.arguments, name);
                    let toolResult;
                    if (truncated) {
                        // Arguments didn't parse as JSON — almost always a
                        // mid-call truncation. Running the tool with empty args
                        // yields a confusing generic error and a blind retry;
                        // instead tell the model exactly what happened so it
                        // resends just this one call. Still push a tool message
                        // so the assistant turn stays well-formed.
                        toolResult = { error: `Your arguments for ${name} were not valid JSON (likely truncated mid-call). Resend just THIS single tool call with complete, valid JSON arguments.`, _truncated: true };
                        send('tool_call', { name, arguments: {}, result: toolResult });
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
                        continue;
                    }
                    // ── Self-planning (route-handled, non-mutating): record the
                    //    agent's to-do list and surface it to the user. ──
                    if (name === 'builder_set_plan') {
                        const todos = normalizePlanTodos(args.todos);
                        draftWrap._todos = todos;
                        const planResult = { ok: true, count: todos.length };
                        send('plan', { todos });
                        send('tool_call', { name, arguments: args, result: planResult });
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(planResult) });
                        continue;
                    }
                    // ── Flowlet delegation (route-handled): spawn one or several
                    //    thinking-model sub-agents to build whole flowlet(s),
                    //    merge into the draft, persist + emit a draft snapshot,
                    //    and let the post-loop validator feed errors back. ──
                    if (name === 'builder_generate_layer' || name === 'builder_generate_layers') {
                        try {
                            toolResult = await runDelegationTool(name, args, {
                                draftWrap, thinkingModelId, userId,
                                userOrgId: userOrgForTiers, session: req.session,
                                catalog, send,
                            });
                        } catch (e) { toolResult = { error: e.message }; }
                        send('tool_call', { name, arguments: args, result: toolResult });
                        await persistDraftWrap(draftWrap);
                        send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
                        mutatedThisIter = true; // post-loop validation feedback runs
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult).slice(0, 30_000) });
                        continue;
                    }
                    try {
                        if (webpageInspectorEnabled && isWebpageAutomationTool(name)) {
                            toolResult = await executeWebpageAutomationTool(name, args, webpageInspectorCtx);
                        } else {
                            toolResult = await applyToolCall(name, args, draftWrap);
                        }
                    } catch (e) { toolResult = { error: e.message }; }
                    send('tool_call', { name, arguments: args, result: toolResult });

                    // After every mutation, persist + emit a draft snapshot.
                    if (mutates(name)) {
                        await persistDraftWrap(draftWrap);
                        send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
                        mutatedThisIter = true;
                    }
                    if (name === 'builder_summarise') {
                        send('summary', toolResult);
                        if (toolResult && typeof toolResult.summary === 'string') {
                            lastSummary = toolResult.summary;
                        }
                    }
                    if (name === 'builder_request_dry_run' && toolResult?.run) {
                        send('dryrun', { run: toolResult.run, steps: toolResult.steps || [] });
                    }
                    if (name === 'builder_finalize' && toolResult?.automation) {
                        // Block finalization when the current draft has any
                        // structural errors. This keeps a half-formed graph
                        // from being saved as "ready" — the LLM gets the
                        // structured errors back and self-corrects.
                        const finalCheck = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
                        if (!finalCheck.ok) {
                            lastValidation = finalCheck;
                            send('validation_errors', { errors: finalCheck.errors, warnings: finalCheck.warnings });
                            // Replace the success result with a diagnostic so
                            // the LLM sees this attempt failed.
                            toolResult = {
                                error: 'Cannot finalize: definition has validation errors. Address the errors below and try again.',
                                validation: finalCheck,
                            };
                        } else {
                            send('finalized', { automationId: toolResult.automation.id });
                            lastFinalized = true;
                        }
                    }

                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult).slice(0, 30_000),
                    });
                }

                // Validation feedback loop: after any mutation, validate the
                // draft and feed the structured records back to the LLM as
                // a synthetic system note. This is what lets the model
                // self-correct on specific failures (e.g. "you wired a
                // condition with no edges") instead of looping on prose.
                if (mutatedThisIter) {
                    lastValidation = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
                    send('validation_errors', { errors: lastValidation.errors, warnings: lastValidation.warnings });
                    if (lastValidation.errors.length || lastValidation.warnings.length) {
                        messages.push({
                            role: 'system',
                            content: `Draft validation results (machine-readable). Address every \`error\` before calling builder_finalize. Each record has {code, severity, path, message, hint}; the hint tells you what to do next.\n\n${JSON.stringify({ errors: lastValidation.errors, warnings: lastValidation.warnings })}`,
                        });
                    }
                }

                if (lastFinalized) break;
                continue;
            }

            // No tool calls — assistant produced a final message; we're done with this turn.
            break;
        }

        // If the model exhausted its iteration budget without finalizing,
        // try to auto-finalize when the draft is structurally complete.
        // Small models sometimes run out of conversational turns AFTER
        // they've already produced a valid graph — abandoning the work
        // would force the user to start over, even though the routine
        // is ready. We only fall back when:
        //   - the draft passes validateDefinition,
        //   - it has a trigger and at least one step (non-empty), and
        //   - the model didn't itself call builder_finalize already.
        if (!lastFinalized && iter >= iterationBudget) {
            const finalCheck = validateDefinition(draftWrap.def);
            const def = draftWrap.def;
            const hasTrigger = !!def?.trigger;
            const hasStep = Array.isArray(def?.steps) && def.steps.length > 0;
            if (finalCheck.ok && hasTrigger && hasStep) {
                try {
                    const finalized = await applyToolCall('builder_finalize', {}, draftWrap);
                    if (finalized?.automation) {
                        send('finalized', { automationId: finalized.automation.id, autoFinalized: true });
                        send('message', { content: 'I ran out of conversational turns but your draft validates — finalising as-is. Activate when ready.' });
                        lastFinalized = true;
                    }
                } catch (e) {
                    console.warn('[AutomationBuilder] auto-finalize failed:', e.message);
                }
            }
            if (!lastFinalized) {
                send('builder_aborted', {
                    reason: 'max_iterations',
                    iterations: iterationBudget,
                    lastValidation: lastValidation || finalCheck || null,
                });
            }
        }

        // Snapshot for SSE-resume. Captures just enough state to hydrate
        // the UI on reconnect: the message that opened this turn, the
        // assistant's reply with its tool calls, the latest draft, the
        // structured validation, and any summary. The store trims
        // oldest assistant turns past 64KB.
        if (draftWrap.automationId) {
            try {
                const lastUserMessage = { role: 'user', content: message || '' };
                const assistantOut = collectAssistantTurn(messages);
                const conversationTail = [
                    ...sanitizeHistory(history),
                    lastUserMessage,
                    ...(assistantOut ? [assistantOut] : []),
                ];
                await automationStore.setBuilderSession(draftWrap.automationId, userId, {
                    sessionId: draftWrap.builderSessionId,
                    draft: draftWrap.def,
                    lastValidation: lastValidation || null,
                    summary: lastSummary || null,
                    conversation: conversationTail,
                    todos: Array.isArray(draftWrap._todos) ? draftWrap._todos : [],
                    updatedAt: new Date().toISOString(),
                });
            } catch (_) { /* non-fatal */ }
        }

        send('done', { automationId: draftWrap.automationId, finalized: lastFinalized, iterations: iter });
        res.end();
    } catch (e) {
        console.error('[automationBuilder/stream] error:', e);
        send('error', { error: e.message });
        res.end();
    }
});

function mutates(toolName) {
    // builder_inspect_tool, builder_summarise, builder_request_dry_run,
    // and builder_finalize are all non-mutating from the draft definition's
    // perspective (finalize flips a flag but doesn't change `def`).
    // Source of truth lives in builderTools.MUTATING_TOOLS so new mutators
    // (flowlet tools, array ops, …) persist + emit a draft snapshot without
    // this list silently drifting out of date.
    return MUTATING_TOOLS.has(toolName);
}

// Tools that legitimately take NO arguments — an empty/missing args string is
// valid for these, so a JSON-parse "failure" on an empty string must NOT be
// treated as a truncation.
const PARAMLESS_BUILDER_TOOLS = new Set(['builder_summarise', 'builder_finalize', 'builder_request_dry_run']);

/**
 * Parse a tool call's `arguments` defensively. Returns `{ args, truncated }`.
 * `truncated` is true only when a NON-EMPTY arguments string fails to parse
 * for a tool that actually takes parameters — the signature of a model
 * response cut off mid-call. Empty args for a parameterless tool are valid.
 */
function parseToolArgs(raw, toolName) {
    if (raw && typeof raw === 'object') return { args: raw, truncated: false };
    if (typeof raw !== 'string') return { args: {}, truncated: false };
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '{}') return { args: {}, truncated: false };
    try { return { args: JSON.parse(trimmed), truncated: false }; }
    catch { return { args: {}, truncated: !PARAMLESS_BUILDER_TOOLS.has(toolName) }; }
}

// Transient provider errors (rate limits, 5xx, network blips) shouldn't kill
// an entire builder turn — the user would lose their in-progress conversation.
// Permanent errors (auth/validation 4xx) are not worth retrying.
function isTransientChatError(err) {
    const status = err && (err.status || err.statusCode);
    if (typeof status === 'number') {
        if ([408, 429, 500, 502, 503, 504].includes(status)) return true;
        if (status >= 400 && status < 500) return false; // auth/validation — permanent
    }
    const msg = String((err && err.message) || '').toLowerCase();
    return /\b(408|429|500|502|503|504)\b/.test(msg)
        || /(rate.?limit|overloaded|too many requests|timeout|timed out|temporarily|econnreset|etimedout|enotfound|eai_again|socket hang up|fetch failed|network error|aborted)/.test(msg);
}

/**
 * Call adapter.chat with a bounded retry on transient errors and exponential
 * backoff + jitter. `baseDelayMs` is injectable so tests run fast.
 */
async function chatWithRetry(adapter, cfg, modelId, messages, options, { retries = 2, baseDelayMs = 500 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await adapter.chat(cfg.apiKey, cfg.url, modelId, messages, options);
        } catch (e) {
            lastErr = e;
            if (attempt === retries || !isTransientChatError(e)) throw e;
            const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            console.warn(`[AutomationBuilder] chat attempt ${attempt + 1} failed (${e.message}); retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

/**
 * Streaming counterpart of chatWithRetry. Runs ONE model turn via
 * `adapter.stream`, forwarding live events to the client so the chat panel
 * shows reasoning + text as they arrive (parity with direct/agent chat), then
 * returns the assembled turn `{ content, toolCalls, thinkingParts }` for the
 * builder's tool loop. `thinkingParts` carry the signature so the next turn's
 * assistant message can replay signed thinking blocks before its tool_use
 * blocks (Anthropic conversation-integrity requirement — claude.js rebuilds
 * them from `m.thinking`).
 *
 * Retries on transient provider errors ONLY when nothing has been streamed yet
 * this attempt — once tokens are on the wire, a blind retry would duplicate
 * them, so we surface the error to the caller's graceful-degradation path.
 */
let __builderStreamSeq = 0;
async function streamWithRetry(adapter, cfg, modelId, messages, options, { send, retries = 2, baseDelayMs = 500 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        let fullContent = '';
        const toolCalls = [];
        const thinkingParts = [];          // { id, text, signature, redacted, startedAt, endedAt }
        const partById = new Map();
        let emittedAny = false;
        let streamErr = null;
        // Adapter part ids (e.g. "claude-0") reset every stream call; namespace
        // them per turn so successive builder iterations don't collide into one
        // part on the client.
        const tag = `s${__builderStreamSeq++}`;
        const tagPart = (id) => `${tag}-${id}`;

        const ensurePart = (id, redacted) => {
            let p = partById.get(id);
            if (!p) {
                p = { id, text: '', signature: null, redacted: !!redacted, startedAt: Date.now(), endedAt: null };
                partById.set(id, p);
                thinkingParts.push(p);
            }
            return p;
        };

        const onEvent = (type, data) => {
            if (type === 'text') {
                if (data && data.text) { fullContent += data.text; emittedAny = true; send('message', { content: data.text }); }
            } else if (type === 'thinking_start') {
                const id = tagPart((data && data.partId) || `t${thinkingParts.length}`);
                ensurePart(id, data && data.redacted);
                emittedAny = true;
                send('thinking_start', { partId: id, redacted: (data && data.redacted) || undefined });
            } else if (type === 'thinking') {
                // data.partId is the raw adapter id (tag it); the no-partId
                // fallback reuses the last part's already-tagged id as-is.
                const id = (data && data.partId)
                    ? tagPart(data.partId)
                    : (thinkingParts.length ? thinkingParts[thinkingParts.length - 1].id : tagPart('t0'));
                const p = ensurePart(id);
                p.text += (data && data.text) || '';
                emittedAny = true;
                send('thinking', { partId: id, text: (data && data.text) || '' });
            } else if (type === 'thinking_signature') {
                if (data && data.partId) { const p = partById.get(tagPart(data.partId)); if (p) p.signature = data.signature; }
            } else if (type === 'thinking_stop') {
                const id = data && data.partId ? tagPart(data.partId) : null;
                if (id) { const p = partById.get(id); if (p) p.endedAt = Date.now(); }
                send('thinking_stop', { partId: id, redacted: (data && data.redacted) || undefined });
            } else if (type === 'tool_use') {
                toolCalls.push({
                    id: (data && data.id) || `call_${Date.now()}_${toolCalls.length}`,
                    type: 'function',
                    function: { name: data && data.name, arguments: JSON.stringify((data && data.input) || {}) },
                    _thought_signature: (data && data.thought_signature) || undefined,
                });
                emittedAny = true;
            } else if (type === 'error') {
                streamErr = new Error((data && (data.error || data.message)) || 'stream error');
            }
            // 'done' / 'tool_args_delta' ignored — usage isn't needed here.
        };

        try {
            await adapter.stream(cfg.apiKey, cfg.url, modelId, messages, options, onEvent);
            // An in-stream error with nothing usable produced → treat as a throw
            // so the retry / graceful path handles it consistently.
            if (streamErr && !fullContent && !toolCalls.length) throw streamErr;
            return {
                content: fullContent || null,
                toolCalls: toolCalls.length ? toolCalls : null,
                thinkingParts: thinkingParts.filter(p => p.text || p.redacted),
            };
        } catch (e) {
            lastErr = e;
            if (attempt === retries || !isTransientChatError(e) || emittedAny) throw e;
            const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
            console.warn(`[AutomationBuilder] stream attempt ${attempt + 1} failed (${e.message}); retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

// Tier keys tried, in order, when flooring a small auto-resolved model up to a
// capable one. The first whose configured model is non-small wins.
const BUILDER_FLOOR_TIER_ORDER = ['standard', 'thinking', 'deep_thinking', 'writer', 'pro', 'smart'];

/**
 * Floor an auto-resolved builder model to at least a non-small capability
 * band. Returns `{ tier, modelId }` — unchanged when `modelId` is already
 * non-small, or when the org has no non-small tier configured (don't break a
 * small-only org).
 */
function applyBuilderTierFloor(resolvedTier, modelId, tiers) {
    const { classifyModel } = require('../../automation/builderModelProfiles');
    if (classifyModel(modelId) !== 'small') return { tier: resolvedTier, modelId };
    for (const key of BUILDER_FLOOR_TIER_ORDER) {
        if (key.startsWith('custom:') || key === 'swarm') continue;
        const cand = tiers?.[key]?.modelId;
        if (cand && classifyModel(cand) !== 'small') return { tier: key, modelId: cand };
    }
    return { tier: resolvedTier, modelId };
}

function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content }))
        .slice(-20);
}

/**
 * Collapse the LLM-loop messages array down to the latest assistant turn
 * for snapshot persistence: pulls the most recent assistant entry and
 * resolves its tool_calls/results so a resume can rebuild the chat bubble.
 */
function collectAssistantTurn(loopMessages) {
    if (!Array.isArray(loopMessages)) return null;
    // Walk back to the last assistant message.
    let assistantIdx = -1;
    for (let i = loopMessages.length - 1; i >= 0; i--) {
        if (loopMessages[i]?.role === 'assistant') { assistantIdx = i; break; }
    }
    if (assistantIdx < 0) return null;
    const a = loopMessages[assistantIdx];
    const toolCalls = Array.isArray(a.tool_calls)
        ? a.tool_calls.map(tc => {
            // Pair with its tool result (next 'tool' message with matching id).
            const result = loopMessages.slice(assistantIdx + 1).find(m => m.role === 'tool' && m.tool_call_id === tc.id);
            let parsedResult = null;
            try { parsedResult = result?.content ? JSON.parse(result.content) : null; }
            catch { parsedResult = result?.content || null; }
            let parsedArgs = {};
            try { parsedArgs = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {}); }
            catch { parsedArgs = {}; }
            return { name: tc.function?.name, arguments: parsedArgs, result: parsedResult };
        })
        : [];
    return {
        role: 'assistant',
        content: typeof a.content === 'string' ? a.content : '',
        toolCalls,
    };
}

async function loadOrCreateDraft({ userId, builderSessionId, automationId }) {
    if (automationId) {
        const a = await automationStore.getAutomation(automationId);
        if (a && a.userId === userId) {
            return {
                userId,
                builderSessionId: builderSessionId || a.createdFromChatId || `bs_${Date.now().toString(36)}`,
                automationId: a.id,
                title: a.title,
                description: a.description,
                def: a.definition && Object.keys(a.definition).length ? a.definition : emptyDefinition(),
            };
        }
    }
    return {
        userId,
        builderSessionId: builderSessionId || `bs_${Date.now().toString(36)}`,
        automationId: null,
        title: 'Untitled automation',
        description: '',
        def: emptyDefinition(),
    };
}

async function persistDraftWrap(draftWrap) {
    // Always-on persistence: every mutation writes through to the
    // automations table. The draft row is also returned by /api/automation
    // listings so the user sees their in-progress work in the UI.
    const { persistDraft } = require('../../automation/builderTools');
    await persistDraft(draftWrap);
}

/** Sanitise an agent-supplied to-do list (capped; {text, done}). */
function normalizePlanTodos(todos) {
    if (!Array.isArray(todos)) return [];
    return todos
        .filter(t => t && (typeof t === 'string' || typeof t.text === 'string'))
        .slice(0, 30)
        .map(t => (typeof t === 'string'
            ? { text: t.slice(0, 200), done: false }
            : { text: String(t.text).slice(0, 200), done: !!t.done }));
}

/**
 * Run a flowlet-delegation tool (builder_generate_layer / _layers). Spawns the
 * thinking-model flowlet sub-agent(s) and mutates draftWrap.def in place; the
 * caller persists + emits the draft snapshot afterwards. Returns a result the
 * orchestrator uses to wire call_layer steps.
 */
async function runDelegationTool(name, args, ctx) {
    const { draftWrap, thinkingModelId, userId, userOrgId, session, catalog, send } = ctx;

    if (name === 'builder_generate_layer') {
        const title = String(args?.title || 'New layer');
        const created = await applyToolCall('builder_create_layer', { title, params: args?.params }, draftWrap);
        if (created?.error) return created;
        const layerKey = created.layerKey;
        send('layer_agent_start', { layerKey, title });
        const r = await runLayerAgent({
            draftWrap, layerKey,
            instruction: String(args?.instruction || title),
            contract: { params: args?.params, outputFields: args?.outputFields },
            mode: 'create', modelId: thinkingModelId, userId, userOrgId, session, catalog, send,
        });
        send('layer_agent_done', { layerKey, outputFields: r.outputFields, summary: r.summary });
        return {
            layerKey, title, outputFields: r.outputFields, summary: r.summary,
            next: `Wire it into the main flow: builder_add_call_layer({ layerKey: "${layerKey}", inputs: {…} }). Bind its results downstream as steps.<callId>.output.<field> for: ${(r.outputFields || []).join(', ') || '(none declared — call builder_set_layer_contract)'}.`,
        };
    }

    // builder_generate_layers — parallel (cap 3, enforced in layerAgent).
    const specs = Array.isArray(args?.layers) ? args.layers.filter(s => s && (s.instruction || s.title)) : [];
    if (specs.length === 0) {
        return { error: 'builder_generate_layers requires a non-empty `layers` array of { title, instruction, params?, outputFields? }.' };
    }
    const results = await runLayersInParallel({
        rootDef: draftWrap.def, specs,
        modelId: thinkingModelId, userId, userOrgId, session, catalog, send, cap: 3,
        inputSchemasByTool: draftWrap._inputSchemasByTool,
    });
    return {
        layers: results.map(r => (r.ok
            ? { layerKey: r.layerKey, title: r.title, outputFields: r.outputFields, summary: r.summary }
            : { title: r.title, error: r.error })),
        next: 'Wire each built flowlet into the main flow with builder_add_call_layer({ layerKey, inputs }); bind their results as steps.<callId>.output.<field>.',
    };
}

async function buildCatalogForUser(userId, session) {
    try {
        const { TOOL_REGISTRY, loadTools } = require('../../automation/toolRegistry');
        const { getOutputSchema, OUTPUT_SCHEMAS } = require('../../automation/outputSchemas');
        const { isSideEffect } = require('../../automation/sideEffectMap');
        const { getIntegrationTools, getUserPermittedApps } = require('../../core/integrationTools');
        const { buildTriggerOutputsCatalog } = require('../../automation/builderTools');

        // `connected` set — apps the user can invoke RIGHT NOW (OAuth done,
        // API key configured, group not opted-out, etc.). Drives the
        // "Connect" badge on the palette.
        const userToolNames = new Set();
        try {
            const r = await getIntegrationTools({ userId, session, isAdmin: !!session?.isAdmin });
            for (const t of (r.tools || [])) if (t?.function?.name) userToolNames.add(t.function.name);
        } catch (_) {}

        // `permitted` set — every app the user is ALLOWED to use under the
        // org / group / personal-toggle gates, regardless of credentials.
        // Mirrors the chat sidebar's Apps panel so an automation user sees
        // exactly the same set of integrations they can wire up in chat.
        // Without this the palette only showed apps OAuth'd today and felt
        // empty on first launch.
        let permittedSet = null;
        try {
            permittedSet = await getUserPermittedApps({ userId, session, isAdmin: !!session?.isAdmin });
        } catch (_) {}

        const apps = TOOL_REGISTRY.map(entry => {
            const tools = loadTools(entry);
            const actions = tools.map(t => {
                const name = t?.function?.name;
                if (!name) return null;
                // inputSchema is the OpenAI-format `parameters` block already attached
                // to every tool entry — surface it so the client mapping UI can render
                // typed fields instead of generic key+value rows.
                // outputSample comes from outputSchemas.js so the VariableTree can
                // show realistic placeholder values without needing a dry-run.
                const sch = OUTPUT_SCHEMAS[name] || null;
                return {
                    name,
                    description: t.function?.description,
                    sideEffect: isSideEffect(name),
                    outputSchema: getOutputSchema(name),
                    inputSchema: t.function?.parameters || null,
                    outputSample: sch?.sample || null,
                };
            }).filter(Boolean);
            const connected = actions.some(a => userToolNames.has(a.name));
            // Permitted = the user has rights to use this app (org/group/
            // personal toggles all pass). Falls back to "permit-all" when
            // the helper couldn't resolve (missing user record, etc.) so
            // we never lock the user out of their own catalog.
            const permitted = permittedSet ? permittedSet.has(entry.app) : true;
            // App appears in the palette when EITHER the user has rights
            // OR is already connected (a credential-only path — shouldn't
            // happen in practice but we don't want to hide a tool the
            // user is actively using).
            const available = permitted || connected;
            return {
                id: entry.app,
                label: entry.label,
                available,
                connected,
                permitted,
                actions,
            };
        });
        return { apps, triggerOutputs: buildTriggerOutputsCatalog() };
    } catch (e) {
        return { apps: [], triggerOutputs: {} };
    }
}

module.exports = router;
// Internals exposed for unit tests (server/routes/ai/automationBuilder.test.js).
module.exports._test = { parseToolArgs, isTransientChatError, chatWithRetry, applyBuilderTierFloor, validateLayerForSummary, sanitiseLayerSummary };
