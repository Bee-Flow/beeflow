/**
 * Tool Dispatcher — Unified tool execution registry
 * 
 * All integration tools (Gmail, Calendar, Sheets, Docs, Drive, Slides,
 * Fireflies, YouTrack, Gamma, N8N, Agent Search, Image Gen, Video Gen,
 * ElevenLabs, Terminal, Regex Generator)
 * and component tools register here. Both directChat and agentRuntime use
 * `executeTool()` instead of maintaining separate if/else chains.
 */

const { executeComponentTool } = require('./toolExecution');
const configStore = require('../stores/configStore');

// ─── Integration imports ────────────────────────────────────────
const { isGmailTool, executeGmailTool } = require('../integrations/gmailTools');
const { isCalendarTool, executeCalendarTool } = require('../integrations/calendarTools');
const { isDriveTool, executeDriveTool } = require('../integrations/driveTools');
const { isDocsTool, executeDocsTool } = require('../integrations/docsTools');
const { isContactsTool, executeContactsTool } = require('../integrations/contactsTools');
const { isKeepTool, executeKeepTool } = require('../integrations/keepTools');
const { isGoogleGroupsTool, executeGoogleGroupsTool } = require('../integrations/googleGroupsTools');
const { isFirefliesTool, executeFirefliesTool } = require('../integrations/firefliesTools');
const { isYouTrackTool, executeYouTrackTool } = require('../integrations/youtrackTools');
const { isSignRequestTool, executeSignRequestTool } = require('../integrations/signrequestTools');
const { isGammaTool, executeGammaTool } = require('../integrations/gammaTools');
const { isN8nTool, executeN8nTool } = require('../integrations/n8nTools');
const { isN8nWorkflowTool, executeN8nWorkflowTool, getN8nToolPermission } = require('../integrations/n8nWorkflowTools');
const { hasPermission } = require('../auth/permissions');
const { isAgentSearchTool, executeAgentSearchTool } = require('../integrations/agentSearchTools');
const { isRegexGeneratorTool, executeRegexGeneratorTool } = require('../integrations/regexGeneratorTools');
const { executeWorkspaceTool } = require('../integrations/workspaceTools');
const { isKbSearchTool, executeKbSearchTool } = require('../integrations/kbSearchTools');
const { isMapsTool, executeMapsTool } = require('../integrations/mapsTools');
const { isLinkedInTool, executeLinkedInTool } = require('../integrations/linkedinTools');
const { isWhatsAppTool, executeWhatsAppTool } = require('../integrations/whatsappTools');
const { isGitHubTool, executeGitHubTool } = require('../integrations/githubTools');
const { isOutlookTool, executeOutlookTool } = require('../integrations/outlookTools');
const { isMsCalendarTool, executeMsCalendarTool } = require('../integrations/msCalendarTools');
const { isOneDriveTool, executeOneDriveTool } = require('../integrations/oneDriveTools');
const { isMsContactsTool, executeMsContactsTool } = require('../integrations/msContactsTools');
const { isTranscriptionTool, executeTranscriptionTool } = require('../integrations/transcriptionTools');

/**
 * Execute a tool by name.
 * 
 * @param {string} toolName - Name of the tool to execute
 * @param {Object} toolArgs - Arguments for the tool
 * @param {Object} context  - Execution context:
 *   @param {string}  context.userId       - Current user ID
 *   @param {Object}  context.session      - Express session (for OAuth tokens)
 *   @param {Object}  context.userAuth     - User auth info (encryptionKey, etc.)
 *   @param {Object}  context.fixedParams  - Pre-configured params for this tool (tier overrides etc)
 *   @param {string}  context.agentId      - Agent ID (or null for direct chat)
 *   @param {string}  context.orgId        - Organization ID for n8n/org-scoped tools
 *   @param {Function} context.send        - SSE send helper (for image gen streaming)
 *   @param {Object}  context.imageGenSettings - Image generation settings
 *   @param {Object}  context.req          - Express request (for image gen API access)
 *   @param {Array}   context.attachments  - File attachments (for n8n)
 *   @param {Function} context.onImageGenerated - Callback when image is generated
 *   @param {Object}  context.terminalCtx  - Terminal tool context (containerKey, etc.)
 * @returns {*} Tool result
 */
