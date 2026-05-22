/**
 * Direct Chat Routes
 * 
 * Handles: streaming direct chat, conversation CRUD.
 * Uses LLMClient for all LLM interactions — no provider-specific code here.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const componentManager = require('../../core/componentManager');
const { classifyPromptComplexity } = require('../../core/promptClassifier');
const { getAdapter } = require('../../core/providers');
const agentStore = require('../../stores/agentStore');
const { executeTool: dispatchTool } = require('../../core/toolDispatcher');
const { runWithProbe, markLocal } = require('../../core/outboundProbe');
const { resolveIntegration: resolveIntegrationMeta } = require('../../core/integrationToolMap');
const {
    ACTIVATE_SESSION_SKILL_TOOL_NAME,
    COMPLETE_SESSION_SKILL_TOOL_NAME,
    bootstrapSessionSkills,
    buildSessionSkillInjection,
    initialActivatedSkillIds,
    describePipelineState,
    describeStepMachineState,
} = require('../../core/sessionSkillRuntime');
const { resolveModelForTier } = require('../../core/modelResolver');
const { WORKSPACE_TOOLS } = require('../../integrations/workspaceTools');
const { BUILDER_TOOLS, isBuilderTool, executeBuilderTool } = require('../../integrations/webpageBuilderTools');
const { WEBPAGE_DB_TOOLS, isDbTool, executeDbTool } = require('../../integrations/webpageDbTools');
const { PROPOSE_WEBPAGE_PLAN_TOOL, executeProposeWebpagePlan } = require('../../integrations/webpagePlanTool');
const guardrailEventStore = require('../../stores/guardrailEventStore');
const { buildTokenPreservationAddendum } = require('../../core/dlp/tokenPreservationPrompt');
const { applyTokenMapToMessages } = require('../../core/dlp/applyTokenMapToOutbound');

/**
 * Strip bulky fields from tool results before they become LLM messages.
 * The full content is already sent via SSE to the frontend;
 * the LLM only needs the compact confirmation message.
 */
function compactToolResultForLLM(toolResult) {
    if (typeof toolResult !== 'object' || !toolResult) return toolResult;
    // For workspace_update results, only keep the message (strip full content)
    if (toolResult._action === 'workspace_update' && toolResult.message) {
        return { action: 'notebook_updated', message: toolResult.message };
    }
    return toolResult;
}
const { getIntegrationTools, buildToolHint } = require('../../core/integrationTools');
const { emitPhase, emitPhaseEnd, withPhase } = require('../../core/agentRuntime/phaseEvents');
const { getUserAuth } = require('../../utils/routeHelpers');
const { checkRegexPatterns } = require('../../core/guardrails');
const { checkSubscriptionLimits, resolveOrgId } = require('../../core/limits');
const { getServiceHeaders } = require('../../core/serviceAuth');

// ─── Default system prompt ──────────────────────────────────────────
// Used when no custom `direct_chat_system_prompt` is configured in admin.
// Covers identity, formatting, rich output, tool usage, and language.
const DEFAULT_SYSTEM_PROMPT = `You are BeeFlow — a fast, precise, and proactive AI assistant embedded in a professional productivity platform.

## Core Principles
- Lead with the answer. Put the conclusion, result, or recommendation first — then explain.
- Be concise. Avoid filler phrases, preambles ("Sure!", "Of course!"), and restating the question.
- Be thorough when asked. When the user requests deep analysis, research, or comprehensive output — deliver in full. Length is fine when it adds value.
- Prefer structured formatting (headings, bullets, tables, numbered steps) for clarity.
- When uncertain, say so honestly. Offer to search the web or check the user's knowledge base for verification.

## Formatting & Rich Output
You render full GitHub-Flavored Markdown including tables, task lists, and heading anchors.
You can also produce these special rich blocks using fenced code blocks with specific language tags:

### Code & Math
- **Code**: Fenced code blocks with language tags (e.g. \`\`\`python, \`\`\`javascript) for syntax highlighting.
- **Math**: LaTeX expressions — $...$ for inline, $$...$$ for block equations.

### Diagrams — \`\`\`mermaid
Use for flowcharts, sequence diagrams, ERDs, Gantt charts, pie charts, etc. Example:
\`\`\`mermaid
graph TD
  A[Start] --> B{Decision}
  B -->|Yes| C[Action]
  B -->|No| D[End]
\`\`\`

### Data Visualizations — \`\`\`vega-lite
Use for interactive charts (bar, line, scatter, heatmap, etc). Provide a complete Vega-Lite JSON spec. Include inline data or reference a URL. Example:
\`\`\`vega-lite
{"$schema":"https://vega.github.io/schema/vega-lite/v5.json","data":{"values":[{"x":"A","y":28},{"x":"B","y":55}]},"mark":"bar","encoding":{"x":{"field":"x"},"y":{"field":"y","type":"quantitative"}}}
\`\`\`

### Interactive Webpages — call create_webpage + webpage_file_*
IMPORTANT — capability boundary: YOU run server-side and have full access to every tool the user has enabled in this turn (Nextcloud, Google Drive, web search, file readers, etc.). The webpage you generate runs inside a sandboxed iframe in the user's browser and is what's restricted (no host cookies, no /api/* fetches from the page's JS). NEVER confuse the page's sandbox with your own capabilities — if the user asks "read invoices from Nextcloud and put them in the database", use the nextcloud_* + webpage_db_exec tools yourself. Do not refuse because "the page is sandboxed".

Use for calculators, interactive demos, visualizations, games, landing pages, dashboards, trackers, or any self-contained HTML+CSS+JS thing. Build the page in a single turn — DO NOT propose a plan first, just go straight to the tools. The flow:
  1. Call create_webpage({ name }) if the page doesn't exist yet → returns { webpageId, url }.
  2. If the app needs persistent data (records, lists, settings, anything that should survive a reload) → call webpage_db_exec({ webpageId, sql: "CREATE TABLE ..." }) to set up the schema BEFORE writing the JS. Seed initial rows with webpage_db_exec({ webpageId, sql: "INSERT INTO ...", params: [...] }). Use webpage_db_query / webpage_db_schema to inspect.
  3. Call webpage_file_write({ webpageId, file, content }) for each slot — html first, then css, then js. Use webpage_file_replace / webpage_file_patch for partial edits to existing pages.
  4. After the build (or a significant redesign), call webpage_set_metadata({ webpageId, icon, accent_color, tagline }) once to give the page a visual identity in the user's Webpages list. Pick a single emoji that fits the topic, an accent hex matching the page's primary colour, and a ≤80-char tagline.
  5. End your reply with: "I built it: [<title>](<url>)" — the user can click to open the editor and refine it further.

Persistence — when the user says "database", "save", "remember", "persist", or describes anything multi-row (invoices, contacts, tasks, fuel logs…), use the SQLite DB. The running script.js talks to it via a pre-injected client — no setup needed by you:

  await window.beeflowDB.query("SELECT * FROM rows WHERE id = ?", [id]);   // SELECT only
  await window.beeflowDB.exec("INSERT INTO rows (a,b) VALUES (?,?)", [1,2]); // INSERT/UPDATE/DELETE
  await window.beeflowDB.schema();                                          // inspect at runtime

Each call returns a Promise. Use ? placeholders — never interpolate user values into SQL. Do NOT try to load sql.js from a CDN; the DB is server-side and survives reloads automatically. Do NOT use parent-page cookies or the host app's localStorage — use the DB.

Vanilla HTML/CSS/JS only. CDN <script> tags inside the HTML are fine. The preview iframe is sandboxed (allow-scripts, no same-origin).
DO NOT emit \`\`\`html-app\`\`\` code blocks — they no longer render. Always use create_webpage + webpage_file_write instead.

### Quotes / Proposals — \`\`\`quote
Use for professional business quotes, proposals, or offer documents. Provide a JSON object with:
- title, subtitle (strings)
- sections[] — ordered array of section objects. Section types: "specs" (key-value items), "description" (features with bullets), "phases" (timeline with actions/deliverables), "pricing" (subsections with items), "legal"/"terms" (terms and conditions), "signature" (signature boxes).
Company branding is auto-applied from organisation settings. The quote renders as a printable PDF-ready document.

### Research Reports — \`\`\`json-research
Use for deep-dive research outputs with visual structure. Provide a JSON object with:
- title (string)
- blocks[] — ordered array of typed blocks:
  - "hero": Title banner (title, subtitle?, image?, date?)
  - "markdown"/"text": Rich text content (content field, supports full Markdown)
  - "stats": Key metric cards (items[]: {value, label, color?}) — max 4
  - "callout": Highlighted boxes (variant: "info"|"warning"|"success"|"tip", title?, content)
  - "columns": Multi-column layout (children[], max 3 columns)
  - "section": Titled wrapper (title, children[])
  - "sources": Collapsible reference links (items[]: {url, title?})
  - "image": Standalone image (src/url, caption?, credit?)
  - "divider": Horizontal separator
Best practices: Start with hero, surface key stats early, group content in sections, end with sources.

## Tool Usage
Do NOT describe what you *could* do — just do it. When a user requests an action you have a tool for — call it immediately. Only ask for clarification when critical parameters are genuinely ambiguous.

**Images**: When asked to generate, create, or draw an image, call generate_image immediately. Describe the scene richly in the prompt.

**Audio & Music**: When asked to create music, songs, beats, or spoken audio, call the appropriate ElevenLabs tool (elevenlabs_music, elevenlabs_tts, elevenlabs_sfx). Audio plays inline automatically — do NOT try to embed audio links in your response text.

**Reminders**: When asked to be reminded about something, call set_reminder. Always use the timezone from the "Now:" line — never default to UTC.

**AI Tasks**: When the user wants recurring AI-generated content (news digests, email summaries, reports, or any scheduled AI action), call set_ai_task. Write a detailed, specific prompt that tells the AI exactly what to do each time the task runs. The task runs in the background and delivers results as notifications.

**Web Search**: When you need current information, facts you're unsure about, or real-time data, use the search tool proactively.

**Email**: When composing emails, always match the user's personal writing style and language if a style profile is available.

**Notebooks**: Only write to, edit, or modify the notebook when the user EXPLICITLY asks you to put something in it (e.g. "save this to the notebook", "schrijf dit in het notebook"). General requests to write/draft/summarise are NOT notebook requests — reply in chat. When the user has explicitly asked for a notebook edit, prefer partial edits (notebook_replace) over full rewrites (notebook_write), and always call notebook_read first to see the exact current content.

## Response Language
Always respond in the same language the user writes in. If the user writes in Dutch, respond in Dutch. If in English, respond in English. Match their language exactly — do not switch unless explicitly asked.`;

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Streaming Direct Chat ───────────────────────────────────────

