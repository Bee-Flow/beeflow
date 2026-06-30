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
const { isSheetsTool, executeSheetsTool } = require('../integrations/sheetsTools');
const { isSlidesTool, executeSlidesTool } = require('../integrations/slidesTools');
const { isContactsTool, executeContactsTool } = require('../integrations/contactsTools');
const { isKeepTool, executeKeepTool } = require('../integrations/keepTools');
const { isGoogleGroupsTool, executeGoogleGroupsTool } = require('../integrations/googleGroupsTools');
const { isFirefliesTool, executeFirefliesTool } = require('../integrations/firefliesTools');
const { isYouTrackTool, executeYouTrackTool } = require('../integrations/youtrackTools');
const { isSignRequestTool, executeSignRequestTool } = require('../integrations/signrequestTools');
const { isGammaTool, executeGammaTool } = require('../integrations/gammaTools');
const { isAfasTool, executeAfasTool } = require('../integrations/afasTools');
const { isNmbrsTool, executeNmbrsTool } = require('../integrations/nmbrsTools');
const { isN8nTool, executeN8nTool } = require('../integrations/n8nTools');
const { isN8nWorkflowTool, executeN8nWorkflowTool, getN8nToolPermission } = require('../integrations/n8nWorkflowTools');
const { hasPermission } = require('../auth/permissions');
const { isAgentSearchTool, executeWebSearch } = require('../integrations/agentSearchTools');
const { isRegexGeneratorTool, executeRegexGeneratorTool } = require('../integrations/regexGeneratorTools');
const { executeWorkspaceTool } = require('../integrations/workspaceTools');
const { isKbSearchTool, executeKbSearchTool } = require('../integrations/kbSearchTools');
const { isKbIngestTool, executeKbIngestTool } = require('../integrations/kbIngestTools');
const { isRechtspraakTool, executeRechtspraakTool } = require('../integrations/rechtspraakTools');
const { isEurlexTool, executeEurlexTool } = require('../integrations/eurlexTools');
const { isKamerstukkenTool, executeKamerstukkenTool } = require('../integrations/kamerstukkenTools');
const { isBekendmakingenTool, executeBekendmakingenTool } = require('../integrations/bekendmakingenTools');
const { isTuchtrechtTool, executeTuchtrechtTool } = require('../integrations/tuchtrechtTools');
const { isMapsTool, executeMapsTool } = require('../integrations/mapsTools');
const { isLinkedInTool, executeLinkedInTool } = require('../integrations/linkedinTools');
const { isGitHubTool, executeGitHubTool } = require('../integrations/githubTools');
const { isOutlookTool, executeOutlookTool } = require('../integrations/outlookTools');
const { isMsCalendarTool, executeMsCalendarTool } = require('../integrations/msCalendarTools');
const { isOneDriveTool, executeOneDriveTool } = require('../integrations/oneDriveTools');
const { isMsContactsTool, executeMsContactsTool } = require('../integrations/msContactsTools');
const { isTranscriptionTool, executeTranscriptionTool } = require('../integrations/transcriptionTools');
const { isNextcloudTool, executeNextcloudTool } = require('../integrations/nextcloudTools');
const { isNextcloudCalendarTool, executeNextcloudCalendarTool } = require('../integrations/nextcloudCalendarTools');
const { isNextcloudContactsTool, executeNextcloudContactsTool } = require('../integrations/nextcloudContactsTools');
const { isNextcloudDeckTool, executeNextcloudDeckTool } = require('../integrations/nextcloudDeckTools');
const { isNextcloudNotificationsTool, executeNextcloudNotificationsTool } = require('../integrations/nextcloudNotificationsTools');
const { isNextcloudTalkTool, executeNextcloudTalkTool } = require('../integrations/nextcloudTalkTools');
const { isNextcloudTasksTool, executeNextcloudTasksTool } = require('../integrations/nextcloudTasksTools');
const { isNextcloudNotesTool, executeNextcloudNotesTool } = require('../integrations/nextcloudNotesTools');
const { isNextcloudMailTool, executeNextcloudMailTool } = require('../integrations/nextcloudMailTools');
const { isNextcloudActivityTool, executeNextcloudActivityTool } = require('../integrations/nextcloudActivityTools');
const { isNextcloudStatusTool, executeNextcloudStatusTool } = require('../integrations/nextcloudStatusTools');
const { isTicketAssistantTool, executeTicketAssistantTool } = require('../integrations/ticketAssistantTools');
const { isSupportTool, executeSupportTool } = require('../integrations/supportTools');
const { isWebpageAutomationTool, executeWebpageAutomationTool } = require('../integrations/webpageAutomationTools');

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
        return { error: 'Tool call had no function name — emit a fresh tool_call with the function.name field set, or answer in plain text.' };
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

    // Media-gen prompt moderation was removed when Azure Content Safety
    // was dropped. The upstream media-gen providers (Azure OpenAI image,
    // FAL, ElevenLabs) still apply their own safety filters.

    // ─── Terminal Tools (removed — module no longer exists) ────
    // Terminal container system has been removed from the platform

    // ─── Custom Integrations (AI Integration Builder) ───────────
    // Org-scoped cint_<slug>_<tool> calls go straight to the hardened runner
    // — org match, status, capability backstop, origin pin, SSRF re-check,
    // method gate and secret scrub all live there. Dispatched BEFORE the
    // per-integration chain so no prefix collision can shadow it.
    // `unattended`: context.autoSend is the only dispatch-side headless
    // marker today — the automation runner sets it on LIVE routine runs and
    // webpageApiRuntime sets it on backend handler calls. Legacy AI tasks
    // (aiTaskRunner) carry NO marker and dispatch as attended; the runner
    // refuses unattended===true outright for now, and the capability
    // backstop still gates every call regardless of path.
    const customRunner = require('../integrations/customIntegrationRunner');
    if (customRunner.isCustomIntegrationTool(toolName)) {
        return await customRunner.executeCustomIntegrationTool(toolName, toolArgs, {
            userId,
            unattended: !!context.autoSend,
        });
    }

    // ─── Skill Activation (dynamic skill loading) ──────────────
    const { ACTIVATE_SKILL_TOOL_NAME, executeActivateSkill } = require('./skillInjection');
    if (toolName === ACTIVATE_SKILL_TOOL_NAME) {
        return await executeActivateSkill({ args: toolArgs, orgId, userId });
    }
    // ─── Session Skill Runtime (direct-chat local skills) ───────
    const {
        ACTIVATE_SESSION_SKILL_TOOL_NAME,
        COMPLETE_SESSION_SKILL_TOOL_NAME,
        PUBLISH_SESSION_SKILL_TOOL_NAME,
        executeActivateSessionSkill,
        executeCompleteSessionSkill,
        executePublishSessionSkill,
    } = require('./sessionSkillRuntime');
    if (toolName === ACTIVATE_SESSION_SKILL_TOOL_NAME) {
        return await executeActivateSessionSkill({
            args: toolArgs,
            sessionSkills: context.sessionSkills || [],
            activatedSkillIds: context.activatedSessionSkillIds || [],
            completedSkillIds: context.completedSessionSkillIds || [],
        });
    }
    if (toolName === COMPLETE_SESSION_SKILL_TOOL_NAME) {
        return await executeCompleteSessionSkill({
            args: toolArgs,
            sessionSkills: context.sessionSkills || [],
            activatedSessionSkillIds: context.activatedSessionSkillIds || [],
            completedSessionSkillIds: context.completedSessionSkillIds || [],
            roundsInCurrentStep: typeof context.roundsInCurrentStep === 'number' ? context.roundsInCurrentStep : null,
        });
    }
    if (toolName === PUBLISH_SESSION_SKILL_TOOL_NAME) {
        return await executePublishSessionSkill({
            args: toolArgs,
            sessionSkills: context.sessionSkills || [],
            orgId,
            userId,
        });
    }

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
    if (isAfasTool(toolName)) {
        return await executeAfasTool(toolName, toolArgs, userId);
    }
    if (isNmbrsTool(toolName)) {
        return await executeNmbrsTool(toolName, toolArgs, userId);
    }
    if (isGmailTool(toolName)) {
        // `autoSend` is opt-in per-call: only the automation runner sets it
        // (no user is present to confirm a draft). Direct chat / agent chat
        // leave it false so the email_draft → user approves → send flow stays.
        return await executeGmailTool(toolName, toolArgs, session, { autoSend: !!context.autoSend });
    }
    if (isCalendarTool(toolName)) {
        return await executeCalendarTool(toolName, toolArgs, session);
    }
    if (isDocsTool(toolName)) {
        return await executeDocsTool(toolName, toolArgs, session);
    }
    if (isSheetsTool(toolName)) {
        return await executeSheetsTool(toolName, toolArgs, session);
    }
    if (isSlidesTool(toolName)) {
        return await executeSlidesTool(toolName, toolArgs, session);
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
        // Read-only n8n tools are implicit for every member of an org with n8n
        // configured (umbrella 'n8n' integration toggle gates injection). Only
        // the write/execute bucket is permission-gated via modify_n8n_workflows.
        // Non-LLM callers (pipelines, schedules) also flow through here, so we
        // re-check writes as defense-in-depth vs. the registration-time filter.
        if (userId) {
            const requiredPerm = getN8nToolPermission(toolName);
            if (requiredPerm === 'modify_n8n_workflows') {
                const granted = await hasPermission(userId, requiredPerm, session);
                if (!granted) {
                    return { error: 'You do not have permission to modify n8n workflows. Ask your organisation admin to grant the "Modify n8n Workflows" permission.' };
                }
            }
        }
        return await executeN8nWorkflowTool(toolName, toolArgs, orgId);
    }
    if (isN8nTool(toolName)) {
        // Webhook-trigger tools are implicit for every member once the org has
        // n8n configured — gated only by the umbrella 'n8n' integration toggle
        // at injection time (see integrationTools.js).
        return await executeN8nTool(toolName, toolArgs, orgId, attachments);
    }
    if (isAgentSearchTool(toolName)) {
        // Route by admin-configured search provider (bing / node-search /
        // agent-search service, with node-search fallback for CPU-only deploys).
        // Single source of truth lives in agentSearchTools.executeWebSearch.
        return await executeWebSearch(toolName, toolArgs);
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
        // BFSF-207 backstop: notebook tools are entitlement-gated at registration;
        // re-check at dispatch so no other injection path can execute them.
        // Mirror registration's org resolution (user's own org — context.orgId is
        // absent in agent chat and may be the LENDER's org under connection lending).
        try {
            const { hasCapability } = require('./entitlements');
            const { hasPermission } = require('../auth/permissions');
            let resolveOrgId = null;
            try { resolveOrgId = (await require('../stores/userStore').getUser(userId))?.organizationId || null; } catch (_) {}
            const ok = !!userId
                && await hasCapability('notebooks', { userId, orgId: resolveOrgId, session })
                && await hasPermission(userId, 'use_notebooks', session);
            if (!ok) {
                return { error: 'The notebook is not available for this user — the notebooks feature is not included in their plan or has not been enabled for them. Briefly let the user know the notebook is unavailable and continue helping them directly in chat.' };
            }
        } catch (_) {
            return { error: 'The notebook is temporarily unavailable. Continue helping the user directly in chat.' };
        }
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

    // ─── KB Ingest Tool (routine-only WRITE; Support Studio template) ───
    if (isKbIngestTool(toolName)) {
        return await executeKbIngestTool(toolName, toolArgs, { orgId, userId });
    }

    // ─── Dutch legal sources (anonymous public APIs) ──────────────
    if (isRechtspraakTool(toolName)) {
        return await executeRechtspraakTool(toolName, toolArgs);
    }
    if (isEurlexTool(toolName)) {
        return await executeEurlexTool(toolName, toolArgs);
    }
    if (isKamerstukkenTool(toolName)) {
        return await executeKamerstukkenTool(toolName, toolArgs);
    }
    if (isBekendmakingenTool(toolName)) {
        return await executeBekendmakingenTool(toolName, toolArgs);
    }
    if (isTuchtrechtTool(toolName)) {
        return await executeTuchtrechtTool(toolName, toolArgs);
    }

    // ─── Maps Tools ─────────────────────────────────────────────
    if (isMapsTool(toolName)) {
        return await executeMapsTool(toolName, toolArgs);
    }
    if (isLinkedInTool(toolName)) {
        return await executeLinkedInTool(toolName, toolArgs, session);
    }
    if (isGitHubTool(toolName)) {
        return await executeGitHubTool(toolName, toolArgs, userId);
    }
    // Nextcloud sub-apps must dispatch BEFORE the generic nextcloud check —
    // isNextcloudTool matches the broad "nextcloud_*" prefix.
    if (isNextcloudCalendarTool(toolName)) {
        return await executeNextcloudCalendarTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudContactsTool(toolName)) {
        return await executeNextcloudContactsTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudDeckTool(toolName)) {
        return await executeNextcloudDeckTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudNotificationsTool(toolName)) {
        return await executeNextcloudNotificationsTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudTalkTool(toolName)) {
        return await executeNextcloudTalkTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudTasksTool(toolName)) {
        return await executeNextcloudTasksTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudNotesTool(toolName)) {
        return await executeNextcloudNotesTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudMailTool(toolName)) {
        return await executeNextcloudMailTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudActivityTool(toolName)) {
        return await executeNextcloudActivityTool(toolName, toolArgs, userId, session);
    }
    if (isNextcloudStatusTool(toolName)) {
        return await executeNextcloudStatusTool(toolName, toolArgs, userId, session);
    }
    if (isTicketAssistantTool(toolName)) {
        return await executeTicketAssistantTool(toolName, toolArgs, userId, session);
    }
    if (isSupportTool(toolName)) {
        return await executeSupportTool(toolName, toolArgs, {
            userId, session, userAuth,
            supportThreadId: context.supportThreadId,
            supportActionPolicy: userAuth?.supportActionPolicy || null,
        });
    }
    if (isWebpageAutomationTool(toolName)) {
        return await executeWebpageAutomationTool(toolName, toolArgs, {
            userId,
            organizationId: orgId,
            userGroupIds: context.userGroupIds || [],
            userOrgIds: context.userOrgIds || (orgId ? [orgId] : []),
        });
    }
    if (isNextcloudTool(toolName)) {
        return await executeNextcloudTool(toolName, toolArgs, userId, session);
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

    // ─── Agent-Callable Routines (trigger.kind === 'agent_call') ─
    // These tools are per-user and named dynamically (toolName or
    // automation_<id>), so they can't be matched by a static isXxxTool guard.
    // Look the caller's active routines up by name and dispatch to the runner.
    if (userId) {
        try {
            const { getAgentCallableToolsForUser, dispatchAgentCallableTool } = require('../automation/agentCallableTools');
            const agentTools = await getAgentCallableToolsForUser(userId);
            const match = agentTools.find(t => t?.function?.name === toolName);
            if (match) {
                return await dispatchAgentCallableTool(match.__automation, toolArgs, { userId });
            }
        } catch (e) {
            console.warn('[ToolDispatcher] agent-callable routine lookup failed:', e.message);
        }
    }

    // ─── Reusable Steps (kind='block') exposed as chat tools ────
    // Named step_<title>; matched the same dynamic way as agent-callable
    // routines and dispatched to runStepAsTool (owner-only, runs as caller).
    if (userId) {
        try {
            const { getStepToolsForUser, dispatchStepTool } = require('../automation/agentCallableTools');
            const stepTools = await getStepToolsForUser(userId);
            const match = stepTools.find(t => t?.function?.name === toolName);
            if (match) {
                return await dispatchStepTool(match.__step, toolArgs, { userId });
            }
        } catch (e) {
            console.warn('[ToolDispatcher] Step tool lookup failed:', e.message);
        }
    }

    // ─── Progressive-disclosure safety net ─────────────────────
    // If the name belongs to a heavy integration group but no executor above
    // claimed it, the model likely referenced a tool it never loaded. Hand
    // back a recoverable hint instead of a confusing "unknown tool" so it can
    // self-correct via load_tools. (No-op for the normal Claude path, which
    // can only emit tools that were actually sent.)
    try {
        const { toolNameToGroupKey } = require('./toolDisclosure');
        const grp = toolNameToGroupKey(toolName);
        if (grp) {
            return { error: `Tool "${toolName}" belongs to the "${grp}" group, which isn't loaded yet. Call load_tools({groups:["${grp}"]}) first, then call this tool.` };
        }
    } catch (_) { /* non-fatal — fall through to component lookup */ }

    // ─── Fallback: Component Tools ──────────────────────────────
    return await executeComponentTool(toolName, toolArgs, userAuth, fixedParams, agentId);
}

module.exports = { executeTool };