async function executeTool(toolName, toolArgs, context = {}) {
    // Guard: some providers return tool_calls without a valid function name
    if (!toolName) {
        console.warn('[ToolDispatcher] Skipping tool with undefined name');
        return { error: 'Tool call had no function name — skipped.' };
    }

    const {
        userId,
        session,
        userAuth,
        fixedParams,
        agentId,
        orgId,
        send,
        imageGenSettings,
        nanoBananaSettings,
        req,
        attachments,
        onImageGenerated,
        terminalCtx,
    } = context;

    // ─── Media Gen Prompt Moderation ────────────────────────────
    // Validate prompts for all media generation tools before dispatch
    const MEDIA_GEN_TOOLS = ['generate_image', 'generate_video', 'generate_music', 'generate_song', 'generate_tts', 'generate_sfx'];
    if (MEDIA_GEN_TOOLS.includes(toolName) && (toolArgs?.prompt || toolArgs?.text)) {
        try {
            const { validateWithLlamaGuard } = require('./moderation');
            const promptText = toolArgs.prompt || toolArgs.text;
            await validateWithLlamaGuard([{ role: 'user', content: promptText }], true);
            console.log(`[ToolDispatcher] Media gen prompt passed moderation (${toolName})`);
        } catch (guardErr) {
            if (guardErr.message?.includes('Safety Violation')) {
                console.warn(`[ToolDispatcher] Media gen prompt BLOCKED (${toolName}): ${guardErr.message}`);
                return { error: `Content blocked — the prompt for ${toolName} was flagged by content safety. Please rephrase.` };
            }
            // Guard service unavailable — fail-open (already logged by moderation.js)
        }
    }

    // ─── Terminal Tools (removed — module no longer exists) ────
    // Terminal container system has been removed from the platform

    // ─── Image Generation ───────────────────────────────────────
    if (toolName === 'generate_image') {
        // Lazy import to avoid circular deps
        const { executeImageGenTool } = require('../routes/ai/imageGenTool');
        let capturedImageData = null;
        const imgSend = (type, data) => {
            if (type === 'image' && data?.data) {
                capturedImageData = data;
            }
            if (send) send(type, data);
        };
        const result = await executeImageGenTool(toolArgs, imageGenSettings, imgSend, req);
        // Enrich captured image data with proxy URL for persistent storage
        if (capturedImageData && onImageGenerated) {
            if (result?.imageUrl) capturedImageData.url = result.imageUrl;
            onImageGenerated(capturedImageData);
        }
        return result;
    }

    // ─── Video Generation ───────────────────────────────────────
    if (toolName === 'generate_video') {
        const { executeVideoGenTool } = require('../routes/ai/videoGenTool');
        const videoSend = (type, data) => {
            if (send) send(type, data);
        };
        return await executeVideoGenTool(toolArgs, videoSend, req, nanoBananaSettings);
    }

    // ─── ElevenLabs Tools (Music, TTS, SFX) ─────────────────────
    const { isElevenLabsTool, executeElevenLabsTool } = require('../routes/ai/elevenLabsTools');
    if (isElevenLabsTool(toolName)) {
        const elSend = (type, data) => {
            if (send) send(type, data);
        };
        return await executeElevenLabsTool(toolName, toolArgs, elSend, req, nanoBananaSettings);
    }

    // ─── Integration Tools ──────────────────────────────────────
    if (isFirefliesTool(toolName)) {
        return await executeFirefliesTool(toolName, toolArgs, userId);
    }
    if (isRegexGeneratorTool(toolName)) {
        return await executeRegexGeneratorTool(toolName, toolArgs);
    }
    if (isYouTrackTool(toolName)) {
        return await executeYouTrackTool(toolName, toolArgs, userId);
    }
    if (isSignRequestTool(toolName)) {
        return await executeSignRequestTool(toolName, toolArgs, userId);
    }
    if (isGammaTool(toolName)) {
        return await executeGammaTool(toolName, toolArgs, userId);
    }
    if (isGmailTool(toolName)) {
        return await executeGmailTool(toolName, toolArgs, session);
    }
    if (isCalendarTool(toolName)) {
        return await executeCalendarTool(toolName, toolArgs, session);
    }
    if (isDocsTool(toolName)) {
        return await executeDocsTool(toolName, toolArgs, session);
    }
    if (isDriveTool(toolName)) {
        return await executeDriveTool(toolName, toolArgs, session);
    }
    if (isContactsTool(toolName)) {
        return await executeContactsTool(toolName, toolArgs, session);
    }
    if (isKeepTool(toolName)) {
        return await executeKeepTool(toolName, toolArgs, session);
    }
    if (isGoogleGroupsTool(toolName)) {
        return await executeGoogleGroupsTool(toolName, toolArgs, session);
    }
    if (isN8nWorkflowTool(toolName)) {
        // Authoritative permission gate (defense-in-depth vs. the registration-time filter).
        // Non-LLM callers (pipelines, schedules) also flow through here, so we must re-check.
        if (userId) {
            const requiredPerm = getN8nToolPermission(toolName);
            const granted = await hasPermission(userId, requiredPerm, session);
            if (!granted) {
                const friendly = requiredPerm === 'modify_n8n_workflows'
                    ? 'You do not have permission to modify n8n workflows. Ask your organisation admin to grant the "Modify n8n Workflows" permission.'
                    : 'You do not have permission to use n8n tools. Ask your organisation admin to grant the "Use n8n Tools" permission.';
                return { error: friendly };
            }
        }
        return await executeN8nWorkflowTool(toolName, toolArgs, orgId);
    }
    if (isN8nTool(toolName)) {
        // Webhook-trigger tools require the base 'use_n8n_tools' permission.
        if (userId) {
            const granted = await hasPermission(userId, 'use_n8n_tools', session);
            if (!granted) {
                return { error: 'You do not have permission to run n8n workflows. Ask your organisation admin to grant the "Use n8n Tools" permission.' };
            }
        }
        return await executeN8nTool(toolName, toolArgs, orgId, attachments);
    }
    if (isAgentSearchTool(toolName)) {
        // Check if admin configured Bing as the search provider
        // Wrapped in try-catch to survive transient PostgreSQL DNS failures (EAI_AGAIN)
        try {
            const searchProvider = await configStore.getConfig('search_provider');
            if (searchProvider === 'bing') {
                const { executeBingSearchTool } = require('../integrations/bingSearchTools');
                return await executeBingSearchTool(toolName, toolArgs);
            }
        } catch (cfgErr) {
            console.warn(`[ToolDispatcher] Config lookup failed (search_provider), using default: ${cfgErr.message}`);
        }
        return await executeAgentSearchTool(toolName, toolArgs);
    }

    // ─── Reminder Tool ──────────────────────────────────────────
    if (toolName === 'set_reminder') {
        const reminderStore = require('../stores/reminderStore');
        if (!userId) return { error: 'Not authenticated' };
        if (!toolArgs.title) return { error: 'Title is required' };
        if (!toolArgs.remind_at) return { error: 'remind_at is required' };
        try {
            const reminder = await reminderStore.createReminder({
                userId,
                title: toolArgs.title,
                message: toolArgs.message || '',
                remindAt: toolArgs.remind_at,
                repeatInterval: toolArgs.repeat_interval || null,
            });
            return { success: true, reminder_id: reminder.id, title: reminder.title, remind_at: reminder.remindAt, repeat_interval: reminder.repeatInterval || 'none' };
        } catch (err) {
            return { error: `Failed to create reminder: ${err.message}` };
        }
    }

    // ─── AI Task Tool ───────────────────────────────────────────
    if (toolName === 'set_ai_task') {
        const aiTaskStore = require('../stores/aiTaskStore');
        if (!userId) return { error: 'Not authenticated' };
        if (!toolArgs.title) return { error: 'Title is required' };
        if (!toolArgs.prompt) return { error: 'Prompt is required' };
        if (!toolArgs.first_run_at) return { error: 'first_run_at is required' };
        try {
            // Check task limit
            const maxTasks = (await configStore.getConfig('ai_tasks_max_per_user')) || 10;
            const currentCount = await aiTaskStore.getTaskCount(userId);
            if (currentCount >= maxTasks) {
                return { error: `Maximum number of AI tasks reached (${maxTasks}). The user needs to delete or deactivate existing tasks first.` };
            }
            const task = await aiTaskStore.createTask({
                userId,
                title: toolArgs.title,
                prompt: toolArgs.prompt,
                repeatInterval: toolArgs.repeat_interval || null,
                nextRunAt: toolArgs.first_run_at,
                modelTier: toolArgs.model_tier || 'fast',
                timezone: context?.timezone || 'UTC',
            });
            return {
                success: true,
                task_id: task.id,
                title: task.title,
                next_run: task.nextRunAt,
                repeat: task.repeatInterval || 'one-time',
                model_tier: task.modelTier,
            };
        } catch (err) {
            return { error: `Failed to create AI task: ${err.message}` };
        }
    }

    // ─── Notebook Tools (formerly Workspace) ──────────────────────
    if (toolName === 'notebook_read' || toolName === 'notebook_write' || toolName === 'notebook_replace' || toolName === 'notebook_insert' ||
        toolName === 'workspace_read' || toolName === 'workspace_write' || toolName === 'workspace_replace') {
        return await executeWorkspaceTool(toolName, toolArgs, {
            conversationId: context.conversationId,
            agentId: context.agentId,
        });
    }

    // ─── KB Search Tool ─────────────────────────────────────────
    if (isKbSearchTool(toolName)) {
        return await executeKbSearchTool(toolName, toolArgs, {
            userId,
            agentId,
            conversationId: context.conversationId,
        });
    }

    // ─── Maps Tools ─────────────────────────────────────────────
    if (isMapsTool(toolName)) {
        return await executeMapsTool(toolName, toolArgs);
    }
    if (isLinkedInTool(toolName)) {
        return await executeLinkedInTool(toolName, toolArgs, session);
    }
    if (isWhatsAppTool(toolName)) {
        return await executeWhatsAppTool(toolName, toolArgs, { userId, session });
    }
    if (isGitHubTool(toolName)) {
        return await executeGitHubTool(toolName, toolArgs, userId);
    }
    if (isOutlookTool(toolName)) {
        return await executeOutlookTool(toolName, toolArgs, session);
    }
    if (isMsCalendarTool(toolName)) {
        return await executeMsCalendarTool(toolName, toolArgs, session);
    }
    if (isOneDriveTool(toolName)) {
        return await executeOneDriveTool(toolName, toolArgs, session);
    }
    if (isMsContactsTool(toolName)) {
        return await executeMsContactsTool(toolName, toolArgs, session);
    }
    if (isTranscriptionTool(toolName)) {
        return await executeTranscriptionTool(toolName, toolArgs, { userId, session, attachments, req });
    }

    // ─── Fallback: Component Tools ──────────────────────────────
    return await executeComponentTool(toolName, toolArgs, userAuth, fixedParams, agentId);
}

module.exports = { executeTool };
