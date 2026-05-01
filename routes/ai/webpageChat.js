/**
 * Webpage Chat — streaming AI chat scoped to a single webpage's three files.
 *
 * Mirrors notebookChat.js. Tools available:
 *   - webpage_file_read / webpage_file_write / webpage_file_replace
 *   - webpage_add_source
 *   - webpage_kb_search (when the webpage has KB sources)
 *   - agent_search (web search, when configured)
 *
 * The frontend is the source of truth for the three slot contents while a
 * chat turn is in flight: it sends html/css/js with each request and listens
 * for `webpage_doc_update` SSE events with `{ file, content }` to apply
 * tool-driven changes in real time. The server persists tool-driven changes
 * to RustFS at the END of the turn so versioning + sha256s stay in sync.
 */

const express = require('express');
const router = express.Router();
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const webpageStore = require('../../stores/webpageStore');

const {
    WEBPAGE_DOC_TOOLS,
    WEBPAGE_ADD_SOURCE_TOOL,
    executeWebpageDocTool,
} = require('../../integrations/webpageDocTools');
const { PROPOSE_WEBPAGE_PLAN_TOOL, executeProposeWebpagePlan } = require('../../integrations/webpagePlanTool');
const {
    WEBPAGE_MULTI_FILE_TOOLS,
    executeMultiFileTool,
    isMultiFileTool,
} = require('../../integrations/webpageMultiFileTools');
const { AGENT_SEARCH_TOOLS, executeAgentSearchTool, isAgentSearchTool } = require('../../integrations/agentSearchTools');
const {
    searchWebpageKB,
    executeWebpageKBSearchTool,
    WEBPAGE_KB_SEARCH_TOOL,
} = require('../../core/webpageKnowledgeSearch');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

function slotFilename(slot) {
    return slot === 'html' ? 'index.html' : slot === 'css' ? 'style.css' : 'script.js';
}

