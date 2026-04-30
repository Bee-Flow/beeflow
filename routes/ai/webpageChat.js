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
    } = req.body;
    const userId = req.session.user.id;

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

        const systemPrompt = `You are an intelligent webpage-building assistant. Today is ${today}.

[WEBPAGE: "${webpage.name}"]
${webpage.description ? `Description: ${webpage.description}` : ''}
${webpage.instructions ? `\nCustom Instructions: ${webpage.instructions}` : ''}

[AVAILABLE SOURCES]
${sourceSummary}

[FILES — three slots, exposed via webpage_file_* tools]
- index.html (page structure)
- style.css (styles)
- script.js (interactive behavior, optional)

CRITICAL EDITING RULES:
1. Always call webpage_file_read({ file }) before webpage_file_replace on the same file.
2. Prefer webpage_file_replace for partial edits; reserve webpage_file_write for whole-file rewrites.
3. The HTML is rendered in a sandboxed iframe (sandbox="allow-scripts", no same-origin) — do NOT depend on parent-page cookies, localStorage, or fetches to the host app.
4. Vanilla HTML/CSS/JS only — there is no build step. CDN <script> tags are fine when needed (loaded inside the iframe).
5. The HTML can reference external CSS/JS via <link href="style.css"> and <script src="script.js"></script> — at download time the zip will contain real files matching those names. The in-app preview inlines them automatically, so EITHER style works.
6. Style and behavior should match the user's described intent. If the description is sparse, default to a clean, modern aesthetic with sensible spacing, readable typography, and accessible color contrast.
7. After applying changes via tool, briefly confirm what you did in the chat reply (e.g. "I added a hero section to index.html and centered the menu grid in style.css").

[CURRENT FILE CONTENTS]
${filesBlock}

${searchAvailable ? `[WEB SEARCH & SOURCES]
- Use agent_search for current information and research.
- Use webpage_add_source to attach search results / references as a webpage source.
` : ''}${kbContext}${selectionContext}
Now: ${(() => { const _tz = timezone || 'Europe/Amsterdam'; try { const _now = new Date(); const _dp = _now.toLocaleString('sv-SE', { timeZone: _tz }); const _lp = new Date(_now.toLocaleString('en-US', { timeZone: _tz })); const _om = Math.round((_lp - _now) / 60000); const _s = _om >= 0 ? '+' : '-'; const _a = Math.abs(_om); return `${_dp} UTC${_s}${String(Math.floor(_a / 60)).padStart(2, '0')}:${String(_a % 60).padStart(2, '0')} (${_tz})`; } catch (_) { return new Date().toISOString(); } })()}`;

        let messages = [{ role: 'system', content: systemPrompt }];

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
        const webpageTools = [...WEBPAGE_DOC_TOOLS, WEBPAGE_ADD_SOURCE_TOOL];
        if (kbIds.length > 0) webpageTools.push(WEBPAGE_KB_SEARCH_TOOL);
        if (searchAvailable) webpageTools.push(...AGENT_SEARCH_TOOLS);

        // Live in-memory file state — kept in sync with tool calls so the
        // model sees its own writes mid-turn.
        const liveFiles = { html, css, js };
        const dirtySlots = new Set();

        const tierSettings = tiers[resolvedTier] || {};
        const { TIER_DEFAULTS } = require('../../core/modelResolver');
        const tierDefaults = TIER_DEFAULTS[resolvedTier] || TIER_DEFAULTS['fast'];
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || tierDefaults.maxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
        };

        let toolCallRounds = 0;
        const MAX_TOOL_ROUNDS = 5;

        async function dispatchToolCall(toolCall) {
            const toolName = toolCall.function?.name || toolCall.name;
            let toolArgs = {};
            try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {}

            console.log(`[WebpageChat] Tool: ${toolName}(${JSON.stringify(toolArgs).substring(0, 160)})`);
            send('thinking', { text: `Using tool: ${toolName}...` });

            let toolResult;
            if (toolName.startsWith('webpage_file_')) {
                toolResult = executeWebpageDocTool(toolName, toolArgs, liveFiles);
                if (toolResult._action === 'webpage_doc_update') {
                    const slot = toolResult.file;
                    liveFiles[slot] = toolResult.content;
                    dirtySlots.add(slot);
                    send('webpage_doc_update', { file: slot, content: toolResult.content, title: toolResult.title });
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

            return {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
            };
        }

        // Tool-calling loop (chat-style)
        while (toolCallRounds < MAX_TOOL_ROUNDS) {
            let result;
            try {
                result = await adapter.chat(apiKey, apiUrl, modelId, messages, {
                    ...chatOptions,
                    tools: webpageTools,
                    toolChoice: 'auto',
                });
            } catch (err) {
                console.error('[WebpageChat] Tool-check error:', err.message);
                break;
            }
            if (!result.toolCalls || result.toolCalls.length === 0) break;

            messages.push({
                role: 'assistant',
                content: result.content || null,
                tool_calls: result.toolCalls,
            });
            toolCallRounds++;
            const toolResults = await Promise.all(result.toolCalls.map(dispatchToolCall));
            messages.push(...toolResults);
        }

        // Final streamed response
        let fullContent = '';
        const streamOptions = {
            ...chatOptions,
            tools: toolCallRounds === 0 ? webpageTools : undefined,
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
                    function: { name: data.name, arguments: JSON.stringify(data.input || {}) },
                });
            } else if (type === 'error') {
                send('error', data);
            }
        };

        await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);

        // Stream-driven tool calls (e.g. Anthropic / Google adapters)
        if (streamToolCalls.length > 0 && toolCallRounds < MAX_TOOL_ROUNDS) {
            messages.push({
                role: 'assistant',
                content: fullContent || null,
                tool_calls: streamToolCalls,
            });
            const streamToolResults = await Promise.all(streamToolCalls.map(dispatchToolCall));
            messages.push(...streamToolResults);

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
