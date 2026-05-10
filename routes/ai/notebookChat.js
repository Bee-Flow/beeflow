/**
 * Notebook Chat — AI chat with full tool support
 * 
 * Tools available:
 * - notebook_doc_read/write/replace: Read and modify the TipTap document editor
 * - agent_search: Web research
 * - notebook_add_source: Add web search results directly as notebook sources
 */

const express = require('express');
const router = express.Router();
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const notebookStore = require('../../stores/notebookStore');

const { NOTEBOOK_DOC_TOOLS, NOTEBOOK_ADD_SOURCE_TOOL, executeNotebookDocTool } = require('../../integrations/notebookDocTools');
const { AGENT_SEARCH_TOOLS, executeAgentSearchTool, isAgentSearchTool } = require('../../integrations/agentSearchTools');
const { searchNotebookKB, executeNotebookKBSearchTool, NOTEBOOK_KB_SEARCH_TOOL } = require('../../core/notebookKnowledgeSearch');
const { emitPhase, emitPhaseEnd } = require('../../core/agentRuntime/phaseEvents');


function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Streaming Notebook Chat ─────────────────────────────────────

router.post('/chat/notebook/stream', requireAuth, async (req, res) => {
    const { message, notebookId, history, modelTier, timezone, attachments, documentContent, notebookSelection } = req.body;
    const userId = req.session.user.id;

    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!notebookId) return res.status(400).json({ error: 'Notebook ID required' });

    // Load notebook
    const notebook = await notebookStore.getNotebook(notebookId, userId);
    if (!notebook) return res.status(404).json({ error: 'Notebook not found' });

    // Get sources for context
    const sources = await notebookStore.getSources(notebookId);
    const readySources = sources.filter(s => s.status === 'ready');

    // EU mode + org privacy shield: resolve user's org (matches direct chat)
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
    if (userOrgForTiers) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`);
        if (shield?.enabled && shield.euModeEnabled) {
            console.log(`[NotebookChat] EU mode active for org ${userOrgForTiers}`);
        }
    }

    let resolvedTier = modelTier || 'fast';
    if (resolvedTier === 'standard') {
        resolvedTier = 'fast';
    }

    // Auto mode: classify which tier to use (matches direct chat)
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/promptClassifier');
            const result = await classifyWithLLM(message, tiers, { userOrgId: userOrgForTiers, userId });
            resolvedTier = result.tier;
            console.log(`[NotebookChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            console.log(`[NotebookChat] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = 'fast';
        }
    }
    if (resolvedTier === 'standard') {
        resolvedTier = 'fast';
    }

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;

    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model;
        if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}". Set up model tiers in Settings.`);
    }

    // Resolve provider
    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        console.error(`[NotebookChat] Provider resolution failed for model "${modelId}":`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    console.log(`[NotebookChat] Model: ${modelId} (tier: ${resolvedTier}${modelTier === 'auto' ? ', auto-selected' : ''}) for notebook: "${notebook.name}" (${readySources.length} sources)`);

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

    // Notify frontend of auto-selected model
    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }
    emitPhase(send, 'model_resolved', modelId);
    emitPhaseEnd(send, 'model_resolved');

    try {
        // Search notebook knowledge base for relevant context
        let kbContext = '';
        let citationSources = [];
        const kbIds = notebook.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            emitPhase(send, 'kb_search');
            const _kbT = Date.now();
            try {
                const kbResult = await searchNotebookKB({
                    userId, kbIds, query: message,
                    options: { topK: 10, rerank: true, minScore: 0.2 },
                });

                if (kbResult.chunks.length > 0) {
                    // Resolve source names for citation display
                    const sourceNameMap = {};
                    readySources.forEach(s => {
                        sourceNameMap[s.name] = s.name;
                        sourceNameMap[s.id] = s.name;
                    });
                    const resolveSourceName = (rawTitle) => {
                        if (!rawTitle) return 'Unknown Source';
                        if (sourceNameMap[rawTitle]) return sourceNameMap[rawTitle];
                        const basename = rawTitle.split('/').pop();
                        if (sourceNameMap[basename]) return sourceNameMap[basename];
                        for (const [key, name] of Object.entries(sourceNameMap)) {
                            if (rawTitle.includes(key) || key.includes(rawTitle)) return name;
                        }
                        return rawTitle;
                    };

                    citationSources = kbResult.citations.map(c => ({
                        ...c,
                        title: resolveSourceName(c.title),
                    }));
                    kbContext = kbResult.contextPrompt;
                    console.log(`[NotebookChat] Injected ${kbResult.chunks.length} KB chunks for notebook "${notebook.name}"`);
                }
            } catch (kbErr) {
                console.warn('[NotebookChat] KB search failed:', kbErr.message);
            }
            emitPhaseEnd(send, 'kb_search', Date.now() - _kbT);
        }

        // Send citation sources to frontend
        if (citationSources.length > 0) {
            send('kb_sources', { sources: citationSources.map(s => ({ title: s.title, preview: s.content, score: s.score })) });
        }

        // If the document was too large to inline in the prompt, tell the UI so
        // it can show a one-shot banner. The client-side handler decides whether
        // to suppress repeat banners for the same conversation turn.
        // Emitted AFTER the systemPrompt build below uses `documentTruncation` —
        // so the announcement is deferred until we've actually committed to it.

        // Build source summary
        const sourceSummary = readySources.length > 0
            ? readySources.map(s => `- ${s.name} (${s.type}, ${(s.wordCount || 0).toLocaleString()} words)`).join('\n')
            : '(No sources added yet)';

        // Build document context. We used to hard-truncate at 8000 chars, which
        // silently dropped content for anything longer than ~4 pages. Now we fit
        // the document into a token budget (~20k tokens ≈ 80k chars) and tell
        // BOTH the AI and the user when truncation happened so neither thinks
        // they've seen the whole thing.
        const { fitIntoTokenBudget } = require('../../core/tokenBudget');
        const DOCUMENT_CONTEXT_TOKENS = 20000;
        let documentContext = '';
        let documentTruncation = null; // { originalTokens, keptTokens, approxPagesCut }
        if (documentContent && documentContent.trim() && documentContent !== '<p></p>') {
            const fit = fitIntoTokenBudget(documentContent, DOCUMENT_CONTEXT_TOKENS);
            if (fit.truncated) {
                documentTruncation = {
                    originalTokens: fit.originalTokens,
                    keptTokens: fit.keptTokens,
                };
                documentContext =
                    `\n\n[DOCUMENT EDITOR — CURRENT CONTENT, TRUNCATED]\n` +
                    `The user has a large rich-text document editor (TipTap) open in the center panel. ` +
                    `Roughly ${fit.keptTokens.toLocaleString()} of ${fit.originalTokens.toLocaleString()} tokens shown below. ` +
                    `If the user asks about something not visible here, use notebook_kb_search to retrieve from the indexed content, ` +
                    `or ask them to quote / select the section they mean.\n` +
                    `\`\`\`html\n${fit.text}\n\`\`\`\n` +
                    `You can read, write, or edit this document using the notebook_doc_* tools.`;
            } else {
                documentContext =
                    `\n\n[DOCUMENT EDITOR — CURRENT CONTENT]\n` +
                    `The user has a rich-text document editor (TipTap) open in the center panel. Current content:\n` +
                    `\`\`\`html\n${fit.text}\n\`\`\`\n` +
                    `You can read, write, or edit this document using the notebook_doc_* tools.`;
            }
        } else {
            documentContext = '\n\n[DOCUMENT EDITOR — EMPTY]\nThe user has an empty rich-text document editor (TipTap) open. Use notebook_doc_write to create content.';
        }

        // Append the user's editor selection (set by the Ask AI / rewrite /
        // shorten / expand bubble menu actions on the frontend). When present,
        // the AI should treat "this", "the text", "the selection", etc. as
        // referring to the exact string below, and — for rewrite-style actions
        // — pass that same string verbatim as `find_text` to notebook_doc_replace.
        let selectionContext = '';
        if (notebookSelection && typeof notebookSelection.text === 'string' && notebookSelection.text.trim()) {
            const MAX_SEL_CHARS = 8000;
            const selText = notebookSelection.text.length > MAX_SEL_CHARS
                ? notebookSelection.text.slice(0, MAX_SEL_CHARS) + '…[truncated]'
                : notebookSelection.text;
            const actionHint = notebookSelection.action && ['rewrite', 'shorten', 'expand'].includes(notebookSelection.action)
                ? `The user explicitly invoked "${notebookSelection.action}" on this selection, so you MUST call notebook_doc_replace with find_text set to the exact selection above and replace_text set to your revised version.`
                : `If the user asks you to edit, rewrite, or change "this" / "the text" / "the selection", use notebook_doc_replace with find_text set to the EXACT string above. If they ask a question, answer about this text specifically.`;
            selectionContext =
                `\n\n[SELECTED TEXT IN DOCUMENT]\n` +
                `The user has highlighted the following text in the editor:\n` +
                `<<<SELECTION_BEGIN>>>\n${selText}\n<<<SELECTION_END>>>\n` +
                actionHint;
        }

        // Build system prompt
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // Compute search availability before the system prompt uses it
        const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
        const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
        const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
        const searchAvailable = searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);

        // ── Build system prompt ──────────────────────────────────────
        emitPhase(send, 'building_prompt');
        const _spT = Date.now();
        let systemPrompt;
        {
            systemPrompt = `You are an intelligent notebook assistant. Today is ${today}.

[NOTEBOOK: "${notebook.name}"]
${notebook.description ? `Description: ${notebook.description}` : ''}
${notebook.instructions ? `\nCustom Instructions: ${notebook.instructions}` : ''}

[AVAILABLE SOURCES]
${sourceSummary}

CRITICAL INSTRUCTIONS:
1. ALWAYS ground your responses in the notebook's sources when relevant context is available.
2. Use inline citations like [Source 1], [Source 2] when referencing specific information from the knowledge base.
3. If the user asks about something not covered in the sources, clearly state that and provide general knowledge with a disclaimer.
4. Be comprehensive but concise. Synthesize information across multiple sources when applicable.
5. If asked to summarize, compare, or analyze — draw from ALL relevant sources.
6. Format responses with clear structure: headings, bullet points, and citations.

[DOCUMENT TOOLS]
You have tools to interact with the user's document editor:
- notebook_doc_read: Read the current document content (ALWAYS use before editing)
- notebook_doc_write: Replace ALL document content (for new documents or full rewrites)
- notebook_doc_replace: Replace a SPECIFIC portion (preferred for edits)

TIPTAP HTML REFERENCE — Use ONLY these supported elements:
Block nodes:
  <p>paragraph text</p>
  <h1>Heading 1</h1>  <h2>Heading 2</h2>  <h3>Heading 3</h3>
  <ul><li><p>bullet item</p></li></ul>
  <ol><li><p>numbered item</p></li></ol>
  <blockquote><p>quoted text</p></blockquote>
  <pre><code>code block</code></pre>
  <hr>  (horizontal rule / divider)

Inline marks (wrap text inside <p> or <li>):
  <strong>bold</strong>
  <em>italic</em>
  <u>underline</u>
  <s>strikethrough</s>
  <mark>highlighted</mark>
  <code>inline code</code>
  <a href="https://example.com" target="_blank" rel="noopener noreferrer">link text</a>

MATH FORMULAS (KaTeX — @tiptap/extension-mathematics):
  Inline math:  $E = mc^2$    (dollar signs around the LaTeX expression)
  Block math:   $$\\frac{a}{b} = \\frac{c}{d}$$    (double dollar signs on their own line)
  Rules:
  - Use LaTeX syntax inside the $ delimiters (e.g., \\frac, \\sum, \\int, \\sqrt, ^, _)
  - Inline math goes directly inside a <p> tag: <p>The formula $E = mc^2$ shows mass-energy equivalence.</p>
  - Block math goes in its own <p> tag on a separate line: <p>$$\\sum_{i=1}^{n} x_i$$</p>
  - NEVER escape the dollar signs in HTML — write them as literal $ characters
  - Good example: <p>Einstein's equation $E = mc^2$ states that energy equals mass times the speed of light squared.</p>

EMOJI (via :shortcode: syntax — @tiptap/extension-emoji):
  The editor supports emoji shortcodes using GitHub emoji names.
  Examples: :rocket: 🚀  :fire: 🔥  :check: ✅  :warning: ⚠️  :star: ⭐  :brain: 🧠  :book: 📖
  - Emoji can be placed directly inline in text: <p>Great work! :rocket: This is a breakthrough :fire:</p>
  - You can also use the literal Unicode emoji character directly in HTML: <p>Great work! 🚀</p>
  - Prefer Unicode characters in document tool calls for maximum compatibility.

DRAG HANDLE (user feature — no action needed from AI):
  The editor has a drag handle that appears when the user hovers over a block.
  This allows blocks to be reordered by drag-and-drop. No special HTML is needed.

TEXT COLOR & HIGHLIGHTS (@tiptap/extension-color + TextStyle + Highlight):
  Apply text colors using inline styles on <span> elements:
    <span style="color: #e74c3c">red text</span>
    <span style="color: #2ecc71">green text</span>
    <span style="color: #3498db">blue text</span>
  Apply background highlights using <mark>:
    <mark>default yellow highlight</mark>
    <mark style="background-color: #ffeaa7">custom highlight color</mark>
  You can combine color with other formatting:
    <strong><span style="color: #e74c3c">bold red</span></strong>
    <em><mark style="background-color: #dfe6e9">italic highlighted</mark></em>
  Use colors when the user asks for colored, highlighted, or styled text.
  Common color palette: #e74c3c (red), #e67e22 (orange), #f1c40f (yellow),
    #2ecc71 (green), #3498db (blue), #9b59b6 (purple), #1abc9c (teal), #34495e (dark)

TYPOGRAPHY (auto-corrections — transparent to AI):
  The editor auto-corrects typographic patterns (smart quotes, em dashes, fractions).
  Examples: typing -- → —, (tm) → ™, 1/2 → ½. These happen automatically. No action needed from AI.

IMAGES (@tiptap/extension-image):
  - HTML: <img src="URL" alt="description">
  - When inserting images, use publicly accessible URLs. User uploads go via the toolbar (not AI).
  - If the user asks to add an image by URL: <p><img src="https://example.com/photo.jpg" alt="Description"></p>
  - Do NOT try to upload images or use data: URLs from AI tool calls.

TASK LISTS (@tiptap/extension-task-list + TaskItem):
  - Use <ul data-type="taskList"> for task/checklist items
  - Each item: <li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Task text</p></div></li>
  - Checked item: data-checked="true" (and add checked attribute to input)
  - Example:
    <ul data-type="taskList">
      <li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div><p>Review document</p></div></li>
      <li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div><p>Write introduction</p></div></li>
    </ul>
  - Use task lists when the user asks for action items, to-do lists, checklists, or follow-ups.

IMPORTANT HTML RULES:
- List items MUST contain <p> tags: <ul><li><p>text</p></li></ul>, NOT <ul><li>text</li></ul>
- Links MUST use <a href="url" target="_blank" rel="noopener noreferrer">text</a> format
- For citations/sources with URLs, ALWAYS use clickable <a> tags, NOT plain text references like [1]
- Use <hr> to separate sections visually
- All text must be inside block nodes (<p>, <h1>, <li>, etc.)

DOCUMENT RULES — FOLLOW STRICTLY:
1. When the user asks you to rewrite, shorten, expand, fix, edit, or modify text from the document: ALWAYS use notebook_doc_replace to apply the change directly. Do NOT just return the modified text in your response.
2. For partial edits, ALWAYS prefer notebook_doc_replace over notebook_doc_write
3. Before using notebook_doc_replace, call notebook_doc_read first to see the EXACT current content
4. When asked to write, create, or draft something: write it to the document using notebook_doc_write — don't just reply with the content in chat
5. The user's message may include text from the document — use notebook_doc_replace with that text as find_text to apply your changes directly
6. After applying changes via tool, briefly confirm what you did in your response (e.g. "I've shortened that paragraph in the document")
7. For source citations in documents, use clickable links: <a href="url" target="_blank" rel="noopener noreferrer">Source Name</a> — never use [1] style refs
8. STYLE CONSISTENCY: When using notebook_doc_replace, ALWAYS match the original text's formatting. If you are replacing text that was in a paragraph, the replacement MUST be wrapped in <p> tags. Do NOT use headers (h1, h2, h3) for replacements unless specifically asked for a header. Avoid "Big Bold Letters" unless they were already there.
9. MATH: When writing scientific, mathematical, or technical content — use KaTeX math syntax ($inline$ or $$block$$) for formulas. This renders beautifully in the editor.
10. EMOJI: You may use Unicode emoji characters directly in document content where appropriate for visual clarity.
11. TASK LISTS: When the user asks for action items, to-dos, checklists, or follow-up tasks — use the task list HTML syntax above. This renders as real interactive checkboxes.
12. IMAGES: Only insert images by URL when explicitly asked. Do NOT invent image URLs.

${searchAvailable ? `[WEB SEARCH & SOURCES]
- You can search the web using agent_search for current information and research
- You can add search results or any text directly as a notebook source using notebook_add_source
- When adding web search results as a source, pass the complete results text directly — no need to re-fetch
` : ''}${kbContext}${documentContext}${selectionContext}
Now: ${(() => { const _tz = timezone || 'Europe/Amsterdam'; try { const _now = new Date(); const _dp = _now.toLocaleString('sv-SE', { timeZone: _tz }); const _lp = new Date(_now.toLocaleString('en-US', { timeZone: _tz })); const _om = Math.round((_lp - _now) / 60000); const _s = _om >= 0 ? '+' : '-'; const _a = Math.abs(_om); return `${_dp} UTC${_s}${String(Math.floor(_a/60)).padStart(2,'0')}:${String(_a%60).padStart(2,'0')} (${_tz})`; } catch(_) { return new Date().toISOString(); } })()}`;
        }
        emitPhaseEnd(send, 'building_prompt', Date.now() - _spT);

        // Announce document truncation to the client now that we've finalised
        // the system prompt. One event per turn — the UI debounces banners.
        if (documentTruncation) {
            send('document_truncated', documentTruncation);
        }

        let messages = [{ role: 'system', content: systemPrompt }];

        // Add conversation history
        if (history && Array.isArray(history)) {
            for (const msg of history) {
                if ((msg.role === 'user' || msg.role === 'assistant') && msg.content?.trim()) {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        // Add current message with attachments
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

        // ── PII detection / tokenization (Privacy Shield) ──────────────
        // Mirrors directChat: if the org's Privacy Shield has either Azure
        // PII or Local Transformers.js PII enabled, run validateInputForPii
        // on the last user message and apply tokenize/block actions.
        let piiTokenMap = null;
        try {
            const orgShield = userOrgForTiers ? await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`) : null;
            const orgPiiEnabled = !!(orgShield?.enabled && (orgShield?.azurePiiEnabled || orgShield?.localPiiEnabled !== false));
            if (orgPiiEnabled) {
                const { validateInputForPii } = require('../../core/azurePiiDetection');
                const piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield);
                if (piiResult && piiResult.tokenizedText) {
                    const lastMsg = messages[messages.length - 1];
                    if (typeof lastMsg.content === 'string') {
                        lastMsg.content = piiResult.tokenizedText;
                    } else if (Array.isArray(lastMsg.content)) {
                        const textPart = lastMsg.content.find(p => p.type === 'text');
                        if (textPart) textPart.text = piiResult.tokenizedText;
                    }
                    piiTokenMap = piiResult.tokenMap;
                    try { require('../../core/dlp/dlpRunner').mergeTokenMap(notebookId, piiResult.tokenMap); } catch (_) { /* non-fatal */ }
                    console.warn(`[NotebookChat] 🔒 PII tokenized (${Object.keys(piiTokenMap).length} tokens)`);
                }
            }
        } catch (piiError) {
            if (piiError?.message?.includes('PII Detected')) {
                send('error', { error: piiError.message, violationCodes: piiError.violationCodes });
                return res.end();
            }
            // Service unavailable → fail-open
        }

        // ── Build tool list ──────────────────────────────────────────
        const notebookTools = [...NOTEBOOK_DOC_TOOLS, NOTEBOOK_ADD_SOURCE_TOOL];

        // Add KB search tool so the AI can explicitly search notebook sources
        if (kbIds.length > 0) {
            notebookTools.push(NOTEBOOK_KB_SEARCH_TOOL);
        }

        // Add web search tools if available (searchAvailable computed earlier for system prompt)
        if (searchAvailable) {
            notebookTools.push(...AGENT_SEARCH_TOOLS);
        }



        // ── Tool calling loop ────────────────────────────────────────
        const tierSettings = tiers[resolvedTier] || {};
        const { TIER_DEFAULTS } = require('../../core/modelResolver');
        const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        };

        // Track mutable document content (updated by tool calls)
        let currentDocContent = documentContent || '';
        let toolCallRounds = 0;
        const MAX_TOOL_ROUNDS = parseInt(await configStore.getConfig('max_tool_rounds_chat'), 10) || 5;

        while (toolCallRounds < MAX_TOOL_ROUNDS) {
            let result;
            try {
                result = await adapter.chat(apiKey, apiUrl, modelId, messages, {
                    ...chatOptions,
                    tools: notebookTools,
                    toolChoice: 'auto',
                });
            } catch (err) {
                console.error('[NotebookChat] Tool check error:', err.message);
                // Fall through to streaming without tools
                break;
            }

            if (!result.toolCalls || result.toolCalls.length === 0) {
                // No tool calls — break to streaming
                break;
            }

            // Add assistant message with tool calls to history
            messages.push({
                role: 'assistant',
                content: result.content || null,
                tool_calls: result.toolCalls,
            });
            toolCallRounds++;

            // Execute tool calls
            const toolResults = await Promise.all(result.toolCalls.map(async (toolCall) => {
                const toolName = toolCall.function?.name || toolCall.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {}

                console.log(`[NotebookChat] Tool call: ${toolName}(${JSON.stringify(toolArgs).substring(0, 200)})`);
                send('thinking', { text: `Using tool: ${toolName}...` });

                let toolResult;

                // Notebook document tools
                if (toolName.startsWith('notebook_doc_')) {
                    toolResult = executeNotebookDocTool(toolName, toolArgs, currentDocContent);

                    // If tool updated the document, send the update to the frontend
                    if (toolResult._action === 'notebook_doc_update') {
                        currentDocContent = toolResult.content;
                        send('notebook_doc_update', { content: toolResult.content, title: toolResult.title });
                    }
                }
                // Notebook add source — directly ingest text as a source
                else if (toolName === 'notebook_add_source') {
                    try {
                        const { ingestTextSource } = require('../../agents/notebooks/sourceIngestion');
                        const sourceName = toolArgs.name || 'AI Research';
                        const sourceContent = toolArgs.content || '';
                        const sourceMeta = toolArgs.metadata || {};

                        if (!sourceContent.trim()) {
                            toolResult = { error: 'Content is required to add a source.' };
                        } else {
                            // Create the source record with structured metadata
                            const source = await notebookStore.addSource({
                                notebookId,
                                type: 'text',
                                name: sourceName,
                                metadata: sourceMeta,
                                wordCount: sourceContent.split(/\s+/).length,
                            });

                            // Track new source for in-flight dedup within same session
                            sources.push({ ...source, metadata: sourceMeta });

                            // Background ingest (chunk + index)
                            ingestTextSource(notebookId, source.id, userId, sourceContent, sourceName).catch(err => {
                                console.error(`[NotebookChat] Source ingestion failed:`, err.message);
                            });

                            // Notify frontend with metadata for instant dashboard update
                            send('notebook_source_added', {
                                source: { id: source.id, name: sourceName, type: 'text', status: 'processing', metadata: sourceMeta }
                            });

                            toolResult = {
                                success: true,
                                message: `Source "${sourceName}" added to the notebook. It's being indexed and will be available for citation shortly.`,
                                sourceId: source.id
                            };
                            console.log(`[NotebookChat] Added source "${sourceName}" (${sourceContent.split(/\s+/).length} words, vendor: ${sourceMeta.vendor || 'unknown'})`);
                        }
                    } catch (err) {
                        console.error('[NotebookChat] Add source failed:', err.message);
                        toolResult = { error: `Failed to add source: ${err.message}` };
                    }
                }
                // Notebook KB search tool
                else if (toolName === 'notebook_kb_search') {
                    try {
                        toolResult = await executeNotebookKBSearchTool(toolArgs, userId, kbIds);
                    } catch (err) {
                        toolResult = { error: `KB search failed: ${err.message}` };
                    }
                }
                // Web search
                else if (isAgentSearchTool(toolName)) {
                    try {
                        toolResult = await executeAgentSearchTool(toolName, toolArgs);
                    } catch (err) {
                        toolResult = { error: `Search failed: ${err.message}` };
                    }
                }

                // Unknown tool
                else {
                    toolResult = { error: `Unknown tool: ${toolName}` };
                }

                return {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
                };
            }));

            messages.push(...toolResults);
        }

        // ── Stream final response ────────────────────────────────────
        let fullContent = '';
        const streamOptions = {
            ...chatOptions,
            // Only pass tools if we haven't exhausted tool rounds and there was no tool use yet
            tools: toolCallRounds === 0 ? notebookTools : undefined,
            toolChoice: toolCallRounds === 0 ? 'auto' : undefined,
        };

        let streamToolCalls = [];
        const streamCallback = (type, data) => {
            if (type === 'text') {
                fullContent += data.text;
                send('content', { text: data.text });
            } else if (type === 'thinking') {
                send('thinking', { text: data.text });
            } else if (type === 'tool_use') {
                streamToolCalls.push({
                    id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    type: 'function',
                    function: {
                        name: data.name,
                        arguments: JSON.stringify(data.input || {}),
                    },
                });
            } else if (type === 'error') {
                send('error', data);
            }
        };

        emitPhase(send, 'streaming_start', modelId);
        await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);

        // Handle tool calls that came through streaming (SDK-based providers like Google)
        if (streamToolCalls.length > 0 && toolCallRounds < MAX_TOOL_ROUNDS) {
            messages.push({
                role: 'assistant',
                content: fullContent || null,
                tool_calls: streamToolCalls,
            });

            const streamToolResults = await Promise.all(streamToolCalls.map(async (toolCall) => {
                const toolName = toolCall.function?.name || toolCall.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {}

                console.log(`[NotebookChat] Stream tool call: ${toolName}`);
                if (!toolName) return { tool_call_id: toolCall.id, role: 'tool', content: 'Unknown tool' };
                let toolResult;

                if (toolName.startsWith('notebook_doc_')) {
                    toolResult = executeNotebookDocTool(toolName, toolArgs, currentDocContent);
                    if (toolResult._action === 'notebook_doc_update') {
                        currentDocContent = toolResult.content;
                        send('notebook_doc_update', { content: toolResult.content, title: toolResult.title });
                    }
                } else if (toolName === 'notebook_add_source') {
                    try {
                        const { ingestTextSource } = require('../../agents/notebooks/sourceIngestion');
                        const sourceName = toolArgs.name || 'AI Research';
                        const sourceContent = toolArgs.content || '';
                        const sourceMeta = toolArgs.metadata || {};
                        if (!sourceContent.trim()) {
                            toolResult = { error: 'Content is required.' };
                        } else {
                            const source = await notebookStore.addSource({
                                notebookId, type: 'text', name: sourceName,
                                metadata: sourceMeta,
                                wordCount: sourceContent.split(/\s+/).length,
                            });
                            sources.push({ ...source, metadata: sourceMeta });
                            ingestTextSource(notebookId, source.id, userId, sourceContent, sourceName).catch(() => {});
                            send('notebook_source_added', { source: { id: source.id, name: sourceName, type: 'text', status: 'processing', metadata: sourceMeta } });
                            toolResult = { success: true, message: `Source "${sourceName}" added.`, sourceId: source.id };
                        }
                    } catch (err) {
                        toolResult = { error: err.message };
                    }
                } else if (toolName === 'notebook_kb_search') {
                    try { toolResult = await executeNotebookKBSearchTool(toolArgs, userId, kbIds); }
                    catch (err) { toolResult = { error: `KB search failed: ${err.message}` }; }
                } else if (isAgentSearchTool(toolName)) {
                    try { toolResult = await executeAgentSearchTool(toolName, toolArgs); }
                    catch (err) { toolResult = { error: err.message }; }

                } else {
                    toolResult = { error: `Unknown tool: ${toolName}` };
                }

                return {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
                };
            }));

            messages.push(...streamToolResults);

            // Stream the follow-up response (no tools this time)
            fullContent = '';
            const followUpCallback = (type, data) => {
                if (type === 'text') {
                    fullContent += data.text;
                    send('content', { text: data.text });
                } else if (type === 'thinking') {
                    send('thinking', { text: data.text });
                }
            };

            await adapter.stream(apiKey, apiUrl, modelId, messages, chatOptions, followUpCallback);
        }

        send('done', {});
        res.end();

    } catch (err) {
        console.error('[NotebookChat] Error:', err);
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
