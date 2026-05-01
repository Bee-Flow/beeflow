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
const { getProviderForModel } = require('../../core/aiAgent');
const { getAdapter } = require('../../core/providers');
const { resolveModelForTier } = require('../../core/modelResolver');
const { TOOL_SCHEMAS, applyToolCall, emptyDefinition } = require('../../automation/builderTools');
const { buildSystemPrompt } = require('../../automation/builderPrompt');
const { summariseDefinition } = require('../../automation/summarise');

function requireAuth(req, res, next) {
    if (req.session?.user?.id) return next();
    res.status(401).json({ error: 'Not authenticated' });
}

// The AI may need: propose_trigger → multiple add_*  → summarise → dry_run
// → fix → dry_run → finalize. Bumped so the auto-test loop has room.
const MAX_ITERATIONS = 16;

router.post('/stream', requireAuth, async (req, res) => {
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
        // Feature gate: open by default. Only block when explicitly disabled.
        // Accepts boolean true/false or string "true"/"false" from configStore.
        const flagRaw = await configStore.getConfig('feature_automations_enabled');
        const featureOff = flagRaw === false || flagRaw === 'false';
        if (featureOff) {
            send('error', { error: 'Automation builder is disabled by your organisation administrator.' });
            return res.end();
        }
        const codeFlagRaw = await configStore.getConfig('automation_code_step_enabled');
        const codeStepEnabled = codeFlagRaw === true || codeFlagRaw === 'true';

        // Resolve / load the draft.
        let draftWrap = await loadOrCreateDraft({ userId, builderSessionId: clientSession, automationId });
        send('builder_session', { builderSessionId: draftWrap.builderSessionId, automationId: draftWrap.automationId });

        // Build catalog for the prompt.
        const catalog = await buildCatalogForUser(userId, req.session);

        const summary = summariseDefinition(draftWrap.def).summary;
        const sys = buildSystemPrompt({
            catalog,
            codeStepEnabled,
            userTimezone: timezone || 'Europe/Amsterdam',
            existingDraftSummary: summary,
            webSearchEnabled: !!webSearchEnabled,
            disabledMedia: disabledMedia || {},
        });

        // Resolve model.
        const modelId = await resolveModelForTier(`tier:${modelTier}`, { userId });
        if (!modelId) {
            send('error', { error: `No model configured for tier ${modelTier}` });
            return res.end();
        }
        const cfg = await getProviderForModel(modelId);
        const adapter = getAdapter(cfg.providerType, cfg.url);

        // Filter the tool schema set by feature flag.
        const tools = TOOL_SCHEMAS.filter(t => codeStepEnabled || t.function.name !== 'builder_add_code_step');

        // Compose messages.
        // Attachments are NOT actually executed (the Builder is a design-time
        // agent, not a runtime). We surface their names/types so the user can
        // reference them in the automation, e.g. "use this CSV as the contact list".
        const attachmentSummary = Array.isArray(attachments) && attachments.length
            ? `\n\n[User attached ${attachments.length} file(s) to this turn: ${attachments.map(a => a?.name || a?.filename || 'untitled').join(', ')}. They are not executed by the Builder, but you can refer to them when proposing steps.]`
            : '';
        const messages = [
            { role: 'system', content: sys },
            ...sanitizeHistory(history),
            { role: 'user', content: (message || '') + attachmentSummary },
        ];

        let lastFinalized = false;
        for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
            const response = await adapter.chat(cfg.apiKey, cfg.url, modelId, messages, {
                maxTokens: 4096,
                temperature: 0.2,
                tools,
                toolChoice: 'auto',
            });

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
                    })),
                });
                for (const tc of response.toolCalls) {
                    const name = tc.function.name;
                    let args = {};
                    try { args = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; }
                    catch { args = {}; }
                    let toolResult;
                    try { toolResult = await applyToolCall(name, args, draftWrap); }
                    catch (e) { toolResult = { error: e.message }; }
                    send('tool_call', { name, arguments: args, result: toolResult });

                    // After every mutation, persist + emit a draft snapshot.
                    if (mutates(name)) {
                        await persistDraftWrap(draftWrap);
                        send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
                    }
                    if (name === 'builder_summarise') {
                        send('summary', toolResult);
                    }
                    if (name === 'builder_request_dry_run' && toolResult?.run) {
                        send('dryrun', { run: toolResult.run, steps: toolResult.steps || [] });
                    }
                    if (name === 'builder_finalize' && toolResult?.automation) {
                        send('finalized', { automationId: toolResult.automation.id });
                        lastFinalized = true;
                    }

                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult).slice(0, 30_000),
                    });
                }
                if (lastFinalized) break;
                continue;
            }

            // No tool calls — assistant produced a final message; we're done with this turn.
            break;
        }

        send('done', { automationId: draftWrap.automationId });
        res.end();
    } catch (e) {
        console.error('[automationBuilder/stream] error:', e);
        send('error', { error: e.message });
        res.end();
    }
});

function mutates(toolName) {
    return [
        'builder_propose_trigger', 'builder_add_action', 'builder_add_ai_step',
        'builder_add_condition', 'builder_add_loop', 'builder_add_code_step',
        'builder_add_notification', 'builder_remove_step', 'builder_set_metadata',
    ].includes(toolName);
}

function sanitizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role, content: m.content }))
        .slice(-20);
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
        const { getOutputSchema } = require('../../automation/outputSchemas');
        const { isSideEffect } = require('../../automation/sideEffectMap');
        const { getIntegrationTools } = require('../../core/integrationTools');
        const userToolNames = new Set();
        try {
            const r = await getIntegrationTools({ userId, session, isAdmin: !!session?.isAdmin });
            for (const t of (r.tools || [])) if (t?.function?.name) userToolNames.add(t.function.name);
        } catch (_) {}
        const apps = TOOL_REGISTRY.map(entry => {
            const tools = loadTools(entry);
            const actions = tools.map(t => {
                const name = t?.function?.name;
                if (!name) return null;
                return { name, description: t.function?.description, sideEffect: isSideEffect(name), outputSchema: getOutputSchema(name) };
            }).filter(Boolean);
            const available = actions.some(a => userToolNames.has(a.name));
            return { id: entry.app, label: entry.label, available, actions };
        });
        return { apps };
    } catch (e) {
        return { apps: [] };
    }
}

module.exports = router;
