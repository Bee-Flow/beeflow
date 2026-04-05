/**
 * Sheet Chat — AI chat with spreadsheet manipulation tools.
 *
 * Mirrors routes/ai/slidesChat.js exactly:
 * - Same SSE streaming pattern
 * - Same model tier resolution + EU mode
 * - Same tool calling loop (max 5 rounds)
 *
 * Tools available:
 * - sheet_read_cells/write_cells/write_range: Read and modify spreadsheet cells
 * - sheet_add_source: Add content as sheet source
 * - agent_search: Web research
 * - notebook_kb_search: Search sheet knowledge base
 */

const express = require('express');
const router = express.Router();
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const sheetStore = require('../../stores/sheetStore');

const { SHEET_DOC_TOOLS, SHEET_ADD_SOURCE_TOOL, executeSheetDocTool } = require('../../integrations/sheetDocTools');
const { AGENT_SEARCH_TOOLS, executeAgentSearchTool, isAgentSearchTool } = require('../../integrations/agentSearchTools');
const { searchNotebookKB, executeNotebookKBSearchTool, NOTEBOOK_KB_SEARCH_TOOL } = require('../../core/notebookKnowledgeSearch');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Streaming Sheet Chat ────────────────────────────────────────

router.post('/chat/sheet/stream', requireAuth, async (req, res) => {
    const { message, spreadsheetId, history, modelTier, timezone, attachments, sheetsContent } = req.body;
    const userId = req.session.user.id;

    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!spreadsheetId) return res.status(400).json({ error: 'Spreadsheet ID required' });

    // Load spreadsheet
    const spreadsheet = await sheetStore.getSpreadsheet(spreadsheetId, userId);
    if (!spreadsheet) return res.status(404).json({ error: 'Spreadsheet not found' });

    // Get sources for context
    const sources = await sheetStore.getSources(spreadsheetId);
    const readySources = sources.filter(s => s.status === 'ready');

    // Resolve model from tier config (same logic as notebookChat)
    let tiers = await configStore.getConfig('chat_model_tiers') || {};

    // EU mode + org privacy shield
    const { resolveUserOrgIds: resolveOrgIdsForTiers } = require('../../auth');
    const userStore = require('../../stores/userStore');
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
    if (userOrgForTiers) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`);
        if (shield?.enabled && shield.euModeEnabled) {
            const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
            const mergedTiers = { ...tiers };
            for (const [tierName, euTier] of Object.entries(euTiers)) {
                if (euTier?.modelId) {
                    mergedTiers[tierName] = { ...mergedTiers[tierName], ...euTier };
                }
            }
            tiers = mergedTiers;
            console.log(`[SheetChat] EU mode active for org ${userOrgForTiers}`);
        }
    }

    let resolvedTier = modelTier || 'fast';

    // Auto mode
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/promptClassifier');
            const result = await classifyWithLLM(message, tiers);
            resolvedTier = result.tier;
            console.log(`[SheetChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            console.log(`[SheetChat] Auto classification failed: ${err.message}, using fast`);
            resolvedTier = 'fast';
        }
    }

    const tier = tiers[resolvedTier] || {};
    let modelId = tier.modelId;

    if (!modelId) {
        const config = await getAIConfig();
        modelId = config.model;
        if (!modelId) throw new Error(`No model configured for tier "${resolvedTier}".`);
    }

    // Resolve provider
    let config;
    let adapter;
    try {
        config = await getProviderForModel(modelId);
        adapter = getAdapter(config.providerType, (config.url || '').replace(/\/+$/, ''));
    } catch (providerErr) {
        console.error(`[SheetChat] Provider resolution failed for model "${modelId}":`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    const currentSheetsData = sheetsContent || spreadsheet.sheetsContent || [];
    const cellCount = currentSheetsData.reduce((sum, s) => sum + Object.keys(s?.cells || {}).length, 0);
    console.log(`[SheetChat] Model: ${modelId} (tier: ${resolvedTier}) for sheet: "${spreadsheet.name}" (${readySources.length} sources, ${cellCount} cells)`);

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

    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }

    try {
        // Search spreadsheet knowledge base
        let kbContext = '';
        let citationSources = [];
        const kbIds = spreadsheet.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            try {
                const kbResult = await searchNotebookKB({
                    userId, kbIds, query: message,
                    options: { topK: 10, rerank: true, minScore: 0.2 },
                });

                if (kbResult.chunks.length > 0) {
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
                    console.log(`[SheetChat] Injected ${kbResult.chunks.length} KB chunks`);
                }
            } catch (kbErr) {
                console.warn('[SheetChat] KB search failed:', kbErr.message);
            }
        }

        if (citationSources.length > 0) {
            send('kb_sources', { sources: citationSources.map(s => ({ title: s.title, preview: s.content, score: s.score })) });
        }

        // Build source summary
        const sourceSummary = readySources.length > 0
            ? readySources.map(s => `- ${s.name} (${s.type}, ${(s.wordCount || 0).toLocaleString()} words)`).join('\n')
            : '(No sources added yet)';

        // Build spreadsheet context
        let sheetContext = '';
        if (currentSheetsData.length > 0) {
            const sheetsSummary = currentSheetsData.map((s, i) => {
                const cellKeys = Object.keys(s?.cells || {});
                const cellCount = cellKeys.length;
                // Show a preview of the first few cells
                const preview = cellKeys.slice(0, 10).map(ref => {
                    const cell = s.cells[ref];
                    const val = typeof cell === 'object' && cell !== null ? (cell.formula || cell.value) : cell;
                    return `${ref}=${JSON.stringify(val)}`;
                }).join(', ');
                return `  Sheet ${i + 1} "${s.name || 'Untitled'}": ${cellCount} cells${preview ? ` (${preview}${cellKeys.length > 10 ? ', ...' : ''})` : ' (empty)'}`;
            }).join('\n');
            sheetContext = `\n\n[CURRENT SPREADSHEET — ${currentSheetsData.length} sheet(s)]\n${sheetsSummary}\n\nUse sheet_read_cells to see full data before editing.`;
        } else {
            sheetContext = '\n\n[SPREADSHEET — EMPTY]\nThe spreadsheet has no data yet. Use sheet_write_cells or sheet_write_range to populate it.';
        }

        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // Compute search availability
        const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
        const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
        const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
        const searchAvailable = searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);

        const systemPrompt = `You are an intelligent spreadsheet assistant and data analyst. Today is ${today}.

[SPREADSHEET: "${spreadsheet.name}"]
${spreadsheet.description ? `Description: ${spreadsheet.description}` : ''}
${spreadsheet.instructions ? `\nCustom Instructions: ${spreadsheet.instructions}` : ''}

[AVAILABLE SOURCES]
${sourceSummary}

CRITICAL INSTRUCTIONS:
1. Ground your responses in the spreadsheet's sources when relevant.
2. Use inline citations like [Source 1], [Source 2] when referencing specific information.
3. When asked to add, edit, or fill data — ALWAYS use the sheet tools directly.
4. For tabular data, use sheet_write_range with a 2D array for efficiency.
5. For individual cell updates, use sheet_write_cells with a cell map.
6. Always read the current data with sheet_read_cells BEFORE making changes.

[SHEET TOOLS]
You have tools to manipulate the spreadsheet:
- sheet_read_cells: Read cell data (optionally by range like "A1:D10")
- sheet_write_cells: Write individual cells { "A1": "value", "B2": 42 }
- sheet_write_range: Write a 2D table starting at a cell

CELL FORMAT:
- Cell references: "A1", "B2", "AA100" (column letter(s) + row number)
- Values: strings, numbers, booleans, or objects { value, formula, style }
- Formulas: start with "=" (e.g., "=SUM(A1:A10)", "=AVERAGE(B2:B5)")
- Styles: { fontWeight: "bold", color: "#333", backgroundColor: "#f0f0f0", textAlign: "right" }

DATA BEST PRACTICES:
1. Always put headers in row 1
2. Keep data types consistent within columns (numbers in one, text in another)
3. Use formulas for calculated values
4. Use sheet_write_range for bulk data (more efficient than individual cells)
5. Format numbers and dates appropriately

${searchAvailable ? `[WEB SEARCH & SOURCES]
- You can search the web using agent_search for current data and information
- You can add search results as spreadsheet sources using sheet_add_source
` : ''}${kbContext}${sheetContext}
Now: ${new Date().toLocaleString('sv-SE', { timeZone: timezone || 'UTC', timeZoneName: 'short' })}`;

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

        // ── Build tool list ──────────────────────────────────────────
        const tools = [...SHEET_DOC_TOOLS, SHEET_ADD_SOURCE_TOOL];

        if (kbIds.length > 0) {
            tools.push(NOTEBOOK_KB_SEARCH_TOOL);
        }

        if (searchAvailable) {
            tools.push(...AGENT_SEARCH_TOOLS);
        }

        // ── Tool calling loop (same as slidesChat / notebookChat) ────
        const tierSettings = tiers[resolvedTier] || {};
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || 8192,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : 0.7,
        };

        let currentSheetContent = sheetsContent || spreadsheet.sheetsContent || [];
        let toolCallRounds = 0;
        const MAX_TOOL_ROUNDS = 5;

        while (toolCallRounds < MAX_TOOL_ROUNDS) {
            let result;
            try {
                result = await adapter.chat(apiKey, apiUrl, modelId, messages, {
                    ...chatOptions,
                    tools,
                    toolChoice: 'auto',
                });
            } catch (err) {
                console.error('[SheetChat] Tool check error:', err.message);
                break;
            }

            if (!result.toolCalls || result.toolCalls.length === 0) break;

            messages.push({
                role: 'assistant',
                content: result.content || null,
                tool_calls: result.toolCalls,
            });
            toolCallRounds++;

            const toolResults = await Promise.all(result.toolCalls.map(async (toolCall) => {
                const toolName = toolCall.function?.name || toolCall.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) {}

                console.log(`[SheetChat] Tool call: ${toolName}(${JSON.stringify(toolArgs).substring(0, 200)})`);
                send('thinking', { text: `Using tool: ${toolName}...` });

                let toolResult;

                // Sheet tools
                if (toolName.startsWith('sheet_read') || toolName.startsWith('sheet_write')) {
                    toolResult = executeSheetDocTool(toolName, toolArgs, currentSheetContent);

                    if (toolResult._action === 'sheet_doc_update') {
                        // Merge cells into current sheet content
                        const sheetIdx = toolResult.sheetIndex || 0;
                        if (currentSheetContent[sheetIdx]) {
                            const existing = currentSheetContent[sheetIdx].cells || {};
                            currentSheetContent[sheetIdx].cells = { ...existing, ...toolResult.cells };
                        }
                        send('sheet_update', { cells: toolResult.cells, sheetIndex: sheetIdx });
                    }
                }
                // Source adding
                else if (toolName === 'sheet_add_source') {
                    try {
                        const { ingestTextSource } = require('../../agents/sheets/sourceIngestion');
                        const sourceName = toolArgs.name || 'AI Research';
                        const sourceContent = toolArgs.content || '';

                        if (!sourceContent.trim()) {
                            toolResult = { error: 'Content is required to add a source.' };
                        } else {
                            const source = await sheetStore.addSource({
                                spreadsheetId,
                                type: 'text',
                                name: sourceName,
                                wordCount: sourceContent.split(/\s+/).length,
                            });

                            ingestTextSource(spreadsheetId, source.id, userId, sourceContent, sourceName).catch(err => {
                                console.error(`[SheetChat] Source ingestion failed:`, err.message);
                            });

                            send('sheet_source_added', {
                                source: { id: source.id, name: sourceName, type: 'text', status: 'processing' }
                            });

                            toolResult = {
                                success: true,
                                message: `Source "${sourceName}" added to the spreadsheet.`,
                                sourceId: source.id
                            };
                        }
                    } catch (err) {
                        console.error('[SheetChat] Add source failed:', err.message);
                        toolResult = { error: `Failed to add source: ${err.message}` };
                    }
                }
                // KB search
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
            tools: toolCallRounds === 0 ? tools : undefined,
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

        await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);

        // Handle streaming tool calls (SDK-based providers)
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

                console.log(`[SheetChat] Stream tool call: ${toolName}`);
                if (!toolName) return { tool_call_id: toolCall.id, role: 'tool', content: 'Unknown tool' };
                let toolResult;

                if (toolName.startsWith('sheet_read') || toolName.startsWith('sheet_write')) {
                    toolResult = executeSheetDocTool(toolName, toolArgs, currentSheetContent);
                    if (toolResult._action === 'sheet_doc_update') {
                        const sheetIdx = toolResult.sheetIndex || 0;
                        if (currentSheetContent[sheetIdx]) {
                            currentSheetContent[sheetIdx].cells = { ...currentSheetContent[sheetIdx].cells, ...toolResult.cells };
                        }
                        send('sheet_update', { cells: toolResult.cells, sheetIndex: sheetIdx });
                    }
                } else if (toolName === 'sheet_add_source') {
                    try {
                        const { ingestTextSource } = require('../../agents/sheets/sourceIngestion');
                        const sourceName = toolArgs.name || 'AI Research';
                        const sourceContent = toolArgs.content || '';
                        if (sourceContent.trim()) {
                            const source = await sheetStore.addSource({
                                spreadsheetId, type: 'text', name: sourceName,
                                wordCount: sourceContent.split(/\s+/).length,
                            });
                            ingestTextSource(spreadsheetId, source.id, userId, sourceContent, sourceName).catch(() => {});
                            send('sheet_source_added', { source: { id: source.id, name: sourceName, type: 'text', status: 'processing' } });
                            toolResult = { success: true, message: `Source "${sourceName}" added.` };
                        } else {
                            toolResult = { error: 'Content is required.' };
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

            // Stream follow-up response
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
        console.error('[SheetChat] Error:', err);
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
