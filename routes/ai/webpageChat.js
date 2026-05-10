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
const {
    WEBPAGE_DB_TOOLS,
    executeDbTool,
    isDbTool,
} = require('../../integrations/webpageDbTools');
const { AGENT_SEARCH_TOOLS, executeAgentSearchTool, isAgentSearchTool } = require('../../integrations/agentSearchTools');
const {
    searchWebpageKB,
    executeWebpageKBSearchTool,
    WEBPAGE_KB_SEARCH_TOOL,
} = require('../../core/webpageKnowledgeSearch');
const terminationStore = require('../../stores/terminationStore');
const { sanitizeError } = require('../../core/errorSanitizer');
const { emitPhase, emitPhaseEnd, withPhase } = require('../../core/agentRuntime/phaseEvents');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

function slotFilename(slot) {
    return slot === 'html' ? 'index.html' : slot === 'css' ? 'style.css' : 'script.js';
}

/**
 * Strip bulky payloads from tool results before they re-enter the model's
 * message history. The frontend already received the full content via SSE
 * (webpage_doc_update / webpage_extra_update / tool_end), so re-shipping it
 * to the LLM doubles every tool round's prompt size for no benefit and
 * pushes long sessions over context limits faster.
 *
 * Mirrors directChat.js's compactToolResultForLLM but with the rules tuned
 * for the webpage tool surface (file/extra/db).
 */
