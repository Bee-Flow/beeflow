/**
 * Streaming agent chat — SSE-based tool-calling loop with real-time events
 * This is the primary chat function used by the frontend
 */
const { getAIConfig, getProviderForModel, resolveModelId } = require('../aiAgent');
const { getAdapter } = require('../providers');
const componentManager = require('../componentManager');
const executionEngine = require('../executionEngine');
const agentStore = require('../../stores/agentStore');
const { sanitizeToolResult } = require('../../utils/sanitize');
const fs = require('fs');
const path = require('path');
// Legacy swarm modules removed — isSwarm is always false
const usageStore = require('../../stores/usageStore');
const integrationActivityStore = require('../../stores/integrationActivityStore');
const { resolveIntegration } = require('../integrationToolMap');

const { classifyPromptComplexity } = require('../promptClassifier');
const configStore = require('../../stores/configStore');
const { mistralOCR } = require('../ocr');
const { sanitizeMessages } = require('../../utils/messageUtils');
const { componentToTool, executeComponentTool, executeSystemTool, SYSTEM_TOOLS } = require('../toolExecution');
const { resolveAgentModel } = require('./modelResolver');
const { getAgentTools } = require('./agentTools');
const { executeWorkerTool } = require('./workerExecution');
const { enrichMessagesWithFormData } = require('./chatWithAgent');
const { checkRegexPatterns } = require('../guardrails');
const { validateInput } = require('../moderation');
const { resolveOrgShield, mergeWithOrgShield } = require('../orgShield');
const { processSystemPrompt } = require('../promptUtils');
const { buildSystemPrompt } = require('./contextBuilder');
const { performKnowledgeSearch } = require('./knowledgeSearch');
const { runInputGuardrails } = require('./guardrailsRunner');
const guardrailEventStore = require('../../stores/guardrailEventStore');
const { processAttachments } = require('./attachmentProcessor');

// ============ RETRY & ERROR HELPERS ============

/**
 * Classify an error as transient (retryable) or permanent.
 * Returns an object with { retryable, errorType, userMessage }.
 */
