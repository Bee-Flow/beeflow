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

// ─── Integration imports ────────────────────────────────────────
const { isGmailTool, executeGmailTool } = require('../integrations/gmailTools');
const { isCalendarTool, executeCalendarTool } = require('../integrations/calendarTools');
const { isSlidesTool, executeSlidesTool } = require('../integrations/slidesTools');
const { isDriveTool, executeDriveTool } = require('../integrations/driveTools');
const { isSheetsTool, executeSheetsTool } = require('../integrations/sheetsTools');
const { isDocsTool, executeDocsTool } = require('../integrations/docsTools');
const { isContactsTool, executeContactsTool } = require('../integrations/contactsTools');
const { isKeepTool, executeKeepTool } = require('../integrations/keepTools');
const { isFirefliesTool, executeFirefliesTool } = require('../integrations/firefliesTools');
const { isYouTrackTool, executeYouTrackTool } = require('../integrations/youtrackTools');
const { isGammaTool, executeGammaTool } = require('../integrations/gammaTools');
const { isN8nTool, executeN8nTool } = require('../integrations/n8nTools');
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

    // ─── Terminal Tools ─────────────────────────────────────────
    try {
        const { TERMINAL_TOOLS } = require('../terminal/tools');
        const isTerminalTool = TERMINAL_TOOLS.some(t => t.function.name === toolName);
        if (isTerminalTool && terminalCtx) {
            const { executeTool: executeTerminalTool } = require('../terminal/orchestrator');
            return await executeTerminalTool(toolName, toolArgs, terminalCtx);
        }
    } catch (e) { /* terminal tools may not be available */ }

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
    if (isGammaTool(toolName)) {
        return await executeGammaTool(toolName, toolArgs, userId);
    }
    if (isGmailTool(toolName)) {
        return await executeGmailTool(toolName, toolArgs, session);
    }
    if (isCalendarTool(toolName)) {
        return await executeCalendarTool(toolName, toolArgs, session);
    }
    if (isSlidesTool(toolName)) {
        return await executeSlidesTool(toolName, toolArgs, session);
    }
    if (isSheetsTool(toolName)) {
        return await executeSheetsTool(toolName, toolArgs, session);
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
    if (isN8nTool(toolName)) {
        return await executeN8nTool(toolName, toolArgs, orgId, attachments);
    }
    if (isAgentSearchTool(toolName)) {
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

    // ─── Workspace Tools ────────────────────────────────────────
    if (toolName === 'workspace_read' || toolName === 'workspace_write' || toolName === 'workspace_replace') {
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