function compactWebpageToolResult(toolResult) {
    if (typeof toolResult !== 'object' || toolResult === null) return toolResult;

    // Primary slot writes — the new content was streamed to the UI; the model
    // can ask for it back via webpage_file_read if it needs to re-check.
    if (toolResult._action === 'webpage_doc_update') {
        return {
            action: 'webpage_doc_update',
            file: toolResult.file,
            title: toolResult.title,
            message: toolResult.message || `${toolResult.file} updated.`,
        };
    }

    // Extra-file create/update — content already sent to the UI.
    if (toolResult._action === 'webpage_extra_update') {
        return {
            action: 'webpage_extra_update',
            path: toolResult.path,
            meta: toolResult.meta,
            message: toolResult.message || `${toolResult.path} updated.`,
        };
    }
    if (toolResult._action === 'webpage_extra_deleted') {
        return {
            action: 'webpage_extra_deleted',
            path: toolResult.path,
            message: toolResult.message || `${toolResult.path} deleted.`,
        };
    }

    // DB exec — already small; pass through but normalize the shape.
    if (toolResult._action === 'webpage_db_update') {
        return {
            action: 'webpage_db_update',
            multi: !!toolResult.multi,
            changes: toolResult.changes,
            lastInsertRowid: toolResult.lastInsertRowid,
            message: toolResult.message,
        };
    }

    // DB query — cap rows shipped back to the model (UI already has the full
    // payload via tool_end). 50 rows is plenty to summarize/reason over.
    if (Array.isArray(toolResult.rows) && toolResult.rows.length > 50) {
        return {
            ...toolResult,
            rows: toolResult.rows.slice(0, 50),
            truncatedForLlm: true,
            originalRowCount: toolResult.rows.length,
        };
    }

    return toolResult;
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
    // Always emit a `model_resolved` phase so the UI can show the concrete
    // model name (e.g. "Using gpt-4o-mini") regardless of tier mode.
    emitPhase(send, 'model_resolved', modelId);
    emitPhaseEnd(send, 'model_resolved');

    try {
        // KB search for grounding
        let kbContext = '';
        let citationSources = [];
        const kbIds = webpage.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            emitPhase(send, 'kb_search');
            const _kbT = Date.now();
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
            emitPhaseEnd(send, 'kb_search', Date.now() - _kbT);
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

        // Mode-aware planning rule (see chatMode above). The propose_webpage_plan
        // tool is only EXPOSED in ask/plan modes — in auto mode it isn't even
        // present in the tool list, so the AI literally cannot stop and ask.
        const planningRule = chatMode === 'plan'
            ? `MODE: PLAN.
You MUST call propose_webpage_plan FIRST for every request that touches code. Even small edits — explore the relevant files via webpage_file_read, then propose a short plan and stop. Do NOT call any webpage_file_write / replace / patch / create_file / delete_file in the same turn. The system pauses and waits for the user to approve. After approval an authorisation message is injected and you may execute.`
            : chatMode === 'ask'
            ? `MODE: ASK.
Always propose a plan before making changes. Call propose_webpage_plan FIRST, list every file you intend to touch and what each change does, then stop. The user must approve before any edits run. After approval an authorisation message is injected and you may execute. Use this mode for high-stakes work where the user wants to review every change up front.`
            : `MODE: AUTO.
Just do the work — no approval step. The propose_webpage_plan tool is NOT available in this mode. For any user request:
1. If you need to understand the current state, call webpage_file_read / webpage_list_files first. That is allowed and encouraged for non-trivial work.
2. Then go straight to editing with the appropriate tool (webpage_file_write / replace / patch / create_file / delete_file).
3. Never stop to ask the user "should I proceed?" — they chose Auto specifically to skip that. After your edits land, briefly explain what you did.
For very large changes you can still narrate your approach in a sentence or two before the first tool call so the user sees what's coming, but DO NOT pause for approval.`;

        emitPhase(send, 'building_prompt');
        const _spT = Date.now();
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
EDITING TOOLS — partial edits are the default, full rewrites are the exception
────────────────────────────────────────
The cardinal rule: when a file already has content, edit it partially. webpage_file_write is reserved for empty files or genuine from-scratch rewrites — using it on a non-empty file is almost always wrong and the system will warn you about it.

Decision tree for any change:
  1. Is the file empty or being created for the first time? → webpage_file_write
  2. Does the change span ≥80% of the file (genuine total rewrite)? → webpage_file_write
  3. Otherwise (the realistic 95% case) → webpage_file_replace or webpage_file_patch

Tools, in order of preference:
• webpage_file_read({ file }) — always call this BEFORE any partial edit on the same file in the same turn. The system tracks reads and warns when an edit comes in cold.
• webpage_file_replace({ file, find_text, replace_text [, replace_all] }) — your default editing tool. Surgical substring replace; preserves everything around the change. find_text must match EXACTLY ONCE by default; if it appears multiple times the tool errors with the matching line numbers and asks you to either narrow the snippet or set \`replace_all: true\`. Whitespace-normalised matching is a fallback. Use this for: adding sections, removing sections, swapping copy, fixing bugs, restyling specific elements, anything contained.
• webpage_file_patch({ file, start_line, end_line, expected_text, replacement }) — line-anchored partial edit. Use when you know exactly which lines to rewrite (you just read the file and counted) and the change is bigger than a clean substring. The expected_text sanity check protects against stale reads.
• webpage_file_write({ file, content [, title] }) — LAST RESORT. Only for empty files or full rewrites where you're throwing away ≥80% of the existing content. The system emits a warning when you call this on a non-empty file because it's nearly always a mistake — use the partial tools instead.

Inserting new content with webpage_file_replace: pick a stable anchor in the existing file (a closing tag, a CSS rule selector, a comment), use that as find_text, and put the anchor + your new content into replace_text. This is how you add things without destroying what's around them.

Iteration discipline:
- Read first, then edit. Never call a partial-edit tool on a file you haven't read this turn.
- Many small focused replaces > one giant rewrite. Each replace shows the user a clean diff card.
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
SQLITE DATABASE — per-webpage server-side persistence
────────────────────────────────────────
Every webpage has a SQLite database (\`data.db\`, stored alongside the script files). The database is server-side; the running script.js talks to it via an injected client:

  await window.beeflowDB.query("SELECT * FROM notes WHERE archived = ?", [0]);
  await window.beeflowDB.exec("INSERT INTO notes (body) VALUES (?)", ["hi"]);
  await window.beeflowDB.batch([{sql: "...", params: []}, ...]);
  await window.beeflowDB.schema();

Each call returns a Promise; reject = error string in \`.error\`. Use \`?\` placeholders — never interpolate user input into SQL.

Three tools to manage the DB directly. The user can also see and edit the DB live in the data.db viewer (Schema / Browse / SQL tabs in the editor) — keep that in mind when shaping schemas, since they will be visible to a human, not just consumed by your script.
• webpage_db_schema() — returns { tables: [{ name, sql, columns: [...] }], message }. Call this BEFORE generating any query against tables you didn't just create yourself this turn.
• webpage_db_query({ sql, params? }) — SELECT / WITH / PRAGMA only. Returns { rows, columns, truncated, message }. Errors and tells you to use exec if the SQL mutates. Rows capped at 10000; \`truncated: true\` means narrow the query and call again. Always parameterize values with \`?\` + params — never interpolate.
• webpage_db_exec({ sql, params? }) — INSERT / UPDATE / DELETE / CREATE / ALTER / DROP / etc. Returns { changes, lastInsertRowid, multi, message }. Two modes: single statement (with or without params) or multi-statement script (only when params is empty/omitted; per-statement counts unavailable). For parameterized DML across many rows, call once per statement.

Use these to set up the schema and seed data the user describes. The DB persists across reloads; new webpages start empty. If the page doesn't actually need persistence, don't create a schema — local state in script.js is fine.

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

        emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);
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
        const webpageTools = [...WEBPAGE_DOC_TOOLS, ...WEBPAGE_MULTI_FILE_TOOLS, ...WEBPAGE_DB_TOOLS, WEBPAGE_ADD_SOURCE_TOOL];
        // Plan tool exposed ONLY in ask/plan modes — auto mode is "just work,
        // no approval gate". Also dropped on plan-execution turns so the AI
        // can't propose another plan after the user already approved one.
        const planToolAvailable = !planExecution && (chatMode === 'ask' || chatMode === 'plan');
        if (planToolAvailable) webpageTools.push(PROPOSE_WEBPAGE_PLAN_TOOL);
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
        // 10 rounds — DB workflows (schema → seed → verify → fix) routinely run
        // long, and partial edits via webpage_file_replace cluster the same way.
        // Admin can override via max_tool_rounds_chat (AI Configuratie → Limits).
        const MAX_TOOL_ROUNDS = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 10;
        // Flips to true when the AI calls propose_webpage_plan — the chat
        // handler exits the streaming/tool loop after the current round so the
        // user gets a chance to approve before any files are touched.
        let planProposedThisTurn = false;

        // ── Termination monitor bookkeeping ───────────────────────────────
        // Tracks tokens, latency and the most recent stop_reason so we can
        // log abnormal terminations (max_tokens / max_iterations / error)
        // without persisting any message content.
        const _termStart = Date.now();
        let _termPromptTokens = 0;
        let _termCompletionTokens = 0;
        let _termLastStopReason = null;
        // Attachment metadata — counts + total bytes only, no filenames or
        // content. Helps explain max_tokens stops where the user uploaded a
        // big file and the LLM ran out of room before a useful answer.
        const _termAttachmentCount = Array.isArray(attachments) ? attachments.length : 0;
        const _termAttachmentBytes = (() => {
            if (!Array.isArray(attachments)) return 0;
            let total = 0;
            for (const att of attachments) {
                if (!att?.content || typeof att.content !== 'string') continue;
                if (att.content.startsWith('data:')) {
                    // base64 — actual bytes are ~3/4 of the base64 length.
                    const comma = att.content.indexOf(',');
                    const b64 = comma >= 0 ? att.content.slice(comma + 1) : att.content;
                    total += Math.floor(b64.length * 0.75);
                } else {
                    total += Buffer.byteLength(att.content, 'utf8');
                }
            }
            return total;
        })();
        const _terminationBase = () => ({
            user_id: userId || null,
            organization_id: userOrgForTiers || null,
            agent_id: webpageId || null,
            agent_name: webpage?.title ? `Webpage: ${webpage.title}` : 'Webpage chat',
            model: modelId || null,
            source: 'webpage_chat',
            conversation_id: webpageId || null,
            iteration_count: toolCallRounds,
            duration_ms: Date.now() - _termStart,
            prompt_tokens: _termPromptTokens,
            completion_tokens: _termCompletionTokens,
            total_tokens: _termPromptTokens + _termCompletionTokens,
            attachment_count: _termAttachmentCount,
            attachment_bytes: _termAttachmentBytes,
        });

        async function dispatchToolCall(toolCall) {
            const toolName = toolCall.function?.name || toolCall.name;
            let toolArgs = {};
            try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {}

            console.log(`[WebpageChat] Tool: ${toolName}(${JSON.stringify(toolArgs).substring(0, 160)})`);
            send('tool_start', { name: toolName, args: toolArgs });

            let toolResult;
            if (toolName === 'propose_webpage_plan') {
                // Auto mode strips this tool from the toolset; if the AI
                // somehow still calls it, refuse and tell it to just edit.
                if (!planToolAvailable) {
                    toolResult = { error: 'propose_webpage_plan is not available in Auto mode. Just make the edits directly using webpage_file_* / webpage_create_file / webpage_delete_file.' };
                } else {
                    toolResult = executeProposeWebpagePlan(toolArgs);
                    if (toolResult._action === 'webpage_plan_proposed') {
                        planProposedThisTurn = true;
                        send('webpage_plan_proposed', {
                            planId: toolResult.planId,
                            plan: toolResult.plan,
                        });
                    }
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
            } else if (isDbTool(toolName)) {
                toolResult = await executeDbTool(toolName, toolArgs, { webpageId, userId });
                if (toolResult?._action === 'webpage_db_update') {
                    // Lets the file explorer refresh the data.db size badge and
                    // the iframe hot-reload if the user wants it.
                    send('webpage_db_update', {});
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

            // The full toolResult goes to the UI (SSE above). The compact
            // shape goes back to the model — strips file content the model
            // already wrote and over-large query rows so prompt size doesn't
            // balloon round-over-round.
            return {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: typeof toolResult === 'string'
                    ? toolResult
                    : JSON.stringify(compactWebpageToolResult(toolResult)),
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
            } else if (type === 'done') {
                // Adapter signals end-of-stream with usage + stop_reason.
                // Track tokens for the termination monitor and remember the
                // last stop_reason so we can detect max_tokens truncations.
                _termPromptTokens += data?.prompt_tokens || 0;
                _termCompletionTokens += data?.completion_tokens || 0;
                _termLastStopReason = data?.stop_reason || data?.finish_reason || null;
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

            // Final pre-LLM phase marker — only on the first round, so the UI
            // status placeholder fades out before the first token arrives.
            if (toolCallRounds === 0) {
                emitPhase(send, 'streaming_start', modelId);
            }

            try {
                await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);
            } catch (err) {
                console.error('[WebpageChat] Stream error:', err.message);
                terminationStore.logTermination({
                    ..._terminationBase(),
                    termination_type: 'error',
                    ...sanitizeError(err),
                }).catch(() => {});
                send('error', { error: `Chat error: ${err.message}` });
                break;
            }

            if (_termLastStopReason === 'max_tokens' || _termLastStopReason === 'length') {
                terminationStore.logTermination({ ..._terminationBase(), termination_type: 'max_tokens' }).catch(() => {});
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
                    terminationStore.logTermination({
                        ..._terminationBase(),
                        termination_type: 'error',
                        ...sanitizeError(err),
                    }).catch(() => {});
                }
                break;
            }
        }

        // Hit MAX_TOOL_ROUNDS with tool calls still pending — give the model
        // one chance to summarise without offering more tools.
        if (toolCallRounds >= MAX_TOOL_ROUNDS && streamToolCalls.length > 0) {
            terminationStore.logTermination({ ..._terminationBase(), termination_type: 'max_iterations' }).catch(() => {});
            try {
                await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, streamCallback);
            } catch (err) {
                console.error('[WebpageChat] Final wrap-up stream error:', err.message);
                terminationStore.logTermination({
                    ..._terminationBase(),
                    termination_type: 'error',
                    ...sanitizeError(err),
                }).catch(() => {});
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
        try {
            terminationStore.logTermination({
                user_id: req.session?.user?.id || null,
                agent_id: req.body?.webpageId || null,
                agent_name: 'Webpage chat',
                source: 'webpage_chat',
                conversation_id: req.body?.webpageId || null,
                termination_type: 'error',
                ...sanitizeError(err),
            }).catch(() => {});
        } catch (_) { /* ignore logging failures */ }
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
