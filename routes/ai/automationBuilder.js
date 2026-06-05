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
 *   message       — assistant text token (passthrough)
 *   tool_call     — { name, arguments, result }
 *   draft         — full updated definition (debounced)
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
const { getEUAwareTiers, isEUModeActive } = require('../../core/modelResolver');
const { TOOL_SCHEMAS, applyToolCall, emptyDefinition } = require('../../automation/builderTools');
const { buildFullSystemPrompt, buildLeanSystemPrompt, buildFewShotMessages } = require('../../automation/builderPrompt');
const { summariseDefinition } = require('../../automation/summarise');
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
                if (snapshot) send('resume', { snapshot });
            } catch (_) { /* non-fatal */ }
        }

        // Build catalog for the prompt. (Prompt construction is deferred
        // until after the model is resolved, so we can pick full vs. lean
        // prompt + apply per-model catalog filtering — see Step 5 of the
        // multi-model optimization in the plan file.)
        const catalog = await buildCatalogForUser(userId, req.session);

        const summary = summariseDefinition(draftWrap.def).summary;

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

        // Build the system prompt with the profile-appropriate variant
        // and (possibly filtered) catalogue.
        const promptCatalog = profile.catalogMode === 'filtered'
            ? filterCatalogForUser(catalog, message, draftWrap.def)
            : catalog;
        const buildPrompt = profile.promptVariant === 'lean' ? buildLeanSystemPrompt : buildFullSystemPrompt;
        // Web search is a licensed feature — don't let the builder propose
        // `agent_search` steps when the org isn't entitled (the tool is also
        // withheld at runtime by core/integrationTools.js, so an ungated
        // suggestion would just produce a step that never runs). Super admins
        // bypass, mirroring the runtime tool gate.
        let webSearchAllowed = !!webSearchEnabled;
        if (webSearchAllowed && !session?.isAdmin && session?.user?.role !== 'admin') {
            try {
                const license = require('../../license');
                webSearchAllowed = await license.hasFeature({ organizationId: userOrgForTiers, userId }, 'web_search');
            } catch (_) { webSearchAllowed = false; }
        }
        const sys = buildPrompt({
            catalog: promptCatalog,
            codeStepEnabled,
            userTimezone: timezone || 'Europe/Amsterdam',
            existingDraftSummary: summary,
            webSearchEnabled: webSearchAllowed,
            disabledMedia: disabledMedia || {},
        });

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
            const turnToolChoice = (iter === 0 && profile.forceFirstToolCall) ? 'required' : 'auto';
            let response;
            try {
                response = await chatWithRetry(adapter, cfg, modelId, messages, {
                    // 8192 (was 4096): a complex turn can chain several tool
                    // calls whose JSON arguments don't fit in 4k — truncation
                    // there produces invalid tool-call JSON. The extra headroom
                    // makes that rare; the parse guard below catches the rest.
                    maxTokens: 8192,
                    temperature: typeof profile.temperature === 'number' ? profile.temperature : 0.2,
                    tools,
                    toolChoice: turnToolChoice,
                });
            } catch (chatErr) {
                // Transient provider failures (429/5xx/timeout) that survived
                // the bounded retry. Don't crash the whole turn — the draft is
                // persisted after every mutation, so end gracefully and let the
                // user resend. Falls through to the snapshot-persist + `done`.
                console.error('[AutomationBuilder] chat failed after retries:', chatErr.message);
                send('error', { error: 'The AI provider had a temporary problem. Your draft is saved — please send your message again.', transient: true });
                break;
            }

            // Stream assistant content tokens (whole-message; we don't have
            // streaming chat for tool-calling on every adapter, so emit once).
            if (response.content) send('message', { content: response.content });

            if (response.toolCalls && response.toolCalls.length) {
                messages.push({
                    role: 'assistant',
                    content: response.content || null,
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
    return [
        'builder_propose_trigger', 'builder_add_action', 'builder_add_ai_step',
        'builder_add_condition', 'builder_add_loop', 'builder_add_code_step',
        'builder_add_notification', 'builder_remove_step', 'builder_set_metadata',
    ].includes(toolName);
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
module.exports._test = { parseToolArgs, isTransientChatError, chatWithRetry, applyBuilderTierFloor };