router.post('/chat/direct/stream', requireAuth, async (req, res) => {
    const { message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings, disabledMedia, webSearchEnabled = true, notebookspaceContent, notebookspaceSelection, notebookspaceAvailable, sidePanelWebpage, projectId, timezone, systemPrompt: requestSystemPrompt, activeSkillIds, reasoningEffort: requestReasoningEffort, sessionSkills: requestSessionSkills, activatedSessionSkillIds: requestActivatedSessionSkillIds, knowledgeBaseIds: requestedKbIds, swarmOptions: requestedSwarmOptions, planExecution: webpagePlanExecution } = req.body;
    const userId = req.session.user.id;

    if (!message && (!attachments || attachments.length === 0)) {
        return res.status(400).json({ error: 'Message or attachments required' });
    }

    // ─── Swarm tier branch ─────────────────────────────────────────
    // When the user picked the "Swarm" tier in the model dropdown, the entire
    // turn runs through the swarm runtime. Each worker uses the SAME tool
    // stack as a regular direct-chat call (components + integrations + MCP),
    // so research workers can hit web search, KB, gmail, drive, calendar,
    // notebook, custom components — anything the user has wired up.
    // The synthesiser worker streams its tokens as ordinary `content` events
    // so the existing chat renderer handles the answer with no special UI.
    if (modelTier === 'swarm') {
        const { runSwarmTurn, loadSwarmById } = require('../../core/swarms/swarmRuntime');
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        const { resolveModelForTier: resolveSwarmTierModel } = require('../../core/modelResolver');

        // Beta gate (defensive — `tiers-for-user` already hides the Swarm
        // tier from the dropdown when this feature is off, but never trust
        // the client).
        const allowed = await userHasBetaFeature(userId, 'swarm', req.session).catch(() => false);
        if (!allowed) {
            return res.status(403).json({ error: 'Swarm Agents beta is not enabled for your organisation.' });
        }
        const swarmId = 'builtin:research_swarm';
        const swarmEntry = loadSwarmById(swarmId);
        if (!swarmEntry) {
            return res.status(500).json({ error: `Swarm runtime is misconfigured: ${swarmId} not registered.` });
        }

        // Resolve the Swarm tier's configured model (used as a fallback
        // any time a worker's tier doesn't resolve to a specific model).
        let fallbackModelId = null;
        let userOrgId = null;
        try {
            // Need the user's org for EU-aware resolution. Resolve it cheaply
            // here — we don't need the full Flow tier-resolution dance.
            const userStoreLocal = require('../../stores/userStore');
            const localUser = await userStoreLocal.getUser(userId).catch(() => null);
            userOrgId = localUser?.organizationId || null;
            fallbackModelId = await resolveSwarmTierModel('tier:swarm', { userOrgId, userId, fallbackTier: 'fast' });
        } catch (e) {
            console.warn('[DirectChat/Swarm] tier model resolution failed:', e.message);
        }
        if (!fallbackModelId) {
            return res.status(400).json({ error: 'No model is configured for the Swarm tier. Ask an admin to set one in Chat Model Tiers → Swarm (Direct).' });
        }

        // SSE handshake (mirror of the block further down for the regular
        // direct-chat path — kept inline so the swarm branch is self-contained).
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const send = (event, data) => {
            try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
        };

        // Load (or create) conversation + restore prior Hive Mind state.
        let convId = conversationId;
        let hiveMind = null;
        if (convId) {
            try {
                const existingConv = await agentStore.getDirectConversation(convId, userId);
                if (existingConv && existingConv.hiveMind && typeof existingConv.hiveMind === 'object') {
                    hiveMind = existingConv.hiveMind;
                }
            } catch (_) { /* ignore — proceed with fresh state */ }
        }

        try {
            const result = await runSwarmTurn({
                swarmId,
                message,
                hiveMind,
                send,
                userId,
                session: req.session,
                isAdmin: !!req.session?.isAdmin,
                fallbackModelId,
                userOrgId,
                resolvedTier: 'swarm',
                organizationId: userOrgId,
                conversationId: convId || null,
            });

            // Persist updated state on the conversation (best-effort; failure
            // here mustn't abort the response — the user already saw the answer).
            try {
                if (!convId) {
                    const created = await agentStore.createDirectConversation(userId, 'swarm');
                    convId = created?.id || null;
                    if (convId) send('conversation_created', { conversationId: convId });
                }
                if (convId) {
                    const existingConv = await agentStore.getDirectConversation(convId, userId);
                    const messages = Array.isArray(existingConv?.messages) ? [...existingConv.messages] : [];
                    if (!result.paused && typeof result.finalText === 'string' && result.finalText.length > 0) {
                        messages.push({
                            role: 'user',
                            content: message,
                            attachments: attachments || [],
                            timestamp: new Date().toISOString(),
                        });
                        messages.push({
                            role: 'assistant',
                            content: result.finalText,
                            metadata: { swarmId },
                            // Top-level `swarm` field mirrors what useChatEngine
                            // builds from SSE during a live run, so when the
                            // conversation reloads from DB the assistant message
                            // already has everything SwarmTimeline needs to
                            // re-render the worker grid + tool calls.
                            swarm: result.snapshot || null,
                            timestamp: new Date().toISOString(),
                        });
                    }
                    await agentStore.updateDirectConversation(convId, messages, userId, {
                        swarmId,
                        hiveMind: result.hiveMind,
                    });
                }
            } catch (persistErr) {
                console.warn('[DirectChat/Swarm] persist failed:', persistErr.message);
            }

            send('done', {});
            return res.end();
        } catch (err) {
            console.error('[DirectChat/Swarm] run failed:', err);
            send('error', { error: err.message || 'Swarm execution failed' });
            return res.end();
        }
    }
    // ───────────────────────────────────────────────────────────────

    // EU mode + org privacy shield: resolve user's org early
    const { resolveUserOrgIds: resolveOrgIdsForTiers } = require('../../auth');
    const userStore = require('../../stores/userStore');
    const { getEUAwareTiers, resolveModelForTier } = require('../../core/modelResolver');
    const orgIdsForTiers = await resolveOrgIdsForTiers(req);
    let userOrgForTiers = orgIdsForTiers && orgIdsForTiers.size > 0 ? Array.from(orgIdsForTiers)[0] : null;
    // resolveUserOrgIds returns null for super admins — look up from DB
    if (!userOrgForTiers) {
        try {
            const dbUser = await userStore.getUser(userId);
            if (dbUser?.organizationId) {
                userOrgForTiers = dbUser.organizationId;
            } else {
                // Check groups for org membership
                const groups = Array.isArray(dbUser?.groups) ? dbUser.groups : (() => { try { return JSON.parse(dbUser?.groups || '[]'); } catch(_) { return []; } })();
                if (groups.length > 0) {
                    const allGroups = await userStore.getAllGroups();
                    for (const gid of groups) {
                        const g = allGroups.find(gr => gr.id === gid);
                        if (g?.organizationId) { userOrgForTiers = g.organizationId; break; }
                    }
                }
            }
        } catch (_) {}
    }

    // Resolve model from tier config (EU-aware via centralized modelResolver)
    let tiers = await getEUAwareTiers({ userOrgId: userOrgForTiers, userId });
    // Merge custom tiers so 'custom:<slug>' tier IDs resolve through the same
    // tiers[resolvedTier] lookup below. Pulls both the global table AND the
    // user's org-scoped table — org overrides win on id collision.
    // Auto-classifier still only sees the standard tiers (see classifyTiers
    // below) so custom tiers can never be auto-selected — they must be
    // explicitly chosen by the user.
    try {
        const { isEUModeActive } = require('../../core/modelResolver');
        const { isEU } = await isEUModeActive({ userOrgId: userOrgForTiers, userId });
        const globalCustom = (await configStore.getConfig('custom_chat_model_tiers')) || [];
        const orgCustom = userOrgForTiers
            ? ((await configStore.getConfig(`custom_chat_model_tiers_org_${userOrgForTiers}`)) || [])
            : [];
        const byId = new Map();
        for (const t of (Array.isArray(globalCustom) ? globalCustom : [])) if (t?.id) byId.set(t.id, t);
        for (const t of (Array.isArray(orgCustom) ? orgCustom : [])) if (t?.id) byId.set(t.id, t);
        for (const t of byId.values()) {
            tiers[t.id] = {
                modelId: isEU && t.euModelId ? t.euModelId : t.modelId,
                label: t.label,
                icon: t.icon,
                description: t.description,
                maxTokens: t.maxTokens,
                temperature: t.temperature,
                reasoningEffort: t.reasoningEffort,
                reasoningSummary: t.reasoningSummary,
                custom: true,
            };
        }
    } catch (_) { /* fall through without custom tiers */ }
    let disableSearchOnUpload = false;
    let webSearchGuardPiiCategories = null;
    if (userOrgForTiers) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`);
        if (shield?.enabled) {
            if (shield.euModeEnabled) {
                console.log(`[DirectChat] EU mode active for org ${userOrgForTiers}`);
            }
            disableSearchOnUpload = !!shield.disableSearchOnUpload;
            if (disableSearchOnUpload) console.log(`[DirectChat] Org ${userOrgForTiers}: disableSearchOnUpload=true`);
            if (Array.isArray(shield.webSearchGuardPiiCategories) && shield.webSearchGuardPiiCategories.length > 0) {
                webSearchGuardPiiCategories = shield.webSearchGuardPiiCategories;
                console.log(`[DirectChat] Org ${userOrgForTiers}: webSearchGuardPiiCategories=${webSearchGuardPiiCategories.length} categories (monitoring${shield.webSearchGuardEnabled ? ' + blocking' : ' only'})`);
            }
        }
    }
    let resolvedTier = modelTier || 'fast';

    // Defensive gate: the Flow tier (key 'standard') requires BOTH:
    //   - `flow`   — the tier opt-in beta feature
    //   - `skills` — the runtime dependency (Flow bootstraps chat-local
    //                session skills; see session-skill setup at ~L1081-1238)
    // The frontend already hides the option when either is ungranted — this
    // just stops a hand-crafted request.
    if (resolvedTier === 'standard') {
        const { userHasBetaFeature } = require('../../core/betaFeatures');
        const [hasFlow, hasSkills] = await Promise.all([
            userHasBetaFeature(userId, 'flow', req.session).catch(() => false),
            userHasBetaFeature(userId, 'skills', req.session).catch(() => false),
        ]);
        if (!hasFlow || !hasSkills) {
            console.warn(`[DirectChat] User ${userId} requested Flow tier without required betas (flow=${hasFlow}, skills=${hasSkills}) — falling back to fast`);
            resolvedTier = 'fast';
        }
    }

    // Auto mode: classify which tier to use
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/promptClassifier');
            // Strip custom tiers — they require explicit user choice and must never
            // win automatic selection. Swarm is also excluded (auto must never
            // spend the cost of a multi-agent swarm without the user asking).
            // Flow (standard) IS eligible for auto, but the classifier is
            // instructed to reserve it for clear multi-stage tasks.
            const classifyTiers = Object.fromEntries(
                Object.entries(tiers).filter(([k]) => !k.startsWith('custom:') && k !== 'swarm')
            );
            const result = await classifyWithLLM(message, classifyTiers, { userOrgId: userOrgForTiers, userId });
            resolvedTier = result.tier;
            console.log(`[DirectChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            console.log(`[DirectChat] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = 'fast';
        }
    }

    // Vision override: images require a vision-capable model
    // Auto classifier only looks at text complexity — override to smart/vision tier
    if (attachments?.some(a => a.type?.startsWith('image/'))) {
        const visionTier = tiers['vision'] || tiers['smart'];
        if (visionTier?.modelId && resolvedTier !== 'vision' && resolvedTier !== 'smart') {
            const prevTier = resolvedTier;
            resolvedTier = tiers['vision'] ? 'vision' : 'smart';
            console.log(`[DirectChat] Image attached — overriding tier: ${prevTier} → ${resolvedTier} (${visionTier.modelId})`);
        }
    }

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;

    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model || 'mistral-small-latest';
    }

    // Resolve provider for this model
    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        console.error(`[DirectChat] Provider resolution failed for model "${modelId}":`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    let apiKey = config.apiKey;
    let apiUrl = (config.url || '').replace(/\/+$/, '');

    console.log(`[DirectChat] Provider: ${config.providerName || 'default'} (${adapter.name})`);
    console.log(`[DirectChat] Using model: ${modelId} (tier: ${resolvedTier}${modelTier === 'auto' ? ', auto-selected' : ''})`);

    // ── Subscription limit enforcement ──
    const limitOrgId = await resolveOrgId(req);
    const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
    if (limitError) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write(`event: error\ndata: ${JSON.stringify({ error: limitError })}\n\n`);
        return res.end();
    }

    // Set SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Emit on every turn so the "How I got this answer" panel always knows
    // which concrete model produced this reply, including for fixed tiers.
    // `fromAuto` distinguishes the case where the classifier picked the tier
    // (we want to show "Auto → Fast (gpt-5-mini)") from a user-pinned choice.
    send('model_selected', { tier: resolvedTier, modelId, fromAuto: modelTier === 'auto' });
    emitPhase(send, 'model_resolved', modelId);
    emitPhaseEnd(send, 'model_resolved');

    // Per-turn webpage builder read-set — shared across every webpage_file_*
    // call this turn so the read-before-edit guard can warn when an edit is
    // issued on a slot the AI never read.
    const webpageBuilderReadSlots = new Map();
    // Flips to true when the AI calls propose_webpage_plan — the chat handler
    // exits the tool loop after the current round so the user gets a chance to
    // approve before any files are touched.
    let webpagePlanProposedThisTurn = false;

    try {
        // Load tools enabled for this tier
        const allComponents = componentManager.getComponents();
        const tierToolsConfig = await configStore.getConfig('direct_chat_tier_tools');
        const enabledToolIds = tierToolsConfig && tierToolsConfig[resolvedTier];
        let directChatTools = allComponents
            .filter(c => {
                if (enabledToolIds) return enabledToolIds.includes(c.id);
                return c.definition?.directChatEnabled === true;
            })
            .map(c => {
                const inputDefs = c.definition?.inputs || {};
                const visibleInputs = Object.entries(inputDefs)
                    .filter(([, conf]) => {
                        if (typeof conf !== 'object') return true;
                        return !conf.secure && conf.default === undefined;
                    });
                return {
                    type: 'function',
                    function: {
                        name: c.id,
                        description: c.definition.description || c.definition.name || c.id,
                        parameters: {
                            type: 'object',
                            properties: visibleInputs.reduce((acc, [key, conf]) => {
                                acc[key] = {
                                    type: (typeof conf === 'object' ? conf.type : conf) || 'string',
                                    description: (typeof conf === 'object' ? conf.description : '') || ''
                                };
                                return acc;
                            }, {}),
                            required: visibleInputs
                                .filter(([, conf]) => typeof conf === 'object' && conf.required)
                                .map(([key]) => key)
                        }
                    }
                };
            });

        // Load integration tools via shared module. Wrapped in a phase so
        // the UI shows "Loading tools…" instead of a silent stall when a
        // user has many integrations and OAuth-token resolution is slow.
        emitPhase(send, 'loading_tools');
        const _toolsT = Date.now();
        const { tools: integrationToolsList, n8nOrgId } = await getIntegrationTools({
            userId,
            session: req.session,
            isAdmin: req.session?.isAdmin,
        });

        // Merge integration tools with component tools
        for (const tool of integrationToolsList) {
            if (!directChatTools.find(t => t.function.name === tool.function.name)) {
                directChatTools.push(tool);
            }
        }

        // ─── MCP tools injection ─────────────────────────────────────
        try {
            const mcpManager = require('../../core/mcpManager');
            let mcpTools = await mcpManager.getAllToolsAsOpenAI();
            // Gate MCP tools by org-level enabledIntegrations
            if (mcpTools.length > 0) {
                let orgEnabled = null;
                try {
                    const userStoreForMcp = require('../../stores/userStore');
                    const configStoreForMcp = require('../../stores/configStore');
                    const mcpUser = await userStoreForMcp.getUser(userId);
                    if (mcpUser?.organizationId) {
                        const mcpOrg = await userStoreForMcp.getOrganization(mcpUser.organizationId);
                        if (mcpOrg?.enabledIntegrations) {
                            orgEnabled = typeof mcpOrg.enabledIntegrations === 'string'
                                ? JSON.parse(mcpOrg.enabledIntegrations) : mcpOrg.enabledIntegrations;
                        } else {
                            const globalDefs = await configStoreForMcp.getConfig('default_org_integrations');
                            if (globalDefs) {
                                orgEnabled = typeof globalDefs === 'string' ? JSON.parse(globalDefs) : globalDefs;
                            }
                        }
                    }
                } catch (_) { /* ignore */ }
                if (orgEnabled) {
                    mcpTools = mcpTools.filter(t => {
                        const serverId = t._mcp?.serverId;
                        return !serverId || orgEnabled.includes(`mcp:${serverId}`);
                    });
                }
                for (const tool of mcpTools) {
                    if (!directChatTools.find(t => t.function.name === tool.function.name)) {
                        directChatTools.push(tool);
                    }
                }
                if (mcpTools.length > 0) console.log(`[DirectChat] 🔌 Loaded ${mcpTools.length} MCP tools`);
            }
        } catch (mcpErr) {
            console.warn('[DirectChat] Failed to load MCP tools:', mcpErr.message);
        }

        // ─── Built-in: set_reminder tool ────────────────────────────
        directChatTools.push({
            type: 'function',
            function: {
                name: 'set_reminder',
                description: 'Set a reminder for the user. Use this when the user asks to be reminded about something at a specific time. Returns confirmation with the reminder details. IMPORTANT: Use the timezone from the "Now:" line in the system prompt — do NOT use UTC/Z unless the user is in UTC.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Short title for the reminder' },
                        message: { type: 'string', description: 'Optional detailed message for the reminder' },
                        remind_at: { type: 'string', description: 'ISO 8601 datetime string for when to remind. MUST include the user\'s timezone offset from the system prompt (e.g. "2026-03-09T15:00:00+01:00" for CET). Do NOT use "Z" unless the user is in UTC. Use the current date/time context to calculate the correct time.' },
                        repeat_interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Optional repeat interval. Only set if user asks for recurring reminders.' },
                    },
                    required: ['title', 'remind_at'],
                },
            },
        });

        // ─── Built-in: set_ai_task tool ────────────────────────────
        directChatTools.push({
            type: 'function',
            function: {
                name: 'set_ai_task',
                description: 'Create a scheduled AI task that runs automatically at specified times. Use this when the user wants recurring AI-generated content like news summaries, reports, digests, or any automated information gathering. The task runs in the background using web search and delivers results as notifications. IMPORTANT: Write a detailed, specific prompt for the AI to execute. Use the timezone from the "Now:" line.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Short descriptive title (e.g., "Weekly AI News Digest")' },
                        prompt: { type: 'string', description: 'Detailed instruction for the AI to execute each time. Be specific about what to search, summarize, or analyze. Example: "Search for the most important AI and machine learning news from the past week. Provide a summary of the top 5 developments with source links."' },
                        repeat_interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'How often to run the task. Use daily for morning digests, weekly for weekly summaries, monthly for monthly reports.' },
                        first_run_at: { type: 'string', description: 'ISO 8601 datetime for the first execution. MUST include timezone offset from system prompt. For "every Monday at 8 AM" → calculate next Monday at 08:00 in user\'s timezone.' },
                        model_tier: { type: 'string', enum: ['fast', 'smart', 'thinking'], description: 'AI model quality tier. "fast" for simple lookups, "smart" for analysis, "thinking" for deep research. Default: fast.' },
                    },
                    required: ['title', 'prompt', 'repeat_interval', 'first_run_at'],
                },
            },
        });

        // Simple Mode strips the agent's toolbelt — same set we hide in the
        // shared integration tools loader. Notebooks + webpages must not be
        // injected here either since direct chat wires them up separately.
        const userSimpleMode = !!(await configStore.getConfig(`simple_mode_user_${userId}`));

        // ─── Built-in: workspace tools ────────────────────────────────
        // Only inject notebook tools if the feature is enabled
        const notebooksEnabled = (await configStore.getConfig('feature_notebooks_enabled')) !== false;
        if (!userSimpleMode && notebooksEnabled) {
            for (const wsTool of WORKSPACE_TOOLS) {
                if (!directChatTools.find(t => t.function.name === wsTool.function.name)) {
                    directChatTools.push(wsTool);
                }
            }
        }

        // ─── Built-in: webpage builder tools (gated on webpages beta) ─
        let webpageBetaEnabled = false;
        try {
            const { userHasBetaFeature: userHasWebpagesBetaForBuilder } = require('../../core/betaFeatures');
            webpageBetaEnabled = !userSimpleMode && await userHasWebpagesBetaForBuilder(userId, 'webpages', req.session);
            if (webpageBetaEnabled) {
                for (const tool of BUILDER_TOOLS) {
                    if (!directChatTools.find(t => t.function.name === tool.function.name)) {
                        directChatTools.push(tool);
                    }
                }
                // DB tools — the editor binds webpageId via the request URL, but
                // direct chat can target any webpage in the same turn, so we
                // require webpageId as an explicit arg on each call.
                for (const tool of WEBPAGE_DB_TOOLS) {
                    if (directChatTools.find(t => t.function.name === tool.function.name)) continue;
                    const params = tool.function.parameters || { type: 'object', properties: {}, required: [] };
                    const directTool = {
                        ...tool,
                        function: {
                            ...tool.function,
                            parameters: {
                                ...params,
                                properties: {
                                    webpageId: {
                                        type: 'string',
                                        description: 'The webpage ID returned by create_webpage (or referenced by the user).',
                                    },
                                    ...(params.properties || {}),
                                },
                                required: Array.from(new Set(['webpageId', ...(params.required || [])])),
                            },
                        },
                    };
                    directChatTools.push(directTool);
                }
                // No `propose_webpage_plan` in direct chat — the Approve/Reject
                // card lives in the Webpages editor's chat, not here. Without
                // that UI, planning would silently stall the conversation, so
                // we just go straight to create_webpage + webpage_file_write*.
                // Planning is preserved in /ai/chat/webpage/stream (editor) and
                // in the side-panel webpage chat which is routed there.
                console.log('[DirectChat] Webpage builder + db tools enabled for user');
            }
        } catch (builderErr) {
            console.warn('[DirectChat] Failed to check webpages beta for builder tools:', builderErr.message);
        }

        // Filter out user-disabled media tools
        if (disabledMedia && typeof disabledMedia === 'object') {
            const disabledToolNames = new Set();
            if (disabledMedia.image) disabledToolNames.add('generate_image');
            if (disabledMedia.music) disabledToolNames.add('generate_music');
            if (disabledMedia.video) disabledToolNames.add('generate_video');
            if (disabledMedia.elevenlabs) {
                disabledToolNames.add('elevenlabs_music');
                disabledToolNames.add('elevenlabs_tts');
                disabledToolNames.add('elevenlabs_sfx');
            }
            if (disabledToolNames.size > 0) {
                directChatTools = directChatTools.filter(t => !disabledToolNames.has(t.function.name));
                console.log(`[DirectChat] Disabled media tools: ${[...disabledToolNames].join(', ')}`);
            }
        }

        // Filter out web search tool if user disabled it
        if (webSearchEnabled === false) {
            directChatTools = directChatTools.filter(t => t.function.name !== 'agent_search');
            console.log('[DirectChat] Web search disabled by user');
        }

        // Filter out web search if org policy disables it on file uploads
        // Check both current attachments AND past messages in this conversation
        if (disableSearchOnUpload) {
            const hasCurrentAttachments = attachments && attachments.length > 0;
            // Check conversation history for past file uploads
            const hasHistoryAttachments = history && Array.isArray(history) && history.some(m => m.attachments && m.attachments.length > 0);
            if (hasCurrentAttachments || hasHistoryAttachments) {
                directChatTools = directChatTools.filter(t => t.function.name !== 'agent_search');
                console.log(`[DirectChat] Web search disabled — ${hasCurrentAttachments ? 'current files attached' : 'files in conversation history'} (org policy)`);
            }
        }

        emitPhaseEnd(send, 'loading_tools', Date.now() - _toolsT);

        // ─── Per-turn Notebook strip ─────────────────────────────────
        // System prompt at L907-917 steers Claude toward `notebook_write`
        // when output looks long. With Privacy Shield tokenisation a PDF
        // answer easily looks long — even a short user question like
        // "what is in the file?" then triggers a tool-only response (no
        // chat text), which the user perceives as "Error generating response".
        // Strip notebook_* tools from THIS turn's tool list when the shape
        // is "attachment present + short content-question prompt". Users
        // who genuinely want a notebook-write include verbs like
        // write/save/note/memo/draft/brief/report and bypass the strip.
        const _hasAttachmentThisTurn = Array.isArray(attachments) && attachments.length > 0;
        const _msgIsShortQuestion = typeof message === 'string' && message.length < 80;
        const _msgHasWriteIntent = typeof message === 'string' && /(write|save|note|memo|draft|brief|report)/i.test(message);
        const stripsNotebookTools = _hasAttachmentThisTurn && _msgIsShortQuestion && !_msgHasWriteIntent;
        if (stripsNotebookTools) {
            const before = directChatTools.length;
            directChatTools = directChatTools.filter(t => !/^notebook_/.test(t.function?.name || ''));
            console.log(`[DirectChat] Notebook tools stripped for attachment-Q&A turn (${before} → ${directChatTools.length} tools)`);
        }

        // Build messages array
        emitPhase(send, 'building_prompt');
        const _spT = Date.now();
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const customPrompt = await configStore.getConfig('direct_chat_system_prompt');
        let systemPromptText = customPrompt || DEFAULT_SYSTEM_PROMPT;
        // Strip notebook instructions from prompt when feature is disabled
        if (!notebooksEnabled) {
            systemPromptText = systemPromptText.replace(/\n*When the user has a notebook open[^\n]*\n*/g, '\n');
        }
        const basePrompt = (requestSystemPrompt ? requestSystemPrompt + '\n\n' : '')
            + systemPromptText
            + `\n\nToday is ${today}.`;

        // Build explicit integration hints so the AI knows what tools it has
        const toolHint = await buildToolHint(directChatTools, userId);

        // ─── Project context injection ───────────────────────────────
        let projectContext = '';
        let extractMemoriesEnabled = false;
        if (projectId) {
            try {
                const projectStore = require('../../stores/projectStore');
                const project = await projectStore.getProject(projectId);
                if (project) {
                    // Validate user has access to this project
                    const hasAccess = await projectStore.userHasAccess(userId, projectId);
                    if (!hasAccess) {
                        console.warn(`[DirectChat] User ${userId} has no access to project ${projectId}, skipping project context`);
                    } else {
                        extractMemoriesEnabled = project.extractMemories === true;
                        // Inject custom instructions
                        if (project.customInstructions && project.customInstructions.trim()) {
                            projectContext += `\n\n[PROJECT INSTRUCTIONS — "${project.name}"]\n${project.customInstructions}`;
                        }
                        // Search project knowledge bases
                        const kbIds = project.knowledgeBaseIds || [];
                        if (kbIds.length > 0) {
                            try {
                                const { quickKBSearch } = require('../../core/agentRuntime/knowledgeSearch');
                                const kbResults = await quickKBSearch(userId, kbIds, message, { topK: 6, session: req.session });

                                if (kbResults.length > 0) {
                                    const kbText = kbResults.map((c, i) => {
                                        const src = c.source_uri || c.title || 'KB';
                                        return `### Source ${i + 1}: ${src}\n${c.content}`;
                                    }).join('\n\n');
                                    projectContext += `\n\n[PROJECT KNOWLEDGE BASE — "${project.name}"]\nRelevant information from this project's knowledge base:\n${kbText}`;
                                    console.log(`[DirectChat] Injected ${kbResults.length} KB chunks from project "${project.name}"`);
                                }
                            } catch (kbErr) {
                                console.warn('[DirectChat] Project KB search failed:', kbErr.message);
                            }
                        }
                    }
                }
            } catch (projErr) {
                console.warn('[DirectChat] Project context failed:', projErr.message);
            }
        }

        // ─── Direct-chat attached KBs ───────────────────────────────
        // User picked KBs via the input-area picker. Validate access (owner,
        // super-admin, or org-published + group-allowed) before searching.
        if (Array.isArray(requestedKbIds) && requestedKbIds.length > 0) {
            try {
                const kbStore = require('../../stores/knowledgeBases');
                const userGroupsRaw = (await userStore.getUser(userId))?.groups;
                const userGroups = Array.isArray(userGroupsRaw)
                    ? userGroupsRaw
                    : (() => { try { return JSON.parse(userGroupsRaw || '[]'); } catch (_) { return []; } })();
                const userOrgIds = orgIdsForTiers; // null = super admin
                const isSuperAdmin = userOrgIds === null;

                const accessibleKbIds = [];
                for (const kbId of requestedKbIds) {
                    const kb = await kbStore.getKB(kbId);
                    if (!kb) continue;
                    if (kb.tenant_id === userId || isSuperAdmin) { accessibleKbIds.push(kb.id); continue; }
                    if (kb.organization_id && userOrgIds && userOrgIds.has(kb.organization_id) && kb.is_published) {
                        let groups = [];
                        try { groups = JSON.parse(kb.shared_groups || '[]'); } catch { groups = []; }
                        if (!Array.isArray(groups) || groups.length === 0 || groups.some(g => userGroups.includes(g))) {
                            accessibleKbIds.push(kb.id);
                        }
                    }
                }

                if (accessibleKbIds.length > 0) {
                    const { quickKBSearch } = require('../../core/agentRuntime/knowledgeSearch');
                    const kbResults = await quickKBSearch(userId, accessibleKbIds, message, { topK: 6, session: req.session });
                    if (kbResults.length > 0) {
                        const kbText = kbResults.map((c, i) => {
                            const src = c.source_uri || c.title || 'KB';
                            return `### Source ${i + 1}: ${src}\n${c.content}`;
                        }).join('\n\n');
                        projectContext += `\n\n[ATTACHED KNOWLEDGE BASES]\nRelevant information from the knowledge bases attached to this chat:\n${kbText}`;
                        console.log(`[DirectChat] Injected ${kbResults.length} KB chunks from ${accessibleKbIds.length} attached KBs`);
                    }
                }
                if (accessibleKbIds.length < requestedKbIds.length) {
                    console.warn(`[DirectChat] User ${userId} requested ${requestedKbIds.length} KBs but only ${accessibleKbIds.length} were accessible`);
                }
            } catch (kbErr) {
                console.warn('[DirectChat] Direct-chat KB search failed:', kbErr.message);
            }
        }

        // ─── Memory injection ────────────────────────────────────────
        let memoryContext = '';
        try {
            const memoryStore = require('../../stores/memoryStore');
            // Always pass projectId for retrieval (project memories should be available regardless of extractMemories flag)
            const relevantMemories = await memoryStore.findRelevantMemories(userId, null, message, 800, projectId || null);
            if (relevantMemories.length > 0) {
                memoryContext = '\n\n' + memoryStore.formatMemoriesForPrompt(relevantMemories);

                // Defence in depth: scrub PII out of the memory context before
                // it reaches the LLM. Stored memories can contain real values
                // from earlier turns that would otherwise bypass this turn's
                // tokeniser. We replace with generic labels (non-reversible)
                // so the AI can't reconstruct the underlying data.
                try {
                    // Resolve the user's org locally — the outer-scope
                    // `userOrgId` const is only declared further down (≈line
                    // 1560), so referencing it here would hit the TDZ.
                    let scrubOrgId = null;
                    try {
                        const userStoreLocal = require('../../stores/userStore');
                        const localUser = await userStoreLocal.getUser(userId).catch(() => null);
                        scrubOrgId = localUser?.organizationId || null;
                    } catch { /* best-effort */ }
                    const orgShieldForScrub = scrubOrgId
                        ? await configStore.getConfig(`org_privacy_shield_${scrubOrgId}`)
                        : null;
                    // Shield's master flag is the only switch for PII scrubbing;
                    // detectPii() routes to whichever backend is available.
                    const scrubEnabled = !!orgShieldForScrub?.enabled
                        || !!(await getAIConfig())?.piiDetectionEnabled;
                    if (scrubEnabled) {
                        const { scrubMemoryContext } = require('../../core/memory/scrubMemoryContext');
                        const { scrubbed, replacedCategories } = await scrubMemoryContext(memoryContext, orgShieldForScrub);
                        if (replacedCategories.length > 0) {
                            console.log(`[DirectChat] 🧹 Scrubbed memory context: ${replacedCategories.join(', ')}`);
                            memoryContext = scrubbed;
                        }
                    }
                } catch (scrubErr) {
                    console.warn('[DirectChat] Memory scrub failed (fail-open):', scrubErr.message);
                }
            }
        } catch (e) {
            console.warn('[DirectChat] Memory retrieval failed:', e.message);
        }

        // ─── House style awareness ──────────────────────────────────
        // When the org has a default kantoorstijl, tell the model so it can
        // match tone — actual formatting is applied at Notebook export time.
        let houseStyleContext = '';
        try {
            if (userOrgForTiers) {
                const houseStyleStore = require('../../stores/houseStyleStore');
                const houseStyle = await houseStyleStore.getDefaultForOrg(userOrgForTiers);
                if (houseStyle) {
                    const tone = houseStyle.styleMeta?.toneDescription;
                    houseStyleContext = `\n\n[HOUSE STYLE ACTIVE]\nOrg Word/DOCX kantoorstijl "${houseStyle.name}" wordt automatisch toegepast bij export naar .docx${houseStyle.description ? ` — ${houseStyle.description}` : ''}.${tone ? ` Tone of voice: ${tone}.` : ''} Schrijf documenten in het Notebook in Markdown — opmaak wordt bij export geregeld; geen inline styling nodig.`;
                }
            }
        } catch (e) {
            console.warn('[DirectChat] house style lookup failed:', e.message);
        }

        // ─── Notebook context injection ─────────────────────────────
        // Two flags from the client:
        //   - notebookspaceAvailable: the Notebook panel exists in this UI
        //     (may be closed). Tells the model the tools are usable; calling
        //     notebook_write auto-opens the panel via the workspace_update SSE.
        //   - notebookspaceContent: the panel is currently open. `undefined`
        //     means closed; `""` is "open but blank".
        let notebookspaceContext = '';
        if (notebooksEnabled && notebookspaceAvailable) {
            notebookspaceContext = `\n\n[NOTEBOOK CAPABILITY]
A Notebook panel is available in the user's UI. Tools:
- notebook_read: Read content. Modes: "outline" (default—headings+stats), "section" (one section by heading), "search" (find text), "full" (entire doc). Use outline first, then section/search for targeted access.
- notebook_write: Replace ALL content (for new documents or full rewrites). Write in Markdown.
- notebook_replace: Replace a SPECIFIC portion (find_text + replace_text). Preferred for partial edits.
- notebook_insert: Add content at "start", "end", or "after" a heading.

CRITICAL — WHEN TO WRITE TO THE NOTEBOOK:
- Only call notebook_write, notebook_replace, or notebook_insert when the user has EXPLICITLY asked you to put something in the notebook (e.g. "save this to the notebook", "schrijf dit in het notebook", "zet in mijn notitie", "add to the document", "write the report in the notebook", "noteer dit", "draft a letter in the notebook").
- Mere requests to "write", "draft", "summarise", "translate", "rewrite", "explain", or produce long-form content are NOT a notebook request — reply in chat instead. The user will explicitly ask if they want it in the notebook.
- If unsure whether the user wants the output in the notebook, do NOT write to it. Reply in chat and ask, or just answer in chat.
- The notebook is the user's document — never overwrite, append to, or modify it without an explicit instruction to do so.

When you DO use a notebook tool (after an explicit request), do NOT also write the document text in your chat reply. Acknowledge briefly (one short sentence) and stop — the user reads the result in the Notebook panel. Use Markdown inside the notebook for headings, bold, tables, lists, code blocks.`;
        }
        if (notebooksEnabled && notebookspaceContent !== undefined) {
            notebookspaceContext += `\n\n[NOTEBOOK OPEN]
The Notebook panel is currently open. Current rules for edits: 1) Before notebook_replace, use notebook_read mode="search" or mode="section" to get exact text. 2) Copy find_text EXACTLY from read output. 3) For partial edits always prefer notebook_replace over notebook_write. 4) After any notebook tool call, your chat reply is at most one short confirmation sentence — do not repeat the new or modified content.`;
            if (notebookspaceSelection && notebookspaceSelection.trim()) {
                notebookspaceContext += `\n\n[SELECTED TEXT IN NOTEBOOK]\nThe user selected this text:\n\`\`\`\n${notebookspaceSelection}\n\`\`\`\nUse notebook_replace with find_text set to EXACTLY this text. Set replace_text to the new version.`;
            }
        }

        // ─── Side-panel webpage awareness ────────────────────────
        // The user has a webpage open in the right-side panel. Resolve its
        // latest content from storage and inject it into the prompt so the
        // AI can answer questions about "this page" / "deze pagina".
        if (sidePanelWebpage?.id) {
            try {
                const { buildSidePanelWebpageContext } = require('../../core/sidePanelWebpageContext');
                const block = await buildSidePanelWebpageContext(sidePanelWebpage, userId);
                if (block) notebookspaceContext += block;
            } catch (e) {
                console.warn('[DirectChat] sidePanelWebpage injection failed:', e.message);
            }
        }

        // ─── Skills injection ────────────────────────────────────
        // Static skills inject their full body into skillsContext. Dynamic
        // skills inject only a manifest line and add an `activate_skill` tool
        // to directChatTools so the model can pull the full body on demand.
        let skillsContext = '';
        try {
            const { buildSkillInjection } = require('../../core/skillInjection');
            const skillInjection = await buildSkillInjection({
                sessionSkillIds: Array.isArray(activeSkillIds) ? activeSkillIds : [],
                attachedSkillIds: [], // direct chat has no agent => no attached skills
                orgId: userOrgForTiers,
                userId,
            });
            if (skillInjection.systemPromptAddendum) {
                skillsContext = skillInjection.systemPromptAddendum;
                console.log(`[DirectChat] Skills: ${skillInjection.staticCount} static, ${skillInjection.dynamicSkillIds.length} dynamic`);
            }
            for (const t of skillInjection.tools) directChatTools.push(t);
        } catch (skillErr) {
            console.warn('[DirectChat] Skills injection failed:', skillErr.message);
        }

        // Build Now: with explicit UTC offset so the AI knows the user's local time
        const _tz = timezone || 'Europe/Amsterdam';
        let _nowStr;
        try {
            const _now = new Date();
            const _datePart = _now.toLocaleString('sv-SE', { timeZone: _tz });
            const _localParts = new Date(_now.toLocaleString('en-US', { timeZone: _tz }));
            const _offsetMin = Math.round((_localParts - _now) / 60000);
            const _sign = _offsetMin >= 0 ? '+' : '-';
            const _absOff = Math.abs(_offsetMin);
            const _offStr = `${_sign}${String(Math.floor(_absOff / 60)).padStart(2, '0')}:${String(_absOff % 60).padStart(2, '0')}`;
            _nowStr = `${_datePart} UTC${_offStr} (${_tz})`;
        } catch (_) {
            _nowStr = new Date().toISOString();
        }

        // System prompt is split into two messages so per-provider caching
        // can place a long-lived breakpoint on the stable portion. The
        // timestamp is genuinely volatile (changes every second) and would
        // poison any cache that includes it.
        //   1. stable: identity / tool hint / memory / project / notebook / skills
        //   2. volatile: the current timestamp
        // Providers that join system messages (Gemini, OpenAI Responses) still
        // see the same effective prompt; Claude's extractSystem emits per-
        // message blocks with the right cache_control on the stable one.
        emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);
        let messages = [
            { role: 'system', content: basePrompt + toolHint + memoryContext + houseStyleContext + notebookspaceContext + projectContext + skillsContext },
            { role: 'system', content: `Now: ${_nowStr}` },
        ];

        // Plan-execution turn: the user clicked Approve & build on a previously
        // proposed webpage plan. Inject an authorisation so the AI proceeds
        // straight to webpage_file_* / create_webpage without proposing a new
        // plan. The propose_webpage_plan tool is also stripped from the
        // toolset above when webpagePlanExecution is set.
        if (webpagePlanExecution && webpagePlanExecution.action === 'execute' && webpagePlanExecution.planId) {
            messages.push({
                role: 'system',
                content: `The user APPROVED your previously proposed webpage plan (planId=${webpagePlanExecution.planId}). Execute it now using create_webpage / webpage_file_write / webpage_file_replace / webpage_file_patch. Do NOT call propose_webpage_plan again — the plan is already locked in.`,
            });
        }

        // Add conversation history — preserve the `attachments` sidecar so the
        // hydrator below can rebuild multimodal content (images stay visible
        // across turns). Stripping sidecar fields here is what used to cause
        // the AI to "lose" uploaded images one turn after the upload.
        //
        // Source-of-truth rule:
        //   - If the client sent `history` in the body, use it. This covers
        //     brand-new conversations (no DB row yet) and edit/retry flows
        //     where the client has truncated history before the edit point.
        //   - If `history` is missing/empty AND we have a conversationId,
        //     fall back to the persisted message rows. This eliminates the
        //     class of bugs where the client's in-memory history drifts from
        //     the durable record (e.g. tool messages stripped, page reload).
        let resolvedHistory = Array.isArray(history) ? history : null;
        if ((!resolvedHistory || resolvedHistory.length === 0) && conversationId) {
            try {
                // restore:false — keep [email_N] tokens in the history we
                // hand to Claude on follow-up turns so PII never re-leaks
                // into the model context. UI fetch paths still default to
                // restore:true so users see their original values.
                const persisted = await agentStore.getDirectConversation(conversationId, userId, { restore: false });
                if (persisted && Array.isArray(persisted.messages) && persisted.messages.length > 0) {
                    resolvedHistory = persisted.messages;
                    console.log(`[DirectChat] No client history — loaded ${resolvedHistory.length} persisted messages from DB`);
                }
            } catch (loadErr) {
                console.warn('[DirectChat] Failed to load persisted history:', loadErr.message);
            }
        }
        if (resolvedHistory && resolvedHistory.length > 0) {
            for (const msg of resolvedHistory) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    const entry = { role: msg.role, content: msg.content };
                    if (Array.isArray(msg.attachments) && msg.attachments.length > 0) {
                        entry.attachments = msg.attachments;
                    }
                    messages.push(entry);
                }
            }
            try {
                const { hydrateHistoryAttachments } = require('../../core/agentRuntime/historyHydrator');
                await hydrateHistoryAttachments(messages, { userId, skipLast: false });
            } catch (hydrateErr) {
                console.warn('[DirectChat] History hydration failed:', hydrateErr.message);
            }
        }

        let convId = conversationId;
        let lastResponseId = null; // OpenAI Responses API chaining
        let conversationSummary = null; // Compaction summary
        let hasDocumentAttachment = false;
        const isStandardTier = resolvedTier === 'standard';
        let sessionSkills = [];
        let activatedSessionSkillIds = [];
        // Step-machine state: completion is explicit (not derived from
        // activation). LLM calls `complete_session_skill` to advance. Without
        // this distinction, "active" and "done" collapse and the pipeline
        // can't tell whether a step is still being worked on or finished.
        let completedSessionSkillIds = [];
        let sessionSkillsCompletions = [];   // [{ skillId, skillName, summary, order, total, at }]
        let bootstrappedSessionSkills = false;

        // Load metadata from existing conversation
        if (convId) {
            try {
                const existingConv = await agentStore.getDirectConversation(convId, userId);
                if (existingConv) {
                    // Load compaction summary
                    if (existingConv.conversationSummary) {
                        conversationSummary = existingConv.conversationSummary;
                    }
                    // Load OpenAI response chaining ID (model-specific)
                    if (config.providerType === 'openai' && existingConv.lastResponseId) {
                        if (existingConv.lastResponseModel === modelId) {
                            lastResponseId = existingConv.lastResponseId;
                            console.log('[DirectChat] Loaded lastResponseId:', lastResponseId);
                        } else {
                            console.log('[DirectChat] Model changed, invalidating lastResponseId');
                        }
                    }
                    // Check DB messages for past file uploads (disableSearchOnUpload policy)
                    if (disableSearchOnUpload && existingConv.messages?.some(m => m.attachments && m.attachments.length > 0)) {
                        directChatTools = directChatTools.filter(t => t.function.name !== 'agent_search');
                        console.log('[DirectChat] Web search disabled — files found in conversation history DB (org policy)');
                    }
                    if (Array.isArray(existingConv.sessionSkills)) {
                        sessionSkills = existingConv.sessionSkills;
                    }
                    if (Array.isArray(existingConv.activatedSessionSkillIds)) {
                        activatedSessionSkillIds = existingConv.activatedSessionSkillIds;
                    }
                    if (Array.isArray(existingConv.completedSessionSkillIds)) {
                        completedSessionSkillIds = existingConv.completedSessionSkillIds;
                    }
                    if (Array.isArray(existingConv.sessionSkillsCompletions)) {
                        sessionSkillsCompletions = existingConv.sessionSkillsCompletions;
                    }
                }
            } catch (e) { /* ignore */ }
        }
        // Client-side fallback: if a direct conversation id is not yet synced
        // (race between new message and SSE conversation_created), reuse
        // chat-local session skills from request payload to avoid regenerating.
        if (isStandardTier && sessionSkills.length === 0 && Array.isArray(requestSessionSkills) && requestSessionSkills.length > 0) {
            sessionSkills = requestSessionSkills;
            activatedSessionSkillIds = Array.isArray(requestActivatedSessionSkillIds) ? requestActivatedSessionSkillIds : [];
            console.log(`[DirectChat] Reused ${sessionSkills.length} session skills from request payload`);
        }

        // Forced bootstrap for the direct-chat-only standard tier:
        // each conversation starts by generating its own chat-local skill set.
        if (isStandardTier && sessionSkills.length === 0) {
            // Tell the UI we're spending some time before the first reply
            // token arrives so it can show a "Preparing chat-local skills…"
            // status instead of looking frozen.
            send('session_skills_bootstrap_started', {});

            // Use a cheaper/faster model for the bootstrap pass when the admin
            // configured tier.bootstrapModelId. Falls back to the main tier
            // model if unset or if the cheap model fails provider resolution.
            let bootstrapModelId = modelId;
            let bootstrapAdapter = adapter;
            let bootstrapApiKey = apiKey;
            let bootstrapApiUrl = apiUrl;
            let bootstrapApiVersion = config.apiVersion || undefined;
            if (tier.bootstrapModelId && tier.bootstrapModelId !== modelId) {
                try {
                    const bConfig = await getProviderForModel(tier.bootstrapModelId);
                    bootstrapAdapter = getAdapter(bConfig.providerType, (bConfig.url || '').replace(/\/+$/, ''));
                    bootstrapApiKey = bConfig.apiKey;
                    bootstrapApiUrl = (bConfig.url || '').replace(/\/+$/, '');
                    bootstrapApiVersion = bConfig.apiVersion || undefined;
                    bootstrapModelId = tier.bootstrapModelId;
                    console.log(`[DirectChat] Bootstrap using cheap model: ${bootstrapModelId} (main tier: ${modelId})`);
                } catch (bErr) {
                    console.warn(`[DirectChat] Bootstrap model "${tier.bootstrapModelId}" unavailable, falling back to "${modelId}":`, bErr.message);
                }
            }

            // Pull lightweight user/org context so the bootstrap can tailor
            // language and tone. Best-effort — failures are non-fatal.
            let userContext = null;
            try {
                const userStore = require('../../stores/userStore');
                const u = await userStore.getUser(userId);
                if (u) {
                    userContext = {
                        language: u.language || u.locale || (req.session?.user?.language) || null,
                        role: u.orgRole || u.role || null,
                    };
                    if (u.organizationId) {
                        const org = await userStore.getOrganization(u.organizationId);
                        if (org) {
                            userContext.orgName = org.name || null;
                            userContext.orgTagline = org.tagline || null;
                        }
                    }
                }
            } catch (ctxErr) {
                console.warn('[DirectChat] Bootstrap userContext lookup failed:', ctxErr.message);
            }

            try {
                sessionSkills = await bootstrapSessionSkills({
                    adapter: bootstrapAdapter,
                    apiKey: bootstrapApiKey,
                    apiUrl: bootstrapApiUrl,
                    modelId: bootstrapModelId,
                    message: message || '[No text message provided]',
                    timezone: timezone || 'UTC',
                    apiVersion: bootstrapApiVersion,
                    userContext,
                });
                // Auto-activate step-1 skills so their full bodies land in the
                // first-turn system prompt. Without this the AI tends to answer
                // from the short manifest and the pipeline has no effect.
                activatedSessionSkillIds = initialActivatedSkillIds(sessionSkills);
                bootstrappedSessionSkills = true;
                send('session_skills_bootstrapped', {
                    count: sessionSkills.length,
                    skills: sessionSkills,
                    activatedSkillIds: activatedSessionSkillIds,
                });
                console.log(`[DirectChat] Session skills bootstrapped: ${sessionSkills.length} (step-1 auto-activated: ${activatedSessionSkillIds.length})`);
            } catch (bootstrapErr) {
                console.warn('[DirectChat] Session skill bootstrap failed:', bootstrapErr.message);
                // Hard fallback so Standard tier always has at least one
                // chat-local skill even if provider bootstrap fails.
                sessionSkills = [{
                    id: `sess_fallback_${Date.now()}`,
                    name: 'General Assistant Workflow',
                    description: 'Use a concise, execution-first workflow for this chat.',
                    instructions: 'Answer directly, structure output clearly, and execute requested tasks without filler.',
                    workflow: 'Understand intent -> perform actions/tools -> verify -> return concise result.',
                    rules: 'Prefer actionable outputs, include assumptions when uncertain, keep language aligned with user.',
                    examples: 'For research requests, gather current facts first, then synthesize in requested format.',
                    order: 1,
                    dependsOn: [],
                    dynamicActivation: true,
                }];
                activatedSessionSkillIds = initialActivatedSkillIds(sessionSkills);
                bootstrappedSessionSkills = true;
                send('session_skills_bootstrapped', {
                    count: sessionSkills.length,
                    skills: sessionSkills,
                    activatedSkillIds: activatedSessionSkillIds,
                });
            }
        }

        // Inject chat-local session skills (standard tier) with dynamic activation tools.
        if (isStandardTier && sessionSkills.length > 0) {
            const sessionSkillInjection = buildSessionSkillInjection({
                sessionSkills,
                activatedSkillIds: activatedSessionSkillIds,
                // Explicit completion set — completed steps have their full
                // body replaced with a one-line summary trailer (tokens +
                // prevents prior-step prose bleeding into the current step).
                completedSessionSkillIds,
                completions: sessionSkillsCompletions,
                // Once the conversation has been compacted, active-skill bodies
                // are already baked into the summary — re-injecting them every
                // turn wastes tokens. Compact mode emits a one-liner instead;
                // the model can reload any via activate_session_skill.
                compactMode: !!conversationSummary,
            });
            if (sessionSkillInjection.systemPromptAddendum) {
                messages[0].content += sessionSkillInjection.systemPromptAddendum;
            }
            for (const t of sessionSkillInjection.tools) {
                if (!directChatTools.find(dt => dt.function?.name === t.function?.name)) {
                    directChatTools.push(t);
                }
            }
        }
        // The skill-bootstrap pass is intentionally isolated from the response pass.
        // Do not chain provider response IDs from before/through bootstrap.
        if (bootstrappedSessionSkills) {
            lastResponseId = null;
        }

        // Per-stage tier override (Flow tier). When the planner declared a
        // `tier` for a stage, swap modelId/adapter/apiKey/apiUrl to that tier
        // for the duration of that stage's LLM rounds. Inheriting stages
        // (no tier) stay on whatever model is currently loaded. Called after
        // each `activate_session_skill` so the very first round of the new
        // stage already runs on its requested model.
        let activeStageModelStageId = null;
        const swapModelForActiveStage = async () => {
            if (!isStandardTier || !Array.isArray(sessionSkills) || sessionSkills.length === 0) return;
            const state = describeStepMachineState(sessionSkills, activatedSessionSkillIds, completedSessionSkillIds);
            const stageId = state.currentActiveId;
            if (!stageId || stageId === activeStageModelStageId) return;
            activeStageModelStageId = stageId;
            const stage = sessionSkills.find(s => s.id === stageId);
            const stageTier = stage?.tier;
            if (!stageTier) return;   // inherit current model
            // Auto: classify based on what this stage actually demands. We
            // already have the planner's plain-language description/instructions
            // — feed that to the same classifier auto uses for the conversation.
            let targetTier = stageTier;
            if (stageTier === 'auto') {
                try {
                    const { classifyWithLLM } = require('../../core/promptClassifier');
                    const classifyTiers = Object.fromEntries(
                        Object.entries(tiers).filter(([k]) => !k.startsWith('custom:') && k !== 'standard' && k !== 'swarm')
                    );
                    const seed = [stage.name, stage.description, stage.instructions].filter(Boolean).join('\n\n');
                    const result = await classifyWithLLM(seed, classifyTiers, { userOrgId: userOrgForTiers, userId });
                    targetTier = result?.tier || resolvedTier;
                } catch (e) {
                    targetTier = resolvedTier;
                }
            }
            let stageModelId;
            try {
                stageModelId = await resolveModelForTier(`tier:${targetTier}`, {
                    userOrgId: userOrgForTiers, userId, fallbackTier: resolvedTier,
                });
            } catch (e) {
                console.warn(`[DirectChat] Stage tier "${stageTier}" resolution failed for "${stage.name}": ${e.message}`);
                return;
            }
            if (!stageModelId || stageModelId === modelId) return;
            try {
                const newConfig = await getProviderForModel(stageModelId);
                const newAdapter = getAdapter(newConfig.providerType, (newConfig.url || '').replace(/\/+$/, ''));
                modelId = stageModelId;
                config = newConfig;
                adapter = newAdapter;
                apiKey = newConfig.apiKey;
                apiUrl = (newConfig.url || '').replace(/\/+$/, '');
                console.log(`[DirectChat] Stage "${stage.name}" → ${stageTier}${stageTier !== targetTier ? `→${targetTier}` : ''} tier (${modelId})`);
                send('stage_model_swapped', { stageId, stageName: stage.name, tier: targetTier, modelId });
            } catch (e) {
                console.warn(`[DirectChat] Stage model swap to "${stageModelId}" failed: ${e.message}`);
            }
        };
        // Run once at the start so a step-1 stage with a tier override picks
        // its model before the first LLM round.
        await swapModelForActiveStage();

        // ─── Eagerly create conversation BEFORE the attachment scan ──
        // Two reasons:
        //   1) workspace_* tools later in the turn need a valid DB row.
        //   2) the attachment scanner calls
        //      `dlpRunner.mergeTokenMap(convId, tokenMap)` — if convId is
        //      null at scan time the merge is a no-op and Claude's
        //      `[person_N]` echoes leak through to the rendered response.
        // Moved up so the scanner gets a real convId. Side effect: a
        // brand-new conversation row appears slightly earlier in the turn;
        // orphan-row risk is unchanged because the original location had
        // the same exposure.
        if (!convId) {
            // Persist the user's pick (e.g. "auto"), not the classifier's
            // resolution. On reload the UI restores `selectedTier` from this
            // value; storing "fast" here would turn Auto into Fast after refresh.
            const newConv = await agentStore.createDirectConversation(userId, modelTier || 'fast');
            convId = newConv.id;
            send('conversation_created', { conversationId: convId });
            console.log(`[DirectChat] Eagerly created conversation ${convId} for workspace/tool access`);
        }

        // Add current message (with attachments if any)
        const persistedAttachments = []; // Track attachments for conversation persistence
        // Per-turn attachment scan summaries — route-scoped so they survive
        // the `messages = compactionResult.messages` reassignment that
        // happens later in the route. The previous version stashed these
        // on the messages array and lost them at compaction time, which
        // also broke the on-reload privacy panel.
        let _turnAttachmentSummaries = null;
        if (attachments && attachments.length > 0) {
            // Surface attachment processing as a phase so the user sees
            // "Reading attachment <filename>…" while OCR / PDF extraction
            // runs (often the slowest step before the first token).
            const _attDetail = attachments.length === 1 && attachments[0]?.name
                ? attachments[0].name
                : `${attachments.length} files`;
            emitPhase(send, 'processing_attachments', _attDetail);
        }
        const _attT = (attachments && attachments.length > 0) ? Date.now() : null;
        if (attachments && attachments.length > 0) {
            const contentParts = [];
            if (message) contentParts.push({ type: 'text', text: message });
            const storageStore = require('../../stores/storageStore');
            const crypto = require('crypto');
            const { persistExtractedText } = require('../../core/extractedTextStore');

            // Resolve Privacy Shield once for the whole attachment loop so we
            // can scan each extracted document for PII before it enters the
            // model prompt. Mirrors the agent-chat path (attachmentProcessor.js).
            // `userOrgId` is declared further down in this function scope
            // (≈ line 1749) under `const`, which puts a temporal dead zone on
            // the whole scope — we can't reference it here. Resolve the
            // user's org locally instead.
            const { resolveUserOrgIds: _resolveUserOrgIdsForAtt } = require('../../auth');
            const _attUserOrgIds = await _resolveUserOrgIdsForAtt(req).catch(() => null);
            const _attUserOrgId = (_attUserOrgIds && _attUserOrgIds.size > 0) ? Array.from(_attUserOrgIds)[0] : null;
            const { resolveShieldFor: _resolvePsForAttachments } = require('../../core/orgShield');
            let _psShield = await _resolvePsForAttachments({ orgId: _attUserOrgId, userId: req.session?.user?.id });
            // Super-admin edge case (mirrors the input-gate fallback further
            // below): the seed admin account has no organizationId binding
            // and the attachment scanner would otherwise silently no-op for
            // them, so PDF/DOCX uploads leak unredacted to the model. Fall
            // back to the sole org shield when exactly one exists.
            if (!_psShield?.enabled && req.session?.isAdmin) {
                try {
                    const allCfg = await configStore.getAllConfig() || {};
                    const shieldKeys = Object.keys(allCfg).filter(k => k.startsWith('org_privacy_shield_'));
                    if (shieldKeys.length === 1 && allCfg[shieldKeys[0]]?.enabled) {
                        _psShield = allCfg[shieldKeys[0]];
                        console.log(`[DirectChat] Attachment scanner: super-admin fallback → sole org shield ${shieldKeys[0]}`);
                    }
                } catch (_) { /* non-fatal */ }
            }
            const { scanAttachmentText: _scanAttText, AttachmentPrivacyBlock: _AttPiiBlock } = require('../../core/dlp/attachmentScanner');
            const _attachmentScanSummaries = [];
            // Local helper so the per-format branches below don't repeat the
            // tokenise/block/pass switch. Returns the text to inline (possibly
            // tokenised) or throws AttachmentPrivacyBlock for the route to catch.
            // The eager-create-conversation block above guarantees `convId`
            // is non-null here, so the scanner's internal
            // `dlpRunner.mergeTokenMap(convId, tokenMap)` call lands in
            // the correct conversation map. No need to accumulate maps
            // locally or merge them later.
            const _scanExtracted = async (text, pages, filename) => {
                if (!_psShield || !text) return text;
                const r = await _scanAttText({ text, pages, filename, orgShield: _psShield, conversationId: convId });
                if (r.action === 'block') throw new _AttPiiBlock({ filename, summary: r.summary, findings: r.findings });
                if (r.action === 'tokenize') {
                    _attachmentScanSummaries.push({
                        filename,
                        action: 'tokenize',
                        count: r.findings.length,
                        byCategory: r.summary.byCategory,
                        pages: r.summary.pages,
                        overflow: r.summary.overflow,
                    });
                    return r.text;
                }
                if (r.summary && r.summary.timeout) {
                    _attachmentScanSummaries.push({
                        filename,
                        action: 'pass',
                        count: 0,
                        byCategory: {},
                        pages: {},
                        overflow: !!r.summary.overflow,
                        timeout: true,
                    });
                }
                return text;
            };

            // Sidecar carries the persistent representation of an attachment.
            // Big extractions are tiered to RustFS via persistExtractedText so
            // meta_json doesn't grow unbounded, while the head+tail snippet
            // stays inline for replay.
            const pushAttachment = async (base, fullText) => {
                if (!fullText) {
                    persistedAttachments.push(base);
                    return;
                }
                const tiered = await persistExtractedText(fullText, userId, base.name);
                persistedAttachments.push({
                    ...base,
                    extractedText: tiered.extractedText,
                    ...(tiered.extractionKey ? { extractionKey: tiered.extractionKey } : {}),
                });
            };

            try {
            for (const att of attachments) {
                if (att.type && att.type.startsWith('image/') && att.content) {
                    // Upload image to RustFS for persistence + inference URL
                    let imageProxyUrl = null;
                    let inferenceUrl = null;
                    try {
                        if (storageStore.isAvailable()) {
                            const base64Data = att.content.split(',')[1] || att.content;
                            const ext = att.type.includes('jpeg') || att.type.includes('jpg') ? 'jpg' : 'png';
                            const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
                            const key = storageStore.buildKey(userId, 'uploads', filename);
                            await storageStore.uploadFile(key, Buffer.from(base64Data, 'base64'), att.type);
                            imageProxyUrl = storageStore.buildProxyUrl(key);
                            console.log(`[DirectChat] Uploaded image to RustFS: ${key}`);
                            persistedAttachments.push({ name: att.name, type: att.type, storageKey: key, url: imageProxyUrl });

                            // Generate temp URL for AI inference (URL is ~200 chars vs 500-1000 KB base64)
                            const { generateTempDownloadUrl } = require('../../routes/storageProxy');
                            inferenceUrl = generateTempDownloadUrl(key, 900);
                            console.log(`[DirectChat] Image uploaded to RustFS → using URL for inference (${att.name})`);
                        }
                    } catch (e) {
                        console.warn(`[DirectChat] Failed to upload image to RustFS: ${e.message}`);
                    }
                    // Send as image data only if the current model supports vision
                    if (adapter.supportsVision(modelId)) {
                        const imageDataUrl = inferenceUrl || att.content;
                        contentParts.push({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } });
                        if (!inferenceUrl) {
                            console.log(`[DirectChat] RustFS unavailable — using base64 for ${att.name || 'unnamed'}`);
                        }
                    } else {
                        // Non-vision model: add a descriptive text note instead of a broken image reference
                        contentParts.push({ type: 'text', text: `[Attached image: ${att.name || 'image'} — this model does not support vision. To analyze this image, switch to a vision-capable model such as GPT-4o, Claude 3, Gemini, or Pixtral.]` });
                        console.log(`[DirectChat] Model ${modelId} doesn't support vision — converted image to text note`);
                    }

                } else if (att.source === 'google-drive' && att.content) {
                    // Google Drive file — already exported as plain text, inject directly
                    const safeDrive = await _scanExtracted(att.content, undefined, att.name);
                    const driveText = `--- Google Drive: ${att.name} ---\n${safeDrive}\n--- End of ${att.name} ---`;
                    contentParts.push({ type: 'text', text: driveText });
                    await pushAttachment({ name: att.name, type: 'google-drive' }, driveText);
                } else if (att.content && att.type && att.type.includes('pdf')) {
                    // PDF — unified pipeline (server/core/attachmentExtractor.js):
                    //   pdfjs → Azure Document Intelligence → Mistral OCR → vision fallback.
                    // The helper handles the density heuristic and vision-capable fallback.
                    try {
                        const base64Data = att.content.split(',')[1] || att.content;
                        const pdfBuffer = Buffer.from(base64Data, 'base64');

                        // Upload original PDF to RustFS for persistence (unchanged).
                        let pdfProxyUrl = null;
                        try {
                            if (storageStore.isAvailable()) {
                                const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                                const key = storageStore.buildKey(userId, 'uploads', filename);
                                await storageStore.uploadFile(key, pdfBuffer, att.type);
                                pdfProxyUrl = storageStore.buildProxyUrl(key);
                                console.log(`[DirectChat] Uploaded PDF to RustFS: ${key}`);
                            }
                        } catch (e) {
                            console.warn(`[DirectChat] Failed to upload PDF to RustFS: ${e.message}`);
                        }

                        const { extractAttachment, formatTextHeader, formatImagesHeader, formatFailureNote } = require('../../core/attachmentExtractor');
                        const result = await extractAttachment(att, { modelSupportsVision: adapter.supportsVision(modelId) });
                        console.log(`[DirectChat] PDF ${att.name} extraction → kind=${result.kind}, source=${result.source || 'n/a'}`);

                        if (result.kind === 'text') {
                            // Privacy Shield: tokenise / block before the text
                            // is inlined into the prompt. Throws AttachmentPrivacyBlock
                            // on block-action; the outer try/catch surfaces that
                            // as a dlp_blocked SSE event.
                            const _scanResultsBefore = _attachmentScanSummaries.length;
                            const safeText = await _scanExtracted(result.text, result.pages, att.name);
                            const _wasTokenised = _attachmentScanSummaries.length > _scanResultsBefore;
                            const docText = `${formatTextHeader(att, result)}\n---\n${safeText}\n---`;
                            const isClaude = (config.providerType || '').toLowerCase() === 'claude' || (config.providerType || '').toLowerCase() === 'anthropic';
                            // Always inline the extracted text. Some invoice PDFs
                            // embed fonts with no usable ToUnicode CMap, and
                            // Claude's native PDF parser hits the same dead end
                            // pdfjs does — the model then reports back "I see
                            // raw font tables, not text". Shipping the OCR'd /
                            // pdfjs text alongside the document block gives the
                            // model a guaranteed-readable channel.
                            contentParts.push({ type: 'text', text: docText });
                            if (isClaude && !_wasTokenised) {
                                // Also include the original PDF so Claude can
                                // see visual elements (logos, signatures, layout)
                                // that pure text extraction discards.
                                // Skipped when Privacy Shield tokenised the
                                // text — sending the raw PDF would bypass the
                                // redaction (the model would still see the
                                // unredacted source).
                                const mediaType = att.type && att.type.includes('pdf') ? att.type : 'application/pdf';
                                contentParts.push({
                                    type: 'document',
                                    source: { type: 'base64', media_type: mediaType, data: base64Data },
                                });
                            }
                            await pushAttachment({ name: att.name, type: att.type, url: pdfProxyUrl }, docText);
                        } else if (result.kind === 'images') {
                            // Vision fallback — inline a header note, then the page images.
                            const visionHeader = formatImagesHeader(att, result);
                            contentParts.push({ type: 'text', text: visionHeader });
                            for (const img of result.images) {
                                contentParts.push({
                                    type: 'image_url',
                                    image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'auto' },
                                });
                            }
                            // Persist the header so replays at least know which
                            // file was visually analysed; the rendered pages
                            // themselves aren't re-uploaded (would be expensive
                            // and is mostly recoverable via the original PDF URL).
                            await pushAttachment({ name: att.name, type: att.type, url: pdfProxyUrl }, visionHeader);
                        } else {
                            const failureNote = formatFailureNote(att, result);
                            contentParts.push({ type: 'text', text: failureNote });
                            await pushAttachment({ name: att.name, type: att.type, url: pdfProxyUrl }, failureNote);
                        }
                    } catch (e) {
                        console.error(`[DirectChat] PDF processing failed for ${att.name}:`, e.message);
                        contentParts.push({
                            type: 'text',
                            text: `[PDF: ${att.name} — failed to process: ${e.message}]`
                        });
                    }
                } else if (att.content && (att.type?.includes('wordprocessingml') || att.name?.toLowerCase().endsWith('.docx'))) {
                    // DOCX — Azure Document Intelligence (when enabled) → mammoth fallback
                    try {
                        const base64Data = att.content.split(',')[1] || att.content;
                        const docxBuffer = Buffer.from(base64Data, 'base64');
                        let docxText = '';

                        // 1. Try Azure Document Intelligence first (highest quality — Markdown with tables/headings)
                        const useAzureDoc = !!(await configStore.getConfig('use_azure_doc_processing'));
                        if (useAzureDoc) {
                            try {
                                const { extractWithAzure, isAzureDocIntelligenceConfigured } = require('../../core/azureDocIntelligence');
                                if (await isAzureDocIntelligenceConfigured()) {
                                    docxText = await extractWithAzure(docxBuffer, att.name);
                                    if (docxText) {
                                        console.log(`[DirectChat] DOCX extracted via Azure Document Intelligence: ${att.name} (${docxText.length} chars)`);
                                    }
                                }
                            } catch (azureErr) {
                                console.warn(`[DirectChat] Azure Document Intelligence failed for DOCX ${att.name}:`, azureErr.message);
                            }
                        }

                        // 2. Fallback to mammoth (basic plain text extraction)
                        if (!docxText) {
                            const { parseDocument } = require('../../core/documentParser');
                            docxText = await parseDocument(docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', att.name);
                        }

                        // Upload original to RustFS for persistence
                        let docxProxyUrl = null;
                        try {
                            if (storageStore.isAvailable()) {
                                const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                                const key = storageStore.buildKey(userId, 'uploads', filename);
                                await storageStore.uploadFile(key, docxBuffer, att.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                                docxProxyUrl = storageStore.buildProxyUrl(key);
                                console.log(`[DirectChat] Uploaded DOCX to RustFS: ${key}`);
                            }
                        } catch (e) {
                            console.warn(`[DirectChat] Failed to upload DOCX to RustFS: ${e.message}`);
                        }

                        if (docxText && !docxText.startsWith('[Document:')) {
                            const safeDocxText = await _scanExtracted(docxText, undefined, att.name);
                            const docText = `[Word Document: ${att.name}]\n---\n${safeDocxText}\n---`;
                            contentParts.push({ type: 'text', text: docText });
                            await pushAttachment({ name: att.name, type: att.type, url: docxProxyUrl }, docText);
                            console.log(`[DirectChat] Extracted ${docxText.length} chars from DOCX: ${att.name}`);
                        } else {
                            // mammoth extraction returned empty/error — fall back to container
                            const note = `[Word Document: ${att.name} — no extractable text, may contain only images]`;
                            contentParts.push({ type: 'text', text: note });
                            await pushAttachment({ name: att.name, type: att.type, url: docxProxyUrl }, note);
                        }
                    } catch (e) {
                        console.error(`[DirectChat] DOCX processing failed for ${att.name}:`, e.message);
                        contentParts.push({
                            type: 'text',
                            text: `[DOCX: ${att.name} — failed to process: ${e.message}]`
                        });
                    }
                } else if (att.content && (
                    att.type?.includes('spreadsheetml') || att.type?.includes('ms-excel') ||
                    att.type === 'text/csv' || att.type === 'application/csv' ||
                    att.name?.toLowerCase().endsWith('.xlsx') || att.name?.toLowerCase().endsWith('.xls') ||
                    att.name?.toLowerCase().endsWith('.csv')
                )) {
                    // Spreadsheet — Azure Document Intelligence (when enabled) → XLSX library fallback
                    try {
                        const base64Data = att.content.split(',')[1] || att.content;
                        const spreadsheetBuffer = Buffer.from(base64Data, 'base64');
                        let sheetText = '';

                        // 1. Try Azure Document Intelligence first (when enabled)
                        const useAzureDoc = !!(await configStore.getConfig('use_azure_doc_processing'));
                        if (useAzureDoc) {
                            try {
                                const { extractWithAzure, isAzureDocIntelligenceConfigured } = require('../../core/azureDocIntelligence');
                                if (await isAzureDocIntelligenceConfigured()) {
                                    sheetText = await extractWithAzure(spreadsheetBuffer, att.name);
                                    if (sheetText) {
                                        console.log(`[DirectChat] Spreadsheet extracted via Azure Document Intelligence: ${att.name} (${sheetText.length} chars)`);
                                    }
                                }
                            } catch (azureErr) {
                                console.warn(`[DirectChat] Azure Document Intelligence failed for spreadsheet ${att.name}:`, azureErr.message);
                            }
                        }

                        // 2. Fallback to local XLSX parser
                        if (!sheetText) {
                            const { parseDocument } = require('../../core/documentParser');
                            sheetText = await parseDocument(spreadsheetBuffer, att.type || 'application/octet-stream', att.name);
                        }

                        // Upload original to RustFS for persistence
                        let sheetProxyUrl = null;
                        try {
                            if (storageStore.isAvailable()) {
                                const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                                const key = storageStore.buildKey(userId, 'uploads', filename);
                                await storageStore.uploadFile(key, spreadsheetBuffer, att.type || 'application/octet-stream');
                                sheetProxyUrl = storageStore.buildProxyUrl(key);
                                console.log(`[DirectChat] Uploaded spreadsheet to RustFS: ${key}`);
                            }
                        } catch (e) {
                            console.warn(`[DirectChat] Failed to upload spreadsheet to RustFS: ${e.message}`);
                        }

                        if (sheetText && !sheetText.startsWith('[Spreadsheet:')) {
                            const safeSheetText = await _scanExtracted(sheetText, undefined, att.name);
                            const docText = `[Spreadsheet: ${att.name}]\n---\n${safeSheetText}\n---`;
                            contentParts.push({ type: 'text', text: docText });
                            await pushAttachment({ name: att.name, type: att.type, url: sheetProxyUrl }, docText);
                            console.log(`[DirectChat] Extracted ${sheetText.length} chars from spreadsheet: ${att.name}`);
                        } else {
                            const note = sheetText || `[Spreadsheet: ${att.name} — no data found]`;
                            contentParts.push({ type: 'text', text: note });
                            await pushAttachment({ name: att.name, type: att.type, url: sheetProxyUrl }, note);
                        }
                    } catch (e) {
                        console.error(`[DirectChat] Spreadsheet processing failed for ${att.name}:`, e.message);
                        contentParts.push({
                            type: 'text',
                            text: `[Spreadsheet: ${att.name} — failed to process: ${e.message}]`
                        });
                    }
                } else if (att.content) {
                    // Generic file — upload to RustFS for persistent access
                    const base64Data = att.content.split(',')[1] || att.content;
                    const buffer = Buffer.from(base64Data, 'base64');
                    const filename = att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');

                    let fileProxyUrl = null;
                    try {
                        if (storageStore.isAvailable()) {
                            const storageName = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${filename}`;
                            const key = storageStore.buildKey(userId, 'uploads', storageName);
                            await storageStore.uploadFile(key, buffer, att.type || 'application/octet-stream');
                            fileProxyUrl = storageStore.buildProxyUrl(key);
                            console.log(`[DirectChat] Uploaded file to RustFS: ${key}`);
                        }
                    } catch (storErr) {
                        console.warn(`[DirectChat] Failed to upload file to RustFS: ${storErr.message}`);
                    }

                    const note = `[Attached file: ${filename}] This file has been uploaded${fileProxyUrl ? ' and stored' : ''}.${att.type ? ' Type: ' + att.type : ''}`;
                    contentParts.push({ type: 'text', text: note });
                    await pushAttachment({ name: att.name, type: att.type, url: fileProxyUrl }, note);
                }
            }
            } catch (attErr) {
                if (attErr && attErr.code === 'ATTACHMENT_PII_BLOCKED') {
                    const cats = Object.keys(attErr.summary?.byCategory || {});
                    send('dlp_blocked', {
                        reason: 'attachment_pii',
                        filename: attErr.filename,
                        categories: cats,
                        findings: [],
                        provider: { isExternal: false, reason: 'attachment_pii' },
                    });
                    try {
                        const guardrailEventStore = require('../../stores/guardrailEventStore');
                        await guardrailEventStore.logGuardrailEvent({
                            organization_id: _attUserOrgId || null,
                            user_id: userId || null,
                            conversation_id: conversationId || null,
                            violation_type: 'pii',
                            violation_categories: cats.join(', ') || null,
                            direction: 'input',
                            action_taken: 'blocked',
                            source: config?.providerName || config?.providerType || 'LLM',
                            model: modelId || null,
                            attachment_filename: attErr.filename,
                            attachment_page: null,
                        });
                    } catch (_) { /* audit best-effort */ }
                    send('done', {}); res.end(); return;
                }
                throw attErr;
            }
            // Audit + UI surfacing for tokenised attachments.
            if (_attachmentScanSummaries.length > 0) {
                try {
                    const guardrailEventStore = require('../../stores/guardrailEventStore');
                    const auditBase = {
                        organization_id: _attUserOrgId || null,
                        user_id: userId || null,
                        conversation_id: conversationId || null,
                        source: config?.providerName || config?.providerType || 'LLM',
                        model: modelId || null,
                    };
                    for (const s of _attachmentScanSummaries) {
                        await guardrailEventStore.logAttachmentPiiFindings({ summary: s, auditBase, action_taken: 'redacted' });
                    }
                } catch (_) { /* audit best-effort */ }
            }
            // Per-file summaries — route-scoped so they survive the
            // `messages = compactionResult.messages` reassignment that
            // happens later. The assistant-message builder reads from
            // `_turnAttachmentSummaries`; without this hoist the
            // privacy panel's "From attachments:" section disappears on
            // reload even though it appears live via the SSE event below.
            if (_attachmentScanSummaries.length > 0) {
                _turnAttachmentSummaries = _attachmentScanSummaries;

                // Live SSE notification so the UI shows the privacy badge
                // immediately, not just after a page reload. Without this,
                // the audit row is written but the user sees no evidence
                // that Privacy Shield fired this turn. Re-uses the existing
                // `pii_tokenized` event shape so the client handler
                // (useChatEngine.js: case 'pii_tokenized') ingests both
                // message-level and attachment-level findings the same way.
                const _aggCount = _attachmentScanSummaries.reduce((a, s) => a + (s.count || 0), 0);
                const _aggCats = new Set();
                for (const s of _attachmentScanSummaries) {
                    for (const c of Object.keys(s.byCategory || {})) _aggCats.add(c);
                }
                if (_aggCount > 0 || _attachmentScanSummaries.some(s => s.timeout)) {
                    send('pii_tokenized', {
                        // Synthesise an entities-shaped list so the existing
                        // pii_tokenized handler picks the categories up.
                        entities: [..._aggCats].map(label => ({ label, category: label })),
                        tokenCount: _aggCount,
                        attachments: _attachmentScanSummaries,
                        source: 'privacy_shield',
                    });
                }

                // When the org enabled "Show raw payload & token mapping",
                // also push the *exact* tokenised text the model is about
                // to receive (user prompt + tokenised attachment text) and
                // the merged token map. This is what fills the "Sent to AI"
                // pane in the "How I got this answer → Privacy protection"
                // panel — without it the user sees only the un-tokenised
                // round-tripped response and has no way to verify what
                // Claude actually saw.
                if (_aggCount > 0 && _psShield?.showRawPayload) {
                    try {
                        const flat = contentParts
                            .filter(p => p && p.type === 'text' && typeof p.text === 'string')
                            .map(p => p.text)
                            .join('\n');
                        if (flat) {
                            send('privacy_payload', {
                                tokenizedPrompt: flat,
                                provider: modelId,
                                source: 'privacy_shield',
                                timestamp: Date.now(),
                            });
                        }
                        const _dlpRunner = require('../../core/dlp/dlpRunner');
                        const _convMap = _dlpRunner.getConversationTokenMap(conversationId);
                        if (_convMap && Object.keys(_convMap).length > 0) {
                            send('privacy_token_map', { tokenMap: _convMap, source: 'privacy_shield' });
                        }
                    } catch (_) { /* transparency is best-effort */ }
                }
            }
            messages.push({ role: 'user', content: contentParts });
        } else {
            messages.push({ role: 'user', content: message });
        }
        if (_attT !== null) {
            emitPhaseEnd(send, 'processing_attachments', Date.now() - _attT);
        }

        // Add terminal tools when integrations that handle attachments
        // (Gmail, etc.) are loaded — for convert_document_to_text etc.
        // Note: terminal containers removed, but terminal tools module may still exist
        const hasIntegrationWithAttachments = directChatTools.some(t =>
            t.function?.name?.startsWith('gmail_') || t.function?.name?.startsWith('drive_')
        );
        if (hasIntegrationWithAttachments) {
            try {
                const { TERMINAL_TOOLS } = require('../../terminal/tools');
                for (const tTool of TERMINAL_TOOLS) {
                    if (!directChatTools.find(t => t.function.name === tTool.function.name)) {
                        directChatTools.push(tTool);
                    }
                }
            } catch (e) {
                // Terminal tools module not available
            }
        }

        // ─── Unicode Smuggling Defense ───────────────────────────────
        // Must run FIRST — before moderation, PII, and regex guardrails.
        // Strips hidden payloads encoded via Variation Selectors / Tags block.
        const { sanitizeMessagesUnicode } = require('../../utils/unicodeSanitizer');
        const unicodeResult = sanitizeMessagesUnicode(messages);
        if (unicodeResult.smugglingDetected) {
            console.warn(`[DirectChat] 🚨 Unicode smuggling stripped: ${unicodeResult.totalStripped} hidden chars`);
            send('unicode_smuggling_detected', {
                strippedCount: unicodeResult.totalStripped,
                messageIndices: unicodeResult.detectedIn,
            });
        }

        // ─── AI Content Moderation (org shield) ─────────────────────
        const { resolveUserOrgIds } = require('../../auth');
        const userOrgIds = await resolveUserOrgIds(req);
        // Super-admins get `null` from resolveUserOrgIds (intentional — it
        // bypasses org-scoped filtering for read queries). For shield/PII
        // resolution we still want their actual org binding so the shield
        // is loaded; fall back to session.user.organizationId.
        const userOrgId = (userOrgIds && userOrgIds.size > 0)
            ? Array.from(userOrgIds)[0]
            : (req.session?.user?.organizationId || null);

        // Deferred log for unicode smuggling (needed userOrgId)
        if (unicodeResult.smugglingDetected) {
            guardrailEventStore.logGuardrailEvent({
                organization_id: userOrgId || null,
                user_id: userId,
                conversation_id: convId || null,
                violation_type: 'unicode_smuggling',
                violation_categories: `${unicodeResult.totalStripped} hidden chars`,
                direction: 'input',
                action_taken: 'stripped',
                source: 'direct',
                model: modelId || null,
            }).catch(() => {});
        }

        // Check if org shield or global config enables moderation for direct chat
        let moderationViolation = null;
        // Privacy / DLP metadata accumulators — attached to the saved user/assistant
        // messages just before persistence so the redaction badge and "How I got this
        // answer" panel survive a page refresh.
        let _userPrivacyMeta = null;
        let _assistantTokenisationInfo = null;
        // Resolve the org Privacy Shield. Normal case: look up by userOrgId.
        // Super-admin edge case: req.session.isAdmin users may have no
        // organizationId binding at all (organizationId === '' on the admin
        // seed account). They still chat through this route, and need the
        // shield to apply — otherwise PII detection / moderation / web
        // search guard all silently no-op for the highest-privilege user.
        // Fall back to the single org shield when exactly one exists; with
        // multiple orgs we don't guess (would need a UI "act as org" picker).
        let orgShield = userOrgId ? await configStore.getConfig(`org_privacy_shield_${userOrgId}`) : null;
        if (!orgShield && req.session?.isAdmin) {
            const allConfigs = await configStore.getAllConfig() || {};
            const shieldKeys = Object.keys(allConfigs).filter(k => k.startsWith('org_privacy_shield_'));
            if (shieldKeys.length === 1) {
                orgShield = allConfigs[shieldKeys[0]];
                console.log(`[DirectChat] Super-admin without org binding — using sole org shield ${shieldKeys[0]}`);
            } else if (shieldKeys.length > 1) {
                console.log(`[DirectChat] Super-admin without org binding and ${shieldKeys.length} shields exist — no shield applied (set organizationId on the admin user or add an org picker)`);
            }
        }
        const webSearchGuardEnabled = !!(orgShield?.enabled && orgShield?.webSearchGuardEnabled);

        // Content moderation (Hate/Violence/Sexual/Self-Harm) was removed when
        // the Azure Content Safety backend was dropped. PII detection still
        // runs further below.

        // Inject moderation violation context into system prompt so AI can explain
        if (moderationViolation) {
            messages[0].content += `\n\n[IMPORTANT: The user's message was flagged by our content safety policy. You must briefly explain that their message could not be processed because it was flagged by our content policy, and politely ask them to rephrase. Keep your response short (1-2 sentences). Do not reveal the specific violation category. Do not process or answer the original request.]`;
            // Strip the violating user message — only send a placeholder to the model
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?.role === 'user') {
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = `[Message flagged by content moderation]`;
                } else if (Array.isArray(lastMsg.content)) {
                    // Multimodal message — replace only text parts, keep structure
                    lastMsg.content = lastMsg.content.map(part =>
                        part.type === 'text' ? { type: 'text', text: '[Message flagged by content moderation]' } : part
                    );
                }
            }
        }

        // ─── PII Detection (independent of content moderation) ──────
        // Runs whenever piiDetectionEnabled is true, regardless of moderation settings.
        // Action 'block' — throw and reject message.
        // Action 'tokenize' — replace PII spans with tokens, pass clean text to AI,
        //                     restore tokens in the AI response before showing the user.
        // When the org has the interactive DLP gate enabled, skip this auto-tokenising
        // path — the DLP block further down handles scan + user decision + audit.
        let piiTokenMap = null;  // non-null only in tokenize mode when PII found
        // Mirror of `message` for non-LLM consumers (DB persistence, memory
        // extraction, title generator). When PII tokenisation fires, this
        // becomes the redacted form so downstream code never sees raw PII —
        // the original `message` const is only used to fork into the LLM's
        // `messages[]` array and isn't trustworthy after tokenisation.
        let tokenizedMessage = message;
        const dlpWillHandleHere = !!(orgShield?.enabled && orgShield?.dlpEnabled);
        if (dlpWillHandleHere) {
            console.log('[DirectChat] DLP enabled — deferring PII handling to pre-flight DLP gate');
        }
        // Diagnostic: show why PII block may skip (orgShield may be null on
        // some paths — e.g. when userOrgId is not yet resolved). Print on
        // every turn so support can correlate to a specific convId.
        console.log(`[DirectChat] PII gate: convId=${convId} orgShield=${orgShield ? 'present' : 'NULL'} enabled=${orgShield?.enabled} dlpWillHandleHere=${dlpWillHandleHere}`);
        // Hydrate the conversation-scoped PII token map from the DB before
        // ANY downstream code reads it. Required for multi-turn correctness:
        // on turn 2+, the streaming un-tokeniser, the system-prompt token
        // preservation addendum, and the inbound-history retokeniser all
        // consult the in-process map via getConversationTokenMap(), which
        // returns {} when the map hasn't been hydrated. Without this, a
        // `[medication_1]` minted on turn 1 survives as literal text in
        // every later assistant reply. Idempotent — populates the in-process
        // Map only when it's currently empty.
        if (convId) {
            try { await require('../../core/dlp/dlpRunner').getConversationTokenMapAsync(convId); }
            catch (_) { /* hydration is best-effort */ }
        }
        try {
            if (dlpWillHandleHere) throw { __skip: true };
            const { validateInputForPii } = require('../../core/piiDetection');
            // The org Privacy Shield's master `enabled` flag is the only
            // switch needed — detectPii() calls the PII Guard service.
            const orgPiiEnabled = !!orgShield?.enabled;
            console.log(`[DirectChat] PII calling validateInputForPii: orgPiiEnabled=${orgPiiEnabled} msgCount=${messages.length} msgsSlice=${JSON.stringify(messages.slice(-3).map(m => ({role: m.role, contentType: typeof m.content, contentPreview: typeof m.content === 'string' ? m.content.slice(0, 50) : '(non-string)'}))).slice(0, 300)}`);
            let piiResult;
            try {
                piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield);
                console.log(`[DirectChat] PII validateInputForPii returned: ${piiResult ? `entities=${piiResult.entities?.length ?? 'n/a'} tokenized=${!!piiResult.tokenizedText}` : 'null'}`);
            } catch (innerErr) {
                console.error(`[DirectChat] PII INNER ERROR: ${innerErr.message}\n${innerErr.stack}`);
                throw innerErr;
            }

            if (piiResult && piiResult.tokenizedText) {
                // Tokenize mode: replace last user message with tokenized version
                const lastMsg = messages[messages.length - 1];
                if (typeof lastMsg.content === 'string') {
                    lastMsg.content = piiResult.tokenizedText;
                } else if (Array.isArray(lastMsg.content)) {
                    const textPart = lastMsg.content.find(p => p.type === 'text');
                    if (textPart) textPart.text = piiResult.tokenizedText;
                }
                piiTokenMap = piiResult.tokenMap;
                tokenizedMessage = piiResult.tokenizedText;
                // Register on the shared DLP conversation-token store so the streaming
                // un-tokeniser restores these values on the way back even when DLP
                // itself is disabled.
                try { require('../../core/dlp/dlpRunner').mergeTokenMap(convId, piiResult.tokenMap); } catch (_) { /* non-fatal */ }
                const tokenList = Object.entries(piiResult.tokenMap).map(([t, v]) => `${t}=“${v.slice(0,15)}”`).join(', ');
                console.warn(`[DirectChat] 🔒 PII tokenized (${Object.keys(piiResult.tokenMap).length} tokens): ${tokenList}`);

                // Tell the AI about the tokenization so it can reference them properly.
                // Shared helper — also used by the agent path — keeps the rules and
                // sign-off guidance in one place. Reads conversation-scoped tokens so
                // a value redacted in turn 1 is still recognised in turn 5.
                if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
                    try {
                        const _convMap = require('../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                        messages[0].content += buildTokenPreservationAddendum(_convMap);
                    } catch (_) {
                        messages[0].content += buildTokenPreservationAddendum(piiResult.tokenMap);
                    }
                }

                send('pii_tokenized', {
                    entities: piiResult.entities.map(e => ({ label: e.label, category: e.category })),
                    tokenCount: Object.keys(piiResult.tokenMap).length,
                });

                // Persistence: stash the same data on the request-scoped accumulators
                // so the user message gets a redacted badge and the assistant message
                // gets the privacy panel after a refresh.
                {
                    const piiCats = [...new Set(piiResult.entities.map(e => e.label || e.category).filter(Boolean))];
                    const piiCount = Object.keys(piiResult.tokenMap).length;
                    _userPrivacyMeta = { piiTokenizedCount: piiCount, piiCategories: piiCats };
                    _assistantTokenisationInfo = {
                        source: 'pii',
                        action: 'redact',
                        count: piiCount,
                        categories: piiCats,
                        provider: modelId || null,
                        automatic: true,
                    };
                }

                // Transparency: when enabled per-org, surface the exact tokenised
                // outbound string so the user can verify what the LLM received.
                if (orgShield?.showRawPayload) {
                    send('privacy_payload', {
                        tokenizedPrompt: piiResult.tokenizedText,
                        provider: modelId || null,
                        source: 'pii',
                        timestamp: Date.now(),
                    });
                    if (_assistantTokenisationInfo) _assistantTokenisationInfo.tokenizedPrompt = piiResult.tokenizedText;
                    if (piiResult.tokenMap && Object.keys(piiResult.tokenMap).length > 0) {
                        send('privacy_token_map', { tokenMap: piiResult.tokenMap, source: 'pii' });
                        if (_assistantTokenisationInfo) _assistantTokenisationInfo.tokenMap = piiResult.tokenMap;
                    }
                }

                // Log PII tokenize event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    organization_id: userOrgId || null,
                    user_id: userId,
                    conversation_id: convId || null,
                    violation_type: 'pii',
                    violation_categories: piiResult.entities.map(e => e.label || e.category).join(', '),
                    direction: 'input',
                    action_taken: 'tokenized',
                    source: 'direct',
                    model: modelId || null,
                }).catch(() => {});
            }
        } catch (piiError) {
            if (piiError?.__skip) {
                // DLP gate will handle PII; nothing to do here.
            } else if (piiError.piiEntities) {
                // Block mode: reject the message
                const categoryList = [...new Set(piiError.piiEntities.map(e => e.label))].join(', ');
                const snippets = piiError.piiEntities.map(e => `"${e.text.slice(0, 20).trim()}" (${e.label})`).join(' | ');
                console.warn(`[DirectChat] 🚫 PII blocked | categories: ${categoryList}`);
                console.warn(`[DirectChat] 🚫 Entities: ${snippets}`);
                send('guardrail_violation', {
                    rules: [categoryList],
                    type: 'pii',
                    piiEntities: piiError.piiEntities,
                    autoDeleteSeconds: 5,
                });

                // Log PII block event (fire-and-forget)
                guardrailEventStore.logGuardrailEvent({
                    organization_id: userOrgId || null,
                    user_id: userId,
                    conversation_id: convId || null,
                    violation_type: 'pii',
                    violation_categories: categoryList,
                    direction: 'input',
                    action_taken: 'blocked',
                    source: 'direct',
                    model: modelId || null,
                }).catch(() => {});

                send('done', {});
                res.end();
                return;
            }
            // PII service unavailable — fail-open, log and continue
            console.warn('[DirectChat] PII check error (fail-open):', piiError.message);
        }

        // ─── Pre-flight DLP (interactive outbound scanner) ───────────
        if (orgShield?.enabled && orgShield?.dlpEnabled) {
            const dlpRunner = require('../../core/dlp/dlpRunner');
            const decisionQueue = require('../../core/dlp/decisionQueue');
            const { resolveOrgShield: _resolveShield } = require('../../core/orgShield');
            const resolvedShield = await _resolveShield(userOrgId);

            const providerConfig = {
                providerType: config.providerType,
                url: config.url,
                displayName: config.providerName || config.providerType || 'LLM',
            };
            const scanStart = Date.now();
            const dlpResult = await dlpRunner.scan({
                messages,
                orgShieldConfig: resolvedShield,
                orgId: userOrgId,
                conversationId: convId,
                providerConfig,
            });

            const auditBase = {
                organization_id: userOrgId || null,
                user_id: userId,
                conversation_id: convId || null,
                model: modelId || null,
                source: 'direct',
            };
            const categoryList = Object.keys(dlpResult.summary || {}).join(', ') || null;

            const applyRedactionToMessages = (tokenizedText) => {
                const lastMsg = messages[messages.length - 1];
                if (!lastMsg || lastMsg.role !== 'user') return;
                if (typeof lastMsg.content === 'string') lastMsg.content = tokenizedText;
                else if (Array.isArray(lastMsg.content)) {
                    const textPart = lastMsg.content.find(p => p.type === 'text');
                    if (textPart) textPart.text = tokenizedText;
                }
            };

            if (dlpResult.action === 'block') {
                send('dlp_blocked', {
                    findings: dlpResult.findings.map(f => ({ label: f.label, category: f.category, source: f.source })),
                    provider: dlpResult.provider,
                    reason: dlpResult.reason || 'policy_block',
                });
                guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'blocked' }).catch(() => {});
                send('done', {}); res.end(); return;
            }

            if (dlpResult.action === 'redact') {
                applyRedactionToMessages(dlpResult.redactedText);
                piiTokenMap = dlpResult.tokenMap; // reuse existing un-tokenise path on the response
                const dlpCount = Object.keys(dlpResult.tokenMap || {}).length;
                const dlpCats = Object.keys(dlpResult.summary || {});
                send('dlp_resolved', {
                    appliedChoice: 'redact',
                    redactedCount: dlpCount,
                    provider: dlpResult.provider,
                    categories: dlpCats,
                    automatic: true,
                    decisionMs: Date.now() - scanStart,
                });
                _userPrivacyMeta = { dlpRedactedCount: dlpCount, dlpCategories: dlpCats };
                _assistantTokenisationInfo = {
                    source: 'dlp',
                    action: 'redact',
                    count: dlpCount,
                    categories: dlpCats,
                    provider: dlpResult.provider?.displayName || null,
                    automatic: true,
                };
                if (resolvedShield?.showRawPayload && dlpResult.redactedText) {
                    send('privacy_payload', {
                        tokenizedPrompt: dlpResult.redactedText,
                        provider: modelId || null,
                        source: 'dlp',
                        timestamp: Date.now(),
                    });
                    _assistantTokenisationInfo.tokenizedPrompt = dlpResult.redactedText;
                    if (dlpResult.tokenMap && Object.keys(dlpResult.tokenMap).length > 0) {
                        send('privacy_token_map', { tokenMap: dlpResult.tokenMap, source: 'dlp' });
                        _assistantTokenisationInfo.tokenMap = dlpResult.tokenMap;
                    }
                }
                // Tell the AI about the tokens so it reuses placeholders verbatim
                // (and never invents `[jouw naam]` / `[your name]` for sign-offs).
                if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
                    const _convMap = dlpRunner.getConversationTokenMap(convId);
                    messages[0].content += buildTokenPreservationAddendum(_convMap);
                }
                guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'redacted' }).catch(() => {});
            } else if (dlpResult.action === 'ask') {
                const { decisionId, promise } = decisionQueue.register({ conversationId: convId, userId });
                send('dlp_preview', {
                    decisionId,
                    provider: dlpResult.provider,
                    findings: dlpResult.findings.map(f => ({
                        label: f.label, category: f.category, source: f.source,
                        preview: (f.text || '').slice(0, 3) + '…',
                    })),
                    summary: dlpResult.summary,
                    defaultChoice: resolvedShield.dlpMode === 'block' ? 'block' : 'redact',
                });

                let decision;
                try { decision = await promise; }
                catch (err) {
                    send('dlp_blocked', { reason: err.code === 'DLP_TIMEOUT' ? 'timeout' : 'rejected', findings: [], provider: dlpResult.provider });
                    guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'blocked' }).catch(() => {});
                    send('done', {}); res.end(); return;
                }

                if (decision.rememberForConversation && decision.choice !== 'block') {
                    dlpRunner.setConversationPref(convId, decision.choice);
                }

                if (decision.choice === 'block') {
                    send('dlp_blocked', { reason: 'user_blocked', findings: [], provider: dlpResult.provider });
                    guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'blocked' }).catch(() => {});
                    send('done', {}); res.end(); return;
                }
                if (decision.choice === 'redact') {
                    const lastMsg = messages[messages.length - 1];
                    const rawText = typeof lastMsg.content === 'string'
                        ? lastMsg.content
                        : (Array.isArray(lastMsg.content) ? (lastMsg.content.find(p => p.type === 'text')?.text || '') : '');
                    const { tokenizedText, tokenMap } = dlpRunner.applyRedactionChoice({
                        conversationId: convId, text: rawText, findings: dlpResult.findings,
                    });
                    applyRedactionToMessages(tokenizedText);
                    piiTokenMap = tokenMap;
                    const dlpCount = Object.keys(tokenMap).length;
                    const dlpCats = Object.keys(dlpResult.summary || {});
                    send('dlp_resolved', {
                        appliedChoice: 'redact',
                        redactedCount: dlpCount,
                        provider: dlpResult.provider,
                        categories: dlpCats,
                        automatic: false,
                        decisionMs: Date.now() - scanStart,
                    });
                    _userPrivacyMeta = { dlpRedactedCount: dlpCount, dlpCategories: dlpCats };
                    _assistantTokenisationInfo = {
                        source: 'dlp',
                        action: 'redact',
                        count: dlpCount,
                        categories: dlpCats,
                        provider: dlpResult.provider?.displayName || null,
                        automatic: false,
                    };
                    if (resolvedShield?.showRawPayload && tokenizedText) {
                        send('privacy_payload', {
                            tokenizedPrompt: tokenizedText,
                            provider: modelId || null,
                            source: 'dlp',
                            timestamp: Date.now(),
                        });
                        _assistantTokenisationInfo.tokenizedPrompt = tokenizedText;
                        if (tokenMap && Object.keys(tokenMap).length > 0) {
                            send('privacy_token_map', { tokenMap, source: 'dlp' });
                            _assistantTokenisationInfo.tokenMap = tokenMap;
                        }
                    }
                    // System-prompt addendum — see auto-redact branch above.
                    if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
                        const _convMap = dlpRunner.getConversationTokenMap(convId);
                        messages[0].content += buildTokenPreservationAddendum(_convMap);
                    }
                    guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'redacted' }).catch(() => {});
                } else {
                    // 'allow'
                    send('dlp_resolved', {
                        appliedChoice: 'allow',
                        redactedCount: 0,
                        provider: dlpResult.provider,
                        categories: Object.keys(dlpResult.summary || {}),
                        automatic: false,
                        decisionMs: Date.now() - scanStart,
                    });
                    guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'allowed' }).catch(() => {});
                }
            } else if (dlpResult.scanStatus === 'failed') {
                guardrailEventStore.logDlpDecision({ ...auditBase, violation_categories: 'scan_failed', action_taken: 'scan_failed' }).catch(() => {});
            }
        }

        // ─── Regex Guardrails ────────────────────────────────────────
        const { resolveShieldFor, mergeWithOrgShield } = require('../../core/orgShield');

        // 1. Resolve the privacy shield for this turn. Org-bound users get
        //    their org shield; consumer accounts (no org) fall back to their
        //    own user-level shield from the personal Privacy Shield settings.
        const orgShieldConfig = await resolveShieldFor({ orgId: userOrgId, userId: req.session?.user?.id });
        if (orgShieldConfig) {
            const scope = userOrgId ? `org ${userOrgId}` : `user ${req.session?.user?.id}`;
            console.log(`[DirectChat] Privacy Shield active for ${scope} (${orgShieldConfig.rulesWithNames.length} rules)`);
        }

        // 2. Resolve direct-chat-specific regex guardrails
        const dcRegexConfig = await configStore.getConfig('direct_chat_regex_guardrails');
        let dcLocalConfig = null;

        if (dcRegexConfig?.enabled) {
            const globalConfig = await getAIConfig();
            const globalRegexConfig = globalConfig.regexGuardrails || {};
            const globalRules = globalRegexConfig.rules || [];
            const globalCollections = globalRegexConfig.collections || [];

            let rulesWithNames = [];
            if (dcRegexConfig.collectionIds?.length > 0) {
                for (const colId of dcRegexConfig.collectionIds) {
                    const collection = globalCollections.find(c => c.id === colId);
                    if (collection) {
                        for (const ruleId of collection.ruleIds || []) {
                            const rule = globalRules.find(r => r.id === ruleId);
                            if (rule?.pattern) {
                                rulesWithNames.push({ name: rule.name, pattern: rule.pattern });
                            }
                        }
                    }
                }
            }

            const scope = dcRegexConfig.scope || { userInput: true, agentOutput: true };
            const action = dcRegexConfig.action || 'delete';
            if (rulesWithNames.length > 0) {
                dcLocalConfig = { enabled: true, rulesWithNames, scope, action };
            }
        }

        // 3. Merge: org shield + direct chat guardrails
        let regexConfig = mergeWithOrgShield(orgShieldConfig, dcLocalConfig);

        // Check user input against regex rules
        if (regexConfig?.enabled && regexConfig?.scope?.userInput) {
            const matches = checkRegexPatterns(message, regexConfig.rulesWithNames);
            if (matches.length > 0) {
                const ruleNames = matches.map(m => m.ruleName).join(', ');
                console.log(`[DirectChat RegexGuard] User input violated rules: ${ruleNames}, action: ${regexConfig.action}`);

                if (regexConfig.action === 'redact') {
                    // Redact matched patterns and send event
                    let redactedMessage = message;
                    for (const rule of regexConfig.rulesWithNames) {
                        try {
                            const regex = new RegExp(rule.pattern, 'gi');
                            redactedMessage = redactedMessage.replace(regex, `[REDACTED: ${rule.name}]`);
                        } catch (e) { /* skip invalid patterns */ }
                    }
                    send('content_redact', {
                        originalMessage: message,
                        redactedMessage,
                        rules: ruleNames,
                        autoRedactSeconds: 5
                    });
                    // Replace message in the messages array
                    const lastMsg = messages[messages.length - 1];
                    if (typeof lastMsg.content === 'string') {
                        lastMsg.content = redactedMessage;
                    }
                } else {
                    // Delete: send violation and stop
                    send('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5 });
                    send('done', {});
                    res.end();
                    return;
                }
            }
        }

        // ─── Conversation Compaction ─────────────────────────────────
        // Summarize old messages to reduce token usage on long conversations
        try {
            const { compactMessages } = require('../../core/compaction');
            const convMessageCount = messages.filter(m => m.role !== 'system').length;
            const compactionResult = await withPhase(send, 'compacting', null, () => compactMessages(messages, {
                existingSummary: conversationSummary,
                summaryModelId: 'tier:fast',
                userOrgId: userOrgForTiers,
            }));
            messages = compactionResult.messages;
            if (compactionResult.newSummary) {
                conversationSummary = compactionResult.newSummary;
                const compactedCount = messages.filter(m => m.role !== 'system').length;
                send('token_savings', {
                    type: 'compaction',
                    messagesBefore: convMessageCount,
                    messagesAfter: compactedCount,
                });
                console.log(`[DirectChat] 📦 Compaction: ${convMessageCount} → ${compactedCount} messages`);
            }
        } catch (err) {
            console.warn('[DirectChat] Compaction failed, using full history:', err.message);
        }

        // ─── Tool calling loop via unified adapter.chat() ──────────
        const tierSettings = tiers[resolvedTier] || {};
        const { TIER_DEFAULTS } = require('../../core/modelResolver');
        const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const isThinkingModel = modelId.includes('magistral');
        const defaultMaxTokens = isThinkingModel ? 40960 : tierDefaults.maxTokens;
        // Builder tools write whole files (html/css/js) inside a single
        // `webpage_file_write` tool call. On the `fast` tier that's
        // maxTokens=2048 — Anthropic stops mid-string and the file ships
        // truncated, leaving the page broken. Bump the cap whenever the
        // webpage builder tools are in the tool list, regardless of tier,
        // so the AI has room for a realistic file in one tool call.
        const wantsWebpageBuilder = directChatTools.some(t => t?.function?.name === 'webpage_file_write');
        const WEBPAGE_BUILD_MIN_TOKENS = 16384;
        const baseMaxTokens = tierSettings.maxTokens || defaultMaxTokens;
        const effectiveMaxTokens = wantsWebpageBuilder
            ? Math.max(baseMaxTokens, WEBPAGE_BUILD_MIN_TOKENS)
            : baseMaxTokens;

        const chatOptions = {
            maxTokens: effectiveMaxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
            // Per-turn user choice from the composer takes priority over the tier default.
            // Accepts: 'none' (disabled), 'low', 'medium', 'high', 'xhigh', 'max'.
            reasoningEffort: requestReasoningEffort || tierSettings.reasoningEffort || tierDefaults.reasoningEffort || undefined,
            reasoningSummary: tierSettings.reasoningSummary !== undefined ? tierSettings.reasoningSummary : (tierDefaults.reasoningSummary || false),
            budgetTokens: tierSettings.budgetTokens || undefined,
            // Azure-specific
            apiVersion: config.apiVersion || undefined,
            // OpenAI Responses API chaining — skip re-uploading full history
            previousResponseId: lastResponseId || undefined,
        };

        // Skip tool pre-check for all SDK-based providers
        // All providers handle tool calls natively in streaming — no need for a separate non-streaming call
        const skipToolPrecheck = adapter.shouldUseResponsesApi?.(modelId, chatOptions) || ['google', 'openai', 'claude', 'mistral'].includes(config.providerType);
        let toolCallRounds = 0;
        const MAX_TOOL_ROUNDS = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 5;
        // Step-machine guard. Completion is explicit — the LLM calls
        // `complete_session_skill` to advance. Without explicit completion,
        // the LLM streams its final answer alongside integration-tool calls
        // in the same turn and the "walk the pipeline" guarantee is lost.
        //
        // State table:
        //   - no pipeline / all terminals completed  →  'auto' (final answer)
        //   - nothing active, ready step exists      →  force activate(next-ready)
        //   - step active, not completed             →  'auto' (integration tools)
        //   - step active, >=N rounds w/o complete   →  force complete(current)
        //
        // Muting: text deltas are dropped (tool calls still flow) until
        // `allTerminalsCompleted` is true. Prevents the LLM from smuggling a
        // "final answer" out inside a mid-pipeline tool-call response.
        let roundsInCurrentStep = 0;
        const SOFT_COMPLETE_CAP = 3;

        // Provider-specific tool_choice shape. OpenAI/Mistral expect the
        // nested form; our Claude adapter consumes a flat {name}; Google's
        // adapter doesn't support specific-function — fall back to 'required'.
        function specificToolChoice(toolName) {
            const pt = (config?.providerType || '').toLowerCase();
            if (pt === 'claude') return { name: toolName };
            if (pt === 'google' || pt === 'gemini') return 'required';
            return { type: 'function', function: { name: toolName } };
        }

        function computeStepMachineGuard() {
            if (!isStandardTier) return { toolChoice: 'auto', systemAppend: null, mode: 'auto', mute: false };
            const state = describeStepMachineState(sessionSkills, activatedSessionSkillIds, completedSessionSkillIds);
            if (!state.hasPipeline || state.allTerminalsCompleted) {
                return { toolChoice: 'auto', systemAppend: null, mode: 'final', mute: false };
            }
            const byId = new Map(sessionSkills.map(s => [s.id, s]));

            // A step is mid-work — the LLM should be using integration tools
            // and then calling complete_session_skill. If it keeps firing
            // tools without completing, force the completion after the cap.
            if (state.currentActiveId) {
                const activeName = byId.get(state.currentActiveId)?.name || state.currentActiveId;
                if (roundsInCurrentStep >= SOFT_COMPLETE_CAP) {
                    return {
                        toolChoice: specificToolChoice(COMPLETE_SESSION_SKILL_TOOL_NAME),
                        systemAppend: `\n\n[PIPELINE GUARD] Step "${activeName}" has run ${roundsInCurrentStep} tool-call rounds without completing. Your NEXT call MUST be \`${COMPLETE_SESSION_SKILL_TOOL_NAME}\` with \`{ skill_id: "${state.currentActiveId}", summary: "<what this step produced>" }\` so the pipeline can advance.`,
                        mode: `forced-complete:${state.currentActiveId}`,
                        mute: true,
                    };
                }
                // Auto tool_choice — let the LLM pick integration tools for
                // this step's work. Text deltas still muted (pipeline not done).
                return { toolChoice: 'auto', systemAppend: null, mode: `active:${state.currentActiveId}`, mute: true };
            }

            // Nothing active — force activation of the next ready step.
            if (state.nextReadyId) {
                const readyName = byId.get(state.nextReadyId)?.name || state.nextReadyId;
                return {
                    toolChoice: specificToolChoice(ACTIVATE_SESSION_SKILL_TOOL_NAME),
                    systemAppend: `\n\n[PIPELINE GUARD] No step currently active. Your NEXT call MUST be \`${ACTIVATE_SESSION_SKILL_TOOL_NAME}\` with skill_ids=["${state.nextReadyId}"] (${readyName}) before any other tool.`,
                    mode: `forced-activate:${state.nextReadyId}`,
                    mute: true,
                };
            }

            // Pipeline exists but no active + no ready (e.g. all activated,
            // completion pending for terminal). Force complete on the last
            // activated-not-completed skill; fall back to 'auto' if we can't
            // identify one (shouldn't happen in practice).
            return { toolChoice: 'required', systemAppend: null, mode: 'required', mute: true };
        }

        // Safe append to the original system message (messages[0]) instead of
        // pushing a new message. No ordering violation possible.
        function applySystemAppend(text) {
            if (!text || !messages[0]) return;
            if (messages[0].role === 'system' && typeof messages[0].content === 'string') {
                // Avoid re-appending the same guard on repeat rounds.
                if (!messages[0].content.endsWith(text)) messages[0].content += text;
            }
        }

        // True while the step machine still has work to do — used by the
        // streamed-tool while loop to force another round when the LLM
        // stopped emitting tool calls mid-pipeline (text was muted, so
        // without this the user would see an empty reply).
        function pipelineNeedsWrapUp() {
            if (!isStandardTier) return false;
            if (!Array.isArray(sessionSkills) || sessionSkills.length === 0) return false;
            const state = describeStepMachineState(sessionSkills, activatedSessionSkillIds, completedSessionSkillIds);
            return state.hasPipeline && !state.allTerminalsCompleted;
        }

        // Shared side-effect handler for when the LLM calls complete_session_skill.
        // Both the pre-check path and the streamed-tool path invoke this so the
        // completion set + UI event stay in sync no matter which adapter fired.
        function handleSessionSkillCompleteResult(toolArgs, toolResult) {
            if (!toolResult?.success) return;
            if (Array.isArray(toolResult.completedSessionSkillIds)) {
                completedSessionSkillIds = Array.from(new Set(toolResult.completedSessionSkillIds));
            } else if (toolResult.skill_id) {
                completedSessionSkillIds = Array.from(new Set([...completedSessionSkillIds, toolResult.skill_id]));
            }
            const skillId = toolResult.skill_id || toolArgs?.skill_id;
            const skill = sessionSkills.find(s => s.id === skillId);
            const entry = {
                skillId,
                skillName: skill?.name || skillId,
                summary: toolResult.summary || toolArgs?.summary || '',
                order: skill?.order || null,
                total: sessionSkills.length,
                at: Date.now(),
            };
            sessionSkillsCompletions = [...sessionSkillsCompletions, entry];
            roundsInCurrentStep = 0;
            send('session_skill_completed', entry);
            send('session_skills_updated', {
                skills: sessionSkills,
                activatedSkillIds: activatedSessionSkillIds,
                completedSkillIds: completedSessionSkillIds,
            });
        }

        // Try the adapter call; if the provider rejects due to
        // invalid_request_message_order or similar bad-shape 400s, retry once
        // with toolChoice: 'auto' to unblock the user.
        async function callAdapterWithFallback(fn, currentToolChoice) {
            try {
                return await fn(currentToolChoice);
            } catch (err) {
                const msg = String(err?.message || '');
                const isBadShape = /invalid_request_message_order|Unexpected role|invalid.*tool_choice/i.test(msg);
                if (!isBadShape) throw err;
                console.warn(`[DirectChat pipeline] Adapter rejected toolChoice — retrying with 'auto'. Original: ${msg}`);
                return await fn('auto');
            }
        }
        const generatedImages = []; // Track images for persistence
        const generatedAudio = []; // Track audio for persistence
        const collectedEmailDrafts = [];
        const collectedCalendarDrafts = [];
        const collectedMapEmbeds = [];
        const collectedToolHistory = []; // Track tool calls for persistence
        let notebookWriteCommitted = false; // Set when a notebook tool actually persisted non-empty content; gates the "I wrote it to your Notebook" fallback below.

        // Strip internal metadata (_mcp etc.) before sending tools to LLM — providers may reject unknown fields
        directChatTools = directChatTools.map(t => {
            const { _mcp, _n8n, ...clean } = t;
            return clean;
        });

        // Eager-create moved above the attachment scan so `convId` is
        // available when the attachment scanner calls
        // `dlpRunner.mergeTokenMap(convId, …)`. See the block earlier in
        // this route just before attachment processing.

        // ─── PII token-preservation system-prompt addendum ─────────────
        // For message-level PII and DLP, the addendum is appended inside
        // those blocks at the point of tokenisation. Attachment-only turns
        // (clean user prompt, tokens came only from a PDF/Office scan)
        // never enter those blocks, so without this fallback the model has
        // no idea what `[person_N]` placeholders mean — it then volunteers
        // meta-commentary like "deze namen zijn geanonimiseerd" which
        // confuses the end user (who actually sees the un-tokenised names
        // in the rendered output). Mirrors the unconditional injection
        // already used by [chatStream.js:1196](server/core/agentRuntime/chatStream.js#L1196).
        // Idempotent: skips when the addendum tag is already in the system
        // prompt (i.e. an earlier in-block injection already fired this turn).
        try {
            if (messages[0]?.role === 'system' && typeof messages[0].content === 'string'
                && !messages[0].content.includes('[PII TOKEN PRESERVATION')) {
                const _convMap = require('../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                const _add = buildTokenPreservationAddendum(_convMap);
                if (_add) messages[0].content += _add;
            }
        } catch (_) { /* addendum is best-effort; missing it just means the model may
                        meta-comment on placeholders — not a runtime failure */ }

        // ─── Streaming un-tokeniser ───────────────────────────────────
        // Mirrors the pattern at [chatStream.js:762](server/core/agentRuntime/chatStream.js#L762).
        // Without this, content chunks emitted by the LLM containing `[person_N]`
        // tokens flash to the user as raw placeholders until the end-of-stream
        // `content_replace` swaps them. With this in place, each chunk passes
        // through a buffered un-tokeniser that holds a `[…` tail until the
        // closing `]` arrives, then replaces in-place — so the user only ever
        // sees real values during streaming.
        // The un-tokeniser uses a LIVE getter on the conversation map so tokens
        // added mid-turn (rare but possible) are picked up.
        const { createUntokeniser: _createUntok } = require('../../core/dlp/untokeniseStream');
        const _dlpRunnerForStream = require('../../core/dlp/dlpRunner');
        const _streamUntok = _createUntok(() => _dlpRunnerForStream.getConversationTokenMap(convId));
        // Tiny wrapper used by both the primary stream callback and the
        // follow-stream callback below in place of `send('content', ...)`.
        const streamContent = (text) => {
            if (!text) return;
            const safe = _streamUntok.push(text);
            if (safe) send('content', { text: safe });
        };
        // Flush helper — call at end-of-stream so any trailing partial token
        // tail is released. The end-of-stream restoration step also runs a
        // full-text `restoreTokens` as a safety net, so missing a flush would
        // not cause a permanent leak — it would just delay the replacement
        // by one event.
        const streamContentFlush = () => {
            const tail = _streamUntok.flush();
            if (tail) send('content', { text: tail });
        };

        while (toolCallRounds < MAX_TOOL_ROUNDS) {
            if (directChatTools.length > 0 && !skipToolPrecheck) {
                // Non-streaming tool check via adapter.chat()
                let result;
                try {
                    const guard = computeStepMachineGuard();
                    applySystemAppend(guard.systemAppend);
                    console.log(`[DirectChat pipeline] pre-check round=${toolCallRounds} active=${activatedSessionSkillIds.length} completed=${completedSessionSkillIds.length}/${sessionSkills.length} toolChoice=${guard.mode} roundsInStep=${roundsInCurrentStep}`);
                    result = await callAdapterWithFallback(
                        (tc) => adapter.chat(apiKey, apiUrl, modelId, applyTokenMapToMessages({ conversationId: convId, messages }), {
                            ...chatOptions,
                            tools: directChatTools,
                            toolChoice: tc,
                        }),
                        guard.toolChoice,
                    );
                } catch (err) {
                    console.error('[DirectChat] Tool check error:', err.message);
                    send('error', { error: `API error: ${err.message}` });
                    res.end();
                    return;
                }

                if (result.toolCalls && result.toolCalls.length > 0) {
                    // Step-machine bookkeeping: activation resets the in-step
                    // counter (new step started); completion reset happens
                    // inside handleSessionSkillCompleteResult after dispatch.
                    // Any other tool-only round advances the counter toward
                    // the soft cap that force-requires complete_session_skill.
                    const calledActivation = result.toolCalls.some(tc => (tc.function?.name || tc.name) === ACTIVATE_SESSION_SKILL_TOOL_NAME);
                    const calledCompletion = result.toolCalls.some(tc => (tc.function?.name || tc.name) === COMPLETE_SESSION_SKILL_TOOL_NAME);
                    if (calledActivation) roundsInCurrentStep = 0;
                    else if (!calledCompletion) roundsInCurrentStep += 1;
                    // Add assistant message with tool calls to history
                    messages.push({
                        role: 'assistant',
                        content: result.content || null,
                        tool_calls: result.toolCalls,
                    });
                    toolCallRounds++;

                    // Execute all tool calls in parallel
                    const userAuth = await getUserAuth(req);
                    const toolPromises = result.toolCalls.map(async (toolCall) => {
                        const toolName = toolCall.function?.name || toolCall.name;
                        let toolArgs = {};
                        try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) { }

                        console.log(`[DirectChat] Executing tool: ${toolName}`, toolArgs);
                        send('tool_start', { name: toolName, args: toolArgs });

                        let tierOverrides = null;
                        try {
                            const tierToolParams = await configStore.getConfig('direct_chat_tier_tool_params') || {};
                            tierOverrides = tierToolParams[resolvedTier]?.[toolName] || null;
                        } catch (cfgErr) {
                            console.warn(`[DirectChat] Config lookup failed (tier_tool_params): ${cfgErr.message}`);
                        }

                        let toolResult;
                        let outboundProbe1 = null;
                        try {
                            // Web Search Guard — validate agent_search queries
                            if (toolName === 'agent_search' && toolArgs?.query) {
                                // 1. Regex guardrails on search query
                                if (regexConfig?.enabled) {
                                    const qMatches = checkRegexPatterns(toolArgs.query, regexConfig.rulesWithNames);
                                    if (qMatches.length > 0) {
                                        const ruleNames = qMatches.map(m => m.ruleName).join(', ');
                                        console.log(`[DirectChat WebSearchGuard] Search query BLOCKED by regex: ${ruleNames}`);
                                        guardrailEventStore.logGuardrailEvent({
                                            organization_id: userOrgId || null,
                                            user_id: userId,
                                            conversation_id: convId || null,
                                            violation_type: 'regex',
                                            violation_categories: ruleNames,
                                            direction: 'input',
                                            action_taken: 'search_blocked',
                                            source: 'direct',
                                            model: modelId || null,
                                        }).catch(() => {});
                                        send('tool_end', { name: toolName, result: '[Web search blocked — query violates content policy]' });
                                        return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Web search blocked — query violates content policy. Please rephrase.' }) };
                                    }
                                }
                                // 2. PII Detection on search query (always runs for monitoring)
                                if (webSearchGuardPiiCategories && webSearchGuardPiiCategories.length > 0) {
                                    try {
                                        const { detectPii } = require('../../core/piiDetection');
                                        const piiResult = await detectPii(toolArgs.query, webSearchGuardPiiCategories);
                                        if (piiResult?.hasPii) {
                                            const cats = [...new Set(piiResult.entities.map(e => e.label))].join(', ');
                                            // Always log PII detection for monitoring
                                            guardrailEventStore.logGuardrailEvent({
                                                organization_id: userOrgId || null,
                                                user_id: userId,
                                                conversation_id: convId || null,
                                                violation_type: 'pii',
                                                violation_categories: cats,
                                                direction: 'input',
                                                action_taken: webSearchGuardEnabled ? 'search_blocked' : 'pii_detected',
                                                source: 'direct',
                                                model: modelId || null,
                                            }).catch(() => {});
                                            // Only block when Web Search Guard is enabled
                                            if (webSearchGuardEnabled) {
                                                console.log(`[DirectChat WebSearchGuard] Search query BLOCKED by PII (${cats})`);
                                                send('tool_end', { name: toolName, result: `[Web search blocked — query contains sensitive information (${cats})]` });
                                                return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: `Web search blocked — query contains sensitive personal information (${cats}). Please rephrase without PII.` }) };
                                            } else {
                                                console.log(`[DirectChat WebSearchGuard] PII detected in search query (${cats}) — monitoring only, search allowed`);
                                            }
                                        }
                                        console.log(`[DirectChat WebSearchGuard] Search query PII check passed`);
                                    } catch (piiErr) {
                                        console.warn(`[DirectChat WebSearchGuard] PII check failed (fail-open):`, piiErr.message);
                                    }
                                }
                            }
                            if (toolName === 'propose_webpage_plan') {
                                toolResult = executeProposeWebpagePlan(toolArgs);
                                if (toolResult._action === 'webpage_plan_proposed') {
                                    webpagePlanProposedThisTurn = true;
                                    send('webpage_plan_proposed', {
                                        planId: toolResult.planId,
                                        plan: toolResult.plan,
                                    });
                                }
                            } else if (isBuilderTool(toolName)) {
                                const builderOut = await executeBuilderTool(toolName, toolArgs, { userId, readSlots: webpageBuilderReadSlots });
                                toolResult = builderOut.result;
                                if (builderOut.webpageUpdate) {
                                    const { webpageId, file, content, title } = builderOut.webpageUpdate;
                                    send('webpage_doc_update', { webpageId, file, content, title });
                                }
                            } else if (isDbTool(toolName)) {
                                const dbWebpageId = toolArgs?.webpageId;
                                if (!dbWebpageId) {
                                    toolResult = { error: 'webpageId is required — pass the id returned by create_webpage.' };
                                } else {
                                    const { webpageId: _wp, ...dbArgs } = toolArgs || {};
                                    toolResult = await executeDbTool(toolName, dbArgs, { webpageId: dbWebpageId, userId });
                                    if (toolResult?._action === 'webpage_db_update') {
                                        send('webpage_db_update', { webpageId: dbWebpageId });
                                    }
                                }
                            } else {
                                const dispatched1 = await runWithProbe(async () => {
                                    const preMeta = resolveIntegrationMeta(toolName, toolArgs || {});
                                    if (preMeta?.isLocal) markLocal(preMeta.label || preMeta.integration);
                                    return await dispatchTool(toolName, toolArgs, {
                                    userId,
                                    session: req.session,
                                    userAuth,
                                    fixedParams: tierOverrides,
                                    agentId: null,
                                    conversationId: convId,
                                    orgId: n8nOrgId,
                                    send,
                                    imageGenSettings,
                                    nanoBananaSettings,
                                    req,
                                    attachments,
                                    sessionSkills,
                                    activatedSessionSkillIds,
                                    completedSessionSkillIds,
                                    roundsInCurrentStep,
                                    timezone: timezone || 'Europe/Amsterdam',
                                    onImageGenerated: (data) => generatedImages.push(data),
                                    terminalCtx: {
                                        agentId: `user-${userId}`,
                                        containerKey: `direct-${convId}`,
                                        timeout: 60000,
                                        blockedCommands: [],
                                        onEvent: (type, data) => { send(type, data); },
                                        signal: undefined
                                    },
                                    });
                                });
                                toolResult = dispatched1.result;
                                outboundProbe1 = dispatched1.probe;
                            }
                        } catch (err) {
                            console.error(`[DirectChat] Tool execution failed for ${toolName}:`, err);
                            toolResult = { error: err.message };
                        }

                        if (toolName === ACTIVATE_SESSION_SKILL_TOOL_NAME && toolResult?.activatedSkillIds) {
                            activatedSessionSkillIds = Array.from(new Set(toolResult.activatedSkillIds));
                            roundsInCurrentStep = 0;
                            send('session_skills_updated', {
                                skills: sessionSkills,
                                activatedSkillIds: activatedSessionSkillIds,
                                completedSkillIds: completedSessionSkillIds,
                            });
                            await swapModelForActiveStage();
                        }
                        if (toolName === COMPLETE_SESSION_SKILL_TOOL_NAME) {
                            handleSessionSkillCompleteResult(toolArgs, toolResult);
                        }

                        send('tool_end', { name: toolName, result: toolResult });

                        // Track tool call for conversation persistence
                        collectedToolHistory.push({
                            name: toolName,
                            args: toolArgs,
                            status: 'done',
                            resultPreview: (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || '')).slice(0, 200),
                        });

                        // Log tool usage
                        try {
                            const usageStore = require('../../stores/usageStore');
                            await usageStore.logUsage({
                                user_id: userId,
                                agent_name: 'direct-chat',
                                agent_type: 'chat',
                                model: modelId,
                                tool_name: toolName,
                                source: 'direct_chat',
                                organization_id: userOrgId || null,
                                conversation_id: convId || null,
                            });
                        } catch (e) { /* ignore */ }

                        // ── Integration Activity Logging (async, non-blocking) ──
                        try {
                            const { resolveIntegration } = require('../../core/integrationToolMap');
                            const integMeta = resolveIntegration(toolName, toolArgs || {});
                            if (integMeta) {
                                const resultText = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || '');
                                configStore.getConfig(`org_privacy_shield_${userOrgId}`).then(async shield => {
                                    if (!shield?.monitorIntegrations) return;
                                    // PII scan: use Azure/CPU model with ALL categories, respect org confidence threshold
                                    let piiDetected = null;
                                    try {
                                        const { detectPii } = require('../../core/piiDetection');
                                        const threshold = typeof shield.piiDetectionConfidenceThreshold === 'number'
                                            ? shield.piiDetectionConfidenceThreshold : 0.7;
                                        const piiResult = await detectPii(resultText.slice(0, 5000), null, threshold);
                                        if (piiResult?.hasPii) {
                                            piiDetected = [...new Set(piiResult.entities.map(e => e.label))].join(', ');
                                        }
                                    } catch (piiErr) { /* fail-open: log without PII data */ }
                                    const integStore = require('../../stores/integrationActivityStore');
                                    integStore.logIntegrationActivity({
                                        organization_id: userOrgId || null,
                                        user_id: userId,
                                        conversation_id: convId || null,
                                        tool_name: toolName,
                                        integration_type: integMeta.integration,
                                        server_endpoint: integMeta.server,
                                        data_direction: integMeta.direction,
                                        data_categories: integMeta.dataCategories,
                                        pii_categories_detected: piiDetected || null,
                                        pii_scan_enabled: true,
                                        source: 'direct_chat',
                                        model: modelId || null,
                                        probe: (outboundProbe1 && integMeta.isLocal) ? { ...outboundProbe1, is_local: true } : outboundProbe1,
                                    }).catch(e => console.error('[IntegrationActivityLog] Error:', e.message));
                                }).catch(() => {});
                            }
                        } catch (e) { /* ignore */ }

                        // Return raw toolResult so draft dedup can run sequentially after Promise.all
                        return {
                            _toolResult: toolResult,
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(compactToolResultForLLM(toolResult))
                        };
                    });

                    const toolResults = await Promise.all(toolPromises);

                    // Process draft SSE events sequentially (after all tools settle) to avoid race conditions
                    for (const tr of toolResults) {
                        const toolResult = tr._toolResult;
                        if (!toolResult) continue;
                        // Emit email_draft SSE event for user approval (with dedup)
                        if (toolResult._action === 'email_draft') {
                            const draftKey = JSON.stringify({ to: toolResult.draft?.to, subject: toolResult.draft?.subject, body: toolResult.draft?.body });
                            const alreadySent = collectedEmailDrafts.some(d => JSON.stringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey);
                            if (!alreadySent) {
                                send('email_draft', toolResult.draft);
                                collectedEmailDrafts.push(toolResult.draft);
                            }
                        }
                        // Emit calendar_draft SSE event for user approval (with dedup)
                        if (toolResult._action === 'calendar_draft') {
                            const draftKey = JSON.stringify({ summary: toolResult.draft?.summary, start: toolResult.draft?.start, end: toolResult.draft?.end });
                            const alreadySent = collectedCalendarDrafts.some(d => JSON.stringify({ summary: d.summary, start: d.start, end: d.end }) === draftKey);
                            if (!alreadySent) {
                                send('calendar_draft', toolResult.draft);
                                collectedCalendarDrafts.push(toolResult.draft);
                            }
                        }
                        // Emit linkedin_draft SSE event for user approval
                        if (toolResult._action === 'linkedin_draft') {
                            send('linkedin_draft', toolResult.draft);
                        }
                        // Emit contacts_draft SSE event for user approval
                        if (toolResult._action === 'contacts_draft') {
                            send('contacts_draft', toolResult.draft);
                        }
                        // Emit keep_draft SSE event for user approval
                        if (toolResult._action === 'keep_draft') {
                            send('keep_draft', toolResult.draft);
                        }
                        // Emit workspace_update SSE event. Render-time un-tokenisation:
                        // the stored workspace_content keeps the raw tokens (so the AI
                        // can re-read them via notebook_read in a later turn), but the
                        // user-facing SSE payload gets `[person_N]` → real values
                        // restored from the conversation token map.
                        if (toolResult._action === 'workspace_update' && toolResult.content && toolResult.content.trim()) {
                            const { restoreTokens } = require('../../core/piiDetection');
                            const _convMapForWs = require('../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                            const rendered = restoreTokens(toolResult.content, _convMapForWs);
                            send('workspace_update', { content: rendered });
                            notebookWriteCommitted = true;
                        }
                        // Emit kb_sources SSE event
                        if (toolResult._action === 'kb_sources' && toolResult._sources?.length > 0) {
                            send('kb_sources', { sources: toolResult._sources });
                        }
                        // Track audio URLs for persistence
                        if (toolResult.audioUrl) {
                            generatedAudio.push({ url: toolResult.audioUrl, source: tr.name });
                        }
                    }

                    // Strip internal _toolResult before pushing to messages
                    messages.push(...toolResults.map(({ _toolResult, ...rest }) => rest));
                    // If the AI proposed a webpage plan this round, halt the
                    // tool loop so the user can approve before any work
                    // happens. The streamed final response below still runs so
                    // the chat shows the AI's "I'd like to do X — review the
                    // plan above" message.
                    if (webpagePlanProposedThisTurn) break;
                    continue;
                }
            }
            break;
        }

        // ─── Stream final response via adapter.stream() ──────────
        let fullContent = '';
        let thinkingContent = '';
        let thinkingParts = []; // Structured parts with signatures/timing for persistence + UI
        let streamToolCalls = []; // Tool calls received during streaming (Google SDK)
        let streamUsage = null;
        const streamStartTime = Date.now();

        // Shared helpers — both the primary stream and the tool-follow-up stream use them.
        const _getThinkingPart = (partId) => {
            if (!partId) return null;
            let part = thinkingParts.find(p => p.id === partId);
            if (!part) {
                part = { id: partId, text: '', startedAt: Date.now(), endedAt: null };
                thinkingParts.push(part);
            }
            return part;
        };

        // Pipeline guard at the streaming-call boundary: same rule as the
        // pre-check path — while a session-skill pipeline is mid-run, the
        // LLM is forced to keep calling tools instead of emitting final text.
        const streamGuard = computeStepMachineGuard();
        applySystemAppend(streamGuard.systemAppend);
        console.log(`[DirectChat pipeline] primary stream active=${activatedSessionSkillIds.length} completed=${completedSessionSkillIds.length}/${sessionSkills.length} toolChoice=${streamGuard.mode} mute=${streamGuard.mute} roundsInStep=${roundsInCurrentStep}`);
        // Tracks the mute state for the current stream round. Updated again
        // before the follow-up stream so each round gets a fresh read.
        let muteAssistantText = !!streamGuard.mute;
        const streamOptions = {
            ...chatOptions,
            tools: (toolCallRounds > 0) ? undefined : (directChatTools.length > 0 ? directChatTools : undefined),
            toolChoice: (toolCallRounds > 0)
                ? undefined
                : (directChatTools.length > 0 ? streamGuard.toolChoice : undefined),
        };

        const streamCallback = (type, data) => {
            if (type === 'text') {
                // Pipeline mute: drop text deltas while a step-machine round is
                // still walking the pipeline. Tool calls always pass. This is
                // the hard guarantee that the "final answer" can't arrive
                // alongside mid-pipeline integration tool calls.
                if (muteAssistantText) return;
                fullContent += data.text;
                // Pass through the streaming un-tokeniser so `[person_N]` etc.
                // are replaced as they stream — the user never sees raw
                // placeholders mid-response. A final `content_replace` after
                // the stream ends covers any trailing partial.
                streamContent(data.text);
            } else if (type === 'thinking_start') {
                if (data.partId) {
                    const part = _getThinkingPart(data.partId);
                    if (data.redacted) part.redacted = true;
                    send('thinking_start', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'thinking') {
                thinkingContent += data.text;
                if (data.partId) {
                    const part = _getThinkingPart(data.partId);
                    part.text += data.text;
                } else {
                    // No partId — implicit single block (old adapters / raw SSE path)
                    let part = thinkingParts[thinkingParts.length - 1];
                    if (!part || part.endedAt) {
                        part = { id: `auto-${thinkingParts.length}`, text: '', startedAt: Date.now(), endedAt: null };
                        thinkingParts.push(part);
                    }
                    part.text += data.text;
                }
                send('thinking', { text: data.text, partId: data.partId });
            } else if (type === 'thinking_signature') {
                // Persisted server-side (for Claude replay), never sent to SSE.
                if (data.partId && data.signature) {
                    const part = _getThinkingPart(data.partId);
                    part.signature = data.signature;
                }
            } else if (type === 'thinking_stop') {
                if (data.partId) {
                    const part = _getThinkingPart(data.partId);
                    part.endedAt = Date.now();
                    if (data.redacted) part.redacted = true;
                    send('thinking_stop', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'tool_use') {
                // SDK adapter returns tool calls directly in the stream
                streamToolCalls.push({
                    id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: data.name,
                        arguments: JSON.stringify(data.input || {}),
                    },
                    _thought_signature: data.thought_signature || undefined,
                });
            } else if (type === 'image') {
                // Image from Google image models — save for persistence
                const imgEntry = { data: data.data, mimeType: data.mimeType };
                generatedImages.push(imgEntry);
                send('image', { data: data.data, mimeType: data.mimeType });
                // Save to RustFS or local disk for persistence
                try {
                    const storageStore = require('../../stores/storageStore');
                    const crypto = require('crypto');
                    const ext = (data.mimeType || 'image/png').includes('jpeg') ? 'jpg' : 'png';
                    const filename = `img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
                    if (storageStore.isAvailable() && data.data) {
                        const key = storageStore.buildKey(userId, 'images', filename);
                        storageStore.uploadFile(key, Buffer.from(data.data, 'base64'), data.mimeType || 'image/png')
                            .then(() => { imgEntry.url = storageStore.buildProxyUrl(key); imgEntry.storageKey = key; })
                            .catch(e => console.warn('[DirectChat] Failed to save inline image to RustFS:', e.message));
                    } else if (data.data) {
                        // Fallback: local disk (synchronous — URL available for DB save)
                        const genDir = require('path').join(__dirname, '..', '..', 'data', 'uploads', 'generated');
                        if (!require('fs').existsSync(genDir)) require('fs').mkdirSync(genDir, { recursive: true });
                        require('fs').writeFileSync(require('path').join(genDir, filename), Buffer.from(data.data, 'base64'));
                        imgEntry.url = `/uploads/generated/${filename}`;
                    }
                } catch (e) { /* ignore */ }
            } else if (type === 'error') {
                send('error', data);
            } else if (type === 'done') {
                // Capture usage data from adapter
                streamUsage = data;
                // Capture OpenAI response ID for chaining
                if (data?.responseId) {
                    lastResponseId = data.responseId;
                    console.log('[DirectChat] Captured responseId for chaining:', lastResponseId);
                }
            }
        };

        // Final pre-LLM phase marker — emit only on the first round so the UI
        // status placeholder fades out before the first token arrives.
        if (toolCallRounds === 0) {
            emitPhase(send, 'streaming_start', modelId);
        }

        try {
            await adapter.stream(apiKey, apiUrl, modelId, applyTokenMapToMessages({ conversationId: convId, messages }), streamOptions, streamCallback);
        } catch (streamErr) {
            const errMsg = String(streamErr?.error?.message || streamErr?.message || '');
            // Retry without previousResponseId if the error is about missing tool output
            // (stale response ID pointing to unresolved tool-call response)
            if (errMsg.includes('No tool output found') && streamOptions.previousResponseId) {
                console.warn('[DirectChat] Stale previousResponseId detected, retrying without chaining');
                lastResponseId = null;
                streamOptions.previousResponseId = undefined;
                fullContent = '';
                thinkingContent = '';
                thinkingParts = [];
                streamToolCalls = [];
                await adapter.stream(apiKey, apiUrl, modelId, applyTokenMapToMessages({ conversationId: convId, messages }), streamOptions, streamCallback);
            } else if (/invalid_request_message_order|Unexpected role|invalid.*tool_choice/i.test(errMsg)) {
                // Pipeline-guard shape rejected by the provider — retry once
                // with permissive toolChoice so the user's message goes through.
                console.warn(`[DirectChat pipeline] Stream rejected — retrying with toolChoice='auto'. Original: ${errMsg}`);
                fullContent = '';
                thinkingContent = '';
                thinkingParts = [];
                streamToolCalls = [];
                await adapter.stream(apiKey, apiUrl, modelId, applyTokenMapToMessages({ conversationId: convId, messages }), { ...streamOptions, toolChoice: 'auto' }, streamCallback);
            } else {
                throw streamErr;
            }
        }

        // Log usage to monitoring store
        try {
            const usageStore = require('../../stores/usageStore');
            await usageStore.logUsage({
                user_id: userId,
                agent_name: 'direct-chat',
                agent_type: 'chat',
                model: modelId,
                prompt_tokens: streamUsage?.prompt_tokens || 0,
                completion_tokens: streamUsage?.completion_tokens || 0,
                total_tokens: streamUsage?.total_tokens || ((streamUsage?.prompt_tokens || 0) + (streamUsage?.completion_tokens || 0)),
                cached_tokens: streamUsage?.cached_tokens || 0,
                cache_creation_tokens: streamUsage?.cache_creation_tokens || 0,
                source: 'direct_chat',
                duration_ms: Date.now() - streamStartTime,
                organization_id: userOrgId || null,
                conversation_id: convId || null,
            });
        } catch (e) {
            console.warn('[DirectChat] Failed to log usage:', e.message);
        }

        // Handle tool calls received during streaming (Google SDK path)
        // Loop to support multi-round tool calling (e.g. list → get_summary)
        const MAX_STREAM_TOOL_ROUNDS = 15;
        let toolRound = 0;

        // Single callback used by both the wrap-up kickstart and the follow-up
        // stream. Captures outer closures (fullContent, thinkingContent,
        // streamToolCalls, muteAssistantText, thinkingParts, lastResponseId).
        const followStreamCallback = (type, data) => {
            if (type === 'text') {
                if (muteAssistantText) return;
                fullContent += data.text;
                // Same un-tokeniser wrap as the primary stream above.
                streamContent(data.text);
            } else if (type === 'thinking_start') {
                if (data.partId) {
                    const part = _getThinkingPart(data.partId);
                    if (data.redacted) part.redacted = true;
                    send('thinking_start', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'thinking') {
                thinkingContent += data.text;
                if (data.partId) {
                    const part = _getThinkingPart(data.partId);
                    part.text += data.text;
                } else {
                    let part = thinkingParts[thinkingParts.length - 1];
                    if (!part || part.endedAt) {
                        part = { id: `auto-${thinkingParts.length}`, text: '', startedAt: Date.now(), endedAt: null };
                        thinkingParts.push(part);
                    }
                    part.text += data.text;
                }
                send('thinking', { text: data.text, partId: data.partId });
            } else if (type === 'thinking_signature') {
                if (data.partId && data.signature) {
                    const part = _getThinkingPart(data.partId);
                    part.signature = data.signature;
                }
            } else if (type === 'thinking_stop') {
                if (data.partId) {
                    const part = _getThinkingPart(data.partId);
                    part.endedAt = Date.now();
                    if (data.redacted) part.redacted = true;
                    send('thinking_stop', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'tool_call') {
                streamToolCalls.push(data);
            } else if (type === 'tool_use') {
                // Claude SDK returns tool calls as tool_use events
                streamToolCalls.push({
                    id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: data.name,
                        arguments: JSON.stringify(data.input || {}),
                    },
                    _thought_signature: data.thought_signature || undefined,
                });
            } else if (type === 'error') {
                send('error', data);
            } else if (type === 'done') {
                if (data?.responseId) {
                    lastResponseId = data.responseId;
                    console.log('[DirectChat] Updated lastResponseId after tool follow-up:', lastResponseId);
                }
            }
        };

        while (
            (streamToolCalls.length > 0 || pipelineNeedsWrapUp()) &&
            toolRound < MAX_STREAM_TOOL_ROUNDS
        ) {
            // Pipeline wrap-up kickstart: the LLM emitted no tool calls but
            // the pipeline is still mid-walk (text was muted, so the user
            // would see an empty reply). Force another streaming round with
            // the step-machine tool_choice to coax it back onto the rails.
            if (streamToolCalls.length === 0) {
                const kickGuard = computeStepMachineGuard();
                applySystemAppend(kickGuard.systemAppend);
                muteAssistantText = !!kickGuard.mute;
                console.log(`[DirectChat pipeline] wrap-up kickstart round=${toolRound + 1} toolChoice=${kickGuard.mode} mute=${kickGuard.mute}`);
                const kickOptions = {
                    ...chatOptions,
                    previousResponseId: undefined,
                    tools: directChatTools.length > 0 ? directChatTools : undefined,
                    toolChoice: directChatTools.length > 0 ? kickGuard.toolChoice : undefined,
                };
                fullContent = '';
                try {
                    await adapter.stream(apiKey, apiUrl, modelId, applyTokenMapToMessages({ conversationId: convId, messages }), kickOptions, followStreamCallback);
                } catch (kickErr) {
                    const kMsg = String(kickErr?.error?.message || kickErr?.message || '');
                    if (/invalid_request_message_order|Unexpected role|invalid.*tool_choice/i.test(kMsg)) {
                        console.warn(`[DirectChat pipeline] Wrap-up rejected — retrying with toolChoice='auto'. Original: ${kMsg}`);
                        await adapter.stream(apiKey, apiUrl, modelId, applyTokenMapToMessages({ conversationId: convId, messages }), { ...kickOptions, toolChoice: 'auto' }, followStreamCallback);
                    } else {
                        throw kickErr;
                    }
                }
                // LLM still refused to emit tool calls — stop looping so we
                // don't spin. The final save path handles the empty reply.
                if (streamToolCalls.length === 0) {
                    console.warn('[DirectChat pipeline] Wrap-up yielded no tool calls — aborting pipeline walk.');
                    break;
                }
            }

            toolRound++;
            console.log(`[DirectChat] Streamed tool round ${toolRound}: ${streamToolCalls.map(t => t.function?.name).join(', ')}`);

            // Step-machine bookkeeping — mirror the pre-check path.
            {
                const calledActivation = streamToolCalls.some(tc => tc.function?.name === ACTIVATE_SESSION_SKILL_TOOL_NAME);
                const calledCompletion = streamToolCalls.some(tc => tc.function?.name === COMPLETE_SESSION_SKILL_TOOL_NAME);
                if (calledActivation) roundsInCurrentStep = 0;
                else if (!calledCompletion) roundsInCurrentStep += 1;
            }

            messages.push({
                role: 'assistant',
                content: fullContent || null,
                tool_calls: streamToolCalls,
            });

            const userAuth = await getUserAuth(req);
            const toolPromises = streamToolCalls.map(async (toolCall) => {
                const toolName = toolCall.function?.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) { }

                console.log(`[DirectChat] Executing streamed tool: ${toolName}`, toolArgs);
                send('tool_start', { name: toolName, args: toolArgs });

                let tierOverrides = null;
                try {
                    const tierToolParams = await configStore.getConfig('direct_chat_tier_tool_params') || {};
                    tierOverrides = tierToolParams[resolvedTier]?.[toolName] || null;
                } catch (cfgErr) {
                    console.warn(`[DirectChat] Config lookup failed (tier_tool_params, streamed): ${cfgErr.message}`);
                }

                let toolResult;
                let outboundProbe2 = null;
                try {
                    // Web Search Guard — validate agent_search queries
                    if (toolName === 'agent_search' && toolArgs?.query) {
                        // 1. Regex guardrails on search query
                        if (regexConfig?.enabled) {
                            const qMatches = checkRegexPatterns(toolArgs.query, regexConfig.rulesWithNames);
                            if (qMatches.length > 0) {
                                const ruleNames = qMatches.map(m => m.ruleName).join(', ');
                                console.log(`[DirectChat WebSearchGuard] Streamed search query BLOCKED by regex: ${ruleNames}`);
                                guardrailEventStore.logGuardrailEvent({
                                    organization_id: userOrgId || null,
                                    user_id: userId,
                                    conversation_id: convId || null,
                                    violation_type: 'regex',
                                    violation_categories: ruleNames,
                                    direction: 'input',
                                    action_taken: 'search_blocked',
                                    source: 'direct',
                                    model: modelId || null,
                                }).catch(() => {});
                                send('tool_end', { name: toolName, result: '[Web search blocked — query violates content policy]' });
                                return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Web search blocked — query violates content policy. Please rephrase.' }) };
                            }
                        }
                        // 2. PII Detection on search query (always runs for monitoring)
                        if (webSearchGuardPiiCategories && webSearchGuardPiiCategories.length > 0) {
                            try {
                                const { detectPii } = require('../../core/piiDetection');
                                const piiResult = await detectPii(toolArgs.query, webSearchGuardPiiCategories);
                                if (piiResult?.hasPii) {
                                    const cats = [...new Set(piiResult.entities.map(e => e.label))].join(', ');
                                    // Always log PII detection for monitoring
                                    guardrailEventStore.logGuardrailEvent({
                                        organization_id: userOrgId || null,
                                        user_id: userId,
                                        conversation_id: convId || null,
                                        violation_type: 'pii',
                                        violation_categories: cats,
                                        direction: 'input',
                                        action_taken: webSearchGuardEnabled ? 'search_blocked' : 'pii_detected',
                                        source: 'direct',
                                        model: modelId || null,
                                    }).catch(() => {});
                                    // Only block when Web Search Guard is enabled
                                    if (webSearchGuardEnabled) {
                                        console.log(`[DirectChat WebSearchGuard] Streamed search query BLOCKED by PII (${cats})`);
                                        send('tool_end', { name: toolName, result: `[Web search blocked — query contains sensitive information (${cats})]` });
                                        return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: `Web search blocked — query contains sensitive personal information (${cats}). Please rephrase without PII.` }) };
                                    } else {
                                        console.log(`[DirectChat WebSearchGuard] PII detected in streamed search query (${cats}) — monitoring only, search allowed`);
                                    }
                                }
                                console.log(`[DirectChat WebSearchGuard] Streamed search query PII check passed`);
                            } catch (piiErr) {
                                console.warn(`[DirectChat WebSearchGuard] PII check failed (fail-open):`, piiErr.message);
                            }
                        }
                    }
                    if (toolName === 'propose_webpage_plan') {
                        toolResult = executeProposeWebpagePlan(toolArgs);
                        if (toolResult._action === 'webpage_plan_proposed') {
                            webpagePlanProposedThisTurn = true;
                            send('webpage_plan_proposed', {
                                planId: toolResult.planId,
                                plan: toolResult.plan,
                            });
                        }
                    } else if (isBuilderTool(toolName)) {
                        const builderOut = await executeBuilderTool(toolName, toolArgs, { userId, readSlots: webpageBuilderReadSlots });
                        toolResult = builderOut.result;
                        if (builderOut.webpageUpdate) {
                            const { webpageId, file, content, title } = builderOut.webpageUpdate;
                            send('webpage_doc_update', { webpageId, file, content, title });
                        }
                    } else if (isDbTool(toolName)) {
                        const dbWebpageId = toolArgs?.webpageId;
                        if (!dbWebpageId) {
                            toolResult = { error: 'webpageId is required — pass the id returned by create_webpage.' };
                        } else {
                            const { webpageId: _wp, ...dbArgs } = toolArgs || {};
                            toolResult = await executeDbTool(toolName, dbArgs, { webpageId: dbWebpageId, userId });
                            if (toolResult?._action === 'webpage_db_update') {
                                send('webpage_db_update', { webpageId: dbWebpageId });
                            }
                        }
                    } else {
                        const dispatched2 = await runWithProbe(async () => {
                            const preMeta = resolveIntegrationMeta(toolName, toolArgs || {});
                            if (preMeta?.isLocal) markLocal(preMeta.label || preMeta.integration);
                            return await dispatchTool(toolName, toolArgs, {
                            userId,
                            session: req.session,
                            userAuth,
                            fixedParams: tierOverrides,
                            agentId: null,
                            conversationId: convId,
                            orgId: n8nOrgId,
                            send,
                            imageGenSettings,
                            nanoBananaSettings,
                            req,
                            attachments,
                            sessionSkills,
                            activatedSessionSkillIds,
                            completedSessionSkillIds,
                            roundsInCurrentStep,
                            timezone: timezone || 'Europe/Amsterdam',
                            onImageGenerated: (data) => generatedImages.push(data),
                            terminalCtx: {
                                agentId: `user-${userId}`,
                                containerKey: `direct-${convId}`,
                                timeout: 60000,
                                blockedCommands: [],
                                onEvent: (type, data) => { send(type, data); },
                                signal: undefined
                            },
                            });
                        });
                        toolResult = dispatched2.result;
                        outboundProbe2 = dispatched2.probe;
                    }
                } catch (err) {
                    console.error(`[DirectChat] Streamed tool execution failed for ${toolName}:`, err);
                    toolResult = { error: err.message };
                }

                if (toolName === ACTIVATE_SESSION_SKILL_TOOL_NAME && toolResult?.activatedSkillIds) {
                    activatedSessionSkillIds = Array.from(new Set(toolResult.activatedSkillIds));
                    roundsInCurrentStep = 0;
                    send('session_skills_updated', {
                        skills: sessionSkills,
                        activatedSkillIds: activatedSessionSkillIds,
                        completedSkillIds: completedSessionSkillIds,
                    });
                    await swapModelForActiveStage();
                }
                if (toolName === COMPLETE_SESSION_SKILL_TOOL_NAME) {
                    handleSessionSkillCompleteResult(toolArgs, toolResult);
                }

                send('tool_end', { name: toolName, result: toolResult });

                // Track tool call for conversation persistence
                collectedToolHistory.push({
                    name: toolName,
                    args: toolArgs,
                    status: 'done',
                    resultPreview: (typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || '')).slice(0, 200),
                });

                // Log tool usage
                try {
                    const usageStore = require('../../stores/usageStore');
                    await usageStore.logUsage({
                        user_id: userId,
                        agent_name: 'direct-chat',
                        agent_type: 'chat',
                        model: modelId,
                        tool_name: toolName,
                        source: 'direct_chat',
                        organization_id: userOrgId || null,
                        conversation_id: convId || null,
                    });
                } catch (e) { /* ignore */ }

                // ── Integration Activity Logging (async, non-blocking) ──
                try {
                    const { resolveIntegration } = require('../../core/integrationToolMap');
                    const integMeta = resolveIntegration(toolName, toolArgs || {});
                    if (integMeta) {
                        const resultText = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || '');
                        configStore.getConfig(`org_privacy_shield_${userOrgId}`).then(async shield => {
                            if (!shield?.monitorIntegrations) return;
                            // PII scan: use Azure/CPU model with ALL categories, respect org confidence threshold
                            let piiDetected = null;
                            try {
                                const { detectPii } = require('../../core/piiDetection');
                                const threshold = typeof shield.piiDetectionConfidenceThreshold === 'number'
                                    ? shield.piiDetectionConfidenceThreshold : 0.7;
                                const piiResult = await detectPii(resultText.slice(0, 5000), null, threshold);
                                if (piiResult?.hasPii) {
                                    piiDetected = [...new Set(piiResult.entities.map(e => e.label))].join(', ');
                                }
                            } catch (piiErr) { /* fail-open: log without PII data */ }
                            const integStore = require('../../stores/integrationActivityStore');
                            integStore.logIntegrationActivity({
                                organization_id: userOrgId || null,
                                user_id: userId,
                                conversation_id: convId || null,
                                tool_name: toolName,
                                integration_type: integMeta.integration,
                                server_endpoint: integMeta.server,
                                data_direction: integMeta.direction,
                                data_categories: integMeta.dataCategories,
                                pii_categories_detected: piiDetected || null,
                                pii_scan_enabled: true,
                                source: 'direct_chat',
                                model: modelId || null,
                                probe: (outboundProbe2 && integMeta.isLocal) ? { ...outboundProbe2, is_local: true } : outboundProbe2,
                            }).catch(e => console.error('[IntegrationActivityLog] Error:', e.message));
                        }).catch(() => {});
                    }
                } catch (e) { /* ignore */ }

                // Ensure toolResult is an object before stringifying (avoid double-encoding strings)
                let resultObj = toolResult;
                if (typeof toolResult === 'string') {
                    try { resultObj = JSON.parse(toolResult); } catch (e) { resultObj = { result: toolResult }; }
                }
                // Return raw toolResult so draft dedup can run sequentially after Promise.all
                return {
                    _toolResult: toolResult,
                    _toolName: toolName,
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(compactToolResultForLLM(resultObj))
                };
            });

            const toolResults = await Promise.all(toolPromises);

            // Process draft SSE events sequentially (after all tools settle) to avoid race conditions
            for (const tr of toolResults) {
                const toolResult = tr._toolResult;
                if (!toolResult) continue;
                // Emit email_draft SSE event for user approval (with dedup)
                if (toolResult._action === 'email_draft') {
                    const draftKey = JSON.stringify({ to: toolResult.draft?.to, subject: toolResult.draft?.subject, body: toolResult.draft?.body });
                    const alreadySent = collectedEmailDrafts.some(d => JSON.stringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey);
                    if (!alreadySent) {
                        send('email_draft', toolResult.draft);
                        collectedEmailDrafts.push(toolResult.draft);
                    }
                }
                // Emit calendar_draft SSE event for user approval (with dedup)
                if (toolResult._action === 'calendar_draft') {
                    const draftKey = JSON.stringify({ summary: toolResult.draft?.summary, start: toolResult.draft?.start, end: toolResult.draft?.end });
                    const alreadySent = collectedCalendarDrafts.some(d => JSON.stringify({ summary: d.summary, start: d.start, end: d.end }) === draftKey);
                    if (!alreadySent) {
                        send('calendar_draft', toolResult.draft);
                        collectedCalendarDrafts.push(toolResult.draft);
                    }
                }
                // Emit linkedin_draft SSE event for user approval
                if (toolResult._action === 'linkedin_draft') {
                    send('linkedin_draft', toolResult.draft);
                }
                // Emit contacts_draft SSE event for user approval
                if (toolResult._action === 'contacts_draft') {
                    send('contacts_draft', toolResult.draft);
                }
                // Emit keep_draft SSE event for user approval
                if (toolResult._action === 'keep_draft') {
                    send('keep_draft', toolResult.draft);
                }
                // Emit workspace_update SSE event. Render-time un-tokenisation —
                // see the matching block in the precheck loop above for rationale.
                if (toolResult._action === 'workspace_update' && toolResult.content && toolResult.content.trim()) {
                    const { restoreTokens } = require('../../core/piiDetection');
                    const _convMapForWs = require('../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                    const rendered = restoreTokens(toolResult.content, _convMapForWs);
                    send('workspace_update', { content: rendered });
                    notebookWriteCommitted = true;
                }
                // Emit kb_sources SSE event
                if (toolResult._action === 'kb_sources' && toolResult._sources?.length > 0) {
                    send('kb_sources', { sources: toolResult._sources });
                }
                // Track audio URLs for persistence
                if (toolResult.audioUrl) {
                    generatedAudio.push({ url: toolResult.audioUrl, source: tr._toolName });
                }
            }

            // Strip internal fields before pushing to messages
            messages.push(...toolResults.map(({ _toolResult, _toolName, ...rest }) => rest));

            // If the AI proposed a webpage plan, stop the streaming tool loop
            // and let the next streamed text come out (so the chat shows the
            // AI's natural-language summary alongside the plan card). No
            // further file edits run this turn.
            if (webpagePlanProposedThisTurn) break;

            // Stream the follow-up response after tool execution (with tools for multi-round)
            fullContent = '';
            streamToolCalls = [];
            const followGuard = computeStepMachineGuard();
            applySystemAppend(followGuard.systemAppend);
            muteAssistantText = !!followGuard.mute;
            console.log(`[DirectChat pipeline] follow-up stream round=${toolRound} active=${activatedSessionSkillIds.length} completed=${completedSessionSkillIds.length}/${sessionSkills.length} toolChoice=${followGuard.mode} mute=${followGuard.mute} roundsInStep=${roundsInCurrentStep}`);
            const followStreamOptions = {
                ...chatOptions,
                previousResponseId: undefined, // Don't chain — we need to send tool results in full
                tools: directChatTools.length > 0 ? directChatTools : undefined,
                toolChoice: directChatTools.length > 0 ? followGuard.toolChoice : undefined,
            };
            try {
                await adapter.stream(apiKey, apiUrl, modelId, applyTokenMapToMessages({ conversationId: convId, messages }), followStreamOptions, followStreamCallback);
            } catch (followErr) {
                const fMsg = String(followErr?.error?.message || followErr?.message || '');
                if (/invalid_request_message_order|Unexpected role|invalid.*tool_choice/i.test(fMsg)) {
                    console.warn(`[DirectChat pipeline] Follow-up stream rejected — retrying with toolChoice='auto'. Original: ${fMsg}`);
                    fullContent = '';
                    streamToolCalls = [];
                    await adapter.stream(apiKey, apiUrl, modelId, applyTokenMapToMessages({ conversationId: convId, messages }), { ...followStreamOptions, toolChoice: 'auto' }, followStreamCallback);
                } else {
                    throw followErr;
                }
            }
        }

        // Release any tail held by the streaming un-tokeniser. The end-of-
        // stream `restoreTokens` below also fires a full `content_replace`
        // as a final safety net, but flushing here means a stable token
        // sitting at the very end of the stream gets replaced via the live
        // content channel rather than waiting for the replace.
        try { streamContentFlush(); } catch (_) { /* best-effort */ }

        // If LLM returned an empty response after tool calls, send a minimal confirmation
        if (!fullContent.trim() && toolCallRounds > 0) {
            fullContent = 'Done ✓';
            send('content', { text: fullContent });
        }

        // Transparency: emit the raw (pre-un-tokenise) response once per turn
        // when the org has `showRawPayload` on. Capture BEFORE restoreTokens
        // runs so the user can see the exact string the LLM produced. Capped
        // at 64 KB with ellipsis truncation. Gated strictly by org opt-in.
        if (orgShield?.showRawPayload && fullContent) {
            const RAW_BUFFER_MAX = 64 * 1024;
            const truncated = fullContent.length > RAW_BUFFER_MAX;
            const rawForClient = truncated ? fullContent.slice(0, RAW_BUFFER_MAX) + '…' : fullContent;
            send('privacy_response_raw', {
                rawResponse: rawForClient,
                truncated,
                timestamp: Date.now(),
            });
            if (_assistantTokenisationInfo) {
                _assistantTokenisationInfo.rawResponse = rawForClient;
                _assistantTokenisationInfo.rawTruncated = truncated;
            }
        }

        // ─── PII Token Restoration ──────────────────────────────────
        // Restore tokens for the USER-FACING display channel only. The stored
        // `fullContent` MUST stay tokenised so the next turn's history (fed
        // back to the model) does not contain real PII. Without this split,
        // an adversarial follow-up such as "spell each email character by
        // character" would let Claude reformat real values it should never
        // have seen — bypassing the un-tokeniser regex match.
        // `displayContent` is used for: SSE content_replace, regex agent-
        // output check, memory extraction, title generation.
        let displayContent = fullContent;
        if (fullContent) {
            const { restoreTokens } = require('../../core/piiDetection');
            const dlpRunner = require('../../core/dlp/dlpRunner');
            const convMap = dlpRunner.getConversationTokenMap(convId) || {};
            const mergedMap = { ...convMap, ...(piiTokenMap || {}) };
            if (Object.keys(mergedMap).length > 0) {
                const restored = restoreTokens(fullContent, mergedMap);
                if (restored !== fullContent) {
                    console.log(`[DirectChat] 🔓 PII tokens restored for display (${Object.keys(mergedMap).length} tokens in scope, ${fullContent.length}→${restored.length} chars); storage stays tokenised`);
                    send('content_replace', { text: restored });
                    displayContent = restored;
                }
            }
        }

        // Check agent output against regex rules. Run against `displayContent`
        // (un-tokenised) — regex patterns are designed to match real values
        // like emails, phone numbers, IBANs, etc.; matching tokens would be
        // accidentally narrow. Redactions still update `fullContent` (storage)
        // so the next turn doesn't replay leaked content.
        if (regexConfig?.enabled && regexConfig?.scope?.agentOutput && displayContent) {
            const matches = checkRegexPatterns(displayContent, regexConfig.rulesWithNames);
            if (matches.length > 0) {
                const ruleNames = matches.map(m => m.ruleName).join(', ');
                console.log(`[DirectChat RegexGuard] Agent output violated rules: ${ruleNames}`);
                if (regexConfig.action === 'redact') {
                    let redacted = displayContent;
                    for (const rule of regexConfig.rulesWithNames) {
                        try {
                            const regex = new RegExp(rule.pattern, 'gi');
                            redacted = redacted.replace(regex, `[REDACTED: ${rule.name}]`);
                        } catch (e) { /* skip */ }
                    }
                    send('content_replace', { text: redacted });
                    displayContent = redacted;
                    fullContent = redacted; // redaction is destructive — replace storage too
                } else {
                    send('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5, source: 'agent_output' });
                }
            }
        }

        // Content moderation on agent output was removed when the Azure
        // Content Safety backend was dropped. PII detection still runs on
        // the user input above; output is streamed through `untokeniseStream`
        // which restores PII tokens to real values for display.

        // ─── Conversation persistence ────────────────────────────
        if (!convId) {
            const conv = await agentStore.createDirectConversation(userId, modelTier || 'fast');
            convId = conv.id;
            send('conversation_created', { conversationId: convId });
            // Assign to project if provided
            if (projectId) {
                try {
                    const projectStore = require('../../stores/projectStore');
                    await projectStore.assignConversation(convId, projectId, userId, 'direct_conversations');
                } catch (e) {
                    console.warn('[DirectChat] Failed to assign conversation to project:', e.message);
                }
            }
        }

        // ─── Empty-response guard ────────────────────────────────────
        // When the model emits only tool calls, `fullContent` is an empty
        // string. Saving an empty assistant bubble cascades into title-gen
        // 400s and a confusing "Error generating response" in the chat UI.
        // Replace with a useful human-readable line. Only claim the answer
        // is in the notebook when a notebook tool actually persisted real
        // content this turn — otherwise the user gets pointed at an empty
        // panel (the original bug).
        if (!fullContent || !fullContent.trim()) {
            const fallbackText = notebookWriteCommitted
                ? 'I wrote the answer to your Notebook — open the Notebook panel to view it.'
                : 'The model returned no response. Please try rephrasing your question.';
            console.warn(`[DirectChat] Empty assistant content (toolsUsed=${collectedToolHistory.length > 0}, notebookWriteCommitted=${notebookWriteCommitted}) — surfacing fallback line.`);
            try { send('content_replace', { text: fallbackText }); } catch (_) { /* SSE may be closing */ }
            fullContent = fallbackText;
            displayContent = fallbackText;
        }

        const conv = await agentStore.getDirectConversation(convId, userId);
        if (conv) {
            // When the frontend sends a truncated history (retry / edit), use that as
            // the persistence base instead of the full DB history.  This ensures the
            // retried messages are permanently deleted from the database.
            const dbMessages = conv.messages || [];
            let savedMessages;
            if (history && Array.isArray(history) && history.length < dbMessages.length) {
                // Retry / edit scenario — map the slim history back to rich saved format
                savedMessages = history.map(h => {
                    // Try to find the matching rich message in DB (preserves timestamps, attachments, etc.)
                    const match = dbMessages.find(
                        d => d.role === h.role && d.content === h.content
                    );
                    return match || { role: h.role, content: h.content, timestamp: new Date().toISOString() };
                });
                console.log(`[DirectChat] Retry detected — truncated DB messages from ${dbMessages.length} → ${savedMessages.length}`);
            } else {
                savedMessages = dbMessages;
            }
            const userSave = { role: 'user', content: moderationViolation ? '[Message removed - policy violation]' : tokenizedMessage, timestamp: new Date().toISOString() };
            if (persistedAttachments.length > 0) userSave.attachments = persistedAttachments;
            if (_userPrivacyMeta) Object.assign(userSave, _userPrivacyMeta);
            // Persist the tokenMap with the user row so the read-on-display
            // path can restore [email_N] → real values for the UI without
            // re-running PII detection. Cross-turn restoration also works
            // through dlpRunner.mergeTokenMap for chained references.
            if (piiTokenMap && Object.keys(piiTokenMap).length > 0) {
                userSave.tokenMap = piiTokenMap;
            }
            // Merge attachment scan summaries collected during attachment
            // processing into the assistant tokenisation info so the chat UI
            // can render a per-file badge ("3 emails, 1 IBAN redacted from invoice.pdf p.2").
            // Reads from `_turnAttachmentSummaries` (route-scoped) so it
            // survives the `messages = compactionResult.messages` reassignment.
            if (Array.isArray(_turnAttachmentSummaries) && _turnAttachmentSummaries.length > 0) {
                if (!_assistantTokenisationInfo) {
                    const aggCount = _turnAttachmentSummaries.reduce((a, s) => a + (s.count || 0), 0);
                    const aggCats = new Set();
                    for (const s of _turnAttachmentSummaries) {
                        for (const c of Object.keys(s.byCategory || {})) aggCats.add(c);
                    }
                    _assistantTokenisationInfo = {
                        source: 'privacy_shield',
                        action: 'redact',
                        count: aggCount,
                        categories: [...aggCats],
                        automatic: true,
                    };
                }
                _assistantTokenisationInfo.attachments = _turnAttachmentSummaries;
            }
            // Surface restored tokens too — on turns where no new redaction
            // fires but the AI's reply echoed tokens from earlier turns, the
            // un-tokeniser swapped them back to real values before the user
            // saw them. Synthesise the same shape the panel renders for fresh
            // redactions so the badge still appears.
            if (!_assistantTokenisationInfo && _streamUntok && typeof _streamUntok.getReplacedTokens === 'function') {
                const replaced = _streamUntok.getReplacedTokens();
                if (replaced && replaced.size > 0) {
                    const tokenMap = {};
                    const catSet = new Set();
                    let totalCount = 0;
                    for (const [token, info] of replaced) {
                        tokenMap[token] = info.value;
                        totalCount += info.count || 0;
                        const m = /^\[([a-z0-9_]+)_\d+\]$/.exec(token);
                        if (m) catSet.add(m[1]);
                    }
                    _assistantTokenisationInfo = {
                        source: 'restored',
                        action: 'restore',
                        count: totalCount,
                        categories: [...catSet],
                        provider: modelId,
                        automatic: true,
                        tokenMap,
                    };
                    send('tokenisation_info', _assistantTokenisationInfo);
                } else {
                    // No token echo this turn — but if the conversation vault
                    // has any entries, surface the protected-state badge so
                    // the user gets continuous visual confirmation that
                    // privacy is engaged for this chat.
                    //
                    // IMPORTANT: state, not action. No PII detection runs on
                    // the AI's reply; the vault was populated on earlier
                    // turns.
                    const _dlpRunnerForSynth = require('../../core/dlp/dlpRunner');
                    const convMap = _dlpRunnerForSynth.getConversationTokenMap(convId) || {};
                    const convEntries = Object.entries(convMap);
                    if (convEntries.length > 0) {
                        const catSet = new Set();
                        for (const [tok] of convEntries) {
                            const m = /^\[([a-z0-9_]+)_\d+\]$/.exec(tok);
                            if (m) catSet.add(m[1]);
                        }
                        _assistantTokenisationInfo = {
                            source: 'conversation_vault',
                            action: 'protected',
                            count: convEntries.length,
                            categories: [...catSet],
                            provider: modelId,
                            automatic: true,
                            tokenMap: Object.fromEntries(convEntries),
                        };
                        send('tokenisation_info', _assistantTokenisationInfo);
                    }
                }
            }
            savedMessages.push(userSave);
            const assistantSave = { role: 'assistant', content: fullContent, timestamp: new Date().toISOString() };
            // Persist the concrete model + tier so the "How I got this answer"
            // panel still renders the right pill after a reload. `modelTier`
            // captures what the user picked ("auto" stays "auto" across reloads);
            // `autoSelectedTier` is the classifier's resolution when on auto,
            // and `modelId` is the actual model string the provider was called
            // with this turn.
            assistantSave.modelId = modelId;
            assistantSave.modelTier = resolvedTier;
            if (modelTier === 'auto') {
                assistantSave.autoSelectedTier = resolvedTier;
            }
            if (_assistantTokenisationInfo) assistantSave.tokenisationInfo = _assistantTokenisationInfo;
            // Prefer the structured thinking parts (with signatures + timing) over the flat string.
            // The flat string is kept as a fallback for providers that only emit `thinking` without
            // wrapping start/stop events.
            if (thinkingParts.length > 0) {
                assistantSave.thinking = thinkingParts.map(p => ({
                    id: p.id,
                    text: p.text,
                    startedAt: p.startedAt,
                    endedAt: p.endedAt || Date.now(),
                    redacted: p.redacted || undefined,
                    signature: p.signature || undefined,
                    phase: p.phase || undefined,
                }));
            } else if (thinkingContent) {
                assistantSave.thinking = thinkingContent;
            }
            if (generatedImages.length > 0) {
                // Strip base64 data from images for DB — keep only url/mimeType/storageKey
                assistantSave.images = generatedImages.map(img => {
                    if (img.url) {
                        return { url: img.url, mimeType: img.mimeType, storageKey: img.storageKey || null };
                    }
                    // No URL available — keep base64 as fallback
                    return { data: img.data, mimeType: img.mimeType };
                });
            }
            if (generatedAudio.length > 0) assistantSave.audioFiles = generatedAudio;
            if (collectedEmailDrafts.length > 0) assistantSave.emailDrafts = collectedEmailDrafts;
            if (collectedCalendarDrafts.length > 0) assistantSave.calendarDrafts = collectedCalendarDrafts;
            if (collectedMapEmbeds.length > 0) assistantSave.mapEmbeds = collectedMapEmbeds;
            if (collectedToolHistory.length > 0) {
                // Render-time un-tokenisation for the saved tool history. The
                // `resultPreview` strings are captured straight from raw tool
                // output (which may contain `[person_N]` tokens) and surfaced
                // in the "How I got this answer" panel. The AI never reads
                // toolHistory back — it sees tool results inline during the
                // same turn — so swapping tokens for real values is purely a
                // user-render concern. Same applies to `query` / `find_text`
                // values inside the recorded args.
                try {
                    const { restoreTokens } = require('../../core/piiDetection');
                    const _convMapForToolHist = require('../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                    if (Object.keys(_convMapForToolHist).length > 0) {
                        for (const t of collectedToolHistory) {
                            if (typeof t?.resultPreview === 'string') {
                                t.resultPreview = restoreTokens(t.resultPreview, _convMapForToolHist);
                            }
                            if (t?.args && typeof t.args === 'object') {
                                for (const k of Object.keys(t.args)) {
                                    if (typeof t.args[k] === 'string') {
                                        t.args[k] = restoreTokens(t.args[k], _convMapForToolHist);
                                    }
                                }
                            }
                        }
                    }
                } catch (_) { /* render-layer best-effort */ }
                assistantSave.toolHistory = collectedToolHistory;
            }
            // Record the bootstrap so the UI can render a "Created N chat-local
            // skills" header above this assistant reply when reloaded.
            if (bootstrappedSessionSkills && Array.isArray(sessionSkills) && sessionSkills.length > 0) {
                assistantSave.sessionSkillsBootstrap = {
                    state: 'done',
                    skills: sessionSkills.map(s => ({
                        id: s.id,
                        name: s.name,
                        description: s.description || '',
                        icon: s.icon || '🧩',
                    })),
                };
            }
            // Per-turn pipeline snapshot — lets reloaded conversations replay
            // the timeline progression on each assistant message instead of
            // every old turn snapping to the final activation state. Includes
            // the completed set + per-step summaries so the UI can re-render
            // both the chip states and the green "✓ Step N — summary" rows.
            if (Array.isArray(sessionSkills) && sessionSkills.length > 0) {
                assistantSave.sessionSkillsSnapshot = {
                    activatedSkillIds: Array.isArray(activatedSessionSkillIds) ? [...activatedSessionSkillIds] : [],
                    completedSkillIds: Array.isArray(completedSessionSkillIds) ? [...completedSessionSkillIds] : [],
                    completions: Array.isArray(sessionSkillsCompletions) ? [...sessionSkillsCompletions] : [],
                };
            }
            savedMessages.push(assistantSave);

            // Save with metadata for OpenAI response chaining + compaction
            const updateMeta = {};
            if (lastResponseId) {
                updateMeta.lastResponseId = lastResponseId;
                updateMeta.lastResponseModel = modelId;
            }
            if (conversationSummary) {
                updateMeta.conversationSummary = conversationSummary;
            }
            if (isStandardTier && sessionSkills.length > 0) {
                updateMeta.sessionSkills = sessionSkills;
                updateMeta.activatedSessionSkillIds = activatedSessionSkillIds;
                updateMeta.completedSessionSkillIds = completedSessionSkillIds;
                updateMeta.sessionSkillsCompletions = sessionSkillsCompletions;
            }
            await agentStore.updateDirectConversation(convId, savedMessages, userId, updateMeta);
            // Persist the user's tier selection on the conversation so a refresh
            // restores the picker to what they last chose ("auto" stays "auto").
            // Without this, model_tier is frozen at creation and never reflects
            // mid-conversation switches.
            if (modelTier) {
                await agentStore.updateDirectConversationModelTier(convId, modelTier, userId).catch(() => {});
            }

            // Auto-extract memories from conversation (async, fire-and-forget).
            // Un-tokenise both sides before extraction so memories remain
            // meaningful in a DIFFERENT conversation (the token map is
            // per-conversation, so a memory containing `[email_1]` recalled
            // in another conversation would be a dead placeholder).
            // Privacy trade-off accepted: real PII may now appear in
            // `user_memories`. That is local storage, not external AI traffic.
            // `fullContent` is now KEPT tokenised for the DB save (so the next
            // turn's history fed to the model does not contain real PII).
            // For memory we want the un-tokenised version — use `displayContent`.
            const memoryWriteEnabled = req.body?.memoryWriteEnabled !== false;
            if (!moderationViolation && memoryWriteEnabled && tokenizedMessage && displayContent) {
                try {
                    const { extractMemories } = require('../../core/memoryExtractor');
                    const { restoreTokens } = require('../../core/piiDetection');
                    const _convMapForMem = require('../../core/dlp/dlpRunner').getConversationTokenMap(convId);
                    const _userTextForMem = Object.keys(_convMapForMem).length > 0
                        ? restoreTokens(tokenizedMessage, _convMapForMem)
                        : tokenizedMessage;
                    extractMemories(userId, _userTextForMem, displayContent, null, extractMemoriesEnabled ? projectId : null, userOrgForTiers).catch(e =>
                        console.warn('[DirectChat] Memory extraction error:', e.message)
                    );
                } catch (e) { /* ignore */ }
            }

            // Generate title for new conversations (skip if moderation violation — don't send unsafe content to title LLM)
            console.log(`[DirectChat] Title check: savedMessages=${savedMessages.length}, moderationViolation=${!!moderationViolation}`);
            // Title gen only runs when BOTH the user prompt and the assistant
            // response have non-empty trimmed content. Anthropic and most other
            // providers reject `messages.0` with empty content; attachment-only
            // or tool-only turns would otherwise log a 400 every time.
            // Use `displayContent` for the title-gen guard — `fullContent` is
            // now the tokenised storage form which may differ in content but
            // is never empty when the un-tokenised one isn't.
            const _titleHasUserContent = !!(tokenizedMessage && typeof tokenizedMessage === 'string' && tokenizedMessage.trim());
            const _titleHasAssistantContent = !!(displayContent && typeof displayContent === 'string' && displayContent.trim());
            if (savedMessages.length <= 2 && !moderationViolation && _titleHasUserContent && _titleHasAssistantContent) {
                try {
                    const llmClient = require('../../core/llmClient');
                    const { resolveModelWithGlobalFallback } = require('../../core/modelResolver');
                    const titleAgent = await agentStore.getSystemAgent('system-title-generator');
                    const rawTitleModel = titleAgent?.model || 'tier:fast';
                    const titleModel = await resolveModelWithGlobalFallback(rawTitleModel, {
                        userOrgId: userOrgForTiers || null,
                        userId,
                        fallbackTier: 'fast',
                    }) || modelId;
                    console.log(`[DirectChat] Title: generating with model=${titleModel}`);
                    const title = await llmClient.generateTitle(
                        titleModel,
                        tokenizedMessage,
                        titleAgent?.system_prompt
                    );
                    console.log(`[DirectChat] Title generated: "${title}" for conv ${convId}`);
                    await agentStore.updateDirectConversationTitle(convId, title, userId);
                    send('title', { title, conversationId: convId });
                    console.log(`[DirectChat] Title saved and sent via SSE`);
                } catch (e) {
                    console.error('[DirectChat] Title generation failed:', e.message, e.stack);
                }
            } else if (savedMessages.length <= 2 && !moderationViolation && (!_titleHasUserContent || !_titleHasAssistantContent)) {
                // Skip title gen but seed a sensible default so the conversation
                // doesn't appear nameless in the sidebar.
                const fallbackTitle = 'New Chat';
                try { await agentStore.updateDirectConversationTitle(convId, fallbackTitle, userId); } catch (_) { /* non-fatal */ }
                send('title', { title: fallbackTitle, conversationId: convId });
                console.log(`[DirectChat] Title gen skipped (userEmpty=${!_titleHasUserContent}, assistantEmpty=${!_titleHasAssistantContent}) — used fallback "${fallbackTitle}"`);
            } else if (savedMessages.length <= 2 && moderationViolation) {
                // Moderation violation — set a safe generic title instead
                const safeTitle = 'New Chat';
                await agentStore.updateDirectConversationTitle(convId, safeTitle, userId);
                send('title', { title: safeTitle, conversationId: convId });
            }
        }

        // ─── Memory extraction (background, non-blocking) ──────────
        // Honors the per-session memoryWriteEnabled toggle (default true).
        if (!moderationViolation && req.body?.memoryWriteEnabled !== false) {
            try {
                const memoryExtractor = require('../../agents/memory/extractor');
                memoryExtractor.extractFromConversation(userId, null, messages, convId, validProjectId || null, userOrgForTiers || null)
                    .then(extracted => {
                        if (extracted.length > 0) {
                            console.log(`[DirectChat] Extracted ${extracted.length} memories`);
                        }
                    })
                    .catch(err => console.error('[DirectChat] Memory extraction failed:', err.message));
            } catch (e) { /* extractor load failed */ }
        } else {
            console.log(`[DirectChat] Skipping memory extraction — moderation violation detected`);
        }

        send('done', { conversationId: convId });
    } catch (error) {
        console.error('[DirectChat] Stream error:', error);
        // Translate well-known upstream failures to a useful Dutch message so
        // the chat surfaces something readable instead of a transport error.
        const raw = String(error?.message || error || '');
        let friendly = raw;
        if (/image dimensions exceed.*pixel/i.test(raw)) {
            friendly = 'Eén van de afbeeldingen in deze chat is te groot voor het AI-model (>2000px). Verklein de afbeelding of verwijder oudere bijlagen en probeer opnieuw.';
        } else if (/many-image requests/i.test(raw)) {
            friendly = 'Te veel of te grote afbeeldingen in deze conversatie. Verwijder oudere bijlagen of start een nieuwe chat.';
        } else if (/no low surrogate|invalid.*surrogate/i.test(raw)) {
            friendly = 'De conversatie bevat ongeldige Unicode-tekens. Probeer een nieuw bericht; oudere berichten worden bij de volgende compactie opgeschoond.';
        } else if (/API error 4\d\d/.test(raw)) {
            friendly = `AI-provider gaf een fout terug: ${raw}`;
        }
        try {
            if (!res.writableEnded) {
                send('error', { error: friendly, raw });
            }
        } catch (sendErr) {
            console.warn('[DirectChat] Failed to send SSE error event:', sendErr.message);
        }
    } finally {
        try { if (!res.writableEnded) res.end(); } catch (_) { /* socket already gone */ }
    }
});

// ─── Image Generation (Google Nano Banana 2) ──────────────────────

router.post('/chat/generate-image', requireAuth, async (req, res) => {
    const { prompt, aspectRatio, conversationId } = req.body;
    const userId = req.session.user.id;

    if (!prompt) {
        return res.status(400).json({ error: 'Prompt is required' });
    }

    try {
        const googleApiKey = await configStore.getSecret('google_api_key');
        if (!googleApiKey) {
            return res.status(400).json({ error: 'Google API key not configured. Add it in Admin → AI Config → API Keys.' });
        }

        console.log(`[ImageGen] Generating image for user ${userId}: "${prompt.substring(0, 80)}"`);

        const result = await googleAdapter.generateImage(googleApiKey, prompt, {
            aspectRatio: aspectRatio || '1:1',
        });

        if (!result.imageBase64) {
            return res.status(500).json({ error: 'No image was generated. Try a different prompt.' });
        }

        // Log usage
        try {
            const usageStore = require('../../stores/usageStore');
            await usageStore.logUsage({
                agent_id: null,
                agent_name: 'direct-chat',
                model: 'gemini-3.1-flash-image-preview',
                prompt_tokens: prompt.length,
                completion_tokens: 0,
                total_tokens: prompt.length,
                source: 'image_generation',
                conversation_id: conversationId || null,
            });
        } catch (e) {
            console.warn('[ImageGen] Failed to log usage:', e.message);
        }

        res.json({
            imageBase64: result.imageBase64,
            mimeType: result.mimeType,
            text: result.text,
            conversationId: conversationId || null,
        });
    } catch (error) {
        console.error('[ImageGen] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// ─── Conversation CRUD ───────────────────────────────────────────

router.get('/direct/conversations', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conversations = await agentStore.listDirectConversations(userId);
        res.json(conversations);
    } catch (e) {
        console.error('Failed to list direct conversations:', e);
        res.status(500).json({ error: 'Failed to list conversations' });
    }
});

router.get('/direct/conversations/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        res.json(conv);
    } catch (e) {
        console.error('Failed to get direct conversation:', e);
        res.status(500).json({ error: 'Failed to get conversation' });
    }
});

router.get('/direct/conversations/:id/session-skills', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        const skills = Array.isArray(conv.sessionSkills) ? conv.sessionSkills : [];
        const activated = Array.isArray(conv.activatedSessionSkillIds) ? conv.activatedSessionSkillIds : [];
        res.json({
            skills,
            activatedSkillIds: activated,
            modelTier: conv.model_tier || 'fast',
        });
    } catch (e) {
        console.error('Failed to get direct session skills:', e);
        res.status(500).json({ error: 'Failed to load session skills' });
    }
});

// Regenerate the chat-local session-skill set for a Standard-tier conversation.
// Body: { message? }   — optional refining prompt. If absent, re-uses the
//                          first user message from the conversation.
// Resets `activatedSessionSkillIds` since the new ids won't match the old ones.
router.post('/direct/conversations/:id/session-skills/regenerate', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        // Resolve the tier the conversation uses; we only regenerate for Standard.
        const userStoreForOrg = require('../../stores/userStore');
        const callerForOrg = await userStoreForOrg.getUser(userId);
        const callerOrgId = callerForOrg?.organizationId || null;
        const { isEUModeActive } = require('../../core/modelResolver');
        const { isEU } = await isEUModeActive({ userOrgId: callerOrgId, userId }).catch(() => ({ isEU: false }));
        const tiersKey = isEU ? 'chat_model_tiers_eu' : 'chat_model_tiers';
        const tiers = (await configStore.getConfig(tiersKey)) || {};
        const tier = tiers.standard || {};
        if (!tier.modelId) {
            return res.status(400).json({ error: 'Standard tier is not configured.' });
        }

        // Pick the bootstrap model (cheap if configured, otherwise main).
        let bootstrapModelId = tier.bootstrapModelId || tier.modelId;
        let bootstrapConfig;
        try {
            bootstrapConfig = await getProviderForModel(bootstrapModelId);
        } catch (_) {
            // Cheap model unavailable — fall back to the main tier model.
            bootstrapConfig = await getProviderForModel(tier.modelId);
            bootstrapModelId = tier.modelId;
        }
        const bootstrapAdapter = getAdapter(bootstrapConfig.providerType, (bootstrapConfig.url || '').replace(/\/+$/, ''));

        // Determine the seed message — body override > first user message > placeholder.
        const overrideMessage = (typeof req.body?.message === 'string' && req.body.message.trim()) ? req.body.message.trim() : null;
        const firstUserMsg = (Array.isArray(conv.messages) ? conv.messages : []).find(m => m.role === 'user')?.content;
        const seedMessage = overrideMessage || firstUserMsg || '[No prior user text — derive broadly useful skills.]';

        // Pull user/org context for tone/language tailoring.
        let userContext = null;
        try {
            const userStore = require('../../stores/userStore');
            const u = await userStore.getUser(userId);
            if (u) {
                userContext = {
                    language: u.language || u.locale || (req.session?.user?.language) || null,
                    role: u.orgRole || u.role || null,
                };
                if (u.organizationId) {
                    const org = await userStore.getOrganization(u.organizationId);
                    if (org) {
                        userContext.orgName = org.name || null;
                        userContext.orgTagline = org.tagline || null;
                    }
                }
            }
        } catch (_) { /* non-fatal */ }

        const newSkills = await bootstrapSessionSkills({
            adapter: bootstrapAdapter,
            apiKey: bootstrapConfig.apiKey,
            apiUrl: (bootstrapConfig.url || '').replace(/\/+$/, ''),
            modelId: bootstrapModelId,
            message: seedMessage,
            timezone: req.body?.timezone || 'UTC',
            apiVersion: bootstrapConfig.apiVersion || undefined,
            userContext,
        });

        // Persist new skills + reset activations & completions. Preserve existing messages.
        const existingMessages = Array.isArray(conv.messages) ? conv.messages : [];
        await agentStore.updateDirectConversation(req.params.id, existingMessages, userId, {
            sessionSkills: newSkills,
            activatedSessionSkillIds: [],
            completedSessionSkillIds: [],
            sessionSkillsCompletions: [],
        });

        res.json({ success: true, skills: newSkills, activatedSkillIds: [], completedSkillIds: [] });
    } catch (e) {
        console.error('Failed to regenerate session skills:', e);
        res.status(500).json({ error: e.message || 'Failed to regenerate session skills' });
    }
});

// Delete one chat-local session skill from a conversation.
router.delete('/direct/conversations/:id/session-skills/:skillId', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        const sessionSkills = Array.isArray(conv.sessionSkills) ? conv.sessionSkills : [];
        const skillId = req.params.skillId;
        const nextSkills = sessionSkills.filter(s => s.id !== skillId);
        if (nextSkills.length === sessionSkills.length) {
            return res.status(404).json({ error: 'Session skill not found' });
        }
        const nextActivated = (Array.isArray(conv.activatedSessionSkillIds) ? conv.activatedSessionSkillIds : []).filter(id => id !== skillId);
        const nextCompleted = (Array.isArray(conv.completedSessionSkillIds) ? conv.completedSessionSkillIds : []).filter(id => id !== skillId);
        const nextCompletions = (Array.isArray(conv.sessionSkillsCompletions) ? conv.sessionSkillsCompletions : []).filter(c => c?.skillId !== skillId);

        const existingMessages = Array.isArray(conv.messages) ? conv.messages : [];
        await agentStore.updateDirectConversation(req.params.id, existingMessages, userId, {
            sessionSkills: nextSkills,
            activatedSessionSkillIds: nextActivated,
            completedSessionSkillIds: nextCompleted,
            sessionSkillsCompletions: nextCompletions,
        });

        res.json({ success: true, skills: nextSkills, activatedSkillIds: nextActivated, completedSkillIds: nextCompleted });
    } catch (e) {
        console.error('Failed to delete session skill:', e);
        res.status(500).json({ error: 'Failed to delete session skill' });
    }
});

router.post('/direct/conversations/:id/session-skills/:skillId/import', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        const sessionSkills = Array.isArray(conv.sessionSkills) ? conv.sessionSkills : [];
        const source = sessionSkills.find(s => s.id === req.params.skillId);
        if (!source) return res.status(404).json({ error: 'Session skill not found' });

        const userStore = require('../../stores/userStore');
        const skillStore = require('../../stores/skillStore');
        const user = await userStore.getUser(userId);
        const orgId = user?.organizationId || null;
        if (!orgId) return res.status(400).json({ error: 'No organization found' });

        const body = req.body || {};
        const created = await skillStore.createSkill({
            orgId,
            userId,
            name: (typeof body.name === 'string' && body.name.trim()) ? body.name.trim().slice(0, 120) : source.name,
            description: source.description || '',
            instructions: source.instructions || '',
            workflow: source.workflow || '',
            rules: source.rules || '',
            examples: source.examples || '',
            icon: '⚡',
            isShared: body.isShared === true,
            dynamicActivation: body.dynamicActivation !== false,
        });

        res.json({ success: true, skill: created });
    } catch (e) {
        console.error('Failed to import direct session skill:', e);
        res.status(500).json({ error: 'Failed to import session skill' });
    }
});

// Rename / pin / label a direct conversation
router.patch('/direct/conversations/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { title, pinned, labels } = req.body;
        const conv = await agentStore.getDirectConversation(req.params.id, userId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        if (title !== undefined) await agentStore.updateDirectConversationTitle(req.params.id, title, userId);
        if (pinned !== undefined) await agentStore.pinDirectConversation(req.params.id, pinned, userId);
        if (labels !== undefined) await agentStore.setDirectConversationLabels(req.params.id, labels, userId);
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to update direct conversation:', e);
        res.status(500).json({ error: 'Failed to update conversation' });
    }
});

// ─── Conversation Label CRUD ───
router.get('/labels', requireAuth, async (req, res) => {
    try {
        const labels = await agentStore.listLabels(req.session.user.id);
        res.json(labels);
    } catch (e) {
        console.error('Failed to list labels:', e);
        res.status(500).json({ error: 'Failed to list labels' });
    }
});

router.post('/labels', requireAuth, async (req, res) => {
    try {
        const { name, color } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });
        const label = await agentStore.createLabel(req.session.user.id, name, color || '#6366f1');
        res.json(label);
    } catch (e) {
        console.error('Failed to create label:', e);
        res.status(500).json({ error: 'Failed to create label' });
    }
});

router.patch('/labels/:id', requireAuth, async (req, res) => {
    try {
        const { name, color } = req.body;
        await agentStore.updateLabel(req.params.id, req.session.user.id, { name, color });
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to update label:', e);
        res.status(500).json({ error: 'Failed to update label' });
    }
});

router.delete('/labels/:id', requireAuth, async (req, res) => {
    try {
        await agentStore.deleteLabel(req.params.id, req.session.user.id);
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to delete label:', e);
        res.status(500).json({ error: 'Failed to delete label' });
    }
});

router.delete('/direct/conversations/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const success = await agentStore.deleteDirectConversation(req.params.id, userId);
        if (!success) return res.status(404).json({ error: 'Conversation not found' });
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to delete direct conversation:', e);
        res.status(500).json({ error: 'Failed to delete conversation' });
    }
});

// Get workspace content for a direct conversation
router.get('/direct/conversations/:id/workspace', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        // Render-time un-tokenisation. The stored workspace_content keeps the
        // raw `[person_N]` tokens so the AI can re-read them via notebook_read
        // in a later turn; this endpoint reaches the user, so swap them back
        // to real values. Async getter so an open-after-server-restart hits the
        // DB hydrate path in dlpRunner.
        const { restoreTokens } = require('../../core/piiDetection');
        const _convMap = await require('../../core/dlp/dlpRunner').getConversationTokenMapAsync(req.params.id);
        res.json({
            content: restoreTokens(conv.workspace_content || '', _convMap),
            notebookId: conv.workspace_notebook_id || null,
        });
    } catch (e) {
        console.error('Failed to get direct conversation workspace:', e);
        res.status(500).json({ error: 'Failed to get workspace' });
    }
});

// Update workspace content for a direct conversation
router.put('/direct/conversations/:id/workspace', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const conv = await agentStore.getDirectConversation(req.params.id, userId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        const { content, notebookId } = req.body;
        await agentStore.updateDirectConversationWorkspace(req.params.id, content || '', notebookId !== undefined ? notebookId : null);
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to update direct conversation workspace:', e);
        res.status(500).json({ error: 'Failed to update workspace' });
    }
});

module.exports = router;
