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
const { getIntegrationTools, buildToolHint } = require('../../core/integrationTools');
const { checkRegexPatterns } = require('../../core/guardrails');
const { checkSubscriptionLimits, resolveOrgId } = require('../../core/limits');
const { getServiceHeaders } = require('../../core/serviceAuth');

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// ─── Streaming Direct Chat ───────────────────────────────────────

router.post('/chat/direct/stream', requireAuth, async (req, res) => {
    const { message, conversationId, modelTier, history, attachments, imageGenSettings, nanoBananaSettings, disabledMedia, webSearchEnabled = true, workspaceContent, workspaceSelection, projectId, timezone, systemPrompt: requestSystemPrompt } = req.body;
    const userId = req.session.user.id;

    if (!message && (!attachments || attachments.length === 0)) {
        return res.status(400).json({ error: 'Message or attachments required' });
    }

    // Resolve model from tier config
    let tiers = await configStore.getConfig('chat_model_tiers') || {};

    // EU mode + org privacy shield: resolve user's org early
    const { resolveUserOrgIds: resolveOrgIdsForTiers } = require('../../auth');
    const userStore = require('../../stores/userStore');
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
    let disableSearchOnUpload = false;
    if (userOrgForTiers) {
        const shield = await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`);
        if (shield?.enabled) {
            if (shield.euModeEnabled) {
                const euTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
                const mergedTiers = { ...tiers };
                for (const [tierName, euTier] of Object.entries(euTiers)) {
                    if (euTier?.modelId) {
                        mergedTiers[tierName] = { ...mergedTiers[tierName], ...euTier };
                    }
                }
                tiers = mergedTiers;
                console.log(`[DirectChat] EU mode active for org ${userOrgForTiers}`);
            }
            disableSearchOnUpload = !!shield.disableSearchOnUpload;
            if (disableSearchOnUpload) console.log(`[DirectChat] Org ${userOrgForTiers}: disableSearchOnUpload=true`);
        }
    }
    let resolvedTier = modelTier || 'fast';

    // Auto mode: classify which tier to use
    if (resolvedTier === 'auto') {
        try {
            const { classifyWithLLM } = require('../../core/promptClassifier');
            const result = await classifyWithLLM(message, tiers);
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
    const config = await getProviderForModel(modelId);
    const apiKey = config.apiKey;
    const apiUrl = (config.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(config.providerType, apiUrl);

    console.log(`[DirectChat] Provider: ${config.providerName || 'default'} (${adapter.name})`);
    console.log(`[DirectChat] Using model: ${modelId} (tier: ${resolvedTier}${modelTier === 'auto' ? ', auto-selected' : ''})`);

    // ── Subscription limit enforcement ──
    const limitOrgId = resolveOrgId(req);
    const limitError = checkSubscriptionLimits(limitOrgId, 'chat');
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
        if (disableSearchOnUpload && attachments && attachments.length > 0) {
            directChatTools = directChatTools.filter(t => t.function.name !== 'agent_search');
            console.log('[DirectChat] Web search disabled — files attached (org policy)');
        }

        // Build messages array
        const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const customPrompt = await configStore.getConfig('direct_chat_system_prompt');
        const basePrompt = (requestSystemPrompt ? requestSystemPrompt + '\n\n' : '') + (customPrompt
            ? `${customPrompt}\n\nToday is ${today}.`
            : `You are a helpful AI assistant. Today is ${today}. Respond thoughtfully and concisely.`);

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
                                const searchUrl = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.ai';
                                const searchRes = await fetch(`${searchUrl}/tools/kb-search`, {
                                    method: 'POST',
                                    headers: getServiceHeaders(),
                                    body: JSON.stringify({ tenant_id: userId, kb_ids: kbIds, query: message, top_k: 8, rerank: true }),
                                    signal: AbortSignal.timeout(10000),
                                });
                                if (searchRes.ok) {
                                    const searchData = await searchRes.json();
                                    const chunks = (searchData.chunks || searchData.results || []).filter(c => (c.score || c.rerank_score || 0) >= 0.25);
                                    if (chunks.length > 0) {
                                        const kbText = chunks.slice(0, 6).map((c, i) => {
                                            const src = c.source_uri || c.title || 'KB';
                                            const content = (c.content || '').slice(0, 1200);
                                            return `### Source ${i + 1}: ${src}\n${content}`;
                                        }).join('\n\n');
                                        projectContext += `\n\n[PROJECT KNOWLEDGE BASE — "${project.name}"]\nRelevant information from this project's knowledge base:\n${kbText}`;
                                        console.log(`[DirectChat] Injected ${chunks.length} KB chunks from project "${project.name}"`);
                                    }
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

        // ─── Workspace context injection ─────────────────────────────
        let workspaceContext = '';
        if (workspaceContent && workspaceContent.trim()) {
            workspaceContext = '\n\n[WORKSPACE CONTEXT]\nThe user has an active workspace document (markdown) open alongside the chat. You have 3 workspace tools:\n- workspace_read: Read current content (ALWAYS use this before workspace_replace to get exact text)\n- workspace_write: Replace ALL content (for new documents or full rewrites only)\n- workspace_replace: Replace a SPECIFIC portion (preferred for edits — uses find_text + replace_text)\n\nWORKSPACE RULES:\n1. For partial edits, ALWAYS prefer workspace_replace over workspace_write\n2. Before using workspace_replace, call workspace_read first to see the EXACT current content\n3. Copy the find_text EXACTLY from workspace_read output — character by character, including markdown formatting\n4. The workspace persists across chat messages — content stays until explicitly changed';
            if (workspaceSelection && workspaceSelection.trim()) {
                workspaceContext += `\n\n[SELECTED TEXT — RAW MARKDOWN]\nThe user has selected this text in the workspace (raw markdown source):\n\`\`\`\n${workspaceSelection}\n\`\`\`\nUse workspace_replace with find_text set to EXACTLY this text (including any ** # - formatting). Set replace_text to the new version. To remove, set replace_text to empty string.`;
            }
        }

        let messages = [
            {
                role: 'system', content: basePrompt + toolHint + memoryContext + workspaceContext + projectContext + `\nNow: ${new Date().toLocaleString('sv-SE', { timeZone: timezone || 'UTC', timeZoneName: 'short' })}`
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
                    // Upload image to RustFS for persistence
                    let imageProxyUrl = null;
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
                        }
                    } catch (e) {
                        console.warn(`[DirectChat] Failed to upload image to RustFS: ${e.message}`);
                    }
                    contentParts.push({ type: 'image_url', image_url: { url: att.content } });
                } else if (att.source === 'google-drive' && att.content) {
                    // Google Drive file — already exported as plain text, inject directly
                    const driveText = `--- Google Drive: ${att.name} ---\n${att.content}\n--- End of ${att.name} ---`;
                    contentParts.push({ type: 'text', text: driveText });
                    persistedAttachments.push({ name: att.name, type: 'google-drive', extractedText: driveText });
                } else if (att.content && att.type && att.type.includes('pdf')) {
                    // PDF — use pdf-parse as primary extractor, Mistral OCR as optional fallback for scanned PDFs
                    try {
                        const base64Data = att.content.split(',')[1] || att.content;
                        const pdfBuffer = Buffer.from(base64Data, 'base64');
                        let pdfText = '';

                        // 1. Try pdfjs-dist first (works for text-based PDFs)
                        try {
                            const { extractTextFromPDF } = require('../../core/pdfExtractor');
                            pdfText = await extractTextFromPDF(pdfBuffer, att.name);
                        } catch (parseErr) {
                            console.warn(`[DirectChat] pdfjs extraction failed for ${att.name}:`, parseErr.message);
                        }

                        // 2. If pdf-parse returned empty (scanned PDF), try Mistral OCR as fallback
                        if (!pdfText) {
                            try {
                                const { mistralOCR } = require('../../core/ocr');
                                pdfText = await mistralOCR(base64Data, att.type, att.name);
                                if (pdfText) {
                                    console.log(`[DirectChat] PDF extracted via Mistral OCR fallback: ${att.name}`);
                                }
                            } catch (ocrErr) {
                                console.warn(`[DirectChat] Mistral OCR fallback failed: ${ocrErr.message}`);
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
                            // Both extraction methods failed — fall back to container upload
                            hasDocumentAttachment = true;
                            if (!convId) {
                                const conv = await agentStore.createDirectConversation(userId, modelTier || 'fast');
                                convId = conv.id;
                                send('conversation_created', { conversationId: convId });
                            }
                            const containerManager = require('../../terminal/containerManager');
                            const os = require('os');
                            const fs = require('fs');
                            const path = require('path');

                            const containerKey = `direct-${convId}`;
                            await containerManager.getOrCreateContainer(containerKey, `user-${userId}`);

                            const filename = att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                            const tmpHostPath = path.join(os.tmpdir(), `direct_att_${crypto.randomBytes(8).toString('hex')}_${filename}`);
                            fs.writeFileSync(tmpHostPath, pdfBuffer);
                            containerManager.copyToContainer(containerKey, tmpHostPath, `/workspace/${filename}`);
                            fs.unlinkSync(tmpHostPath);

                            contentParts.push({
                                type: 'text',
                                text: `[Uploaded document: ${filename}] This file has been placed in your secure terminal workspace at /workspace/${filename}. Use terminal tools to analyze it.`
                            });
                            persistedAttachments.push({ name: att.name, type: att.type, url: pdfProxyUrl });
                            console.log(`[DirectChat] PDF extraction failed, fell back to container: ${att.name}`);
                        }
                    } catch (e) {
                        console.error(`[DirectChat] PDF processing failed for ${att.name}:`, e.message);
                        contentParts.push({
                            type: 'text',
                            text: `[PDF: ${att.name} — failed to process: ${e.message}]`
                        });
                    }
                } else if (att.content) {
                    hasDocumentAttachment = true;
                    if (!convId) {
                        const conv = await agentStore.createDirectConversation(userId, modelTier || 'fast');
                        convId = conv.id;
                        send('conversation_created', { conversationId: convId });
                    }

                    try {
                        const containerManager = require('../../terminal/containerManager');
                        const os = require('os');
                        const fs = require('fs');
                        const path = require('path');

                        const containerKey = `direct-${convId}`;
                        await containerManager.getOrCreateContainer(containerKey, `user-${userId}`);

                        const base64Data = att.content.split(',')[1] || att.content;
                        const buffer = Buffer.from(base64Data, 'base64');
                        const filename = att.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
                        const tmpHostPath = path.join(os.tmpdir(), `direct_att_${crypto.randomBytes(8).toString('hex')}_${filename}`);
                        fs.writeFileSync(tmpHostPath, buffer);
                        containerManager.copyToContainer(containerKey, tmpHostPath, `/workspace/${filename}`);
                        fs.unlinkSync(tmpHostPath);

                        // Also upload to RustFS for persistent access
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
                            text: `[Uploaded document: ${filename}] This file has been placed in your secure terminal workspace at /workspace/${filename}. Use terminal tools (like convert_document_to_text, run_command, python_exec) to analyze it.`
                        });
                        persistedAttachments.push({ name: att.name, type: att.type, url: fileProxyUrl });
                    } catch (e) {
                        contentParts.push({
                            type: 'text',
                            text: `[File: ${att.name}, failed to upload to workspace: ${e.message}]`
                        });
                    }
                }
            }
            messages.push({ role: 'user', content: contentParts });
        } else {
            messages.push({ role: 'user', content: message });
        }

        // Add terminal tools when document attachments are present OR when integrations
        // that handle attachments (Gmail, etc.) are loaded — so the AI can use
        // convert_document_to_text and other terminal tools on Gmail attachments.
        const hasIntegrationWithAttachments = directChatTools.some(t =>
            t.function?.name?.startsWith('gmail_') || t.function?.name?.startsWith('drive_')
        );
        if (hasDocumentAttachment || hasIntegrationWithAttachments) {
            const { TERMINAL_TOOLS } = require('../../terminal/tools');
            for (const tTool of TERMINAL_TOOLS) {
                if (!directChatTools.find(t => t.function.name === tTool.function.name)) {
                    directChatTools.push(tTool);
                }
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
                } else {
                    // Guard service error (not a violation) — fail-open, log and continue
                    console.warn(`[DirectChat] Guard service error (fail-open): ${guardError.message}`);
                }
            }
        }

        // Inject moderation violation context into system prompt so AI can explain
        if (moderationViolation) {
            messages[0].content += `\n\n[IMPORTANT: The user's message was flagged by our content safety policy. You must briefly explain that their message could not be processed because it was flagged by our content policy, and politely ask them to rephrase. Keep your response short (1-2 sentences). Do not reveal the specific violation category. Do not process or answer the original request.]`;
        }

        // ─── PII Detection (independent of content moderation) ──────
        // Runs whenever piiDetectionEnabled is true, regardless of moderation settings.
        // Action 'block' — throw and reject message.
        // Action 'tokenize' — replace PII spans with tokens, pass clean text to AI,
        //                     restore tokens in the AI response before showing the user.
        let piiTokenMap = null;  // non-null only in tokenize mode when PII found
        try {
            const { validateInputForPii } = require('../../core/azurePiiDetection');
            const piiResult = await validateInputForPii(messages.slice(-3), false);

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
            const compactionResult = await compactMessages(messages, {
                existingSummary: conversationSummary,
                summaryModelId: 'tier:fast',
            });
            messages = compactionResult.messages;
            if (compactionResult.newSummary) {
                conversationSummary = compactionResult.newSummary;
            }
        } catch (err) {
            console.warn('[DirectChat] Compaction failed, using full history:', err.message);
        }

        // ─── Tool calling loop via unified adapter.chat() ──────────
        const tierSettings = tiers[resolvedTier] || {};
        const isThinkingModel = modelId.includes('magistral');
        const defaultMaxTokens = isThinkingModel ? 40960 : 8192;
        const chatOptions = {
            maxTokens: tierSettings.maxTokens || defaultMaxTokens,
            temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : 0.7,
            reasoningEffort: tierSettings.reasoningEffort || undefined,
            reasoningSummary: tierSettings.reasoningSummary || false,
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
        const collectedSheetsResults = [];
        const collectedSheetsDrafts = [];
        const collectedSheetsReports = [];
        const collectedEmailDrafts = [];
        const collectedCalendarDrafts = [];
        const collectedMapEmbeds = [];

        // Strip internal metadata (_mcp etc.) before sending tools to LLM — providers may reject unknown fields
        directChatTools = directChatTools.map(t => {
            const { _mcp, _n8n, ...clean } = t;
            return clean;
        });

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

                        const tierToolParams = await configStore.getConfig('direct_chat_tier_tool_params') || {};
                        const tierOverrides = tierToolParams[resolvedTier]?.[toolName] || null;

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
                                        send('tool_end', { name: toolName, result: '[Web search blocked — query violates content policy]' });
                                        return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Web search blocked — query violates content policy. Please rephrase.' }) };
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

                        // Emit email_draft SSE event for user approval (with dedup)
                        if (toolResult?._action === 'email_draft') {
                            const draftKey = JSON.stringify({ to: toolResult.draft?.to, subject: toolResult.draft?.subject, body: toolResult.draft?.body });
                            const alreadySent = collectedEmailDrafts.some(d => JSON.stringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey);
                            if (!alreadySent) {
                                send('email_draft', toolResult.draft);
                                collectedEmailDrafts.push(toolResult.draft);
                            }
                        }
                        // Emit calendar_draft SSE event for user approval (with dedup)
                        if (toolResult?._action === 'calendar_draft') {
                            const draftKey = JSON.stringify({ summary: toolResult.draft?.summary, start: toolResult.draft?.start, end: toolResult.draft?.end });
                            const alreadySent = collectedCalendarDrafts.some(d => JSON.stringify({ summary: d.summary, start: d.start, end: d.end }) === draftKey);
                            if (!alreadySent) {
                                send('calendar_draft', toolResult.draft);
                                collectedCalendarDrafts.push(toolResult.draft);
                            }
                        }
                        // Emit linkedin_draft SSE event for user approval
                        if (toolResult?._action === 'linkedin_draft') {
                            send('linkedin_draft', toolResult.draft);
                        }
                        // Emit whatsapp_draft SSE event for user approval
                        if (toolResult?._action === 'whatsapp_draft') {
                            send('whatsapp_draft', toolResult.draft);
                        }
                        // Emit contacts_draft SSE event for user approval
                        if (toolResult?._action === 'contacts_draft') {
                            send('contacts_draft', toolResult.draft);
                        }
                        // Emit keep_draft SSE event for user approval
                        if (toolResult?._action === 'keep_draft') {
                            send('keep_draft', toolResult.draft);
                        }
                        // Emit sheets_result SSE event for visual card (read operations)
                        if (toolResult?._action === 'sheets_result') {
                            send('sheets_result', toolResult._sheetsData);
                            collectedSheetsResults.push(toolResult._sheetsData);
                        }
                        // Emit sheets_draft SSE event for user approval (write operations)
                        if (toolResult?._action === 'sheets_draft') {
                            send('sheets_draft', toolResult._sheetsDraft);
                            collectedSheetsDrafts.push({ ...toolResult._sheetsDraft, status: 'pending' });
                        }
                        // Emit sheets_report SSE event for report/dashboard view
                        if (toolResult?._action === 'sheets_report') {
                            send('sheets_report', toolResult._sheetsReport);
                            collectedSheetsReports.push(toolResult._sheetsReport);
                        }
                        // Emit workspace_update SSE event
                        if (toolResult?._action === 'workspace_update') {
                            send('workspace_update', { content: toolResult.content });
                        }
                        // Emit kb_sources SSE event
                        if (toolResult?._action === 'kb_sources' && toolResult._sources?.length > 0) {
                            send('kb_sources', { sources: toolResult._sources });
                        }
                        // Track audio URLs for persistence
                        if (toolResult?.audioUrl) {
                            generatedAudio.push({ url: toolResult.audioUrl, source: toolName });
                        }

                        return {
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult)
                        };
                    });

                    const toolResults = await Promise.all(toolPromises);
                    messages.push(...toolResults);
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

                const tierToolParams = await configStore.getConfig('direct_chat_tier_tool_params') || {};
                const tierOverrides = tierToolParams[resolvedTier]?.[toolName] || null;

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
                                send('tool_end', { name: toolName, result: '[Web search blocked — query violates content policy]' });
                                return { role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ error: 'Web search blocked — query violates content policy. Please rephrase.' }) };
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

                // Emit email_draft SSE event for user approval (with dedup)
                if (toolResult?._action === 'email_draft') {
                    const draftKey = JSON.stringify({ to: toolResult.draft?.to, subject: toolResult.draft?.subject, body: toolResult.draft?.body });
                    const alreadySent = collectedEmailDrafts.some(d => JSON.stringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey);
                    if (!alreadySent) {
                        send('email_draft', toolResult.draft);
                        collectedEmailDrafts.push(toolResult.draft);
                    }
                }
                // Emit calendar_draft SSE event for user approval (with dedup)
                if (toolResult?._action === 'calendar_draft') {
                    const draftKey = JSON.stringify({ summary: toolResult.draft?.summary, start: toolResult.draft?.start, end: toolResult.draft?.end });
                    const alreadySent = collectedCalendarDrafts.some(d => JSON.stringify({ summary: d.summary, start: d.start, end: d.end }) === draftKey);
                    if (!alreadySent) {
                        send('calendar_draft', toolResult.draft);
                        collectedCalendarDrafts.push(toolResult.draft);
                    }
                }
                // Emit linkedin_draft SSE event for user approval
                if (toolResult?._action === 'linkedin_draft') {
                    send('linkedin_draft', toolResult.draft);
                }
                // Emit whatsapp_draft SSE event for user approval
                if (toolResult?._action === 'whatsapp_draft') {
                    send('whatsapp_draft', toolResult.draft);
                }
                // Emit contacts_draft SSE event for user approval
                if (toolResult?._action === 'contacts_draft') {
                    send('contacts_draft', toolResult.draft);
                }
                // Emit keep_draft SSE event for user approval
                if (toolResult?._action === 'keep_draft') {
                    send('keep_draft', toolResult.draft);
                }
                // Emit sheets_result SSE event for visual card (read operations)
                if (toolResult?._action === 'sheets_result') {
                    send('sheets_result', toolResult._sheetsData);
                    collectedSheetsResults.push(toolResult._sheetsData);
                }
                // Emit sheets_draft SSE event for user approval (write operations)
                if (toolResult?._action === 'sheets_draft') {
                    send('sheets_draft', toolResult._sheetsDraft);
                    collectedSheetsDrafts.push({ ...toolResult._sheetsDraft, status: 'pending' });
                }
                // Emit sheets_report SSE event for report/dashboard view
                if (toolResult?._action === 'sheets_report') {
                    send('sheets_report', toolResult._sheetsReport);
                    collectedSheetsReports.push(toolResult._sheetsReport);
                }
                // Emit workspace_update SSE event
                if (toolResult?._action === 'workspace_update') {
                    send('workspace_update', { content: toolResult.content });
                }
                // Emit kb_sources SSE event
                if (toolResult?._action === 'kb_sources' && toolResult._sources?.length > 0) {
                    send('kb_sources', { sources: toolResult._sources });
                }
                // Track audio URLs for persistence
                if (toolResult?.audioUrl) {
                    generatedAudio.push({ url: toolResult.audioUrl, source: toolName });
                }

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
                // Ensure toolResult is an object before stringifying (avoid double-encoding strings)
                let resultObj = toolResult;
                if (typeof toolResult === 'string') {
                    try { resultObj = JSON.parse(toolResult); } catch (e) { resultObj = { result: toolResult }; }
                }
                return {
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(resultObj)
                };
            });

            const toolResults = await Promise.all(toolPromises);
            messages.push(...toolResults);

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
            const savedMessages = conv.messages || [];
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
            if (collectedSheetsResults.length > 0) assistantSave.sheetsResults = collectedSheetsResults;
            if (collectedSheetsDrafts.length > 0) assistantSave.sheetsDrafts = collectedSheetsDrafts;
            if (collectedSheetsReports.length > 0) assistantSave.sheetsReports = collectedSheetsReports;
            if (collectedEmailDrafts.length > 0) assistantSave.emailDrafts = collectedEmailDrafts;
            if (collectedCalendarDrafts.length > 0) assistantSave.calendarDrafts = collectedCalendarDrafts;
            if (collectedMapEmbeds.length > 0) assistantSave.mapEmbeds = collectedMapEmbeds;
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
                    extractMemories(userId, message, fullContent, null, extractMemoriesEnabled ? projectId : null).catch(e =>
                        console.warn('[DirectChat] Memory extraction error:', e.message)
                    );
                } catch (e) { /* ignore */ }
            }

            // Generate title for new conversations (skip if moderation violation — don't send unsafe content to title LLM)
            console.log(`[DirectChat] Title check: savedMessages=${savedMessages.length}, moderationViolation=${!!moderationViolation}`);
            if (savedMessages.length <= 2 && !moderationViolation) {
                try {
                    const llmClient = require('../../core/llmClient');
                    const titleAgent = await agentStore.getTitleGeneratorAgent();
                    let titleModel = titleAgent?.model || modelId;
                    // Resolve tier: prefix (e.g. 'tier:fast' → actual model ID)
                    if (titleModel.startsWith('tier:')) {
                        const tierName = titleModel.substring(5);
                        let titleTiers = await configStore.getConfig('chat_model_tiers') || {};
                        // EU mode override for title generation
                        if (userOrgForTiers) {
                            const titleShield = await configStore.getConfig(`org_privacy_shield_${userOrgForTiers}`);
                            if (titleShield?.enabled && titleShield?.euModeEnabled) {
                                const euTitleTiers = await configStore.getConfig('chat_model_tiers_eu') || {};
                                const mergedTitleTiers = { ...titleTiers };
                                for (const [tn, euT] of Object.entries(euTitleTiers)) {
                                    if (euT?.modelId) mergedTitleTiers[tn] = { ...mergedTitleTiers[tn], ...euT };
                                }
                                titleTiers = mergedTitleTiers;
                            }
                        }
                        titleModel = titleTiers[tierName]?.modelId || modelId;
                    } else {
                        // Non-tier model — resolve display names and validate
                        const { resolveModelId } = require('../../core/aiAgent');
                        titleModel = resolveModelId(titleModel) || titleModel;
                        // If it still looks like a display label (has uppercase), use the chat model instead
                        if (!/^[a-z0-9._\/-]+$/.test(titleModel)) {
                            titleModel = modelId;
                        }
                    }
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
                memoryExtractor.extractFromConversation(userId, null, messages, convId)
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
        res.json({ content: conv.workspace_content || '' });
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
        const { content } = req.body;
        await agentStore.updateDirectConversationWorkspace(req.params.id, content || '');
        res.json({ success: true });
    } catch (e) {
        console.error('Failed to update direct conversation workspace:', e);
        res.status(500).json({ error: 'Failed to update workspace' });
    }
});

module.exports = router;
