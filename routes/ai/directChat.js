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
const { WORKSPACE_TOOLS } = require('../../integrations/workspaceTools');
const guardrailEventStore = require('../../stores/guardrailEventStore');

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

### Interactive Mini-Apps — \`\`\`html-app
Use for calculators, interactive demos, visualizations, games, or any self-contained HTML+CSS+JS app. Write a SINGLE complete HTML document (with inline <style> and <script> tags). It renders in a sandboxed iframe. Use dark themes to match the platform (#0a0a1a background, #fff text). Do NOT use external scripts or imports. Example use cases: unit converters, mortgage calculators, interactive timers, drawing tools, physics simulations.

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

### Interactive Forms — \`\`\`json-form
Use to collect structured input from the user (credentials, settings, preferences). Provide a JSON object with:
- fields[]: Array of field objects — each has: name, type ("text"|"select"|"textarea"|"checkbox"|"radio"|"number"|"date"|"email"|"url"|"range"), label, placeholder?, required?, options? (for select/radio), hint?, defaultValue?
- submitLabel? (button text), description? (form intro text)
The form renders inline in the chat. When submitted, field values are sent back as a user message.

## Tool Usage
Do NOT describe what you *could* do — just do it. When a user requests an action you have a tool for — call it immediately. Only ask for clarification when critical parameters are genuinely ambiguous.

**Images**: When asked to generate, create, or draw an image, call generate_image immediately. Describe the scene richly in the prompt.

**Audio & Music**: When asked to create music, songs, beats, or spoken audio, call the appropriate ElevenLabs tool (elevenlabs_music, elevenlabs_tts, elevenlabs_sfx). Audio plays inline automatically — do NOT try to embed audio links in your response text.

**Reminders**: When asked to be reminded about something, call set_reminder. Always use the timezone from the "Now:" line — never default to UTC.

**AI Tasks**: When the user wants recurring AI-generated content (news digests, email summaries, reports, or any scheduled AI action), call set_ai_task. Write a detailed, specific prompt that tells the AI exactly what to do each time the task runs. The task runs in the background and delivers results as notifications.

**Web Search**: When you need current information, facts you're unsure about, or real-time data, use the search tool proactively.

**Email**: When composing emails, always match the user's personal writing style and language if a style profile is available.

**Notebooks**: When the user has a notebook open, prefer partial edits (notebook_replace) over full rewrites (notebook_write). Always call notebook_read before notebook_replace to see the exact current content.

## Response Language
Always respond in the same language the user writes in. If the user writes in Dutch, respond in Dutch. If in English, respond in English. Match their language exactly — do not switch unless explicitly asked.`;

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Streaming Direct Chat ───────────────────────────────────────

router.post('/chat/direct/stream', requireAuth, async (req, res) => {
    const { message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings, disabledMedia, webSearchEnabled = true, workspaceContent, workspaceSelection, projectId, timezone, systemPrompt: requestSystemPrompt, activeSkillIds } = req.body;
    const userId = req.session.user.id;

    if (!message && (!attachments || attachments.length === 0)) {
        return res.status(400).json({ error: 'Message or attachments required' });
    }

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

    // Auto mode: classify which tier to use
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/promptClassifier');
            const result = await classifyWithLLM(message, tiers, { userOrgId: userOrgForTiers, userId });
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
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');

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

    if (modelTier === 'auto') {
        send('model_selected', { tier: resolvedTier, modelId });
    }

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

        // Load integration tools via shared module
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

        // ─── Built-in: workspace tools ────────────────────────────────
        // Only inject notebook tools if the feature is enabled
        const notebooksEnabled = (await configStore.getConfig('feature_notebooks_enabled')) !== false;
        if (notebooksEnabled) {
            for (const wsTool of WORKSPACE_TOOLS) {
                if (!directChatTools.find(t => t.function.name === wsTool.function.name)) {
                    directChatTools.push(wsTool);
                }
            }
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

        // Build messages array
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
                                const kbResults = await quickKBSearch(userId, kbIds, message, { topK: 6 });

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

        // ─── Memory injection ────────────────────────────────────────
        let memoryContext = '';
        try {
            const memoryStore = require('../../stores/memoryStore');
            // Always pass projectId for retrieval (project memories should be available regardless of extractMemories flag)
            const relevantMemories = await memoryStore.findRelevantMemories(userId, null, message, 800, projectId || null);
            if (relevantMemories.length > 0) {
                memoryContext = '\n\n' + memoryStore.formatMemoriesForPrompt(relevantMemories);
            }
        } catch (e) {
            console.warn('[DirectChat] Memory retrieval failed:', e.message);
        }

        // ─── Notebook context injection ─────────────────────────────
        let workspaceContext = '';
        if (notebooksEnabled && workspaceContent) {
            workspaceContext = `\n\n[NOTEBOOK]
The user has a Notebook panel open. You have 4 tools:
- notebook_read: Read content. Modes: "outline" (default—headings+stats), "section" (one section by heading), "search" (find text), "full" (entire doc). Use outline first, then section/search for targeted access.
- notebook_write: Replace ALL content (for new documents or full rewrites). Write in Markdown.
- notebook_replace: Replace a SPECIFIC portion (find_text + replace_text). Preferred for edits.
- notebook_insert: Add content at "start", "end", or "after" a heading.

RULES: 1) Before notebook_replace, use notebook_read mode="search" or mode="section" to get exact text. 2) Copy find_text EXACTLY from read output. 3) For partial edits always prefer notebook_replace over notebook_write. 4) Use Markdown for rich text (headings, bold, tables, code blocks, lists, etc.).`;
            if (workspaceSelection && workspaceSelection.trim()) {
                workspaceContext += `\n\n[SELECTED TEXT IN NOTEBOOK]\nThe user selected this text:\n\`\`\`\n${workspaceSelection}\n\`\`\`\nUse notebook_replace with find_text set to EXACTLY this text. Set replace_text to the new version.`;
            }
        }

        // ─── Skills injection ────────────────────────────────────
        let skillsContext = '';
        if (Array.isArray(activeSkillIds) && activeSkillIds.length > 0) {
            try {
                const skillStore = require('../../stores/skillStore');
                // Cap at 3 active skills to prevent token overflow
                const cappedIds = activeSkillIds.slice(0, 3);
                const skills = await skillStore.getSkillsByIds(cappedIds, userOrgForTiers, userId);
                if (skills.length > 0) {
                    const skillBlocks = skills.map(s => {
                        let block = `\n### SKILL — "${s.name}"`;
                        if (s.instructions) block += `\nInstructions: ${s.instructions}`;
                        if (s.workflow) block += `\nWorkflow: ${s.workflow}`;
                        if (s.rules) block += `\nRules: ${s.rules}`;
                        if (s.examples) block += `\nExamples: ${s.examples}`;
                        return block;
                    }).join('\n');
                    skillsContext = `\n\n[ACTIVE SKILLS]\nThe user has activated the following skills. Follow their instructions precisely when the task matches.${skillBlocks}`;
                    console.log(`[DirectChat] Injected ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`);
                }
            } catch (skillErr) {
                console.warn('[DirectChat] Skills injection failed:', skillErr.message);
            }
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

        let messages = [
            {
                role: 'system', content: basePrompt + toolHint + memoryContext + workspaceContext + projectContext + skillsContext + `\nNow: ${_nowStr}`
            }
        ];

        // Add conversation history
        if (history && Array.isArray(history)) {
            for (const msg of history) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                    messages.push({ role: msg.role, content: msg.content });
                }
            }
        }

        let convId = conversationId;
        let lastResponseId = null; // OpenAI Responses API chaining
        let conversationSummary = null; // Compaction summary
        let hasDocumentAttachment = false;

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
                }
            } catch (e) { /* ignore */ }
        }

        // Add current message (with attachments if any)
        const persistedAttachments = []; // Track attachments for conversation persistence
        if (attachments && attachments.length > 0) {
            const contentParts = [];
            if (message) contentParts.push({ type: 'text', text: message });
            const storageStore = require('../../stores/storageStore');
            const crypto = require('crypto');

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
                    const driveText = `--- Google Drive: ${att.name} ---\n${att.content}\n--- End of ${att.name} ---`;
                    contentParts.push({ type: 'text', text: driveText });
                    persistedAttachments.push({ name: att.name, type: 'google-drive', extractedText: driveText });
                } else if (att.content && att.type && att.type.includes('pdf')) {
                    // PDF — pdfjs → Azure Document Intelligence (fallback when enabled)
                    try {
                        const base64Data = att.content.split(',')[1] || att.content;
                        const pdfBuffer = Buffer.from(base64Data, 'base64');
                        let pdfText = '';

                        // 1. Try pdfjs-dist first (fast, free — works for text-based PDFs)
                        try {
                            const { extractTextFromPDF } = require('../../core/pdfExtractor');
                            pdfText = await extractTextFromPDF(pdfBuffer, att.name);
                        } catch (parseErr) {
                            console.warn(`[DirectChat] pdfjs extraction failed for ${att.name}:`, parseErr.message);
                        }

                        // 2. If pdfjs returned empty (e.g. scanned PDF), try Azure Document Intelligence
                        if (!pdfText) {
                            const useAzureDoc = !!(await configStore.getConfig('use_azure_doc_processing'));
                            if (useAzureDoc) {
                                try {
                                    const { extractWithAzure, isAzureDocIntelligenceConfigured } = require('../../core/azureDocIntelligence');
                                    if (await isAzureDocIntelligenceConfigured()) {
                                        pdfText = await extractWithAzure(pdfBuffer, att.name);
                                        if (pdfText) {
                                            console.log(`[DirectChat] PDF extracted via Azure Document Intelligence: ${att.name} (${pdfText.length} chars)`);
                                        }
                                    }
                                } catch (azureErr) {
                                    console.warn(`[DirectChat] Azure Document Intelligence failed for PDF ${att.name}:`, azureErr.message);
                                }
                            }
                        }

                        // Upload original PDF to RustFS for persistence
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

                        if (pdfText) {
                            const docText = `[PDF Document: ${att.name}]\n---\n${pdfText}\n---`;
                            contentParts.push({ type: 'text', text: docText });
                            persistedAttachments.push({ name: att.name, type: att.type, url: pdfProxyUrl, extractedText: docText });
                        } else {
                            // PDF extraction failed — terminal containers have been removed
                            contentParts.push({
                                type: 'text',
                                text: `[PDF: ${att.name} — could not extract text. The document may be scanned or image-based. Try re-uploading a text-selectable version.]`
                            });
                            persistedAttachments.push({ name: att.name, type: att.type, url: pdfProxyUrl });
                            console.log(`[DirectChat] PDF extraction failed for ${att.name}, no container fallback available`);
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
                            const docText = `[Word Document: ${att.name}]\n---\n${docxText}\n---`;
                            contentParts.push({ type: 'text', text: docText });
                            persistedAttachments.push({ name: att.name, type: att.type, url: docxProxyUrl, extractedText: docText });
                            console.log(`[DirectChat] Extracted ${docxText.length} chars from DOCX: ${att.name}`);
                        } else {
                            // mammoth extraction returned empty/error — fall back to container
                            contentParts.push({ type: 'text', text: `[Word Document: ${att.name} — no extractable text, may contain only images]` });
                            persistedAttachments.push({ name: att.name, type: att.type, url: docxProxyUrl });
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
                            const docText = `[Spreadsheet: ${att.name}]\n---\n${sheetText}\n---`;
                            contentParts.push({ type: 'text', text: docText });
                            persistedAttachments.push({ name: att.name, type: att.type, url: sheetProxyUrl, extractedText: docText });
                            console.log(`[DirectChat] Extracted ${sheetText.length} chars from spreadsheet: ${att.name}`);
                        } else {
                            contentParts.push({ type: 'text', text: sheetText || `[Spreadsheet: ${att.name} — no data found]` });
                            persistedAttachments.push({ name: att.name, type: att.type, url: sheetProxyUrl });
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

                    contentParts.push({
                        type: 'text',
                        text: `[Attached file: ${filename}] This file has been uploaded${fileProxyUrl ? ' and stored' : ''}.${att.type ? ' Type: ' + att.type : ''}`
                    });
                    persistedAttachments.push({ name: att.name, type: att.type, url: fileProxyUrl });
                }
            }
            messages.push({ role: 'user', content: contentParts });
        } else {
            messages.push({ role: 'user', content: message });
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

        // ─── AI Content Moderation (org shield) ─────────────────────
        const { resolveUserOrgIds } = require('../../auth');
        const userOrgIds = await resolveUserOrgIds(req);
        const userOrgId = userOrgIds && userOrgIds.size > 0 ? Array.from(userOrgIds)[0] : null;

        // Check if org shield or global config enables moderation for direct chat
        let moderationViolation = null;
        const orgShield = userOrgId ? await configStore.getConfig(`org_privacy_shield_${userOrgId}`) : null;
        const globalModerationEnabled = (await getAIConfig()).llamaGuardConfig?.enabled;
        const moderationEnabled = (orgShield?.enabled && orgShield?.moderationEnabled) || globalModerationEnabled;
        const moderationScope = orgShield?.enabled ? (orgShield.scope || { userInput: true, agentOutput: true }) : { userInput: true, agentOutput: true };
        const webSearchGuardEnabled = !!(orgShield?.enabled && orgShield?.webSearchGuardEnabled);
        const moderationCategories = orgShield?.moderationCategories || null;

        // Check user input with moderation (only if scope.userInput)
        if (moderationEnabled && moderationScope.userInput) {
            try {
                const { validateInput } = require('../../core/moderation');
                await validateInput(messages, true, moderationCategories);
                console.log(`[DirectChat] AI moderation passed (user input)`);
            } catch (guardError) {
                if (guardError.violationCodes) {
                    let violationLabels = guardError.violationCodes;
                    try {
                        const parsed = JSON.parse(guardError.outcome);
                        violationLabels = parsed.map(f => f.label || f.category);
                    } catch (e) { /* use codes as-is */ }
                    send('guardrail_violation', {
                        rules: violationLabels,
                        autoDeleteSeconds: 5,
                        outcome: guardError.outcome,
                        categories: violationLabels
                    });
                    // Let the AI explain the violation instead of blocking
                    moderationViolation = violationLabels.join(', ');
                    console.log(`[DirectChat] Moderation violation detected: ${moderationViolation} — AI will respond`);

                    // Log moderation event (fire-and-forget)
                    guardrailEventStore.logGuardrailEvent({
                        organization_id: userOrgId || null,
                        user_id: userId,
                        conversation_id: convId || null,
                        violation_type: 'moderation',
                        violation_categories: moderationViolation,
                        direction: 'input',
                        action_taken: 'soft_block',
                        source: 'direct',
                        model: modelId || null,
                    }).catch(() => {});
                } else {
                    // Guard service error (not a violation) — fail-open, log and continue
                    console.warn(`[DirectChat] Guard service error (fail-open): ${guardError.message}`);
                }
            }
        }

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
        let piiTokenMap = null;  // non-null only in tokenize mode when PII found
        try {
            const { validateInputForPii } = require('../../core/azurePiiDetection');
            const orgPiiEnabled = !!(orgShield?.enabled && orgShield?.azurePiiEnabled);
            const piiResult = await validateInputForPii(messages.slice(-3), orgPiiEnabled, orgShield);

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
                const tokenList = Object.entries(piiResult.tokenMap).map(([t, v]) => `${t}=“${v.slice(0,15)}”`).join(', ');
                console.warn(`[DirectChat] 🔒 PII tokenized (${Object.keys(piiResult.tokenMap).length} tokens): ${tokenList}`);

                // Tell the AI about the tokenization so it can reference them properly
                messages[0].content += `\n\n[PII TOKENIZATION ACTIVE: Some sensitive data in the user's message has been replaced with placeholder tokens like [PII:iban:1]. When referencing this data in your response, use the same token (e.g. [PII:iban:1]) and the system will automatically restore the real value for the user. Never reveal or guess the actual values.`;

                send('pii_tokenized', {
                    entities: piiResult.entities.map(e => ({ label: e.label, category: e.category })),
                    tokenCount: Object.keys(piiResult.tokenMap).length,
                });

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
            if (piiError.piiEntities) {
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

        // ─── Regex Guardrails ────────────────────────────────────────
        const { resolveOrgShield, mergeWithOrgShield } = require('../../core/orgShield');

        // 1. Resolve org-level privacy shield regex rules for this user
        const orgShieldConfig = await resolveOrgShield(userOrgId);
        if (orgShieldConfig) {
            console.log(`[DirectChat] Org Privacy Shield active for org ${userOrgId} (${orgShieldConfig.rulesWithNames.length} rules)`);
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
            const compactionResult = await compactMessages(messages, {
                existingSummary: conversationSummary,
                summaryModelId: 'tier:fast',
                userOrgId: userOrgForTiers,
            });
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
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || defaultMaxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
            reasoningEffort: tierSettings.reasoningEffort || tierDefaults.reasoningEffort || undefined,
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
        const MAX_TOOL_ROUNDS = 5;
        const generatedImages = []; // Track images for persistence
        const generatedAudio = []; // Track audio for persistence
        const collectedEmailDrafts = [];
        const collectedCalendarDrafts = [];
        const collectedMapEmbeds = [];
        const collectedToolHistory = []; // Track tool calls for persistence

        // Strip internal metadata (_mcp etc.) before sending tools to LLM — providers may reject unknown fields
        directChatTools = directChatTools.map(t => {
            const { _mcp, _n8n, ...clean } = t;
            return clean;
        });

        // ─── Eagerly create conversation so workspace (and terminal) tools have a valid DB row ──
        // convId is null for brand-new chats that have no file attachments yet.
        // Without a row in direct_conversations, workspace_read/write/replace will fail
        // immediately with "Workspace requires an active conversation".
        if (!convId) {
            const newConv = await agentStore.createDirectConversation(userId, resolvedTier);
            convId = newConv.id;
            send('conversation_created', { conversationId: convId });
            console.log(`[DirectChat] Eagerly created conversation ${convId} for workspace/tool access`);
        }

        while (toolCallRounds < MAX_TOOL_ROUNDS) {
            if (directChatTools.length > 0 && !skipToolPrecheck) {
                // Non-streaming tool check via adapter.chat()
                let result;
                try {
                    result = await adapter.chat(apiKey, apiUrl, modelId, messages, {
                        ...chatOptions,
                        tools: directChatTools,
                        toolChoice: 'auto',
                    });
                } catch (err) {
                    console.error('[DirectChat] Tool check error:', err.message);
                    send('error', { error: `API error: ${err.message}` });
                    res.end();
                    return;
                }

                if (result.toolCalls && result.toolCalls.length > 0) {
                    // Add assistant message with tool calls to history
                    messages.push({
                        role: 'assistant',
                        content: result.content || null,
                        tool_calls: result.toolCalls,
                    });
                    toolCallRounds++;

                    // Execute all tool calls in parallel
                    const userAuth = { userId, session: req.session };
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
                                // 2. Llama Guard on search query
                                if (webSearchGuardEnabled) {
                                    try {
                                        const { validateInput } = require('../../core/moderation');
                                        await validateInput([{ role: 'user', content: toolArgs.query }], true, moderationCategories);
                                        console.log(`[DirectChat WebSearchGuard] Search query passed`);
                                    } catch (guardErr) {
                                        console.log(`[DirectChat WebSearchGuard] Search query BLOCKED: ${guardErr.message}`);
                                        guardrailEventStore.logGuardrailEvent({
                                            organization_id: userOrgId || null,
                                            user_id: userId,
                                            conversation_id: convId || null,
                                            violation_type: 'moderation',
                                            violation_categories: 'Web Search Guard',
                                            direction: 'input',
                                            action_taken: 'search_blocked',
                                            source: 'direct',
                                            model: modelId || null,
                                        }).catch(() => {});
                                        send('tool_end', { name: toolName, result: '[Web search blocked — query violates content policy]' });
                                        return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Web search blocked — query violates content policy. Please rephrase.' }) };
                                    }
                                }
                                // 3. PII Detection on search query (always runs for monitoring)
                                if (webSearchGuardPiiCategories && webSearchGuardPiiCategories.length > 0) {
                                    try {
                                        const { detectPii } = require('../../core/azurePiiDetection');
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
                            toolResult = await dispatchTool(toolName, toolArgs, {
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
                        } catch (err) {
                            console.error(`[DirectChat] Tool execution failed for ${toolName}:`, err);
                            toolResult = { error: err.message };
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
                                        const { detectPii } = require('../../core/azurePiiDetection');
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
                        // Emit whatsapp_draft SSE event for user approval
                        if (toolResult._action === 'whatsapp_draft') {
                            send('whatsapp_draft', toolResult.draft);
                        }
                        // Emit contacts_draft SSE event for user approval
                        if (toolResult._action === 'contacts_draft') {
                            send('contacts_draft', toolResult.draft);
                        }
                        // Emit keep_draft SSE event for user approval
                        if (toolResult._action === 'keep_draft') {
                            send('keep_draft', toolResult.draft);
                        }
                        // Emit workspace_update SSE event
                        if (toolResult._action === 'workspace_update') {
                            send('workspace_update', { content: toolResult.content });
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
                    continue;
                }
            }
            break;
        }

        // ─── Stream final response via adapter.stream() ──────────
        let fullContent = '';
        let thinkingContent = '';
        let streamToolCalls = []; // Tool calls received during streaming (Google SDK)
        let streamUsage = null;
        const streamStartTime = Date.now();

        const streamOptions = {
            ...chatOptions,
            tools: (toolCallRounds > 0) ? undefined : (directChatTools.length > 0 ? directChatTools : undefined),
            toolChoice: (toolCallRounds > 0) ? undefined : (directChatTools.length > 0 ? 'auto' : undefined),
        };

        const streamCallback = (type, data) => {
            if (type === 'text') {
                fullContent += data.text;
                // Stream raw text (tokens like [PII:iban:1] will show briefly — restored at end)
                send('content', { text: data.text });
            } else if (type === 'thinking') {
                thinkingContent += data.text;
                send('thinking', { text: data.text });
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

        try {
            await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);
        } catch (streamErr) {
            // Retry without previousResponseId if the error is about missing tool output
            // (stale response ID pointing to unresolved tool-call response)
            if (streamErr?.error?.message?.includes('No tool output found') && streamOptions.previousResponseId) {
                console.warn('[DirectChat] Stale previousResponseId detected, retrying without chaining');
                lastResponseId = null;
                streamOptions.previousResponseId = undefined;
                fullContent = '';
                thinkingContent = '';
                streamToolCalls = [];
                await adapter.stream(apiKey, apiUrl, modelId, messages, streamOptions, streamCallback);
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

        while (streamToolCalls.length > 0 && toolRound < MAX_STREAM_TOOL_ROUNDS) {
            toolRound++;
            console.log(`[DirectChat] Streamed tool round ${toolRound}: ${streamToolCalls.map(t => t.function?.name).join(', ')}`);

            messages.push({
                role: 'assistant',
                content: fullContent || null,
                tool_calls: streamToolCalls,
            });

            const userAuth = { userId, session: req.session };
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
                        // 2. Llama Guard on search query
                        if (webSearchGuardEnabled) {
                            try {
                                const { validateInput } = require('../../core/moderation');
                                await validateInput([{ role: 'user', content: toolArgs.query }], true, moderationCategories);
                                console.log(`[DirectChat WebSearchGuard] Streamed search query passed`);
                            } catch (guardErr) {
                                console.log(`[DirectChat WebSearchGuard] Streamed search query BLOCKED: ${guardErr.message}`);
                                guardrailEventStore.logGuardrailEvent({
                                    organization_id: userOrgId || null,
                                    user_id: userId,
                                    conversation_id: convId || null,
                                    violation_type: 'moderation',
                                    violation_categories: 'Web Search Guard',
                                    direction: 'input',
                                    action_taken: 'search_blocked',
                                    source: 'direct',
                                    model: modelId || null,
                                }).catch(() => {});
                                send('tool_end', { name: toolName, result: '[Web search blocked — query violates content policy]' });
                                return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Web search blocked — query violates content policy. Please rephrase.' }) };
                            }
                        }
                        // 3. PII Detection on search query (always runs for monitoring)
                        if (webSearchGuardPiiCategories && webSearchGuardPiiCategories.length > 0) {
                            try {
                                const { detectPii } = require('../../core/azurePiiDetection');
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
                    toolResult = await dispatchTool(toolName, toolArgs, {
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
                } catch (err) {
                    console.error(`[DirectChat] Streamed tool execution failed for ${toolName}:`, err);
                    toolResult = { error: err.message };
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
                                const { detectPii } = require('../../core/azurePiiDetection');
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
                // Emit whatsapp_draft SSE event for user approval
                if (toolResult._action === 'whatsapp_draft') {
                    send('whatsapp_draft', toolResult.draft);
                }
                // Emit contacts_draft SSE event for user approval
                if (toolResult._action === 'contacts_draft') {
                    send('contacts_draft', toolResult.draft);
                }
                // Emit keep_draft SSE event for user approval
                if (toolResult._action === 'keep_draft') {
                    send('keep_draft', toolResult.draft);
                }
                // Emit workspace_update SSE event
                if (toolResult._action === 'workspace_update') {
                    send('workspace_update', { content: toolResult.content });
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

            // Stream the follow-up response after tool execution (with tools for multi-round)
            fullContent = '';
            streamToolCalls = [];
            await adapter.stream(apiKey, apiUrl, modelId, messages, {
                ...chatOptions,
                previousResponseId: undefined, // Don't chain — we need to send tool results in full
                tools: directChatTools.length > 0 ? directChatTools : undefined,
            }, (type, data) => {
                if (type === 'text') {
                    fullContent += data.text;
                    send('content', { text: data.text });
                } else if (type === 'thinking') {
                    thinkingContent += data.text;
                    send('thinking', { text: data.text });
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
                    // Capture the follow-up response ID so chaining uses this
                    // (not the previous tool-call response)
                    if (data?.responseId) {
                        lastResponseId = data.responseId;
                        console.log('[DirectChat] Updated lastResponseId after tool follow-up:', lastResponseId);
                    }
                }
            });
        }

        // If LLM returned an empty response after tool calls, send a minimal confirmation
        if (!fullContent.trim() && toolCallRounds > 0) {
            fullContent = 'Done ✓';
            send('content', { text: fullContent });
        }

        // ─── PII Token Restoration ──────────────────────────────────
        // If tokens were injected before sending to AI, restore real values now
        if (piiTokenMap && Object.keys(piiTokenMap).length > 0 && fullContent) {
            const { restoreTokens } = require('../../core/azurePiiDetection');
            const restored = restoreTokens(fullContent, piiTokenMap);
            if (restored !== fullContent) {
                console.log('[DirectChat] 🔓 PII tokens restored in AI response');
                send('content_replace', { text: restored });
                fullContent = restored;
            }
        }

        // Check agent output against regex rules
        if (regexConfig?.enabled && regexConfig?.scope?.agentOutput && fullContent) {
            const matches = checkRegexPatterns(fullContent, regexConfig.rulesWithNames);
            if (matches.length > 0) {
                const ruleNames = matches.map(m => m.ruleName).join(', ');
                console.log(`[DirectChat RegexGuard] Agent output violated rules: ${ruleNames}`);
                if (regexConfig.action === 'redact') {
                    let redacted = fullContent;
                    for (const rule of regexConfig.rulesWithNames) {
                        try {
                            const regex = new RegExp(rule.pattern, 'gi');
                            redacted = redacted.replace(regex, `[REDACTED: ${rule.name}]`);
                        } catch (e) { /* skip */ }
                    }
                    send('content_replace', { text: redacted });
                    fullContent = redacted;
                } else {
                    send('guardrail_violation', { rules: ruleNames, autoDeleteSeconds: 5, source: 'agent_output' });
                }
            }
        }

        // Check agent output with AI moderation (only if scope.agentOutput)
        if (moderationEnabled && moderationScope.agentOutput && fullContent && !moderationViolation) {
            try {
                const { validateInput } = require('../../core/moderation');
                const outputMessages = [{ role: 'assistant', content: fullContent }];
                await validateInput(outputMessages, true, moderationCategories);
                console.log(`[DirectChat] AI moderation passed (agent output)`);
            } catch (guardError) {
                if (guardError.violationCodes) {
                    let violationLabels = guardError.violationCodes;
                    try {
                        const parsed = JSON.parse(guardError.outcome);
                        violationLabels = parsed.map(f => f.label || f.category);
                    } catch (e) { /* use codes as-is */ }
                    console.log(`[DirectChat] Agent output moderation violation: ${violationLabels.join(', ')}`);
                    send('content_replace', { text: `⚠️ This response was blocked by content moderation (${violationLabels.join(', ')}). The AI's response contained content that violates organization safety policies.` });
                    fullContent = '[Response blocked by content moderation]';

                    // Log output moderation event (fire-and-forget)
                    guardrailEventStore.logGuardrailEvent({
                        organization_id: userOrgId || null,
                        user_id: userId,
                        conversation_id: convId || null,
                        violation_type: 'moderation',
                        violation_categories: violationLabels.join(', '),
                        direction: 'output',
                        action_taken: 'soft_block',
                        source: 'direct',
                        model: modelId || null,
                    }).catch(() => {});
                }
            }
        }

        // ─── Conversation persistence ────────────────────────────
        if (!convId) {
            const conv = await agentStore.createDirectConversation(userId, modelTier || 'fast');
            convId = conv.id;
            send('conversation_created', { conversationId: convId });
            // Assign to project if provided
            if (projectId) {
                try {
                    const projectStore = require('../../stores/projectStore');
                    await projectStore.assignConversation(convId, projectId, 'direct_conversations');
                } catch (e) {
                    console.warn('[DirectChat] Failed to assign conversation to project:', e.message);
                }
            }
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
            const userSave = { role: 'user', content: moderationViolation ? '[Message removed - policy violation]' : message, timestamp: new Date().toISOString() };
            if (persistedAttachments.length > 0) userSave.attachments = persistedAttachments;
            savedMessages.push(userSave);
            const assistantSave = { role: 'assistant', content: fullContent, timestamp: new Date().toISOString() };
            if (thinkingContent) assistantSave.thinking = thinkingContent;
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
            if (collectedToolHistory.length > 0) assistantSave.toolHistory = collectedToolHistory;
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
            await agentStore.updateDirectConversation(convId, savedMessages, userId, updateMeta);

            // Auto-extract memories from conversation (async, fire-and-forget)
            if (!moderationViolation && message && fullContent) {
                try {
                    const { extractMemories } = require('../../core/memoryExtractor');
                    extractMemories(userId, message, fullContent, null, extractMemoriesEnabled ? projectId : null, userOrgForTiers).catch(e =>
                        console.warn('[DirectChat] Memory extraction error:', e.message)
                    );
                } catch (e) { /* ignore */ }
            }

            // Generate title for new conversations (skip if moderation violation — don't send unsafe content to title LLM)
            console.log(`[DirectChat] Title check: savedMessages=${savedMessages.length}, moderationViolation=${!!moderationViolation}`);
            if (savedMessages.length <= 2 && !moderationViolation) {
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
                        message,
                        titleAgent?.system_prompt
                    );
                    console.log(`[DirectChat] Title generated: "${title}" for conv ${convId}`);
                    await agentStore.updateDirectConversationTitle(convId, title, userId);
                    send('title', { title, conversationId: convId });
                    console.log(`[DirectChat] Title saved and sent via SSE`);
                } catch (e) {
                    console.error('[DirectChat] Title generation failed:', e.message, e.stack);
                }
            } else if (savedMessages.length <= 2 && moderationViolation) {
                // Moderation violation — set a safe generic title instead
                const safeTitle = 'New Chat';
                await agentStore.updateDirectConversationTitle(convId, safeTitle, userId);
                send('title', { title: safeTitle, conversationId: convId });
            }
        }

        // ─── Memory extraction (background, non-blocking) ──────────
        if (!moderationViolation) {
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
        send('error', { error: error.message });
    } finally {
        res.end();
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
        res.json({
            content: conv.workspace_content || '',
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