function classifyStreamError(error) {
    const msg = error.message || '';
    const isNetworkError = error instanceof TypeError && /network|fetch|ECONNRESET|ETIMEDOUT/i.test(msg);
    const isTimeout = msg.includes('timed out') || msg.includes('AbortError') || error.name === 'TimeoutError';
    const statusMatch = msg.match(/API error (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : null;
    // Claude SDK exposes .status directly on the error object
    const httpStatus = status || error.status || null;
    // Detect Claude-specific overloaded_error from the error body or status
    const isOverloaded = /overloaded/i.test(msg) || error.error?.type === 'overloaded_error' || httpStatus === 529;

    // Transient errors — worth retrying
    if (isNetworkError) return { retryable: true, errorType: 'network', userMessage: 'Network error — please try again' };
    if (isTimeout) return { retryable: true, errorType: 'timeout', userMessage: 'Request timed out — please try again' };
    if (isOverloaded) return { retryable: true, errorType: 'overloaded', userMessage: 'The AI service is temporarily overloaded — retrying automatically' };
    if (httpStatus === 429) return { retryable: true, errorType: 'rate_limit', userMessage: 'The AI service is temporarily busy — please try again in a moment' };
    if (httpStatus && httpStatus >= 500) return { retryable: true, errorType: 'server', userMessage: 'The AI service encountered a temporary error — please try again' };

    // Permanent errors — do not retry
    if (httpStatus === 413) return { retryable: false, errorType: 'payload_too_large', userMessage: 'Message too large — try sending fewer or smaller images' };
    if (httpStatus === 400) return { retryable: false, errorType: 'bad_request', userMessage: msg };
    if (httpStatus === 401 || httpStatus === 403) return { retryable: false, errorType: 'auth', userMessage: 'Authentication error with AI service' };

    // Context overflow patterns (various providers)
    if (/context.*(length|window|overflow|limit|exceeded)/i.test(msg) || /max.*token/i.test(msg)) {
        return { retryable: false, errorType: 'context_overflow', userMessage: 'Message too large for the AI model — try a shorter conversation or fewer images' };
    }

    // Unknown — don't retry
    return { retryable: false, errorType: 'unknown', userMessage: msg || 'An unexpected error occurred' };
}

/**
 * Retry an async operation with exponential backoff.
 * Only retries on transient errors as classified by classifyStreamError.
 * @param {Function} fn - Async function to execute
 * @param {number} maxRetries - Maximum retry attempts (default 2)
 * @returns {Promise} Result of fn()
 */
async function retryStreamCall(fn, maxRetries = 3) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const classified = classifyStreamError(error);
            if (!classified.retryable || attempt >= maxRetries) {
                // Attach classification to the error for downstream handling
                error._classified = classified;
                throw error;
            }
            const baseDelay = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
            const jitter = Math.random() * baseDelay * 0.5; // 0-50% jitter
            const delayMs = Math.min(Math.round(baseDelay + jitter), 10000); // cap at 10s
            console.log(`[AgentRuntime] Retry attempt ${attempt + 1}/${maxRetries} after ${classified.errorType} error (waiting ${delayMs}ms): ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    throw lastError;
}

async function chatWithAgentStream(agentId, userId, userMessage, userAuth = {}, onEvent, historyOverride = null, messageMetadata = {}) {
    const swarm = null; // Swarm agents removed
    let agent = await agentStore.getAgent(agentId);
    let isSwarm = false;
    let brain = null;

    if (!agent) {
        throw new Error('Agent not found');
    }

    // Swarm execution history collector
    const swarmLogs = [];
    const swarmBrain = [];
    const SWARM_EVENT_TYPES = new Set(['phase', 'worker_start', 'worker_tool', 'worker_complete', 'worker_error', 'brain_update']);

    // Worker call counter for unique IDs (e.g. "Web Searcher #1", "Web Searcher #2")
    const workerCallCounts = {};

    // Wrap onEvent to intercept swarm events for persistence
    const originalOnEvent = onEvent;
    if (isSwarm) {
        onEvent = (type, data) => {
            // Enrich worker events with call number
            if (type === 'worker_start' || type === 'worker_complete' || type === 'worker_error' || type === 'brain_update') {
                const workerName = data.worker || 'unknown';
                if (type === 'worker_start') {
                    workerCallCounts[workerName] = (workerCallCounts[workerName] || 0) + 1;
                }
                data.workerId = `${workerName.toLowerCase().replace(/\s+/g, '_')}_${workerCallCounts[workerName] || 1}`;
                data.callNumber = workerCallCounts[workerName] || 1;
            }

            // Collect swarm events for persistence
            if (SWARM_EVENT_TYPES.has(type)) {
                const entry = { type, ...data, timestamp: new Date().toISOString() };
                if (type === 'brain_update') {
                    swarmBrain.push(entry);
                } else {
                    swarmLogs.push(entry);
                }
            }
            // Always forward to the original handler for SSE streaming
            originalOnEvent(type, data);
        };
    }

    // Get global config for guardrails and defaults
    const globalConfig = await getAIConfig();

    // Get the model to use - supports tier-based selection (tier:auto, tier:fast, etc.)
    const modelToUse = await resolveAgentModel(agent.model, userMessage, { ...globalConfig, organizationId: agent.organization_id, userOrgId: messageMetadata?.userOrgId });

    // Get the correct provider config for this model
    const config = await getProviderForModel(modelToUse);
    console.log(`[AgentRuntime] Streaming with model: ${modelToUse} from provider: ${config.providerName || 'default'}`);

    // For swarms, tools are loaded per-phase; for normal agents, load all tools
    let tools = isSwarm
        ? swarmOrchestrator.getSwarmToolsForPhase(swarm, 0)
        : await getAgentTools(agentId);

    // ── Inject integration tools (Gmail, Calendar, etc.) ──────
    // These require OAuth tokens from the user session
    let n8nOrgId = null;
    try {
        const { getIntegrationTools, buildToolHint } = require('../integrationTools');
        const session = userAuth?.session;
        const integrationResult = await getIntegrationTools({
            userId,
            session,
            isAdmin: session?.user?.isAdmin || false,
            agentConfig: agent.config,
        });
        if (integrationResult.tools.length > 0) {
            // Deduplicate — don't add integration tools that overlap with component tools
            for (const intTool of integrationResult.tools) {
                if (!tools.find(t => t.function?.name === intTool.function?.name)) {
                    tools.push(intTool);
                }
            }
            console.log(`[AgentRuntime] Injected ${integrationResult.tools.length} integration tools for agent ${agentId}`);
        }
        n8nOrgId = integrationResult.n8nOrgId;
    } catch (intErr) {
        console.warn('[AgentRuntime] Integration tools injection failed:', intErr.message);
    }

    // ── Built-in: set_reminder tool (always available) ────────────
    if (!tools.find(t => t.function?.name === 'set_reminder')) {
        tools.push({
            type: 'function',
            function: {
                name: 'set_reminder',
                description: 'Set a reminder for the user. Use when the user asks to be reminded about something at a specific time. IMPORTANT: Use the timezone from the "Now:" line in the system prompt — do NOT use UTC/Z unless the user is in UTC.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Short title for the reminder' },
                        message: { type: 'string', description: 'Optional detailed message' },
                        remind_at: { type: 'string', description: 'ISO 8601 datetime for when to remind. MUST include the user\'s timezone offset from the system prompt (e.g. "2026-03-09T15:00:00+01:00" for CET). Do NOT use "Z" unless the user is in UTC.' },
                        repeat_interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'Optional repeat interval' },
                    },
                    required: ['title', 'remind_at'],
                },
            },
        });
    }

    // ── Built-in: set_ai_task tool (always available) ────────────
    if (!tools.find(t => t.function?.name === 'set_ai_task')) {
        tools.push({
            type: 'function',
            function: {
                name: 'set_ai_task',
                description: 'Create a scheduled AI task that runs automatically at specified times. Use this when the user wants recurring AI-generated content like news summaries, reports, digests, or any automated information gathering. The task runs in the background using web search and delivers results as notifications. IMPORTANT: Write a detailed, specific prompt for the AI to execute. Use the timezone from the "Now:" line.',
                parameters: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Short descriptive title (e.g., "Weekly AI News Digest")' },
                        prompt: { type: 'string', description: 'Detailed instruction for the AI to execute each time. Be specific about what to search, summarize, or analyze.' },
                        repeat_interval: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'How often to run the task' },
                        first_run_at: { type: 'string', description: 'ISO 8601 datetime for the first execution. MUST include timezone offset from system prompt.' },
                        model_tier: { type: 'string', enum: ['fast', 'smart', 'thinking'], description: 'AI model quality tier. Default: fast.' },
                    },
                    required: ['title', 'prompt', 'repeat_interval', 'first_run_at'],
                },
            },
        });
    }

    // Load tool configs with fixed params
    const toolConfigs = await agentStore.getAgentToolsWithParams(agentId);
    const toolParamsMap = {};
    for (const tc of toolConfigs) {
        const toolName = tc.componentId.replace(/-/g, '_');
        toolParamsMap[toolName] = tc.params;
    }
    console.log('[AgentRuntime] Tool params map:', JSON.stringify(toolParamsMap, null, 2));

    // Get or create conversation - use specific conversationId if provided
    // For ephemeral chats (embed), skip database persistence entirely
    const isEphemeral = messageMetadata.ephemeral === true;
    let conversation;
    if (isEphemeral) {
        // Use a dummy in-memory conversation — no database writes
        conversation = { id: `ephemeral-${Date.now()}`, agent_id: agentId, user_id: userId, messages: [] };
    } else if (messageMetadata.conversationId) {
        // Use the specific conversation
        conversation = await agentStore.getConversationById(messageMetadata.conversationId, userAuth.encryptionKey);
        if (!conversation) {
            // If conversation doesn't exist, create a new one
            conversation = await agentStore.getOrCreateConversation(agentId, userId, userAuth.encryptionKey);
        }
    } else {
        // No conversationId provided - create a new conversation
        conversation = await agentStore.createNewConversation(agentId, userId);
    }

    // Assign new conversation to project if projectId provided
    let extractMemoriesEnabled = false;
    let validProjectId = null;
    if (messageMetadata.projectId) {
        try {
            const projectStore = require('../../stores/projectStore');
            const project = await projectStore.getProject(messageMetadata.projectId);
            if (project) {
                // Validate user has access to this project
                const hasAccess = await projectStore.userHasAccess(userId, messageMetadata.projectId);
                if (hasAccess) {
                    validProjectId = messageMetadata.projectId;
                    extractMemoriesEnabled = project.extractMemories === true;
                } else {
                    console.warn(`[AgentRuntime] User ${userId} has no access to project ${messageMetadata.projectId}, skipping project context`);
                }
            }
        } catch (e) {
            console.warn('[AgentRuntime] Failed to fetch project:', e.message);
        }
    }

    if (conversation && messageMetadata.projectId && !messageMetadata.conversationId && !isEphemeral) {
        try {
            const projectStore = require('../../stores/projectStore');
            await projectStore.assignConversation(conversation.id, messageMetadata.projectId, 'agent_conversations');
        } catch (e) {
            console.warn('[AgentRuntime] Failed to assign conversation to project:', e.message);
        }
    }

    // Use historyOverride if provided (for thread context isolation), otherwise use conversation
    let messages;
    if (historyOverride && Array.isArray(historyOverride)) {
        // Use the overridden history (thread context)
        messages = [...historyOverride];
    } else {
        messages = [...conversation.messages];

        // Build persisted attachments (strip base64, upload to RustFS for persistent URLs)
        const persistedAttachments = [];
        if (messageMetadata?.attachments && messageMetadata.attachments.length > 0) {
            const storageStore = require('../../stores/storageStore');
            const crypto = require('crypto');
            for (const att of messageMetadata.attachments) {
                if (att.type && att.type.startsWith('image/') && att.content) {
                    // Upload image to RustFS for persistence
                    let imageProxyUrl = null;
                    let storageKey = null;
                    try {
                        if (storageStore.isAvailable()) {
                            const base64Data = att.content.split(',')[1] || att.content;
                            const ext = att.type.includes('jpeg') || att.type.includes('jpg') ? 'jpg' : 'png';
                            const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
                            const key = storageStore.buildKey(userId, 'uploads', filename);
                            await storageStore.uploadFile(key, Buffer.from(base64Data, 'base64'), att.type);
                            imageProxyUrl = storageStore.buildProxyUrl(key);
                            storageKey = key;
                            console.log(`[AgentRuntime] Uploaded attachment image to RustFS: ${key}`);
                        }
                    } catch (e) {
                        console.warn(`[AgentRuntime] Failed to upload attachment image to RustFS: ${e.message}`);
                    }
                    persistedAttachments.push({ name: att.name, type: att.type, storageKey, url: imageProxyUrl });
                } else if (att.type && att.type.includes('pdf')) {
                    // PDF — persist metadata without base64 content
                    let pdfProxyUrl = null;
                    try {
                        if (storageStore.isAvailable()) {
                            const base64Data = att.content.split(',')[1] || att.content;
                            const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${(att.name || 'document').replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                            const key = storageStore.buildKey(userId, 'uploads', filename);
                            await storageStore.uploadFile(key, Buffer.from(base64Data, 'base64'), att.type);
                            pdfProxyUrl = storageStore.buildProxyUrl(key);
                            console.log(`[AgentRuntime] Uploaded attachment PDF to RustFS: ${key}`);
                        }
                    } catch (e) {
                        console.warn(`[AgentRuntime] Failed to upload attachment PDF to RustFS: ${e.message}`);
                    }
                    persistedAttachments.push({ name: att.name, type: att.type, url: pdfProxyUrl });
                } else if (att.name) {
                    // Other file types — persist metadata only
                    let fileProxyUrl = null;
                    try {
                        if (att.content && storageStore.isAvailable()) {
                            const base64Data = att.content.split(',')[1] || att.content;
                            const filename = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${(att.name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
                            const key = storageStore.buildKey(userId, 'uploads', filename);
                            await storageStore.uploadFile(key, Buffer.from(base64Data, 'base64'), att.type || 'application/octet-stream');
                            fileProxyUrl = storageStore.buildProxyUrl(key);
                            console.log(`[AgentRuntime] Uploaded attachment file to RustFS: ${key}`);
                        }
                    } catch (e) {
                        console.warn(`[AgentRuntime] Failed to upload attachment file to RustFS: ${e.message}`);
                    }
                    persistedAttachments.push({ name: att.name, type: att.type, url: fileProxyUrl });
                }
            }
        }

        // Include id and parentId for persistence
        const userMsg = {
            id: messageMetadata.messageId,
            role: 'user',
            content: userMessage,
            parentId: messageMetadata.parentId || null
        };
        if (persistedAttachments.length > 0) userMsg.attachments = persistedAttachments;
        messages.push(userMsg);
    }

    // ============ REFRESH IMAGE URLS IN HISTORY ============
    // Images from previous turns need special handling:
    //  - base64 data URIs are stripped (500KB+ each — causes context overflow)
    //  - temp HTTPS URLs (from RustFS) are regenerated with fresh expiry so the AI
    //    can still see images from earlier turns when user asks follow-up questions
    for (let i = 0; i < messages.length - 1; i++) {
        const msg = messages[i];
        if (Array.isArray(msg.content)) {
            const hasImages = msg.content.some(p => p.type === 'image_url');
            if (hasImages) {
                messages[i] = {
                    ...msg,
                    content: msg.content.map(part => {
                        if (part.type !== 'image_url') return part;
                        const url = part.image_url?.url || '';

                        // Strip base64 — too large for context window
                        if (url.startsWith('data:')) {
                            return { type: 'text', text: '[Previously attached image]' };
                        }

                        // Regenerate fresh temp URL for RustFS images
                        if (url.includes('/api/storage/tmp/')) {
                            try {
                                const parsedUrl = new URL(url);
                                const key = parsedUrl.searchParams.get('key');
                                if (key) {
                                    const { generateTempDownloadUrl } = require('../../routes/storageProxy');
                                    const freshUrl = generateTempDownloadUrl(key, 900);
                                    console.log(`[AgentRuntime] Refreshed temp URL for historical image (key: ${key.substring(0, 40)}...)`);
                                    return {
                                        type: 'image_url',
                                        image_url: { url: freshUrl, detail: 'auto' }
                                    };
                                }
                            } catch (e) {
                                console.warn(`[AgentRuntime] Failed to refresh image URL: ${e.message}`);
                            }
                            // Fallback if URL parsing fails
                            return { type: 'text', text: '[Previously attached image]' };
                        }

                        // Unknown URL format — keep as-is (could be external URL)
                        return part;
                    })
                };
            }
        }
    }

    // ============ MEMORY INTEGRATION ============
    // Skip memory for embed-enabled agents — private user memories must not leak into public embed chats
    let memoryContext = '';
    if (agent.embed_enabled) {
        console.log(`[AgentRuntime] Skipping memory for embed-enabled agent ${agentId}`);
    } else {
        try {
            const memoryStore = require('../../stores/memoryStore');
            console.log(`[AgentRuntime] Memory lookup - userId: ${userId}, agentId: ${agentId}`);
            // Limit to ~300 tokens (approx 1200 chars) to prevent context pollution
            // Always pass projectId for retrieval (project memories should be available regardless of extractMemories flag)
            const relevantMemories = await memoryStore.findRelevantMemories(userId, agentId, userMessage, 300, validProjectId || null);
            if (relevantMemories.length > 0) {
                memoryContext = memoryStore.formatMemoriesForPrompt(relevantMemories);
                console.log(`[AgentRuntime] Injected ${relevantMemories.length} memories into prompt`);
                console.log(`[AgentRuntime] Memory context:\n${memoryContext}`);
            } else {
                console.log('[AgentRuntime] No memories found for this user/agent');
            }
        } catch (memErr) {
            console.error('[AgentRuntime] Memory retrieval failed:', memErr.message);
        }
    }

    const isStrictKnowledge = agent.config?.strictKnowledge === true;
    let systemPrompt = await buildSystemPrompt({ agent, tools, userId, messageMetadata, memoryContext, isStrictKnowledge });

    // ============ GUARDRAILS (before KB search — block early) ============
    const guardrailsResult = await runInputGuardrails({ agent, messages, userMessage, globalConfig, onEvent, userId, conversationId: conversation?.id, source: isSwarm ? 'swarm_orchestrator' : 'agent_stream', model: modelToUse });
    let moderationViolation = guardrailsResult.moderationViolation;
    let guardrailViolation = guardrailsResult.guardrailViolation;
    let processedUserMessage = guardrailsResult.processedUserMessage;
    const regexConfig = guardrailsResult.regexConfig;
    const webSearchGuardEnabled = guardrailsResult.webSearchGuardEnabled;
    const disableSearchOnUpload = guardrailsResult.disableSearchOnUpload;
    const webSearchGuardPiiCategories = guardrailsResult.webSearchGuardPiiCategories;
    const orgShieldCategories = guardrailsResult.orgShieldCategories;

    // Filter out web search if org policy disables it on file uploads
    // Check both current attachments AND conversation history for past uploads
    if (disableSearchOnUpload) {
        const hasCurrentAttachments = messageMetadata?.attachments && messageMetadata.attachments.length > 0;
        const hasHistoryAttachments = conversation?.messages?.some(m => m.attachments && m.attachments.length > 0);
        if (hasCurrentAttachments || hasHistoryAttachments) {
            tools = tools.filter(t => t.function?.name !== 'agent_search');
            console.log(`[AgentRuntime] Web search disabled — ${hasCurrentAttachments ? 'current files attached' : 'files in conversation history'} (org policy)`);
        }
    }

    // If redaction occurred, update the user message in the messages array
    if (processedUserMessage !== userMessage) {
        const lastMsgIndex = messages.length - 1;
        if (messages[lastMsgIndex]?.role === 'user') {
            messages[lastMsgIndex].content = processedUserMessage;
        }
    }

    // ============ VECTOR KNOWLEDGE BASE ============
    // Only search KB if guardrails did NOT fire — prevents leaking sensitive KB content
    if (!moderationViolation && !guardrailViolation) {
        try {
            const kbExtension = await performKnowledgeSearch({ agent, userId, userMessage, isStrictKnowledge, onEvent });
            if (kbExtension) {
                systemPrompt += kbExtension;
            }
        } catch (kErr) {
            console.error('[AgentRuntime] Knowledge retrieval failed:', kErr.message);
        }
    }

    // ============ WORKSPACE INTEGRATION ============
    // Workspace streaming/parsing is handled in the stream loop below;
    // no system prompt injection needed.

    // ── Hard block: skip AI entirely when guardrails/moderation fired ──
    // The AI must never see the user message or KB context when a violation is detected.
    const hasViolation = moderationViolation || guardrailViolation;
    if (hasViolation) {
        const violationType = moderationViolation || guardrailViolation;

        // Send structured event so frontend can compose the translated message
        onEvent('guardrail_blocked', { violation: violationType });

        // English fallback for DB persistence (not shown to user — frontend overrides with t())
        const persistedResponse = `Your message was flagged as **"${violationType}"**.\n\nThis message was blocked by our security policy and cannot be processed. Would you like to rephrase your question?`;

        // Persist the conversation with the English fallback response
        const assistantMsg = {
            role: 'assistant',
            content: persistedResponse,
            parentId: messageMetadata.parentId || null
        };
        messages.push(assistantMsg);
        if (!isEphemeral) {
            await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);
        }

        // Server-side persistence: redact/remove the violating user message
        if (!isEphemeral) {
            setImmediate(async () => {
                try {
                    const conv = await agentStore.getConversationById(conversation.id, userAuth.encryptionKey);
                    if (conv && conv.messages) {
                        let lastUserIdx = -1;
                        for (let i = conv.messages.length - 1; i >= 0; i--) {
                            if (conv.messages[i].role === 'user') { lastUserIdx = i; break; }
                        }
                        if (lastUserIdx >= 0) {
                            const redactedContent = guardrailViolation
                                ? '[Message removed - policy violation]'
                                : (processedUserMessage !== userMessage ? processedUserMessage : '[Message removed - policy violation]');
                            const updatedMessages = conv.messages.map((m, idx) =>
                                idx === lastUserIdx ? { ...m, content: redactedContent, isRedacted: true } : m
                            );
                            await agentStore.updateConversation(conversation.id, updatedMessages, userAuth.encryptionKey, userAuth.userId);
                            console.log(`[AgentRuntime] Guardrail: server-side redaction completed for conversation ${conversation.id}`);
                        }
                    }
                } catch (err) {
                    console.error('[AgentRuntime] Guardrail: server-side redaction failed:', err.message);
                }
            });
        }

        console.log(`[AgentRuntime] Guardrail hard-block — skipped AI entirely (violation: ${violationType})`);
        return {
            message: persistedResponse,
            toolCalls: [],
            conversationLength: messages.length,
            conversationId: conversation.id,
            guardrailViolation: violationType,
            model: modelToUse
        };
    }

    // Phase-driven execution state for swarms
    // Filter out disabled phases before execution
    if (isSwarm && swarm.phases) {
        swarm.phases = swarm.phases.filter(p => p.enabled !== false);
    }
    let currentPhaseIndex = 0;
    const phaseResults = [];
    const totalPhases = isSwarm ? (swarm.phases?.length || 1) : 1;
    const calledWorkersInPhase = new Set(); // Track called workers for runOnce enforcement

    let iterations = 0;
    const maxIterations = isSwarm ? (totalPhases * 8) : 10;
    let toolCalls = [];
    let fullResponse = '';
    let _emailDrafts = [];
    let _calendarDrafts = [];
    let _linkedInDrafts = [];
    let _mapEmbeds = [];
    let _audioFiles = [];
    let _toolHistory = []; // Track tool calls for persistence

    // Abort signal from the route handler (client disconnect)
    const signal = messageMetadata.signal || null;

    // Emit first phase start event
    if (isSwarm && swarm.phases?.length > 0) {
        onEvent('phase', { phase: swarm.phases[0].name, message: `Starting phase: ${swarm.phases[0].name}` });
    }


    while (iterations < maxIterations) {
        // Check if client disconnected
        if (signal?.aborted) {
            console.log('[AgentRuntime] Aborting — client disconnected');
            break;
        }
        iterations++;

        try {
            const headers = { 'Content-Type': 'application/json' };
            const apiKey = config.apiKey;
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }

            // Build API URL - handle providers with /v1 in URL
            let apiUrl = config.url.replace(/\/$/, '');
            if (!apiUrl.endsWith('/v1')) {
                apiUrl = `${apiUrl}/v1`;
            }

            // Process Attachments (PDFs, Images)
            const processedMessages = [...messages];
            const lastMsg = processedMessages[processedMessages.length - 1]; // This is the user message
            let attachmentContent = '';

            // Handle attachments if present
            if (messageMetadata?.attachments && messageMetadata.attachments.length > 0) {
                console.log(`[Agent] Processing ${messageMetadata.attachments.length} attachments...`);
                await processAttachments(messageMetadata.attachments, lastMsg, userId);
            }

            // Inject guardrail violation context if detected
            let effectiveSystemPrompt = systemPrompt;
            if (guardrailViolation && iterations === 1) {
                effectiveSystemPrompt += `\n\n[IMPORTANT: The user's message was blocked by guardrail rule(s): "${guardrailViolation}". You must politely decline to process this request and explain that the content violates the "${guardrailViolation}" policy. Do not attempt to answer the request.]`;
                // Strip the violating user message — only send a placeholder to the model
                const lastIdx = messages.length - 1;
                if (messages[lastIdx]?.role === 'user') {
                    messages[lastIdx] = { ...messages[lastIdx], content: `[Message blocked by guardrail: ${guardrailViolation}]` };
                }
            }
            if (moderationViolation && iterations === 1) {
                effectiveSystemPrompt += `\n\n[IMPORTANT: The user's message was flagged by content moderation for: "${moderationViolation}". You must briefly explain that their message was flagged for "${moderationViolation}" and politely ask them to rephrase. Keep your response short (1-2 sentences). Do not process or answer the original request.]`;
                // Strip the violating user message — only send a placeholder to the model
                const lastIdx = messages.length - 1;
                if (messages[lastIdx]?.role === 'user') {
                    messages[lastIdx] = { ...messages[lastIdx], content: `[Message flagged by content moderation: ${moderationViolation}]` };
                }
            }

            // For swarms: update system prompt and tools for the current phase
            if (isSwarm) {
                effectiveSystemPrompt = swarmOrchestrator.generatePhasePrompt(swarm, currentPhaseIndex, phaseResults);
                tools = swarmOrchestrator.getSwarmToolsForPhase(swarm, currentPhaseIndex);
                console.log(`[AgentRuntime] 🐝 Phase ${currentPhaseIndex + 1}/${totalPhases}: "${swarm.phases[currentPhaseIndex]?.name}" — ${tools.length} workers available: [${tools.map(t => t.function?.name).join(', ')}]`);


            }

            // Enrich messages with form data context
            // We do this inside the loop to ensure it persists across tool calls if needed (though usually it's static)
            // But strict guardrails might want to check it. Ideally we do it once.
            // However, doing it here ensures `processedMessages` (which handles attachments) gets enriched.
            const finalMessages = enrichMessagesWithFormData(processedMessages);

            // Sanitize messages — Mistral rejects extra fields like parentId, id, etc.
            const sanitize = sanitizeMessages;

            const _streamCallStart = Date.now();

            // ─── Resolve tier settings for thinking/temperature config ─────
            let tierSettings = {};
            if (agent.model && agent.model.startsWith('tier:')) {
                const tierName = agent.model.substring(5);
                const { getTierConfig } = require('./modelResolver');
                tierSettings = await getTierConfig(tierName, { userOrgId: messageMetadata?.userOrgId || null });
            }

            // ─── Native SDK adapter streaming (Google, OpenAI, Claude, Mistral) ─────
            const providerAdapter = getAdapter(config.providerType, config.url);
            const useNativeAdapter = ['google', 'openai', 'claude', 'mistral', 'azure', 'google-vertex'].includes(config.providerType) && typeof providerAdapter?.stream === 'function';

            let currentToolCalls = [];
            let contentBuffer = '';

            if (useNativeAdapter) {
                // Build OpenAI-format messages for the adapter's normalizeMessages
                const adapterMessages = [
                    { role: 'system', content: effectiveSystemPrompt },
                    ...sanitizeMessages(finalMessages)
                ];

                const isThinkingModel = modelToUse.includes('magistral');
                const defaultMaxTokens = isThinkingModel ? 40960 : 8192;
                const adapterOptions = {
                    maxTokens: tierSettings.maxTokens || defaultMaxTokens,
                    temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : 0.7,
                    budgetTokens: tierSettings.budgetTokens || undefined,
                    reasoningEffort: tierSettings.reasoningEffort || undefined,
                    reasoningSummary: tierSettings.reasoningSummary || false,
                    // Azure-specific: needed for Responses API version check
                    apiVersion: config.apiVersion || undefined,
                };


                if (tools.length > 0) {
                    // Strip internal metadata (_mcp, _n8n etc.) before sending to LLM — providers may reject unknown fields
                    adapterOptions.tools = tools.map(t => {
                        const { _mcp, _n8n, ...clean } = t;
                        return clean;
                    });
                    adapterOptions.toolChoice = 'auto';
                }
                const mcpToolCount = tools.filter(t => t._mcp || t.function?.name?.startsWith('mcp_')).length;
                if (mcpToolCount > 0) {
                    console.log(`[AgentRuntime] 🔌 ${mcpToolCount} MCP tools loaded for LLM`);
                }

                console.log(`[AgentRuntime] Using native ${config.providerType} adapter for streaming`, {
                    model: modelToUse,
                    budgetTokens: adapterOptions.budgetTokens,
                    temperature: adapterOptions.temperature,
                    toolsCount: tools.length,
                });

                let _adapterStreamUsage = null;
                await retryStreamCall(() => providerAdapter.stream(
                    config.apiKey, config.url, modelToUse,
                    adapterMessages, adapterOptions,
                    (type, data) => {
                        if (type === 'text') {
                            const textChunk = data.text || '';
                            contentBuffer += textChunk;

                            // Real-time Agent Output validation
                            if (regexConfig?.enabled && regexConfig?.scope?.agentOutput) {
                                const matches = checkRegexPatterns(contentBuffer, regexConfig.rulesWithNames);
                                if (matches.length > 0) {
                                    const ruleNames = matches.map(m => m.ruleName).join(', ');
                                    console.log(`[RegexGuard] Agent output violated rules during stream: ${ruleNames}`);
                                    contentBuffer = `I apologize, but I cannot provide that response as it contains content that violates the ${ruleNames} policy.`;
                                    onEvent('content_replace', { text: contentBuffer });
                                    guardrailViolation = ruleNames;
                                    return;
                                }
                            }

                            if (!isSwarm) {
                                onEvent('content', { text: textChunk });
                            } else {
                                onEvent('orchestrator_thinking', { text: textChunk });
                            }
                        } else if (type === 'thinking') {
                            if (isSwarm) {
                                onEvent('orchestrator_thinking', { text: data.text });
                            } else {
                                onEvent('thinking', { text: data.text });
                            }
                        } else if (type === 'tool_use') {
                            // Accumulate tool calls for post-stream processing
                            currentToolCalls.push({
                                id: data.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                                function: {
                                    name: data.name,
                                    arguments: JSON.stringify(data.input || {}),
                                },
                                _thought_signature: data.thought_signature || undefined
                            });
                        } else if (type === 'done') {
                            // Capture usage data from adapter
                            _adapterStreamUsage = data;
                        } else if (type === 'error') {
                            onEvent('error', data);
                        }
                    }
                ));

                // Log usage for native adapter streams
                try {
                    await usageStore.logUsage({
                        user_id: userId,
                        agent_id: agentId,
                        agent_name: agent.name,
                        agent_type: isSwarm ? 'swarm' : 'chat',
                        model: modelToUse,
                        prompt_tokens: _adapterStreamUsage?.prompt_tokens || 0,
                        completion_tokens: _adapterStreamUsage?.completion_tokens || 0,
                        total_tokens: _adapterStreamUsage?.total_tokens || 0,
                        source: isSwarm ? 'swarm_orchestrator' : 'agent_stream',
                        duration_ms: Date.now() - _streamCallStart,
                        organization_id: agent.organization_id || null,
                        conversation_id: conversation?.id || null
                    });
                } catch (e) { /* ignore usage errors */ }

            } else {
                // ─── Raw fetch SSE streaming (OpenAI-compatible) ──────────────
                // Detect reasoning models that need special handling
                const isReasoningModel = /^o\d|^gpt-5/i.test(modelToUse);
                const isRestrictedTemp = /^o\d|nano|^gpt-5/i.test(modelToUse);
                const requestBody = {
                    model: modelToUse,
                    messages: [{ role: 'system', content: effectiveSystemPrompt }, ...sanitizeMessages(finalMessages)],
                    stream: true,
                    stream_options: { include_usage: true }
                };
                // Only set temperature for models that support it
                if (!isRestrictedTemp) {
                    requestBody.temperature = tierSettings.temperature !== undefined ? tierSettings.temperature : 0.7;
                }
                // Enable reasoning for capable models
                if (isReasoningModel) {
                    requestBody.reasoning_effort = 'medium';
                }

                if (tools.length > 0) {
                    requestBody.tools = tools.map(t => {
                        const { _mcp, _n8n, ...clean } = t;
                        return clean;
                    });
                    requestBody.tool_choice = 'auto';

                    // Enable parallel tool calls when the swarm phase is configured for parallel execution
                    if (isSwarm && swarm.phases?.[currentPhaseIndex]?.parallel) {
                        requestBody.parallel_tool_calls = true;
                        console.log(`[AgentRuntime] ⚡ Parallel tool calls enabled for phase "${swarm.phases[currentPhaseIndex].name}"`);
                    }
                }

                // Debug logging: what is being sent to the LLM
                console.log(`[AgentRuntime] Request to LLM:`, {
                    agentId,
                    model: modelToUse,
                    toolsCount: tools.length,
                    toolNames: tools.map(t => t.function?.name),
                    systemPromptPreview: effectiveSystemPrompt.substring(0, 200) + '...'
                });

                // Combine client disconnect signal with a 120s timeout to prevent indefinite hangs
                const timeoutMs = 120000;
                const timeoutSignal = AbortSignal.timeout(timeoutMs);
                const combinedSignal = signal
                    ? AbortSignal.any([signal, timeoutSignal])
                    : timeoutSignal;

                const response = await retryStreamCall(async () => {
                    const resp = await fetch(`${apiUrl}/chat/completions`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(requestBody),
                        signal: combinedSignal
                    });

                    if (!resp.ok) {
                        const errorText = await resp.text();
                        throw new Error(`API error ${resp.status}: ${errorText}`);
                    }
                    return resp;
                });


                // Parse SSE stream
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';


                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const data = line.slice(6);
                            if (data === '[DONE]') continue;

                            try {
                                const parsed = JSON.parse(data);

                                // Capture usage from final streaming chunk
                                if (parsed.usage) {
                                    await usageStore.logUsage({
                                        user_id: userId,
                                        agent_id: agentId,
                                        agent_name: agent.name,
                                        agent_type: isSwarm ? 'swarm' : 'chat',
                                        model: modelToUse,
                                        prompt_tokens: parsed.usage.prompt_tokens || 0,
                                        completion_tokens: parsed.usage.completion_tokens || 0,
                                        total_tokens: parsed.usage.total_tokens || 0,
                                        source: isSwarm ? 'swarm_orchestrator' : 'agent_stream',
                                        duration_ms: Date.now() - _streamCallStart,
                                        organization_id: agent.organization_id || null,
                                        conversation_id: conversation?.id || null
                                    });
                                }

                                const delta = parsed.choices?.[0]?.delta;

                                if (delta?.content !== undefined && delta?.content !== null) {
                                    // Handle reasoning models: delta.content can be a string OR an object
                                    let textChunk = '';
                                    if (typeof delta.content === 'string') {
                                        textChunk = delta.content;
                                    } else if (Array.isArray(delta.content)) {
                                        // Reasoning model — array of structured chunks
                                        // Format: [{type: "thinking", thinking: [{type: "text", text: "..."}]}]
                                        for (const chunk of delta.content) {
                                            if (chunk.type === 'thinking' && Array.isArray(chunk.thinking)) {
                                                const thinkText = chunk.thinking
                                                    .filter(t => t.type === 'text' && t.text)
                                                    .map(t => t.text)
                                                    .join('');
                                                if (thinkText) {
                                                    if (isSwarm) {
                                                        onEvent('orchestrator_thinking', { text: thinkText });
                                                    } else {
                                                        onEvent('thinking', { text: thinkText });
                                                    }
                                                }
                                            } else if (chunk.type === 'text' && chunk.text) {
                                                textChunk += chunk.text;
                                            }
                                        }
                                        if (!textChunk) continue; // Only thinking chunks — skip content processing
                                    }

                                    if (textChunk) {
                                        contentBuffer += textChunk;

                                        // Real-time Agent Output validation - check as we stream
                                        if (regexConfig?.enabled && regexConfig?.scope?.agentOutput) {
                                            const matches = checkRegexPatterns(contentBuffer, regexConfig.rulesWithNames);
                                            if (matches.length > 0) {
                                                const ruleNames = matches.map(m => m.ruleName).join(', ');
                                                console.log(`[RegexGuard] Agent output violated rules during stream: ${ruleNames}`);
                                                // Cancel remaining stream and send redacted message
                                                contentBuffer = `I apologize, but I cannot provide that response as it contains content that violates the ${ruleNames} policy.`;
                                                onEvent('content_replace', { text: contentBuffer }); // Replace all content
                                                guardrailViolation = ruleNames; // Mark as violation
                                                reader.cancel(); // Cancel the stream
                                                break;
                                            }
                                        }
                                        // Stream content to user (suppress during swarm phases — workers handle output)
                                        if (!isSwarm) {
                                            onEvent('content', { text: textChunk });
                                        } else {
                                            // In swarm mode, emit orchestrator text as thinking so the UI can show it
                                            onEvent('orchestrator_thinking', { text: textChunk });
                                        }
                                    }
                                }

                                // Handle tool calls in streaming
                                if (delta?.tool_calls) {
                                    for (const tc of delta.tool_calls) {
                                        const idx = tc.index;
                                        if (!currentToolCalls[idx]) {
                                            currentToolCalls[idx] = {
                                                id: tc.id || '',
                                                function: { name: '', arguments: '' }
                                            };
                                        }
                                        if (tc.id) currentToolCalls[idx].id = tc.id;
                                        if (tc.function?.name) currentToolCalls[idx].function.name = tc.function.name;
                                        if (tc.function?.arguments) currentToolCalls[idx].function.arguments += tc.function.arguments;
                                    }
                                }
                            } catch (e) {
                                // Skip parse errors
                            }
                        }
                    }
                }
            } // end else (raw fetch SSE)

            // Check if we have tool calls to execute
            if (currentToolCalls.length > 0 && currentToolCalls[0]?.function?.name) {
                // Clear intermediate planning text from the UI — only the final response
                // (from the last iteration without tool calls) should be visible to the user
                if (contentBuffer && !isSwarm) {
                    onEvent('content_replace', { text: '' });
                }

                const assistantMessage = {
                    role: 'assistant',
                    content: contentBuffer || null,
                    tool_calls: currentToolCalls.map(tc => ({
                        id: tc.id,
                        type: 'function',
                        function: tc.function,
                        // Preserve thought_signature for Gemini multi-turn tool calls
                        _thought_signature: tc._thought_signature || undefined
                    }))
                };
                messages.push(assistantMessage);

                // In the last phase, only execute the FIRST worker_* call to avoid duplicates
                // (the LLM sometimes issues parallel calls to the same worker)
                let effectiveToolCalls = currentToolCalls;
                if (isSwarm && currentPhaseIndex === totalPhases - 1) {
                    let firstWorkerSeen = false;
                    effectiveToolCalls = currentToolCalls.filter(tc => {
                        if (tc.function?.name?.startsWith('worker_')) {
                            if (firstWorkerSeen) {
                                console.log(`[AgentRuntime] ⚠️ Last phase: skipping duplicate worker call "${tc.function.name}"`);
                                return false;
                            }
                            firstWorkerSeen = true;
                        }
                        return true;
                    });
                }

                // Check abort before tool execution
                if (signal?.aborted) {
                    console.log('[AgentRuntime] Aborting before tool execution — client disconnected');
                    break;
                }

                // Execute all tools in parallel
                const toolExecutionPromises = effectiveToolCalls.map(async (toolCall) => {
                    const toolName = toolCall.function.name;
                    let toolArgs = {};
                    try {
                        toolArgs = JSON.parse(toolCall.function.arguments || '{}');
                    } catch (e) {
                        toolArgs = {};
                    }

                    const fixedParams = toolParamsMap[toolName] || null;
                    console.log(`[AgentRuntime] Tool lookup: ${toolName}, found fixedParams:`, fixedParams);
                    onEvent('tool_start', { name: toolName, args: toolArgs });

                    // Phase boundary enforcement: reject worker calls not in current phase
                    if (isSwarm && toolName.startsWith('worker_')) {
                        const allowedToolNames = tools.map(t => t.function?.name);
                        if (!allowedToolNames.includes(toolName)) {
                            const phaseName = swarm.phases[currentPhaseIndex]?.name || `Phase ${currentPhaseIndex + 1}`;
                            console.log(`[AgentRuntime] ⛔ Blocked worker call "${toolName}" — not available in current phase "${phaseName}". Allowed: [${allowedToolNames.join(', ')}]`);
                            onEvent('tool_end', { name: toolName, result: `[Blocked: ${toolName} is not available in the current phase "${phaseName}"]` });
                            return {
                                toolCall,
                                toolName,
                                toolArgs,
                                finalToolResult: `Error: ${toolName} is not available in the current phase "${phaseName}". Only use the workers provided for this phase.`,
                                blocked: true
                            };
                        }

                        // RunOnce enforcement: block duplicate worker calls in the same phase
                        const currentPhase = swarm.phases[currentPhaseIndex];
                        if (currentPhase?.runOnce && calledWorkersInPhase.has(toolName)) {
                            const phaseName = currentPhase.name || `Phase ${currentPhaseIndex + 1}`;
                            console.log(`[AgentRuntime] ⛔ Blocked duplicate worker call "${toolName}" — runOnce enabled for phase "${phaseName}"`);
                            onEvent('tool_end', { name: toolName, result: `[Blocked: ${toolName} already executed in this phase (run-once mode)]` });
                            return {
                                toolCall,
                                toolName,
                                toolArgs,
                                finalToolResult: `Error: ${toolName} has already been called in this phase. Each worker can only be called once in "${phaseName}". Move on to the next phase.`,
                                blocked: true
                            };
                        }

                        // Track the worker call
                        calledWorkersInPhase.add(toolName);
                    }

                    // Regex Guardrails - Tool Input scope
                    if (regexConfig?.enabled && regexConfig?.scope?.toolInput) {
                        const matches = checkRegexPatterns(JSON.stringify(toolArgs), regexConfig.rulesWithNames);
                        if (matches.length > 0) {
                            const ruleNames = matches.map(m => m.ruleName).join(', ');
                            console.log(`[RegexGuard] Tool input violated rules: ${ruleNames}`);
                            onEvent('tool_end', { name: toolName, result: `[Tool input blocked - violates ${ruleNames} policy]` });
                            return {
                                toolCall,
                                toolName,
                                toolArgs,
                                finalToolResult: `[Tool input blocked - violates ${ruleNames} policy]`,
                                blocked: true
                            };
                        }
                    }

                    // Web Search Guard — validate agent_search queries through Llama Guard
                    if (webSearchGuardEnabled && toolName === 'agent_search' && toolArgs?.query) {
                        try {
                            const searchMessages = [{ role: 'user', content: toolArgs.query }];
                            await validateInput(searchMessages, true, orgShieldCategories);
                            console.log(`[WebSearchGuard] Search query passed: "${toolArgs.query.substring(0, 80)}"`);
                        } catch (guardError) {
                            console.log(`[WebSearchGuard] Search query BLOCKED: "${toolArgs.query.substring(0, 80)}" — ${guardError.message}`);
                            onEvent('tool_end', { name: toolName, result: `[Web search blocked — query violates content policy]` });
                            return {
                                toolCall,
                                toolName,
                                toolArgs,
                                finalToolResult: `[Web search blocked — the search query "${toolArgs.query}" was flagged by the safety guard. Please rephrase or use a different approach.]`,
                                blocked: true
                            };
                        }
                    }

                    // Web Search Guard — PII detection on search queries
                    if (webSearchGuardPiiCategories && toolName === 'agent_search' && toolArgs?.query) {
                        try {
                            const { detectPii } = require('../azurePiiDetection');
                            const piiResult = await detectPii(toolArgs.query, webSearchGuardPiiCategories);
                            if (piiResult?.hasPii) {
                                const cats = [...new Set(piiResult.entities.map(e => e.label))].join(', ');
                                console.log(`[WebSearchGuard] Search query BLOCKED by PII (${cats}): "${toolArgs.query.substring(0, 80)}"`);
                                onEvent('tool_end', { name: toolName, result: `[Web search blocked — query contains sensitive information (${cats})]` });
                                return {
                                    toolCall,
                                    toolName,
                                    toolArgs,
                                    finalToolResult: `[Web search blocked — the search query contains sensitive personal information (${cats}). Please rephrase without including PII.]`,
                                    blocked: true
                                };
                            }
                            console.log(`[WebSearchGuard] Search query PII check passed`);
                        } catch (piiErr) {
                            console.warn(`[WebSearchGuard] PII check failed (fail-open):`, piiErr.message);
                        }
                    }

                    let toolResult;
                    if (isSwarm && toolName.startsWith('worker_')) {
                        toolResult = await executeWorkerTool(toolName, toolArgs, agentId, userAuth, onEvent, brain, signal);
                    } else {
                        // Use unified tool dispatcher — supports integrations + components
                        const { executeTool: dispatchTool } = require('../toolDispatcher');
                        toolResult = await dispatchTool(toolName, toolArgs, {
                            userId,
                            session: userAuth?.session,
                            userAuth,
                            fixedParams: fixedParams,
                            agentId: agent.id,
                            conversationId: conversation.id,
                            send: onEvent,
                            req: messageMetadata.req || null,
                            nanoBananaSettings: messageMetadata.nanoBananaSettings || null,
                            onImageGenerated: (data) => {
                                onEvent('image', data);
                            },
                        });
                    }

                    // Regex Guardrails - Tool Output scope
                    let finalToolResult = toolResult;
                    if (regexConfig?.enabled && regexConfig?.scope?.toolOutput) {
                        const matches = checkRegexPatterns(JSON.stringify(toolResult), regexConfig.rulesWithNames);
                        if (matches.length > 0) {
                            const ruleNames = matches.map(m => m.ruleName).join(', ');
                            console.log(`[RegexGuard] Tool output violated rules: ${ruleNames}`);
                            finalToolResult = `[Tool output redacted - contains ${ruleNames} content]`;
                        }
                    }

                    return {
                        toolCall,
                        toolName,
                        toolArgs,
                        finalToolResult,
                        blocked: false
                    };
                });

                // Wait for all tools to complete
                console.log(`[AgentRuntime] Executing ${currentToolCalls.length} tools in parallel...`);
                const toolResults = await Promise.all(toolExecutionPromises);

                // Check if any worker directly streamed to the user
                const directStreamResult = toolResults.find(r =>
                    r.finalToolResult && typeof r.finalToolResult === 'object' && r.finalToolResult.__direct_streamed__
                );

                if (directStreamResult) {
                    // The last worker already streamed directly to the user
                    // Save the conversation with the streamed content as the assistant response
                    fullResponse = directStreamResult.finalToolResult.content;
                    console.log(`[AgentRuntime] Worker streamed directly to user (${fullResponse.length} chars) — skipping orchestrator synthesis`);

                    // Add the assistant message with the streamed content
                    const directStreamMsg = {
                        role: 'assistant',
                        content: fullResponse,
                        parentId: messageMetadata.parentId || null
                    };
                    // Attach swarm execution history if available
                    if (isSwarm && (swarmLogs.length > 0 || swarmBrain.length > 0)) {
                        directStreamMsg.swarmActivity = {
                            type: 'swarm',
                            logs: swarmLogs,
                            brain: swarmBrain
                        };
                        console.log(`[AgentRuntime] Persisting swarm activity: ${swarmLogs.length} logs, ${swarmBrain.length} brain entries`);
                    }
                    messages.push(directStreamMsg);
                    await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);

                    // Note: 'done' event will be sent by the route handler when chatWithAgentStream returns
                    break; // Exit the orchestrator loop
                }

                // Process results in order (normal path)
                for (const result of toolResults) {
                    const { toolCall, toolName, toolArgs, finalToolResult } = result;

                    toolCalls.push({ name: toolName, args: toolArgs, result: finalToolResult });
                    // Track for persistence
                    _toolHistory.push({
                        name: toolName,
                        args: toolArgs,
                        status: 'done',
                        resultPreview: (typeof finalToolResult === 'string' ? finalToolResult : JSON.stringify(finalToolResult || '')).slice(0, 200),
                    });
                    // Sanitize tool result before streaming to client to prevent API key exposure
                    onEvent('tool_end', { name: toolName, result: sanitizeToolResult(finalToolResult) });

                    // Emit email_draft SSE event for user approval (with dedup)
                    if (finalToolResult?._action === 'email_draft') {
                        const draftKey = JSON.stringify({ to: finalToolResult.draft?.to, subject: finalToolResult.draft?.subject, body: finalToolResult.draft?.body });
                        const alreadySent = _emailDrafts.some(d => JSON.stringify({ to: d.to, subject: d.subject, body: d.body }) === draftKey);
                        if (!alreadySent) {
                            onEvent('email_draft', finalToolResult.draft);
                            _emailDrafts.push({ ...finalToolResult.draft, status: 'pending' });
                        }
                    }
                    // Emit calendar_draft SSE event for user approval (with dedup)
                    if (finalToolResult?._action === 'calendar_draft') {
                        const draftKey = JSON.stringify({ summary: finalToolResult.draft?.summary, start: finalToolResult.draft?.start, end: finalToolResult.draft?.end });
                        const alreadySent = _calendarDrafts.some(d => JSON.stringify({ summary: d.summary, start: d.start, end: d.end }) === draftKey);
                        if (!alreadySent) {
                            onEvent('calendar_draft', finalToolResult.draft);
                            _calendarDrafts.push({ ...finalToolResult.draft, status: 'pending' });
                        }
                    }
                    // Emit linkedin_draft SSE event for user approval
                    if (finalToolResult?._action === 'linkedin_draft') {
                        onEvent('linkedin_draft', finalToolResult.draft);
                        _linkedInDrafts.push({ ...finalToolResult.draft, status: 'pending' });
                    }
                    // Emit whatsapp_draft SSE event for user approval
                    if (finalToolResult?._action === 'whatsapp_draft') {
                        onEvent('whatsapp_draft', finalToolResult.draft);
                    }


                    // Emit map_embed SSE event so map renders persist on messages
                    if (finalToolResult?._action === 'map_embed' && finalToolResult._mapEmbed) {
                        onEvent('map_embed', finalToolResult._mapEmbed);
                        _mapEmbeds.push(finalToolResult._mapEmbed);
                    }

                    // Emit workspace_update SSE event so frontend updates panel
                    if (finalToolResult?._action === 'workspace_update') {
                        onEvent('workspace_update', { content: finalToolResult.content });
                    }

                    // Emit kb_sources SSE event so frontend shows knowledge base sources
                    if (finalToolResult?._action === 'kb_sources' && finalToolResult._sources?.length > 0) {
                        onEvent('kb_sources', { sources: finalToolResult._sources });
                    }

                    // Track audio files for persistence (sent via SSE by the tool)
                    if (finalToolResult?.audioUrl) {
                        _audioFiles.push({ url: finalToolResult.audioUrl, source: toolName });
                    }

                    // Log tool usage
                    try {
                        await usageStore.logUsage({
                            user_id: userId,
                            agent_id: agentId,
                            agent_name: agent.name,
                            agent_type: isSwarm ? 'swarm' : 'chat',
                            model: modelToUse,
                            tool_name: toolName,
                            source: isSwarm ? 'swarm_orchestrator' : 'agent_chat',
                            organization_id: agent.organization_id || null,
                            conversation_id: conversation?.id || null,
                        });
                    } catch (e) { /* ignore */ }

                    // ── Integration Activity Logging (async, non-blocking) ──
                    try {
                        const integMeta = resolveIntegration(toolName, toolArgs || {});
                        if (integMeta) {
                            // Fire-and-forget: check shield config + log
                            const shieldKey = `org_privacy_shield_${agent.organization_id}`;
                            configStore.getConfig(shieldKey).then(shield => {
                                if (shield?.monitorIntegrations) {
                                    integrationActivityStore.logIntegrationActivity({
                                        organization_id: agent.organization_id || null,
                                        user_id: userId,
                                        agent_id: agentId,
                                        agent_name: agent.name,
                                        conversation_id: conversation?.id || null,
                                        tool_name: toolName,
                                        integration_type: integMeta.integration,
                                        server_endpoint: integMeta.server,
                                        data_direction: integMeta.direction,
                                        data_categories: integMeta.dataCategories,
                                        source: isSwarm ? 'swarm_orchestrator' : 'agent_stream',
                                        model: modelToUse,
                                    }).catch(e => console.error('[IntegrationActivityLog] Error:', e.message));
                                }
                            }).catch(() => {});
                        }
                    } catch (e) { /* ignore integration logging errors */ }

                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: typeof finalToolResult === 'string' ? finalToolResult : JSON.stringify(
                            // Strip bulky notebook content — LLM only needs the confirmation message
                            (typeof finalToolResult === 'object' && finalToolResult?._action === 'workspace_update' && finalToolResult?.message)
                                ? { action: 'notebook_updated', message: finalToolResult.message }
                                : finalToolResult
                        )
                    });
                }

                // In the LAST phase: ANY worker call produces the final output
                // Break immediately — don't let the orchestrator add meta-commentary
                if (isSwarm && currentPhaseIndex === totalPhases - 1) {
                    const workerResult = toolResults.find(r => r.toolName?.startsWith('worker_') && !r.blocked);
                    if (workerResult) {
                        const lastPhase = swarm.phases[currentPhaseIndex];
                        const workerName = workerResult.toolName.replace('worker_', '');
                        console.log(`[AgentRuntime] 🐝 Final phase worker "${workerResult.toolName}" completed — using as final output`);
                        fullResponse = typeof workerResult.finalToolResult === 'string'
                            ? workerResult.finalToolResult
                            : JSON.stringify(workerResult.finalToolResult);

                        // Stream the worker's result to the user
                        onEvent('content', { text: fullResponse });
                        onEvent('worker_complete', { worker: workerName, result: fullResponse.slice(0, 100) + '...' });

                        // Save conversation and break
                        const finalMsg = {
                            role: 'assistant',
                            content: fullResponse,
                            parentId: messageMetadata.parentId || null
                        };
                        if (swarmLogs.length > 0 || swarmBrain.length > 0) {
                            finalMsg.swarmActivity = {
                                type: 'swarm',
                                logs: swarmLogs,
                                brain: swarmBrain
                            };
                        }
                        messages.push(finalMsg);
                        await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);
                        break; // Exit the orchestrator loop
                    }
                }

                // Save conversation after tool execution (so tool calls are persisted)
                console.log('[AgentStream] Saving conversation with tool calls:', JSON.stringify(messages.slice(-3), null, 2));
                await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);
                continue;
            }

            // No tool calls — check if swarm phase is complete
            if (isSwarm && currentPhaseIndex < totalPhases - 1) {
                // Phase complete but NOT the last phase — advance to next phase
                const phaseSummary = contentBuffer;
                const phaseName = swarm.phases[currentPhaseIndex]?.name || `Phase ${currentPhaseIndex + 1}`;
                phaseResults.push(phaseSummary);
                console.log(`[AgentRuntime] ✅ Phase "${phaseName}" complete (${phaseSummary.length} chars). Advancing to phase ${currentPhaseIndex + 2}/${totalPhases}`);

                // Add phase summary to Hive Mind so later workers can access it
                if (brain && phaseSummary.trim()) {
                    brain.addEntry(`Orchestrator`, `Phase "${phaseName}" summary: ${phaseSummary}`);
                    onEvent('brain_update', {
                        worker: 'Orchestrator',
                        phase: phaseName,
                        content: phaseSummary
                    });
                }

                // Emit phase completion event
                onEvent('phase', { phase: phaseName, message: `Phase complete: ${phaseName}`, status: 'complete' });

                currentPhaseIndex++;
                calledWorkersInPhase.clear(); // Reset worker tracking for the new phase
                const nextPhaseName = swarm.phases[currentPhaseIndex]?.name || `Phase ${currentPhaseIndex + 1}`;

                // Emit next phase start event
                onEvent('phase', { phase: nextPhaseName, message: `Starting phase: ${nextPhaseName}` });

                // For the last phase, also emit worker_start so the UI shows which agent will respond
                if (currentPhaseIndex === totalPhases - 1) {
                    const lastPhase = swarm.phases[currentPhaseIndex];
                    const lastAgent = lastPhase?.agents?.[lastPhase.agents.length - 1];
                    if (lastAgent) {
                        onEvent('worker_start', {
                            worker: lastAgent.name,
                            role: lastAgent.role,
                            phase: nextPhaseName,
                            message: `${lastAgent.name} is preparing the final response...`
                        });
                    }
                }

                // Trim conversation to prevent cross-phase context bleed
                // Keep only the original user message(s) and add a compact transition
                const originalMessages = messages.filter(m => m.role === 'user' && !m.content?.startsWith('Previous phases'));
                messages.length = 0;
                messages.push(...originalMessages);

                // Inject Hive Mind context so the orchestrator can see all findings
                const hiveMindContext = brain && brain.size > 0 ? `\n\n${brain.toPromptContext()}` : '';
                messages.push({
                    role: 'user',
                    content: `Previous phases complete.${hiveMindContext}\n\nBegin phase "${nextPhaseName}" now. Use only the workers provided.`
                });

                // Reset content buffer for next phase
                fullResponse = '';
                continue;
            }

            // Final response (last phase or non-swarm)
            if (isSwarm && currentPhaseIndex === totalPhases - 1) {
                // Last phase: orchestrator didn't call the worker — force-call it
                const lastPhase = swarm.phases[currentPhaseIndex];
                const lastAgent = lastPhase?.agents?.[lastPhase.agents.length - 1];
                const lastWorkerKey = lastAgent?.role || lastAgent?.name?.toLowerCase().replace(/\s+/g, '_');

                if (lastAgent && lastWorkerKey) {
                    console.log(`[AgentRuntime] 🐝 Orchestrator didn't call last worker "${lastAgent.name}" — force-invoking it`);

                    // Emit worker attribution
                    onEvent('worker_start', {
                        worker: lastAgent.name,
                        role: lastAgent.role,
                        phase: lastPhase.name,
                        message: `${lastAgent.name} is preparing the final response...`
                    });

                    // Use orchestrator's output as instruction for the last worker
                    const workerResult = await executeWorkerTool(
                        `worker_${lastWorkerKey}`,
                        { instruction: contentBuffer || 'Produce the final comprehensive response based on all Hive Mind findings.' },
                        agentId,
                        userAuth,
                        onEvent,
                        brain,
                        signal
                    );

                    if (workerResult && typeof workerResult === 'object' && workerResult.__direct_streamed__) {
                        fullResponse = workerResult.content;
                        onEvent('worker_complete', { worker: lastAgent.name, result: '(streamed directly to user)' });
                    } else {
                        fullResponse = typeof workerResult === 'string' ? workerResult : JSON.stringify(workerResult);
                        // Stream the worker's response to the user
                        onEvent('content', { text: fullResponse });
                        onEvent('worker_complete', { worker: lastAgent.name, result: fullResponse.slice(0, 100) + '...' });
                    }
                } else {
                    // Fallback: no last agent found, use orchestrator's response
                    fullResponse = contentBuffer;
                }
            } else {
                fullResponse = contentBuffer;
            }

            // Strip raw tool-call XML tags from the response — some models (e.g. Mistral thinking)
            // output <tool_call>/<tool_response> as plain text instead of structured function calls
            if (fullResponse) {
                const originalLen = fullResponse.length;
                fullResponse = fullResponse
                    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
                    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, '')
                    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
                    .replace(/<tool_results>[\s\S]*?<\/tool_results>/g, '')
                    .trim();
                if (fullResponse.length !== originalLen) {
                    console.log(`[AgentRuntime] Stripped tool-call XML tags from response (${originalLen} → ${fullResponse.length} chars)`);
                    // Replace the content in the UI with the cleaned version
                    onEvent('content_replace', { text: fullResponse });
                }
            }

            // Agent Output — AI Content Moderation (Guard Service)
            // Regex guards are checked in real-time during streaming above;
            // the Guard Service check runs post-stream on the full response.
            if (fullResponse && !moderationViolation && !guardrailViolation) {
                // Resolve org moderation scope for output check
                const orgModerationEnabled = agent.organization_id
                    ? await (async () => {
                        const shield = await configStore.getConfig(`org_privacy_shield_${agent.organization_id}`);
                        return shield?.enabled && shield?.moderationEnabled;
                    })()
                    : false;
                const orgModerationScope = agent.organization_id
                    ? await (async () => {
                        const shield = await configStore.getConfig(`org_privacy_shield_${agent.organization_id}`);
                        return shield?.enabled ? (shield.scope || { userInput: true, agentOutput: true }) : { userInput: true, agentOutput: true };
                    })()
                    : { userInput: true, agentOutput: true };
                const outputModerationEnabled = (orgModerationEnabled && orgModerationScope.agentOutput) ||
                    agent.config?.llamaGuardEnabled || globalConfig?.llamaGuardConfig?.enabled;

                if (outputModerationEnabled) {
                    try {
                        const outputMessages = [{ role: 'assistant', content: fullResponse }];
                        await validateInput(outputMessages, true, orgShieldCategories);
                        console.log(`[AgentRuntime] AI moderation passed (agent output)`);
                    } catch (guardError) {
                        if (guardError.violationCodes) {
                            let violationLabels = guardError.violationCodes;
                            try {
                                const parsed = JSON.parse(guardError.outcome);
                                violationLabels = parsed.map(f => f.label || f.category);
                            } catch (e) { /* use codes as-is */ }
                            console.log(`[AgentRuntime] Agent output moderation violation: ${violationLabels.join(', ')}`);
                            fullResponse = `⚠️ This response was blocked by content moderation (${violationLabels.join(', ')}). The AI's response contained content that violates organization safety policies.`;
                            onEvent('content_replace', { text: fullResponse });
                            moderationViolation = violationLabels.join(', ');

                            // Log output moderation event (fire-and-forget)
                            guardrailEventStore.logGuardrailEvent({
                                organization_id: agent.organization_id || null,
                                user_id: userId,
                                agent_id: agentId,
                                agent_name: agent.name,
                                conversation_id: conversation?.id || null,
                                violation_type: 'moderation',
                                violation_categories: violationLabels.join(', '),
                                direction: 'output',
                                action_taken: 'soft_block',
                                source: isSwarm ? 'swarm_orchestrator' : 'agent_stream',
                                model: modelToUse,
                            }).catch(() => {});
                        }
                    }
                }
            }

            // Include parentId for thread persistence
            const assistantMsg = {
                role: 'assistant',
                content: fullResponse,
                parentId: messageMetadata.parentId || null
            };

            // Attach persisted metadata
            if (_emailDrafts.length > 0) assistantMsg.emailDrafts = _emailDrafts;
            if (_calendarDrafts.length > 0) assistantMsg.calendarDrafts = _calendarDrafts;
            if (_linkedInDrafts.length > 0) assistantMsg.linkedInDrafts = _linkedInDrafts;
            if (_mapEmbeds.length > 0) assistantMsg.mapEmbeds = _mapEmbeds;
            if (_audioFiles.length > 0) assistantMsg.audioFiles = _audioFiles;
            if (_toolHistory.length > 0) assistantMsg.toolHistory = _toolHistory;

            // Emit phase completion for the last phase
            if (isSwarm && swarm.phases?.length > 0) {
                const lastPhaseName = swarm.phases[currentPhaseIndex]?.name || `Phase ${currentPhaseIndex + 1}`;
                onEvent('phase', { phase: lastPhaseName, message: `Phase complete: ${lastPhaseName}`, status: 'complete' });
            }

            // Attach swarm execution history if available
            if (isSwarm && (swarmLogs.length > 0 || swarmBrain.length > 0)) {
                assistantMsg.swarmActivity = {
                    type: 'swarm',
                    logs: swarmLogs,
                    brain: swarmBrain
                };
                console.log(`[AgentRuntime] Persisting swarm activity: ${swarmLogs.length} logs, ${swarmBrain.length} brain entries`);
            }
            messages.push(assistantMsg);
            if (!isEphemeral) {
                await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);
            }

            // ============ MEMORY EXTRACTION ============
            // Skip memory extraction if ephemeral, guardrail violation, or redaction occurred
            if (!isEphemeral && !agent.embed_enabled) {
                const shouldSkipMemoryExtraction = guardrailViolation || processedUserMessage !== userMessage;

                const debugData = {
                    agentId,
                    conversationId: conversation.id,
                    guardrailViolation: !!guardrailViolation,
                    isRedacted: processedUserMessage !== userMessage,
                    shouldSkip: shouldSkipMemoryExtraction,
                    messagesCount: messages.length,
                    userMessageLength: userMessage.length
                };
                console.log(`[DEBUG] Memory Extraction Check:`, debugData);


                if (!shouldSkipMemoryExtraction) {
                    try {
                        const memoryExtractor = require('../../agents/memory/extractor');
                        memoryExtractor.extractFromConversation(userId, agentId, messages, conversation.id, extractMemoriesEnabled ? validProjectId : null, messageMetadata?.userOrgId || null)
                            .then(extracted => {

                                if (extracted.length > 0) {
                                    console.log(`[AgentRuntime] Extracted ${extracted.length} memories from conversation`);
                                }
                            })
                            .catch(err => {
                                console.error('[AgentRuntime] Memory extraction failed:', err.message);

                            });
                    } catch (memErr) {
                        console.error('[AgentRuntime] Memory extractor load failed:', memErr.message);

                    }
                } else {
                    console.log('[AgentRuntime] Skipping memory extraction due to guardrail violation or redaction');

                }
            }

            // ============ SERVER-SIDE PERSISTENCE FOR REDACTION ============
            // Schedule server-side persistence for both delete mode (guardrailViolation) and redact mode (processedUserMessage changed)
            // Skip for ephemeral embed chats
            if (!isEphemeral) {
                const needsServerPersistence = guardrailViolation || processedUserMessage !== userMessage;
                if (needsServerPersistence) {
                    const redactedContent = processedUserMessage !== userMessage
                        ? processedUserMessage  // Use redacted version (with [REDACTED: RuleName])
                        : '[Message removed - policy violation]';  // Full replacement for delete mode

                    // Persist redaction immediately after current event-loop tick
                    // (was setTimeout(5000) which raced with conversation save)
                    setImmediate(async () => {
                        try {
                            const conv = await agentStore.getConversationById(conversation.id, userAuth.encryptionKey);
                            if (conv && conv.messages) {
                                // Find the LAST user message (more robust than index-based lookup)
                                let lastUserIdx = -1;
                                for (let i = conv.messages.length - 1; i >= 0; i--) {
                                    if (conv.messages[i].role === 'user') {
                                        lastUserIdx = i;
                                        break;
                                    }
                                }
                                if (lastUserIdx < 0) {
                                    console.warn('[RegexGuard] No user message found for redaction');
                                    return;
                                }
                                const updatedMessages = conv.messages.map((m, idx) => {
                                    if (idx === lastUserIdx) {
                                        return { ...m, content: redactedContent, isRedacted: true };
                                    }
                                    return m;
                                });
                                await agentStore.updateConversation(conversation.id, updatedMessages, userAuth.encryptionKey, userAuth.userId);
                                console.log(`[RegexGuard] Server-side persistence completed for conversation ${conversation.id}`);
                            }
                        } catch (redactErr) {
                            console.error('[RegexGuard] Server-side persistence failed:', redactErr.message);
                        }
                    });
                }
            }

            return {
                message: fullResponse,
                toolCalls,
                conversationLength: messages.length,
                conversationId: conversation.id,
                guardrailViolation: guardrailViolation || null,
                model: modelToUse
            };
        } catch (error) {
            // Classify the error for better logging and user-facing messages
            const classified = error._classified || classifyStreamError(error);
            console.error(`[Agent Stream] Error (${classified.errorType}):`, error.message);
            // Attach classification so the route handler can send a descriptive error
            error._classified = classified;
            error.message = classified.userMessage;
            throw error;
        }
    }

    // If we broke out of the loop with a valid response (last-phase worker path), return it
    if (fullResponse) {
        // Memory extraction for the break path
        // Extract memories from the conversation (skip for ephemeral/embed chats)
        if (!isEphemeral && !agent.embed_enabled) {
            try {
                const shouldSkipMemoryExtraction = guardrailViolation || processedUserMessage !== userMessage;
                if (!shouldSkipMemoryExtraction) {
                    const memoryExtractor = require('../../agents/memory/extractor');

                    memoryExtractor.extractFromConversation(userId, agentId, messages, conversation.id, extractMemoriesEnabled ? validProjectId : null, messageMetadata?.userOrgId || null)
                        .catch(err => {

                        });
                } else {

                }
            } catch (e) { /* ignore */ }
        }

        return {
            message: fullResponse,
            toolCalls,
            conversationLength: messages.length,
            conversationId: conversation.id,
            guardrailViolation: guardrailViolation || null,
            model: modelToUse
        };
    }

    throw new Error('Agent exceeded maximum tool call iterations');
}

module.exports = { chatWithAgentStream };