router.post('/chat/webpage/stream', requireAuth, async (req, res) => {
    const {
        message, webpageId, history, modelTier, timezone, attachments,
        htmlContent, cssContent, jsContent, webpageSelection,
        planExecution, // { planId, action: 'execute' } when user approved a plan
        chatMode: rawChatMode, // 'ask' | 'auto' | 'plan'
    } = req.body;
    const userId = req.session.user.id;
    // Sanitise mode — fall back to 'auto' for unknown values.
    const chatMode = ['ask', 'auto', 'plan'].includes(rawChatMode) ? rawChatMode : 'auto';

    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!webpageId) return res.status(400).json({ error: 'Webpage ID required' });

    const webpage = await webpageStore.getWebpage(webpageId, userId);
    if (!webpage) return res.status(404).json({ error: 'Webpage not found' });

    const sources = await webpageStore.getSources(webpageId);
    const readySources = sources.filter(s => s.status === 'ready');

    // Org / EU mode resolution (matches notebookChat)
    const { resolveUserOrgIds: resolveOrgIdsForTiers } = require('../../auth');
    const userStore = require('../../stores/userStore');
    const { getEUAwareTiers } = require('../../core/modelResolver');
    const orgIdsForTiers = await resolveOrgIdsForTiers(req);
    let userOrgForTiers = orgIdsForTiers && orgIdsForTiers.size > 0 ? Array.from(orgIdsForTiers)[0] : null;
    if (!userOrgForTiers) {
        try {
            const dbUser = await userStore.getUser(userId);
            if (dbUser?.organizationId) {
                userOrgForTiers = dbUser.organizationId;
            } else {
                const groups = Array.isArray(dbUser?.groups) ? dbUser.groups : (() => { try { return JSON.parse(dbUser?.groups || '[]'); } catch (_) { return []; } })();
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

    let tiers = await getEUAwareTiers({ userOrgId: userOrgForTiers, userId });

    let resolvedTier = modelTier || 'fast';
    if (resolvedTier === 'standard') resolvedTier = 'fast';

    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/promptClassifier');
            const result = await classifyWithLLM(message, tiers, { userOrgId: userOrgForTiers, userId });
            resolvedTier = result.tier;
            console.log(`[WebpageChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            console.log(`[WebpageChat] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = 'fast';
        }
    }
    if (resolvedTier === 'standard') resolvedTier = 'fast';

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;
    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model;
        if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
    }

    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        console.error(`[WebpageChat] Provider resolution failed:`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    console.log(`[WebpageChat] Model: ${modelId} (tier: ${resolvedTier}) for webpage: "${webpage.name}" (${readySources.length} sources)`);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }

    try {
        // KB search for grounding
        let kbContext = '';
        let citationSources = [];
        const kbIds = webpage.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            try {
                const kbResult = await searchWebpageKB({
                    userId, kbIds, query: message,
                    options: { topK: 10, rerank: true, minScore: 0.2 },
                });
                if (kbResult.chunks.length > 0) {
                    citationSources = kbResult.citations;
                    kbContext = kbResult.contextPrompt;
                }
            } catch (kbErr) {
                console.warn('[WebpageChat] KB search failed:', kbErr.message);
            }
        }
        if (citationSources.length > 0) {
            send('kb_sources', { sources: citationSources.map(s => ({ title: s.title, preview: s.content, score: s.score })) });
        }

        // Source summary
        const sourceSummary = readySources.length > 0
            ? readySources.map(s => `- ${s.name} (${s.type}, ${(s.wordCount || 0).toLocaleString()} words)`).join('\n')
            : '(No sources added yet)';

        // File-content blocks — fit each slot into its own token slice.
        const { fitIntoTokenBudget } = require('../../core/tokenBudget');
        const SLOT_TOKENS = 6000;

        const html = htmlContent || '';
        const css = cssContent || '';
        const js = jsContent || '';

        function slotBlock(slot, language, content) {
            const filename = slotFilename(slot);
            if (!content || !content.trim()) {
                return `\n--- ${filename} (empty) ---\n`;
            }
            const fit = fitIntoTokenBudget(content, SLOT_TOKENS);
            const truncNote = fit.truncated ? ` [TRUNCATED: ${fit.keptTokens.toLocaleString()} of ${fit.originalTokens.toLocaleString()} tokens]` : '';
            return `\n--- ${filename}${truncNote} ---\n\`\`\`${language}\n${fit.text}\n\`\`\`\n`;
        }

        const filesBlock =
            slotBlock('html', 'html', html) +
            slotBlock('css', 'css', css) +
            slotBlock('js', 'javascript', js);

        // Selection context
        let selectionContext = '';
        if (webpageSelection && typeof webpageSelection.text === 'string' && webpageSelection.text.trim()) {
            const MAX_SEL_CHARS = 8000;
            const selFile = ['html', 'css', 'js'].includes(webpageSelection.file) ? webpageSelection.file : 'html';
            const selText = webpageSelection.text.length > MAX_SEL_CHARS
                ? webpageSelection.text.slice(0, MAX_SEL_CHARS) + '…[truncated]'
                : webpageSelection.text;
            const actionHint = webpageSelection.action && ['rewrite', 'shorten', 'expand', 'fix'].includes(webpageSelection.action)
                ? `The user explicitly invoked "${webpageSelection.action}" on this selection — call webpage_file_replace with file="${selFile}", find_text set to the EXACT selection above, and replace_text set to your revised version.`
                : `If the user asks you to edit, rewrite, or change "this" / "the selection", use webpage_file_replace with file="${selFile}" and find_text set to the EXACT string above.`;
            selectionContext =
                `\n\n[SELECTED CODE IN ${slotFilename(selFile)}]\n` +
                `<<<SELECTION_BEGIN>>>\n${selText}\n<<<SELECTION_END>>>\n` +
                actionHint;
        }

        // Web-search availability
        const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
        const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
        const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
        const searchAvailable = searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);

        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // Mode-aware planning rule (see chatMode above)
        const planningRule = chatMode === 'plan'
            ? `MODE: PLAN.
You MUST call propose_webpage_plan FIRST for every request that touches code. Even small edits — explore the relevant files via webpage_file_read, then propose a short plan and stop. Do NOT call any webpage_file_write / replace / patch / create_file / delete_file in the same turn. The system pauses and waits for the user to approve. After approval an authorisation message is injected and you may execute.`
            : chatMode === 'ask'
            ? `MODE: ASK.
Always propose a plan before making changes. Call propose_webpage_plan FIRST, list every file you intend to touch and what each change does, then stop. The user must approve before any edits run. After approval an authorisation message is injected and you may execute. Use this mode for high-stakes work where the user wants to review every change up front.`
            : `MODE: AUTO.
You decide whether to plan first. Plan first (call propose_webpage_plan, then stop) when the user asks for a brand-new page, a multi-file change, or any rewrite that touches more than ~80 lines. For small, surgical edits (typo fix, single CSS tweak, single line change) skip planning and edit directly. After approval the system injects an authorisation; do NOT propose again on that turn.`;

        const systemPrompt = `You are a precise, efficient webpage-building assistant. Today is ${today}.

────────────────────────────────────────
WEBPAGE
────────────────────────────────────────
Name: "${webpage.name}"
${webpage.description ? `Description: ${webpage.description}` : ''}${webpage.instructions ? `\nCustom instructions from the user: ${webpage.instructions}` : ''}

The page is rendered live in a sandboxed iframe visible to the user while you work. Every webpage_file_write / replace / patch you call updates the preview in real time.

────────────────────────────────────────
RUNTIME CONSTRAINTS — READ ONCE, OBEY ALWAYS
────────────────────────────────────────
1. Vanilla HTML / CSS / JavaScript only. There is NO build step.
2. NO package installation. No \`npm install\`, no \`yarn add\`, no \`require()\` of node modules, no bundler. If you need a library, use a CDN \`<script>\` tag inside the HTML (e.g. \`<script src="https://cdn.jsdelivr.net/...">\`).
3. NO TypeScript, JSX, SCSS, LESS, or any language that needs compilation.
4. The preview iframe runs with \`sandbox="allow-scripts"\` and NO \`allow-same-origin\`. That means:
   - \`document.cookie\`, \`localStorage\`, \`sessionStorage\` are unavailable inside the page.
   - \`fetch()\` to the host app or any same-origin URL fails (CORS / opaque origin).
   - \`parent.window\` access throws SecurityError.
   Use in-memory variables for state. CDN fetches are allowed.
5. Reference styles and scripts however you like — \`<link href="style.css">\` and \`<script src="script.js"></script>\` work in the downloaded zip; the in-app preview inlines them automatically.
6. Default to a clean, modern aesthetic when the user's brief is sparse: sensible spacing, readable typography, accessible color contrast (WCAG AA), responsive on mobile.

────────────────────────────────────────
FILES
────────────────────────────────────────
${filesBlock}

────────────────────────────────────────
EDITING TOOLS — pick the right one
────────────────────────────────────────
• webpage_file_read({ file }) — ALWAYS call this before any partial edit on the same file in the same turn. The tool tracks reads and warns when an edit is issued cold.
• webpage_file_replace({ file, find_text, replace_text [, replace_all] }) — surgical substring replace. find_text must match EXACTLY ONCE by default; if it appears multiple times the tool errors with the matching line numbers and asks you to either narrow the snippet or set \`replace_all: true\`. Whitespace-normalised matching is a fallback.
• webpage_file_patch({ file, start_line, end_line, expected_text, replacement }) — line-anchored replace with a sanity check. Use when you know the exact line range. \`expected_text\` must match the current contents of those lines or the tool refuses to write — protects against corruption from stale reads.
• webpage_file_write({ file, content [, title] }) — full-file overwrite. Reserve for INITIAL creation or genuine full rewrites only. For any edit on existing content, prefer the partial tools above (faster, cheaper, more robust).

Iteration discipline:
- Read first, then edit. Never call a partial-edit tool on a file you haven't read this turn.
- Make ONE focused edit at a time. Don't bundle unrelated changes.
- After edits land, briefly confirm what changed in plain language: "I added the hero section to index.html and centered the menu grid in style.css."

────────────────────────────────────────
EXTRA FILES & FOLDERS — beyond the three primary slots
────────────────────────────────────────
You can split your work across additional files when it makes the project clearer (e.g. components/header.html, modules/state.js, assets/products.json). Folders are created implicitly from the path.
• webpage_list_files() — see every file currently in the project.
• webpage_create_file({ path, content }) — create or overwrite an extra file. Reject reserved paths (index.html, style.css, script.js); for those, use webpage_file_write({ file: "html"|"css"|"js" }).
• webpage_read_file({ path }) — read an extra file's contents.
• webpage_replace_in_file({ path, find_text, replace_text [, replace_all] }) — partial edit on an extra file. Same single-match-required contract as webpage_file_replace.
• webpage_delete_file({ path }) — remove an extra file.

When to split files: only when it genuinely simplifies the project. A small page belongs in the three primary slots. Split when you have multiple components, reusable modules, or content that wants its own file. Don't pre-emptively scaffold dozens of files for a simple page.

────────────────────────────────────────
PLANNING
────────────────────────────────────────
${planningRule}

────────────────────────────────────────
SOURCES & RESEARCH
────────────────────────────────────────
${sourceSummary}
${searchAvailable ? `\nWeb research:
• agent_search — current information, factual lookups.
• webpage_add_source — attach search results / references as a webpage source for grounding future questions.` : ''}${kbContext}${selectionContext}

Now: ${(() => { const _tz = timezone || 'Europe/Amsterdam'; try { const _now = new Date(); const _dp = _now.toLocaleString('sv-SE', { timeZone: _tz }); const _lp = new Date(_now.toLocaleString('en-US', { timeZone: _tz })); const _om = Math.round((_lp - _now) / 60000); const _s = _om >= 0 ? '+' : '-'; const _a = Math.abs(_om); return `${_dp} UTC${_s}${String(Math.floor(_a / 60)).padStart(2, '0')}:${String(_a % 60).padStart(2, '0')} (${_tz})`; } catch (_) { return new Date().toISOString(); } })()}`;

        let messages = [{ role: 'system', content: systemPrompt }];

        // Plan-execution turn: the user clicked Approve & build on a previously
        // proposed plan. Inject a system-style authorisation so the AI proceeds
        // straight to webpage_file_write / replace / patch without proposing
        // another plan (the propose_webpage_plan tool is also stripped from
        // the toolset above when planExecution is set).
        if (planExecution && planExecution.action === 'execute' && planExecution.planId) {
            messages.push({
                role: 'system',
                content: `The user APPROVED your previously proposed plan (planId=${planExecution.planId}). Execute it now using webpage_file_write / webpage_file_replace / webpage_file_patch. Do NOT call propose_webpage_plan again — the plan is already locked in.`,
            });
        }

        if (history && Array.isArray(history)) {
            for (const msg of history) {
                if ((msg.role === 'user' || msg.role === 'assistant') && msg.content?.trim()) {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        if (attachments && attachments.length > 0) {
            const contentParts = [];
            if (message) contentParts.push({ type: 'text', text: message });
            for (const att of attachments) {
                try {
                    if (att.type && att.type.startsWith('image/') && att.content) {
                        contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                    } else if (att.content && typeof att.content === 'string') {
                        const textContent = att.content.startsWith('data:') ? Buffer.from(att.content.split(',')[1] || '', 'base64').toString('utf-8') : att.content;
                        if (textContent) contentParts.push({ type: 'text', text: `[File: ${att.name}]\n---\n${textContent.slice(0, 8000)}\n---` });
                    }
                } catch {}
            }
            const hasImages = contentParts.some(p => p.type === 'image_url');
            if (hasImages) {
                messages.push({ role: 'user', content: contentParts });
            } else {
                const combined = contentParts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
                if (combined.trim()) messages.push({ role: 'user', content: combined });
            }
        } else {
            messages.push({ role: 'user', content: message });
        }

        // Tool list
        const webpageTools = [...WEBPAGE_DOC_TOOLS, ...WEBPAGE_MULTI_FILE_TOOLS, WEBPAGE_ADD_SOURCE_TOOL];
        // Plan tool only on regular (non-execution) turns. When the user
        // approves a plan, we don't want the AI to propose another one.
        if (!planExecution) webpageTools.push(PROPOSE_WEBPAGE_PLAN_TOOL);
        if (kbIds.length > 0) webpageTools.push(WEBPAGE_KB_SEARCH_TOOL);
        if (searchAvailable) webpageTools.push(...AGENT_SEARCH_TOOLS);

        // Live in-memory file state — kept in sync with tool calls so the
        // model sees its own writes mid-turn.
        const liveFiles = { html, css, js };
        const dirtySlots = new Set();
        // Per-turn read-set: tracks slots the AI called webpage_file_read on so
        // the read-before-edit guard can warn when an edit comes in cold.
        const readSlots = new Set();

        const tierSettings = tiers[resolvedTier] || {};
        const { TIER_DEFAULTS } = require('../../core/modelResolver');
        const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        };

        let toolCallRounds = 0;
        const MAX_TOOL_ROUNDS = 5;
        // Flips to true when the AI calls propose_webpage_plan — the chat
        // handler exits the streaming/tool loop after the current round so the
        // user gets a chance to approve before any files are touched.
        let planProposedThisTurn = false;

        async function dispatchToolCall(toolCall) {
            const toolName = toolCall.function?.name || toolCall.name;
            let toolArgs = {};
            try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {}

            console.log(`[WebpageChat] Tool: ${toolName}(${JSON.stringify(toolArgs).substring(0, 160)})`);
            send('tool_start', { name: toolName, args: toolArgs });

            let toolResult;
            if (toolName === 'propose_webpage_plan') {
                toolResult = executeProposeWebpagePlan(toolArgs);
                if (toolResult._action === 'webpage_plan_proposed') {
                    planProposedThisTurn = true;
                    send('webpage_plan_proposed', {
                        planId: toolResult.planId,
                        plan: toolResult.plan,
                    });
                }
            } else if (toolName.startsWith('webpage_file_')) {
                toolResult = executeWebpageDocTool(toolName, toolArgs, liveFiles, { readSlots });
                if (toolResult._action === 'webpage_doc_update') {
                    const slot = toolResult.file;
                    liveFiles[slot] = toolResult.content;
                    dirtySlots.add(slot);
                    send('webpage_doc_update', { file: slot, content: toolResult.content, title: toolResult.title });
                }
            } else if (isMultiFileTool(toolName)) {
                toolResult = await executeMultiFileTool(toolName, toolArgs, { webpageId, userId });
                if (toolResult?._action === 'webpage_extra_update') {
                    send('webpage_extra_update', { path: toolResult.path, meta: toolResult.meta });
                } else if (toolResult?._action === 'webpage_extra_deleted') {
                    send('webpage_extra_deleted', { path: toolResult.path });
                }
            } else if (toolName === 'webpage_add_source') {
                try {
                    const { ingestTextSource } = require('../../agents/webpages/sourceIngestion');
                    const sourceName = toolArgs.name || 'AI Research';
                    const sourceContent = toolArgs.content || '';
                    const sourceMeta = toolArgs.metadata || {};
                    if (!sourceContent.trim()) {
                        toolResult = { error: 'Content is required to add a source.' };
                    } else {
                        const source = await webpageStore.addSource({
                            webpageId, type: 'text', name: sourceName,
                            metadata: sourceMeta,
                            wordCount: sourceContent.split(/\s+/).length,
                        });
                        sources.push({ ...source, metadata: sourceMeta });
                        ingestTextSource(webpageId, source.id, userId, sourceContent, sourceName).catch(err => {
                            console.error(`[WebpageChat] Source ingestion failed:`, err.message);
                        });
                        send('webpage_source_added', {
                            source: { id: source.id, name: sourceName, type: 'text', status: 'processing', metadata: sourceMeta },
                        });
                        toolResult = {
                            success: true,
                            message: `Source "${sourceName}" added to the webpage.`,
                            sourceId: source.id,
                        };
                    }
                } catch (err) {
                    toolResult = { error: `Failed to add source: ${err.message}` };
                }
            } else if (toolName === 'webpage_kb_search') {
                try {
                    toolResult = await executeWebpageKBSearchTool(toolArgs, userId, kbIds);
                } catch (err) {
                    toolResult = { error: `KB search failed: ${err.message}` };
                }
            } else if (isAgentSearchTool(toolName)) {
                try {
                    toolResult = await executeAgentSearchTool(toolName, toolArgs);
                } catch (err) {
                    toolResult = { error: `Search failed: ${err.message}` };
                }
            } else {
                toolResult = { error: `Unknown tool: ${toolName}` };
            }

            send('tool_end', { name: toolName, result: toolResult });

            return {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            };
        }

        // Unified streaming loop: every model round streams, so users see
        // text + reasoning + tool calls immediately rather than waiting on
        // blocking chat completions before the first paint.
        let fullContent = '';
        let streamToolCalls = [];
        let streamThinkingParts = {};

        const streamCallback = (type, data) => {
            if (type === 'text') {
                fullContent += data.text;
                send('content', { text: data.text });
            } else if (type === 'thinking_start') {
                if (data.partId) {
                    streamThinkingParts[data.partId] = { redacted: !!data.redacted };
                    send('thinking_start', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'thinking') {
                send('thinking', { text: data.text, partId: data.partId });
            } else if (type === 'thinking_stop') {
                if (data.partId) {
                    send('thinking_stop', { partId: data.partId, redacted: data.redacted || undefined });
                }
            } else if (type === 'tool_use' || type === 'tool_call') {
                streamToolCalls.push({
                    id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: data.name || data.function?.name,
                        arguments: typeof data.input !== 'undefined'
                            ? JSON.stringify(data.input || {})
                            : (data.function?.arguments || '{}'),
                    },
                });
            } else if (type === 'error') {
                send('error', data);
            }
        };

        while (toolCallRounds < MAX_TOOL_ROUNDS) {
            fullContent = '';
            streamToolCalls = [];
            streamThinkingParts = {};

            const streamOptions = {
                ...chatOptions,
                tools: webpageTools,
                toolChoice: 'auto',
            };

            try {
                await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);
            } catch (err) {
                console.error('[WebpageChat] Stream error:', err.message);
                send('error', { error: `Chat error: ${err.message}` });
                break;
            }

            if (streamToolCalls.length === 0) break;

            messages.push({
                role: 'assistant',
                content: fullContent || null,
                tool_calls: streamToolCalls,
            });
            toolCallRounds++;
            const toolResults = await Promise.all(streamToolCalls.map(dispatchToolCall));
            messages.push(...toolResults);

            // Plan proposed — stop the loop. Then run one more streaming
            // round (no tools) so the model can deliver its natural-language
            // "I'll build the following…" message above the plan card.
            if (planProposedThisTurn) {
                fullContent = '';
                streamToolCalls = [];
                try {
                    await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, streamCallback);
                } catch (err) {
                    console.error('[WebpageChat] Plan wrap-up stream error:', err.message);
                }
                break;
            }
        }

        // Hit MAX_TOOL_ROUNDS with tool calls still pending — give the model
        // one chance to summarise without offering more tools.
        if (toolCallRounds >= MAX_TOOL_ROUNDS && streamToolCalls.length > 0) {
            try {
                await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, streamCallback);
            } catch (err) {
                console.error('[WebpageChat] Final wrap-up stream error:', err.message);
            }
        }

        // Persist any tool-driven file updates to RustFS so versioning + sha256s
        // stay accurate across sessions. Auto-version triggers if any slot
        // changed AND the 5-min debounce has elapsed.
        if (dirtySlots.size > 0) {
            try {
                const wpFresh = await webpageStore.getWebpage(webpageId, userId);
                const hadContent = wpFresh && (wpFresh.htmlSize + wpFresh.cssSize + wpFresh.jsSize > 0);
                if (hadContent) {
                    const should = await webpageStore.shouldAutoVersion(webpageId);
                    if (should) {
                        await webpageStore.createVersion(userId, webpageId, 'AI edit', {
                            htmlSha: wpFresh.htmlSha,
                            cssSha: wpFresh.cssSha,
                            jsSha: wpFresh.jsSha,
                            contentLength: wpFresh.htmlSize + wpFresh.cssSize + wpFresh.jsSize,
                        });
                    }
                }
                const updates = {};
                for (const slot of dirtySlots) {
                    const { sha, size } = await webpageStore.writeSlot(userId, webpageId, slot, liveFiles[slot]);
                    updates[`${slot}Sha`] = sha;
                    updates[`${slot}Size`] = size;
                }
                if (Object.keys(updates).length > 0) {
                    await webpageStore.updateWebpageMetadata(webpageId, userId, updates);
                }
            } catch (persistErr) {
                console.error('[WebpageChat] Failed to persist tool-driven edits:', persistErr.message);
            }
        }

        send('done', {});
        res.end();
    } catch (err) {
        console.error('[WebpageChat] Error:', err);
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
