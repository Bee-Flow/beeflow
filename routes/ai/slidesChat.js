/**
 * Slides Chat — AI chat with slide manipulation tools.
 *
 * Mirrors routes/ai/notebookChat.js exactly:
 * - Same SSE streaming pattern
 * - Same model tier resolution + EU mode
 * - Same tool calling loop (max 5 rounds)
 *
 * Tools available:
 * - slides_deck_read/write/add/update/delete/reorder: Manipulate slides
 * - slides_add_source: Add content as deck source
 * - agent_search: Web research
 * - notebook_kb_search: Search deck knowledge base
 */

const express = require('express');
const router = express.Router();
const {
    getAIConfig,
    getProviderForModel,
} = require('../../core/aiAgent');
const configStore = require('../../stores/configStore');
const { getAdapter } = require('../../core/providers');
const slidesStore = require('../../stores/slidesStore');

const { SLIDES_DOC_TOOLS, SLIDES_ADD_SOURCE_TOOL, executeSlidesDocTool } = require('../../integrations/slidesDocTools');
const { AGENT_SEARCH_TOOLS, executeAgentSearchTool, isAgentSearchTool } = require('../../integrations/agentSearchTools');
const { searchNotebookKB, executeNotebookKBSearchTool, NOTEBOOK_KB_SEARCH_TOOL } = require('../../core/notebookKnowledgeSearch');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Streaming Slides Chat ───────────────────────────────────────

