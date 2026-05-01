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
const { hydrateHistoryAttachments } = require('./historyHydrator');
const { compactMessages } = require('../compaction');
const { buildTokenPreservationAddendum } = require('../dlp/tokenPreservationPrompt');

/**
 * Serialize a tool result for the LLM's tool message.
 *
 * The server stores "internal" fields on tool results (prefixed with `_`,
 * or the `_action` dispatch field) which chatStream intercepts to emit SSE
 * events or save persistence state. The LLM only needs the *outcome*; sending
 * the bulky UI-facing payload (e.g. kb_sources' `_sources` duplicates `results`
 * at full 3000-char content) wastes tokens and distracts the model.
 *
 * Rules:
 *   - Strings pass through verbatim.
 *   - Special-case workspace_update → tiny confirmation.
 *   - Otherwise: drop every key starting with `_` (e.g. `_action`, `_sources`)
 *     and drop known noise fields (`instruction`, `resultCount`) that are
 *     superseded by the agent's system prompt.
 */
function buildLLMToolContent(finalToolResult) {
    if (typeof finalToolResult === 'string') return finalToolResult;
    if (finalToolResult == null || typeof finalToolResult !== 'object') {
        return JSON.stringify(finalToolResult);
    }

    // Strip bulky notebook content — LLM only needs the confirmation message.
    if (finalToolResult._action === 'workspace_update' && finalToolResult.message) {
        return JSON.stringify({ action: 'notebook_updated', message: finalToolResult.message });
    }

    const NOISE_KEYS = new Set(['instruction', 'resultCount']);
    const clean = {};
    for (const [k, v] of Object.entries(finalToolResult)) {
        if (k.startsWith('_')) continue;     // Internal dispatch / UI-only fields
        if (NOISE_KEYS.has(k)) continue;     // Redundant with system prompt
        clean[k] = v;
    }
    return JSON.stringify(clean);
}

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
    let agent = await agentStore.getAgent(agentId);

    if (!agent) {
        throw new Error('Agent not found');
    }

    // Get global config for guardrails and defaults
    const globalConfig = await getAIConfig();

    // Get the model to use - supports tier-based selection (tier:auto, tier:fast, etc.)
    // If client provided a modelTier override (e.g. retry with different model), use it
    const effectiveAgentModel = messageMetadata?.modelTier ? `tier:${messageMetadata.modelTier}` : agent.model;
    const modelToUse = await resolveAgentModel(effectiveAgentModel, userMessage, { ...globalConfig, organizationId: agent.organization_id, userOrgId: messageMetadata?.userOrgId });

    // Get the correct provider config for this model
    const config = await getProviderForModel(modelToUse);
    console.log(`[AgentRuntime] Streaming with model: ${modelToUse} from provider: ${config.providerName || 'default'}`);

    let tools = await getAgentTools(agentId);

    // ── Check per-agent external tools disable flag ──────
    const disableExternalTools = agent.config?.disableExternalTools === true;

    // ── Inject integration tools (Gmail, Calendar, etc.) ──────
    // These require OAuth tokens from the user session
    let n8nOrgId = null;
    if (!disableExternalTools) {
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
    } else {
        // Also strip web search when external tools are disabled
        tools = tools.filter(t => t.function?.name !== 'agent_search');
        console.log(`[AgentRuntime] External tools disabled for agent ${agentId} — skipping integrations and web search`);
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
    let validProject = null;
    if (messageMetadata.projectId) {
        try {
            const projectStore = require('../../stores/projectStore');
            const project = await projectStore.getProject(messageMetadata.projectId);
            if (project) {
                // Validate user has access to this project
                const hasAccess = await projectStore.userHasAccess(userId, messageMetadata.projectId);
                if (hasAccess) {
                    validProjectId = messageMetadata.projectId;
                    validProject = project;
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

    // ============ HYDRATE HISTORY ATTACHMENTS ============
    // Rebuilds multimodal content from each historical message's persisted
    // attachments sidecar so images/files from earlier turns stay visible to
    // the LLM, and refreshes any stale RustFS temp URLs (900 s TTL).
    // The current (last) user message is skipped — processAttachments() below
    // handles it with live upload data.
    await hydrateHistoryAttachments(messages, { userId });

    // ============ COMPACTION ============
    // Once the hydrated history exceeds COMPACTION_THRESHOLD messages, collapse
    // older turns into a summary block to keep the prompt within a sane token
    // budget. Any image_url blocks in the summarised window are hoisted into
    // the summary so visual context is preserved (user requested all images
    // stay visible). The summary is persisted on the conversation's meta_json
    // and reused on subsequent turns so we don't re-summarise from scratch.
    try {
        // Key name (`conversationSummary`) matches the direct-chat convention so
        // any future shared helper can read both paths the same way.
        const existingSummary = conversation?.meta?.conversationSummary || null;
        const { messages: compactedMessages, newSummary } = await compactMessages(messages, {
            existingSummary,
            summaryModelId: 'tier:fast',
            userOrgId: messageMetadata?.userOrgId || agent?.organization_id || null,
        });
        messages = compactedMessages;
        if (newSummary && newSummary !== existingSummary && conversation?.id) {
            // Fire-and-forget — the next turn picks it up even if this write
            // races with the message persistence.
            agentStore.updateConversationMeta(conversation.id, { conversationSummary: newSummary })
                .catch(err => console.warn('[AgentRuntime] Failed to persist compaction summary:', err.message));
        }
    } catch (compactErr) {
        console.warn('[AgentRuntime] Compaction failed (continuing with full history):', compactErr.message);
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

                // Defence in depth against the "memory leak" class of bug: stored
                // memories can carry real PII from earlier turns that would bypass
                // this turn's tokeniser. Replace detected values with generic
                // labels before they reach the LLM. Non-reversible by design.
                try {
                    const configStore = require('../../stores/configStore');
                    const { getAIConfig } = require('../aiAgent');
                    const orgShieldForScrub = agent.organization_id
                        ? await configStore.getConfig(`org_privacy_shield_${agent.organization_id}`)
                        : null;
                    const aiCfg = await getAIConfig();
                    const scrubEnabled = !!(orgShieldForScrub?.enabled && orgShieldForScrub?.azurePiiEnabled) || !!aiCfg?.piiDetectionEnabled;
                    if (scrubEnabled) {
                        const { scrubMemoryContext } = require('../memory/scrubMemoryContext');
                        const { scrubbed, replacedCategories } = await scrubMemoryContext(memoryContext, orgShieldForScrub);
                        if (replacedCategories.length > 0) {
                            console.log(`[AgentRuntime] 🧹 Scrubbed memory context: ${replacedCategories.join(', ')}`);
                            memoryContext = scrubbed;
                        }
                    }
                } catch (scrubErr) {
                    console.warn('[AgentRuntime] Memory scrub failed (fail-open):', scrubErr.message);
                }
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
    const guardrailsResult = await runInputGuardrails({ agent, messages, userMessage, globalConfig, onEvent, userId, conversationId: conversation?.id, source: 'agent_stream', model: modelToUse });
    let moderationViolation = guardrailsResult.moderationViolation;
    let guardrailViolation = guardrailsResult.guardrailViolation;
    let processedUserMessage = guardrailsResult.processedUserMessage;
    // Privacy / DLP metadata accumulators — attached to the saved user/assistant
    // messages just before persistence so the redaction badge and "How I got this
    // answer" panel survive a page refresh.
    let _userPrivacyMeta = guardrailsResult.userPrivacyMeta || null;
    let _assistantTokenisationInfo = guardrailsResult.assistantTokenisationInfo || null;
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

    // ============ PRE-FLIGHT DLP (interactive outbound scanner) ============
    // Runs only when the org has `dlpEnabled: true`. It scans the last user
    // message for PII + org-defined custom terms, classifies the provider, and
    // either proceeds / redacts / blocks / pauses-to-ask based on the org's
    // `dlpMode`. See server/core/dlp/dlpRunner.js for semantics.
    const dlpShield = await resolveOrgShield(agent.organization_id);
    if (dlpShield?.dlpEnabled) {
        const dlpRunner = require('../dlp/dlpRunner');
        const decisionQueue = require('../dlp/decisionQueue');
        const dlpStore = require('../../stores/guardrailEventStore');

        const providerConfig = {
            providerType: config.providerType,
            url: config.url,
            displayName: config.providerName || config.providerType || 'LLM',
        };

        const scanStart = Date.now();
        const dlpResult = await dlpRunner.scan({
            messages,
            orgShieldConfig: dlpShield,
            orgId: agent.organization_id,
            conversationId: conversation?.id,
            providerConfig,
        });
        const scanMs = Date.now() - scanStart;

        const auditBase = {
            organization_id: agent.organization_id || null,
            user_id: userId || null,
            agent_id: agentId || null,
            agent_name: agent.name || null,
            conversation_id: conversation?.id || null,
            model: modelToUse,
            source: providerConfig.displayName,
        };
        const categoryList = Object.keys(dlpResult.summary || {}).join(', ') || null;

        async function applyRedactionToMessages(tokenizedText) {
            const lastIdx = messages.length - 1;
            const lastMsg = messages[lastIdx];
            if (!lastMsg || lastMsg.role !== 'user') return;
            if (typeof lastMsg.content === 'string') {
                lastMsg.content = tokenizedText;
                processedUserMessage = tokenizedText;
            } else if (Array.isArray(lastMsg.content)) {
                const textPart = lastMsg.content.find(p => p.type === 'text');
                if (textPart) { textPart.text = tokenizedText; processedUserMessage = tokenizedText; }
            }
        }

        if (dlpResult.action === 'block') {
            onEvent?.('dlp_blocked', {
                findings: dlpResult.findings.map(f => ({ label: f.label, category: f.category, source: f.source })),
                provider: dlpResult.provider,
                reason: dlpResult.reason || 'policy_block',
            });
            dlpStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'blocked' }).catch(() => {});
            const err = new Error('Prompt blocked by data-loss-prevention policy.');
            err.code = 'DLP_BLOCKED';
            throw err;
        }

        if (dlpResult.action === 'redact') {
            await applyRedactionToMessages(dlpResult.redactedText);
            const dlpCount = Object.keys(dlpResult.tokenMap || {}).length;
            const dlpCats = Object.keys(dlpResult.summary || {});
            onEvent?.('dlp_resolved', {
                appliedChoice: 'redact',
                redactedCount: dlpCount,
                provider: dlpResult.provider,
                categories: dlpCats,
                automatic: true,
                decisionMs: scanMs,
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
            if (dlpShield?.showRawPayload && dlpResult.redactedText) {
                onEvent?.('privacy_payload', {
                    tokenizedPrompt: dlpResult.redactedText,
                    provider: modelToUse,
                    source: 'dlp',
                    timestamp: Date.now(),
                });
                _assistantTokenisationInfo.tokenizedPrompt = dlpResult.redactedText;
                if (dlpResult.tokenMap && Object.keys(dlpResult.tokenMap).length > 0) {
                    onEvent?.('privacy_token_map', { tokenMap: dlpResult.tokenMap, source: 'dlp' });
                    _assistantTokenisationInfo.tokenMap = dlpResult.tokenMap;
                }
            }
            dlpStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'redacted' }).catch(() => {});
        } else if (dlpResult.action === 'ask') {
            // Surface findings to the user and pause until they choose.
            const { decisionId, promise } = decisionQueue.register({ conversationId: conversation?.id, userId });
            onEvent?.('dlp_preview', {
                decisionId,
                provider: dlpResult.provider,
                findings: dlpResult.findings.map(f => ({
                    label: f.label,
                    category: f.category,
                    source: f.source,
                    // Safe preview: first 3 chars of the match + ellipsis. We deliberately
                    // do NOT send the full value back over SSE — the user already typed it,
                    // and this keeps the event small / harder to log-snoop.
                    preview: (f.text || '').slice(0, 3) + '…',
                })),
                summary: dlpResult.summary,
                defaultChoice: dlpShield.dlpMode === 'block' ? 'block' : 'redact',
            });

            let decision;
            try {
                decision = await promise;
            } catch (err) {
                // Timeout or abort → treat as block under fail-closed semantics.
                onEvent?.('dlp_blocked', { reason: err.code === 'DLP_TIMEOUT' ? 'timeout' : 'rejected', findings: [], provider: dlpResult.provider });
                dlpStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'blocked' }).catch(() => {});
                const blockErr = new Error('Prompt blocked: DLP decision timed out.');
                blockErr.code = 'DLP_TIMEOUT';
                throw blockErr;
            }

            if (decision.rememberForConversation && decision.choice !== 'block') {
                dlpRunner.setConversationPref(conversation?.id, decision.choice);
            }

            if (decision.choice === 'block') {
                onEvent?.('dlp_blocked', { reason: 'user_blocked', findings: [], provider: dlpResult.provider });
                dlpStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'blocked' }).catch(() => {});
                const err = new Error('Prompt blocked by the user.');
                err.code = 'DLP_USER_BLOCKED';
                throw err;
            } else if (decision.choice === 'redact') {
                const { tokenizedText, tokenMap } = dlpRunner.applyRedactionChoice({
                    conversationId: conversation?.id,
                    text: (messages[messages.length - 1].content && typeof messages[messages.length - 1].content === 'string')
                        ? messages[messages.length - 1].content
                        : (Array.isArray(messages[messages.length - 1].content)
                            ? (messages[messages.length - 1].content.find(p => p.type === 'text')?.text || '')
                            : ''),
                    findings: dlpResult.findings,
                });
                await applyRedactionToMessages(tokenizedText);
                const dlpCount = Object.keys(tokenMap).length;
                const dlpCats = Object.keys(dlpResult.summary || {});
                onEvent?.('dlp_resolved', {
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
                if (dlpShield?.showRawPayload && tokenizedText) {
                    onEvent?.('privacy_payload', {
                        tokenizedPrompt: tokenizedText,
                        provider: modelToUse,
                        source: 'dlp',
                        timestamp: Date.now(),
                    });
                    _assistantTokenisationInfo.tokenizedPrompt = tokenizedText;
                    if (tokenMap && Object.keys(tokenMap).length > 0) {
                        onEvent?.('privacy_token_map', { tokenMap, source: 'dlp' });
                        _assistantTokenisationInfo.tokenMap = tokenMap;
                    }
                }
                dlpStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'redacted' }).catch(() => {});
            } else {
                // 'allow' — user chose to send raw. Still log (compliance audit).
                onEvent?.('dlp_resolved', {
                    appliedChoice: 'allow',
                    redactedCount: 0,
                    provider: dlpResult.provider,
                    categories: Object.keys(dlpResult.summary || {}),
                    automatic: false,
                    decisionMs: Date.now() - scanStart,
                });
                dlpStore.logDlpDecision({ ...auditBase, violation_categories: categoryList, action_taken: 'allowed' }).catch(() => {});
            }
        } else if (dlpResult.scanStatus === 'failed') {
            // fail-open took this path — still record for audit.
            dlpStore.logDlpDecision({ ...auditBase, violation_categories: 'scan_failed', action_taken: 'scan_failed' }).catch(() => {});
        }
    }

    // ── DLP un-tokeniser (wraps onEvent for the rest of the turn) ──
    // If the conversation has any redacted tokens (from this turn or an earlier
    // one), transparently replace them with the real values in every `content`
    // chunk before it hits the client. Any other event is forwarded unchanged.
    //
    // When the org enables `showRawPayload`, we also accumulate the *raw*
    // (pre-un-tokenise) response text so we can emit `privacy_response_raw` at
    // the end of the turn. That lets the "How I got this answer" panel show the
    // exact string the LLM produced.
    let _rawResponseBuffer = '';
    const _captureRaw = !!dlpShield?.showRawPayload;
    const RAW_BUFFER_MAX = 64 * 1024; // cap at 64 KB per turn, then truncate.
    {
        const _dlpConvMap = require('../dlp/dlpRunner').getConversationTokenMap(conversation?.id);
        if (_dlpConvMap && Object.keys(_dlpConvMap).length > 0) {
            const { createUntokeniser } = require('../dlp/untokeniseStream');
            const _ut = createUntokeniser(_dlpConvMap);
            const _rawOnEvent = onEvent;
            onEvent = (type, data) => {
                if (type === 'content' && data && typeof data.text === 'string') {
                    if (_captureRaw && _rawResponseBuffer.length < RAW_BUFFER_MAX) {
                        _rawResponseBuffer += data.text;
                        if (_rawResponseBuffer.length > RAW_BUFFER_MAX) {
                            _rawResponseBuffer = _rawResponseBuffer.slice(0, RAW_BUFFER_MAX) + '…';
                        }
                    }
                    const safe = _ut.push(data.text);
                    if (safe) _rawOnEvent(type, { ...data, text: safe });
                    return;
                }
                // On any non-content event (tool-call, thinking, done-ish), flush
                // whatever is buffered so we never leave a partial token dangling.
                const tail = _ut.flush();
                if (tail) _rawOnEvent('content', { text: tail });
                _rawOnEvent(type, data);
            };
        } else if (_captureRaw) {
            // No token map (no redaction happened) — we still want to capture the
            // raw response so the admin / user can inspect "what the AI said"
            // even when tokenisation didn't fire this turn. Minimal wrapper.
            const _rawOnEvent = onEvent;
            onEvent = (type, data) => {
                if (type === 'content' && data && typeof data.text === 'string') {
                    if (_rawResponseBuffer.length < RAW_BUFFER_MAX) {
                        _rawResponseBuffer += data.text;
                        if (_rawResponseBuffer.length > RAW_BUFFER_MAX) {
                            _rawResponseBuffer = _rawResponseBuffer.slice(0, RAW_BUFFER_MAX) + '…';
                        }
                    }
                }
                _rawOnEvent(type, data);
            };
        }
    }

    // KB source references accumulator (declared early because performKnowledgeSearch emits before the main loop)
    let _kbSources = [];
    // Chunk identities already sent to the LLM/UI this turn. When the agent
    // runs multiple kb_search calls with overlapping results, dedup here
    // prevents the same chunk from being re-serialized into the tool message
    // (tokens) and re-emitted to the UI (visual noise).
    const _seenChunkIds = new Set();

    // ============ PROJECT CONTEXT ============
    // Mirrors directChat.js project handling: inject the project's custom
    // instructions and auto-search its knowledge bases. Skipped for embed-enabled
    // agents — same privacy guard used for memory injection.
    if (validProject && !agent.embed_enabled) {
        if (validProject.customInstructions && validProject.customInstructions.trim()) {
            systemPrompt += `\n\n[PROJECT INSTRUCTIONS — "${validProject.name}"]\n${validProject.customInstructions}`;
        }
        const kbIds = validProject.knowledgeBaseIds || [];
        if (kbIds.length > 0) {
            try {
                const { quickKBSearch } = require('./knowledgeSearch');
                const kbResults = await quickKBSearch(userId, kbIds, userMessage, { topK: 6 });
                if (kbResults.length > 0) {
                    const kbText = kbResults.map((c, i) => {
                        const src = c.source_uri || c.title || 'KB';
                        return `### Source ${i + 1}: ${src}\n${c.content}`;
                    }).join('\n\n');
                    systemPrompt += `\n\n[PROJECT KNOWLEDGE BASE — "${validProject.name}"]\nRelevant information from this project's knowledge base:\n${kbText}`;
                    _kbSources.push(...kbResults.map(c => ({
                        document_id: c.document_id, kb_id: c.kb_id,
                        title: c.title, source_uri: c.source_uri,
                        score: c.score, snippet: (c.content || '').slice(0, 240),
                    })));
                    console.log(`[AgentRuntime] Injected ${kbResults.length} KB chunks from project "${validProject.name}"`);
                }
            } catch (kbErr) {
                console.warn('[AgentRuntime] Project KB search failed:', kbErr.message);
            }
        }
    }

    // ============ VECTOR KNOWLEDGE BASE ============
    // When the kb_search TOOL is available, skip auto-injection — let the LLM
    // decide when and what to search.  This avoids double-searching (once here,
    // once via the tool) and gives the LLM control over query formulation.
    const hasKbSearchTool = tools.some(t => t.function?.name === 'kb_search');

    if (!moderationViolation && !guardrailViolation && !hasKbSearchTool) {
        try {
            const kbExtension = await performKnowledgeSearch({ agent, userId, userMessage, isStrictKnowledge, onEvent: (type, data) => {
                // Intercept kb_sources to accumulate for persistence
                if (type === 'kb_sources' && data?.sources) {
                    _kbSources.push(...data.sources);
                }
                onEvent(type, data);
            } });
            if (kbExtension) {
                systemPrompt += kbExtension;
            }
        } catch (kErr) {
            console.error('[AgentRuntime] Knowledge retrieval failed:', kErr.message);
        }
    } else if (hasKbSearchTool) {
        console.log('[AgentRuntime] KB auto-inject skipped — kb_search tool available, LLM will decide');
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

    let iterations = 0;
    const maxIterations = 10;
    let toolCalls = [];
    let fullResponse = '';
    let _emailDrafts = [];
    let _calendarDrafts = [];
    let _linkedInDrafts = [];
    let _mapEmbeds = [];
    let _audioFiles = [];
    let _toolHistory = []; // Track tool calls for persistence
    let _thinking = '';    // Accumulate model reasoning for persistence (legacy string form)
    let _thinkingParts = []; // Structured thinking parts — carry signature (Claude) + timing for UI
    // Helper: look up / create a thinking part by provider-supplied partId.
    const _getThinkingPart = (partId) => {
        if (!partId) return null;
        let part = _thinkingParts.find(p => p.id === partId);
        if (!part) {
            part = { id: partId, text: '', startedAt: Date.now(), endedAt: null };
            _thinkingParts.push(part);
        }
        return part;
    };

    // Abort signal from the route handler (client disconnect)
    const signal = messageMetadata.signal || null;

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
                await processAttachments(messageMetadata.attachments, lastMsg, userId, { modelId: modelToUse });
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

            // PII tokens: tell the LLM to preserve & reuse them rather than invent new placeholders.
            // Reads the conversation-scoped accumulator so prior turns' tokens still apply.
            const _convTokenMap = require('../dlp/dlpRunner').getConversationTokenMap(conversation?.id);
            const _tokenAddendum = buildTokenPreservationAddendum(_convTokenMap);
            if (_tokenAddendum) effectiveSystemPrompt += _tokenAddendum;

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
                const { getTierConfig } = require('../modelResolver');
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
                const { TIER_DEFAULTS } = require('../modelResolver');
                const tierName = (agent.model && agent.model.startsWith('tier:')) ? agent.model.substring(5) : 'fast';
                const tierDefaults = TIER_DEFAULTS[tierName] || TIER_DEFAULTS['fast'];
                const defaultMaxTokens = isThinkingModel ? 40960 : tierDefaults.maxTokens;
                const adapterOptions = {
                    maxTokens: tierSettings.maxTokens || defaultMaxTokens,
                    temperature: tierSettings.temperature !== undefined ? tierSettings.temperature : tierDefaults.temperature,
                    budgetTokens: tierSettings.budgetTokens || undefined,
                    // messageMetadata.reasoningEffort is the per-turn user choice from the composer.
                    // It overrides tier defaults when present.
                    reasoningEffort: messageMetadata?.reasoningEffort || tierSettings.reasoningEffort || tierDefaults.reasoningEffort || undefined,
                    reasoningSummary: tierSettings.reasoningSummary !== undefined ? tierSettings.reasoningSummary : (tierDefaults.reasoningSummary || false),
                    // Azure-specific: needed for Responses API version check
                    apiVersion: config.apiVersion || undefined,
                };


                if (tools.length > 0) {
                    // Strip internal metadata (_mcp, _n8n etc.) before sending to LLM — providers may reject unknown fields.
                    // Sort by tool name so the JSON prefix is byte-stable across turns — required for
                    // OpenAI/Azure automatic prefix caching (≥1024-token stable prefix).
                    adapterOptions.tools = tools
                        .map(t => {
                            const { _mcp, _n8n, ...clean } = t;
                            return clean;
                        })
                        .sort((a, b) => {
                            const an = a.function?.name || a.name || '';
                            const bn = b.function?.name || b.name || '';
                            return an.localeCompare(bn);
                        });
                    adapterOptions.toolChoice = 'auto';
                }
                // Stable end-user identifier — OpenAI uses it as a cache-routing hint
                // and for abuse monitoring. Safe to pass the raw userId (opaque string).
                if (userId) adapterOptions.userId = userId;
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

                            onEvent('content', { text: textChunk });
                        } else if (type === 'thinking_start') {
                            if (data.partId) {
                                const part = _getThinkingPart(data.partId);
                                if (data.redacted) part.redacted = true;
                                onEvent('thinking_start', { partId: data.partId, redacted: data.redacted || undefined });
                            }
                        } else if (type === 'thinking') {
                            // Route into the right thinking part if provider supplied partId;
                            // otherwise append to the most recent part (or open an implicit one).
                            if (data.partId) {
                                const part = _getThinkingPart(data.partId);
                                part.text += data.text;
                            } else {
                                let part = _thinkingParts[_thinkingParts.length - 1];
                                if (!part || part.endedAt) {
                                    part = { id: `auto-${_thinkingParts.length}`, text: '', startedAt: Date.now(), endedAt: null };
                                    _thinkingParts.push(part);
                                }
                                part.text += data.text;
                            }
                            onEvent('thinking', { text: data.text, partId: data.partId });
                            _thinking += data.text;
                        } else if (type === 'thinking_signature') {
                            // Server-side only — persist onto the matching part so Claude multi-turn
                            // tool flows replay with signature intact. Never forwarded to SSE.
                            if (data.partId && data.signature) {
                                const part = _getThinkingPart(data.partId);
                                part.signature = data.signature;
                            }
                        } else if (type === 'thinking_stop') {
                            if (data.partId) {
                                const part = _getThinkingPart(data.partId);
                                part.endedAt = Date.now();
                                if (data.redacted) part.redacted = true;
                                onEvent('thinking_stop', { partId: data.partId, redacted: data.redacted || undefined });
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
                        agent_type: 'chat',
                        model: modelToUse,
                        prompt_tokens: _adapterStreamUsage?.prompt_tokens || 0,
                        completion_tokens: _adapterStreamUsage?.completion_tokens || 0,
                        total_tokens: _adapterStreamUsage?.total_tokens || 0,
                        cached_tokens: _adapterStreamUsage?.cached_tokens || 0,
                        cache_creation_tokens: _adapterStreamUsage?.cache_creation_tokens || 0,
                        reasoning_tokens: _adapterStreamUsage?.reasoning_tokens || 0,
                        cache_ttl: _adapterStreamUsage?.cache_ttl || null,
                        stop_reason: _adapterStreamUsage?.stop_reason || null,
                        parent_call_id: messageMetadata.parentCallId || null,
                        source: 'agent_stream',
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
                // Buffer the latest usage frame and finish_reason; log once after the stream ends.
                // Logging inside the loop caused duplicate rows whenever a server emitted more
                // than one usage frame (and was racy with the inner async path).
                let _sseStreamUsage = null;
                let _sseFinishReason = null;


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

                                // Buffer the latest usage frame — log once after stream completes.
                                if (parsed.usage) {
                                    _sseStreamUsage = parsed.usage;
                                }
                                const fr = parsed.choices?.[0]?.finish_reason;
                                if (fr) _sseFinishReason = fr;

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
                                                    onEvent('thinking', { text: thinkText });
                                                    _thinking += thinkText;
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
                                        onEvent('content', { text: textChunk });
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

                // Log usage once after the SSE stream finishes. Buffering inside
                // the loop and writing here avoids duplicate rows when servers
                // emit multiple usage frames or when [DONE] races the last frame.
                if (_sseStreamUsage) {
                    try {
                        await usageStore.logUsage({
                            user_id: userId,
                            agent_id: agentId,
                            agent_name: agent.name,
                            agent_type: 'chat',
                            model: modelToUse,
                            prompt_tokens: _sseStreamUsage.prompt_tokens || 0,
                            completion_tokens: _sseStreamUsage.completion_tokens || 0,
                            total_tokens: _sseStreamUsage.total_tokens || 0,
                            cached_tokens: _sseStreamUsage.prompt_tokens_details?.cached_tokens || _sseStreamUsage.cached_tokens || 0,
                            cache_creation_tokens: _sseStreamUsage.cache_creation_input_tokens || 0,
                            reasoning_tokens: _sseStreamUsage.completion_tokens_details?.reasoning_tokens || 0,
                            stop_reason: _sseFinishReason,
                            parent_call_id: messageMetadata.parentCallId || null,
                            source: 'agent_stream',
                            duration_ms: Date.now() - _streamCallStart,
                            organization_id: agent.organization_id || null,
                            conversation_id: conversation?.id || null
                        });
                    } catch (e) { /* ignore usage errors */ }
                }
            } // end else (raw fetch SSE)

            // Check if we have tool calls to execute
            if (currentToolCalls.length > 0 && currentToolCalls[0]?.function?.name) {
                // Clear intermediate planning text from the UI — only the final response
                // (from the last iteration without tool calls) should be visible to the user
                if (contentBuffer) {
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

                // Check abort before tool execution
                if (signal?.aborted) {
                    console.log('[AgentRuntime] Aborting before tool execution — client disconnected');
                    break;
                }

                // Execute all tools in parallel
                const toolExecutionPromises = currentToolCalls.map(async (toolCall) => {
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
                            guardrailEventStore.logGuardrailEvent({
                                organization_id: agent.organization_id || null,
                                user_id: userId,
                                agent_id: agentId,
                                agent_name: agent.name,
                                conversation_id: conversation?.id || null,
                                violation_type: 'moderation',
                                violation_categories: 'Web Search Guard',
                                direction: 'input',
                                action_taken: 'search_blocked',
                                source: 'agent_stream',
                                model: modelToUse,
                            }).catch(() => {});
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

                    // Web Search Guard — PII detection on search queries (always runs for monitoring)
                    if (webSearchGuardPiiCategories && toolName === 'agent_search' && toolArgs?.query) {
                        try {
                            const { detectPii } = require('../azurePiiDetection');
                            const piiResult = await detectPii(toolArgs.query, webSearchGuardPiiCategories);
                            if (piiResult?.hasPii) {
                                const cats = [...new Set(piiResult.entities.map(e => e.label))].join(', ');
                                // Always log PII detection for monitoring
                                guardrailEventStore.logGuardrailEvent({
                                    organization_id: agent.organization_id || null,
                                    user_id: userId,
                                    agent_id: agentId,
                                    agent_name: agent.name,
                                    conversation_id: conversation?.id || null,
                                    violation_type: 'pii',
                                    violation_categories: cats,
                                    direction: 'input',
                                    action_taken: webSearchGuardEnabled ? 'search_blocked' : 'pii_detected',
                                    source: 'agent_stream',
                                    model: modelToUse,
                                }).catch(() => {});
                                // Only block when Web Search Guard is enabled
                                if (webSearchGuardEnabled) {
                                    console.log(`[WebSearchGuard] Search query BLOCKED by PII (${cats}): "${toolArgs.query.substring(0, 80)}"`);
                                    onEvent('tool_end', { name: toolName, result: `[Web search blocked — query contains sensitive information (${cats})]` });
                                    return {
                                        toolCall,
                                        toolName,
                                        toolArgs,
                                        finalToolResult: `[Web search blocked — the search query contains sensitive personal information (${cats}). Please rephrase without including PII.]`,
                                        blocked: true
                                    };
                                } else {
                                    console.log(`[WebSearchGuard] PII detected in search query (${cats}): "${toolArgs.query.substring(0, 80)}" — monitoring only, search allowed`);
                                }
                            }
                            console.log(`[WebSearchGuard] Search query PII check passed`);
                        } catch (piiErr) {
                            console.warn(`[WebSearchGuard] PII check failed (fail-open):`, piiErr.message);
                        }
                    }

                    // Use unified tool dispatcher — supports integrations + components
                    const { executeTool: dispatchTool } = require('../toolDispatcher');
                    let toolResult = await dispatchTool(toolName, toolArgs, {
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

                // Process results in order
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

                    // Emit kb_sources SSE event so frontend shows knowledge base sources.
                    // Turn-local dedup: if a chunk_id has already been seen in a prior
                    // kb_search this turn, drop it from every surface (UI, persistence,
                    // AND the tool response the LLM will see).
                    if (finalToolResult?._action === 'kb_sources' && finalToolResult._sources?.length > 0) {
                        const keepIdx = [];
                        const resultsArr = Array.isArray(finalToolResult.results) ? finalToolResult.results : [];
                        finalToolResult._sources.forEach((src, i) => {
                            const id = resultsArr[i]?.chunk_id
                                || (src.title || '') + '::' + (src.section || '') + '::' + (src.content || '').slice(0, 80);
                            if (!_seenChunkIds.has(id)) {
                                _seenChunkIds.add(id);
                                keepIdx.push(i);
                            }
                        });
                        const filteredSources = keepIdx.map(i => finalToolResult._sources[i]);
                        const filteredResults = keepIdx.map(i => resultsArr[i]).filter(Boolean);
                        const dropped = finalToolResult._sources.length - filteredSources.length;
                        if (dropped > 0) {
                            console.log(`[KBSearch] Turn-local dedup: dropped ${dropped} already-seen chunk(s) from kb_search result`);
                        }
                        // Mutate so downstream LLM serialization (buildLLMToolContent) sees the trimmed set.
                        finalToolResult._sources = filteredSources;
                        finalToolResult.results = filteredResults;
                        if (filteredSources.length > 0) {
                            onEvent('kb_sources', { sources: filteredSources });
                            _kbSources.push(...filteredSources);
                        }
                    }

                    // Track audio files for persistence (sent via SSE by the tool)
                    if (finalToolResult?.audioUrl) {
                        _audioFiles.push({ url: finalToolResult.audioUrl, source: toolName });
                    }

                    // Log tool invocation for the per-tool dashboard. These rows
                    // intentionally carry zero token counts — tool execution
                    // doesn't consume model tokens. Cost-bearing queries
                    // (summary, by-model, by-source) filter `tool_name IS NULL`
                    // so these rows don't inflate call count or distort cost.
                    try {
                        await usageStore.logUsage({
                            user_id: userId,
                            agent_id: agentId,
                            agent_name: agent.name,
                            agent_type: 'chat',
                            model: modelToUse,
                            tool_name: toolName,
                            source: 'agent_chat',
                            organization_id: agent.organization_id || null,
                            conversation_id: conversation?.id || null,
                            parent_call_id: messageMetadata.parentCallId || null,
                        });
                    } catch (e) { /* ignore */ }

                    // ── Integration Activity Logging (async, non-blocking) ──
                    try {
                        const integMeta = resolveIntegration(toolName, toolArgs || {});
                        if (integMeta) {
                            const resultText = typeof finalToolResult === 'string' ? finalToolResult : JSON.stringify(finalToolResult || '');
                            // Fire-and-forget: check shield config, scan PII, log
                            const shieldKey = `org_privacy_shield_${agent.organization_id}`;
                            configStore.getConfig(shieldKey).then(async shield => {
                                if (!shield?.monitorIntegrations) return;
                                // PII scan: use Azure/CPU model with ALL categories, respect org confidence threshold
                                let piiDetected = null;
                                try {
                                    const { detectPii } = require('../azurePiiDetection');
                                    const threshold = typeof shield.piiDetectionConfidenceThreshold === 'number'
                                        ? shield.piiDetectionConfidenceThreshold : 0.7;
                                    const piiResult = await detectPii(resultText.slice(0, 5000), null, threshold);
                                    if (piiResult?.hasPii) {
                                        piiDetected = [...new Set(piiResult.entities.map(e => e.label))].join(', ');
                                    }
                                } catch (piiErr) { /* fail-open: log without PII data */ }
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
                                    pii_categories_detected: piiDetected || null,
                                    pii_scan_enabled: true,
                                    source: 'agent_stream',
                                    model: modelToUse,
                                }).catch(e => console.error('[IntegrationActivityLog] Error:', e.message));
                            }).catch(() => {});
                        }
                    } catch (e) { /* ignore integration logging errors */ }

                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: buildLLMToolContent(finalToolResult),
                    });
                }

                // Save conversation after tool execution (so tool calls are persisted)
                console.log('[AgentStream] Saving conversation with tool calls:', JSON.stringify(messages.slice(-3), null, 2));
                await agentStore.updateConversation(conversation.id, messages, userAuth.encryptionKey, userAuth.userId);
                continue;
            }

            fullResponse = contentBuffer;

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
                                source: 'agent_stream',
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
            if (_kbSources.length > 0) assistantMsg.kbSources = _kbSources;
            // Persistence format: `thinkingParts` is the structured array (with signatures
            // for Claude replay); `thinking` stays as the flat string for backwards compat
            // with memory extraction and anything reading the old shape.
            if (_thinkingParts.length > 0) {
                assistantMsg.thinking = _thinkingParts.map(p => ({
                    id: p.id,
                    text: p.text,
                    startedAt: p.startedAt,
                    endedAt: p.endedAt || Date.now(),
                    redacted: p.redacted || undefined,
                    signature: p.signature || undefined,
                    phase: p.phase || undefined,
                }));
            } else if (_thinking) {
                // Legacy path: flat-string thinking without part metadata.
                assistantMsg.thinking = _thinking;
            }

            // Privacy / DLP — persist redaction metadata so the badge + "How I got
            // this answer" panel survive a refresh. Raw response is captured live
            // into _rawResponseBuffer above; copy it here before persistence.
            if (_assistantTokenisationInfo) {
                if (_captureRaw && _rawResponseBuffer) {
                    _assistantTokenisationInfo.rawResponse = _rawResponseBuffer;
                    _assistantTokenisationInfo.rawTruncated = _rawResponseBuffer.endsWith('…');
                }
                assistantMsg.tokenisationInfo = _assistantTokenisationInfo;
            }
            if (_userPrivacyMeta) {
                for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i]?.role === 'user') {
                        Object.assign(messages[i], _userPrivacyMeta);
                        break;
                    }
                }
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

        // Transparency: emit the accumulated raw (pre-un-tokenise) LLM
        // response once per turn, gated by the org's `showRawPayload` toggle.
        if (_captureRaw && _rawResponseBuffer) {
            onEvent?.('privacy_response_raw', {
                rawResponse: _rawResponseBuffer,
                truncated: _rawResponseBuffer.endsWith('…'),
                timestamp: Date.now(),
            });
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