router.post('/chat/slides/stream', requireAuth, async (req, res) => {
    const { message, deckId, history, modelTier, timezone, attachments, slidesContent } = req.body;
    const userId = req.session.user.id;

    if (!message) return res.status(400).json({ error: 'Message required' });
    if (!deckId) return res.status(400).json({ error: 'Deck ID required' });

    // Load deck
    const deck = await slidesStore.getDeck(deckId, userId);
    if (!deck) return res.status(404).json({ error: 'Slide deck not found' });

    // Get sources for context
    const sources = await slidesStore.getSources(deckId);
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
            console.log(`[SlidesChat] EU mode active for org ${userOrgForTiers}`);
        }
    }

    let resolvedTier = modelTier || 'fast';

    // Auto mode
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/promptClassifier');
            const result = await classifyWithLLM(message, tiers);
            resolvedTier = result.tier;
            console.log(`[SlidesChat] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason})`);
        } catch (err) {
            console.log(`[SlidesChat] Auto classification failed: ${err.message}, using fast`);
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
        console.error(`[SlidesChat] Provider resolution failed for model "${modelId}":`, providerErr.message);
        return res.status(400).json({ error: providerErr.message });
    }
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

    console.log(`[SlidesChat] Model: ${modelId} (tier: ${resolvedTier}) for deck: "${deck.name}" (${readySources.length} sources, ${(deck.slidesContent || []).length} slides)`);

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
        // Search deck knowledge base
        let kbContext = '';
        let citationSources = [];
        const kbIds = deck.knowledgeBaseIds || [];
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
                    console.log(`[SlidesChat] Injected ${kbResult.chunks.length} KB chunks`);
                }
            } catch (kbErr) {
                console.warn('[SlidesChat] KB search failed:', kbErr.message);
            }
        }

        if (citationSources.length > 0) {
            send('kb_sources', { sources: citationSources.map(s => ({ title: s.title, preview: s.content, score: s.score })) });
        }

        // Build source summary
        const sourceSummary = readySources.length > 0
            ? readySources.map(s => `- ${s.name} (${s.type}, ${(s.wordCount || 0).toLocaleString()} words)`).join('\n')
            : '(No sources added yet)';

        // Build slides context
        const currentSlides = slidesContent || deck.slidesContent || [];
        let slidesContext = '';
        if (currentSlides.length > 0) {
            // Provide a concise summary instead of full JSON to save tokens
            const slidesSummary = currentSlides.map((s, i) => {
                const heading = s.elements?.find(e => e.type === 'heading')?.content || 'No title';
                const elementTypes = (s.elements || []).map(e => e.type).join(', ');
                return `  Slide ${i + 1} (id: ${s.id}, layout: ${s.layout}): "${heading}" [${elementTypes}]`;
            }).join('\n');
            slidesContext = `\n\n[CURRENT SLIDES — ${currentSlides.length} slides]\n${slidesSummary}\n\nUse slides_deck_read to see full content before editing.`;
        } else {
            slidesContext = '\n\n[SLIDE DECK — EMPTY]\nThe deck has no slides yet. Use slides_deck_write to create slides or slides_add to add individual slides.';
        }

        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const theme = deck.settings?.theme || 'corporate';

        // Compute search availability
        const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
        const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
        const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
        const searchAvailable = searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);

        const systemPrompt = `You are an expert presentation designer and slide deck architect. You produce Google Slides-quality, visually compelling presentations. Today is ${today}.

[SLIDE DECK: "${deck.name}"]
${deck.description ? `Description: ${deck.description}` : ''}
${deck.instructions ? `\nCustom Instructions: ${deck.instructions}` : ''}
Theme: ${theme}

[AVAILABLE SOURCES]
${sourceSummary}

CRITICAL INSTRUCTIONS:
1. Ground your responses in the deck's sources when relevant.
2. Use inline citations like [Source 1], [Source 2] when referencing specific information.
3. When asked to create or edit slides, ALWAYS use the slides tools — don't just describe what to put on slides.
4. Keep slide content concise: max 6 bullet points per slide, max 8 words per bullet.
5. Use a varied mix of layouts for rich visual variety — NEVER use only "content" slides.
6. Always include speaker notes with talking points when creating slides.

[AVAILABLE THEMES]
Use slides_apply_theme to set the theme for the deck. Available themes:
- "corporate": Professional blue/white
- "dark": Dark navy with indigo accents
- "pitch": Ultra-modern black with gold (#f5c418) — best for business pitches
- "creative": Pink/purple gradient, vibrant
- "minimal": Clean white, ultra-simple typography
- "gradient": Vivid multi-color, high energy
- "aurora": Deep space navy with cyan/teal accents — stunning for tech/AI
- "academic": Warm amber/sepia, scholarly feel
- "tech": Neon cyan/green on near-black, terminal aesthetic
- "nature": Fresh greens, health/sustainability

[LAYOUT TYPES]
Each slide has a "layout" field. Choose thoughtfully:

1. "title" — Large centered heading + subtitle. For deck cover/intro.
2. "content" — Heading at top, body text/list below. Workhorse layout.
3. "two-column" — Heading at top, two text columns side-by-side.
4. "split-left" — Premium: IMAGE/GRADIENT left (45%), TEXT right (55%). Use slides_add_image_split.
5. "split-right" — Premium: TEXT left (55%), IMAGE/GRADIENT right (45%). Use slides_add_image_split.
6. "hero" — Full-bleed image or gradient bg with text overlay. For dramatic effect.
7. "section" — Large centered text, topic separator between main sections.
8. "blank" — Free-form absolute positioning for custom layouts.

[SLIDE TOOLS]
**Content tools:**
- slides_deck_read: Read all slides as JSON (CALL THIS FIRST before any editing)
- slides_deck_write: Replace ALL slides (for full generation)
- slides_add: Insert a standard slide (title/content/section/two-column/blank) at a position
- slides_update: Update a specific slide's content, layout, elements, or notes
- slides_delete: Remove a slide by ID
- slides_reorder: Change slide order

**Premium layout tool:**
- slides_add_image_split: Create a split slide with IMAGE ZONE + TEXT ZONE. This is the MOST VISUALLY IMPACTFUL layout. Use it for cover slides, feature highlights, team slides, and stat showcases. The image zone uses a branded gradient by default.

  Example usage: For a cover slide on "AI in Healthcare":
  {
    position: 0,
    side: "left",
    imageZone: { background: "linear-gradient(135deg, #22d3ee 0%, #0f4c75 60%, #10b981 100%)" },
    background: "#0a0a1a",
    elements: [
      { type: "label", content: "WHITEPAPER 2025" },
      { type: "heading", content: "AI in Healthcare" },
      { type: "text", content: "How machine learning is transforming patient outcomes globally." },
      { type: "meta", content: "Dr. Sarah Chen · April 2025" }
    ]
  }

**Styling tools:**
- slides_apply_theme: Switch the whole deck theme
- slides_set_background: Set a CSS background (gradient, solid, radial) on one or all slides
- slides_style_element: Apply CSS to any element (borders, shadows, glass, typography)
- slides_add_shape: Add a decorative element (accent bar, pill badge, highlight rectangle)

[ELEMENT TYPES]
Elements are content blocks. For standard slides (absolute positioning), each has "position" {x,y,width,height in percent} and "style" {CSS}.
For split slides, elements have "zone": "content" and are stacked vertically — NO position needed.

Types (both modes):
- "heading": Bold main title. Use fontWeight:"800", large fontSize, letterSpacing:"-0.02em"
- "text": Body paragraph. Use lineHeight:"1.65", secondary text color
- "list": HTML bullet list. content: "<ul><li>Point</li></ul>"
- "label": Small uppercase category label. Use textTransform:"uppercase", letterSpacing:"0.15em", theme accent color
- "stat": Big impact number. Set content to the value (e.g. "94%"), set label field for descriptor
- "quote": Pull quote with left accent bar. Set content and optionally "author" field
- "divider": Horizontal line/gradient divider
- "meta": Small fine print / attribution text
- "image": Image element. content = URL
- "code": Code block with monospace formatting

[IMAGE ZONE GRADIENT RECIPES]
Always pick a gradient that fits the theme:
- Warm gold pitch: "linear-gradient(135deg, #f5c418 0%, #e8832a 60%, #c85d1a 100%)"
- Deep navy: "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #334155 100%)"
- Vibrant indigo: "linear-gradient(135deg, #6366f1 0%, #8b5cf6 60%, #ec4899 100%)"
- Teal tech: "linear-gradient(135deg, #22d3ee 0%, #10b981 60%, #065f46 100%)"
- Aurora: "linear-gradient(135deg, #0a0a1a 0%, #111132 40%, #22d3ee 80%)"
- Emerald nature: "linear-gradient(135deg, #15803d 0%, #65a30d 100%)"
- Crimson bold: "linear-gradient(135deg, #991b1b 0%, #dc2626 60%, #f87171 100%)"
- Pink creative: "linear-gradient(135deg, #be185d 0%, #ec4899 60%, #f9a8d4 100%)"

[DESIGN RULES]
1. When asked to create slides — use tools directly. Never just describe what to make.
2. ALWAYS call slides_deck_read first before editing to see element IDs.
3. Use slides_add_image_split for cover slides, feature highlights, team profiles, and big stats.
4. For dark themes: use glassmorphism cards — { background:"rgba(255,255,255,0.07)", backdropFilter:"blur(12px)", border:"1px solid rgba(255,255,255,0.12)", borderRadius:"16px", padding:"24px" }
5. Add gradient accent bars between sections: slides_add_shape at y:17 h:0.45 with gradient background.
6. Use "label" elements (UPPERCASE, small, accent color) to brand every major slide.
7. Mix layouts: never use only "content" slides. Alternate with split, section, two-column.
8. For a 10-slide deck: 1 title, 1 split cover, 2 section dividers, 4 content/two-column, 1 split stats, 1 closing.
9. Stat slides: use "stat" elements with big numbers. E.g. { type:"stat", content:"94%", label:"Customer Satisfaction" }
10. After any tool sequence, briefly confirm what you did.

${searchAvailable ? `[WEB SEARCH & SOURCES]
- Search the web using agent_search for current data, statistics, and facts
- Save search results as deck sources using slides_add_source
- Reference searched facts in slide content with citations
` : ''}${kbContext}${slidesContext}
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
        const tools = [...SLIDES_DOC_TOOLS, SLIDES_ADD_SOURCE_TOOL];

        if (kbIds.length > 0) {
            tools.push(NOTEBOOK_KB_SEARCH_TOOL);
        }

        if (searchAvailable) {
            tools.push(...AGENT_SEARCH_TOOLS);
        }

        // ── Tool calling loop (same as notebookChat) ─────────────────
        const tierSettings = tiers[resolvedTier] || {};
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || 8192,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : 0.7,
        };

        let currentSlidesContent = slidesContent || deck.slidesContent || [];
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
                console.error('[SlidesChat] Tool check error:', err.message);
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

                console.log(`[SlidesChat] Tool call: ${toolName}(${JSON.stringify(toolArgs).substring(0, 200)})`);
                send('thinking', { text: `Using tool: ${toolName}...` });

                let toolResult;

                // Slide tools
                if (toolName.startsWith('slides_deck_') || toolName === 'slides_add' || toolName === 'slides_update' || toolName === 'slides_delete' || toolName === 'slides_reorder' || toolName === 'slides_apply_theme' || toolName === 'slides_set_background' || toolName === 'slides_style_element' || toolName === 'slides_add_shape' || toolName === 'slides_add_image_split') {
                    toolResult = executeSlidesDocTool(toolName, toolArgs, currentSlidesContent);

                    if (toolResult._action === 'slides_deck_update') {
                        currentSlidesContent = toolResult.slides;
                        send('slides_deck_update', { slides: toolResult.slides, title: toolResult.title });
                    } else if (toolResult._action === 'slides_theme_update') {
                        send('slides_theme_update', { theme: toolResult.theme });
                    }
                }
                // Source adding
                else if (toolName === 'slides_add_source') {
                    try {
                        const { ingestTextSource } = require('../../agents/slides/sourceIngestion');
                        const sourceName = toolArgs.name || 'AI Research';
                        const sourceContent = toolArgs.content || '';

                        if (!sourceContent.trim()) {
                            toolResult = { error: 'Content is required to add a source.' };
                        } else {
                            const source = await slidesStore.addSource({
                                deckId,
                                type: 'text',
                                name: sourceName,
                                wordCount: sourceContent.split(/\s+/).length,
                            });

                            ingestTextSource(deckId, source.id, userId, sourceContent, sourceName).catch(err => {
                                console.error(`[SlidesChat] Source ingestion failed:`, err.message);
                            });

                            send('slides_source_added', {
                                source: { id: source.id, name: sourceName, type: 'text', status: 'processing' }
                            });

                            toolResult = {
                                success: true,
                                message: `Source "${sourceName}" added to the deck.`,
                                sourceId: source.id
                            };
                        }
                    } catch (err) {
                        console.error('[SlidesChat] Add source failed:', err.message);
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

                console.log(`[SlidesChat] Stream tool call: ${toolName}`);
                if (!toolName) return { tool_call_id: toolCall.id, role: 'tool', content: 'Unknown tool' };
                let toolResult;

                if (toolName.startsWith('slides_deck_') || toolName === 'slides_add' || toolName === 'slides_update' || toolName === 'slides_delete' || toolName === 'slides_reorder' || toolName === 'slides_apply_theme' || toolName === 'slides_set_background' || toolName === 'slides_style_element' || toolName === 'slides_add_shape') {
                    toolResult = executeSlidesDocTool(toolName, toolArgs, currentSlidesContent);
                    if (toolResult._action === 'slides_deck_update') {
                        currentSlidesContent = toolResult.slides;
                        send('slides_deck_update', { slides: toolResult.slides, title: toolResult.title });
                    } else if (toolResult._action === 'slides_theme_update') {
                        send('slides_theme_update', { theme: toolResult.theme });
                    }
                } else if (toolName === 'slides_add_source') {
                    try {
                        const { ingestTextSource } = require('../../agents/slides/sourceIngestion');
                        const sourceName = toolArgs.name || 'AI Research';
                        const sourceContent = toolArgs.content || '';
                        if (sourceContent.trim()) {
                            const source = await slidesStore.addSource({
                                deckId, type: 'text', name: sourceName,
                                wordCount: sourceContent.split(/\s+/).length,
                            });
                            ingestTextSource(deckId, source.id, userId, sourceContent, sourceName).catch(() => {});
                            send('slides_source_added', { source: { id: source.id, name: sourceName, type: 'text', status: 'processing' } });
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
        console.error('[SlidesChat] Error:', err);
        send('error', { error: `Chat error: ${err.message}` });
        res.end();
    }
});

module.exports = router;
