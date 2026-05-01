/**
 * Integration Tools — Shared tool injection for direct chat and agent chat
 * 
 * Builds the list of available integration tools (Gmail, Calendar,
 * Docs, Drive, Fireflies, YouTrack, Gamma, N8N, Tavily, Image Gen,
 * Video Gen, Terminal, Regex Generator) based on user session,
 * org settings, and enabled apps.
 */

const configStore = require('../stores/configStore');
const { GMAIL_TOOLS } = require('../integrations/gmailTools');
const { CALENDAR_TOOLS } = require('../integrations/calendarTools');
const { DRIVE_TOOLS } = require('../integrations/driveTools');
const { DOCS_TOOLS } = require('../integrations/docsTools');
const { CONTACTS_TOOLS } = require('../integrations/contactsTools');
const { KEEP_TOOLS } = require('../integrations/keepTools');
const { GOOGLE_GROUPS_TOOLS } = require('../integrations/googleGroupsTools');
const { FIREFLIES_TOOLS } = require('../integrations/firefliesTools');
const { YOUTRACK_TOOLS } = require('../integrations/youtrackTools');
const { SIGNREQUEST_TOOLS } = require('../integrations/signrequestTools');
const { GAMMA_TOOLS } = require('../integrations/gammaTools');
const { buildN8nTools } = require('../integrations/n8nTools');
const { N8N_WORKFLOW_TOOLS, getN8nToolPermission } = require('../integrations/n8nWorkflowTools');
const { hasPermission } = require('../auth/permissions');
const { AGENT_SEARCH_TOOLS } = require('../integrations/agentSearchTools');
const { REGEX_GENERATOR_TOOLS } = require('../integrations/regexGeneratorTools');
const { IMAGE_GEN_TOOLS } = require('../routes/ai/imageGenTool');
const { VIDEO_GEN_TOOLS } = require('../routes/ai/videoGenTool');
const { ELEVENLABS_TOOLS } = require('../routes/ai/elevenLabsTools');
const { WORKSPACE_TOOLS } = require('../integrations/workspaceTools');
const { KB_SEARCH_TOOLS } = require('../integrations/kbSearchTools');
const { MAPS_TOOLS } = require('../integrations/mapsTools');
const { LINKEDIN_TOOLS } = require('../integrations/linkedinTools');
const { WHATSAPP_TOOLS } = require('../integrations/whatsappTools');
const { GITHUB_TOOLS } = require('../integrations/githubTools');
const { OUTLOOK_TOOLS, OUTLOOK_READONLY_TOOLS } = require('../integrations/outlookTools');
const { MS_CALENDAR_TOOLS } = require('../integrations/msCalendarTools');
const { ONEDRIVE_TOOLS } = require('../integrations/oneDriveTools');
const { MS_CONTACTS_TOOLS } = require('../integrations/msContactsTools');
const { TRANSCRIPTION_TOOLS } = require('../integrations/transcriptionTools');
const { NEXTCLOUD_TOOLS } = require('../integrations/nextcloudTools');
const { NEXTCLOUD_CALENDAR_TOOLS } = require('../integrations/nextcloudCalendarTools');
const { NEXTCLOUD_CONTACTS_TOOLS } = require('../integrations/nextcloudContactsTools');
const { NEXTCLOUD_DECK_TOOLS } = require('../integrations/nextcloudDeckTools');
const { NEXTCLOUD_NOTIFICATIONS_TOOLS } = require('../integrations/nextcloudNotificationsTools');
const { NEXTCLOUD_TALK_TOOLS } = require('../integrations/nextcloudTalkTools');
const { NEXTCLOUD_TASKS_TOOLS } = require('../integrations/nextcloudTasksTools');
const { NEXTCLOUD_NOTES_TOOLS } = require('../integrations/nextcloudNotesTools');
const { NEXTCLOUD_ACTIVITY_TOOLS } = require('../integrations/nextcloudActivityTools');
const { NEXTCLOUD_STATUS_TOOLS } = require('../integrations/nextcloudStatusTools');

// IDs that are exempt from org-level gating (admin-only tools, internal utilities)
const ORG_EXEMPT_APPS = ['workspace', 'regex-gen'];

/**
 * Build the list of integration tools available for the current user.
 * 
 * @param {Object} options
 * @param {string}  options.userId       - Current user ID
 * @param {Object}  options.session      - Express session (for OAuth tokens)
 * @param {boolean} options.isAdmin      - Whether user is admin
 * @returns {Object} { tools: Array, n8nOrgId: string|null }
 */
async function getIntegrationTools({ userId, session, isAdmin, agentConfig }) {
    const tools = [];
    let n8nOrgId = null;

    // Load user's enabled apps (null = all enabled)
    const userEnabledApps = await configStore.getConfig(`enabled_apps_user_${userId}`);

    // Load org-level enabled integrations
    let orgEnabledIntegrations = null;
    let userOrgId = null;
    try {
        const userStore = require('../stores/userStore');
        const currentUser = await userStore.getUser(userId);
        if (currentUser?.organizationId) {
            userOrgId = currentUser.organizationId;
            const org = await userStore.getOrganization(currentUser.organizationId);
            if (org?.enabledIntegrations) {
                // Org has custom overrides
                orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations)
                    : org.enabledIntegrations;
            } else {
                // Org uses defaults — load global default integrations
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                if (globalDefaults) {
                    orgEnabledIntegrations = typeof globalDefaults === 'string'
                        ? JSON.parse(globalDefaults)
                        : globalDefaults;
                }
                // null globalDefaults = all enabled (no defaults configured yet)
            }
        }
    } catch (e) { /* ignore */ }

    // Auto-enable new integrations for users with existing saved lists
    // (these were added after the user saved their enabledApps, so they wouldn't be included)
    const AUTO_ENABLED_APPS = ['agent-search', 'workspace', 'image-gen', 'music-gen', 'video-gen', 'elevenlabs', 'google-maps', 'linkedin', 'github', 'google-contacts', 'google-keep', 'outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts', 'google-groups', 'n8n', 'nextcloud', 'nextcloud-calendar', 'nextcloud-contacts', 'nextcloud-deck', 'nextcloud-notifications', 'nextcloud-talk', 'nextcloud-tasks', 'nextcloud-notes', 'nextcloud-activity', 'nextcloud-status'];

    const isAppOn = (appId) => {
        // Must be enabled at user level
        if (userEnabledApps) {
            // For auto-enabled apps, they're on unless _explicitly_ in a list that excluded them
            // after they existed. Since we can't tell, we default to enabled.
            if (AUTO_ENABLED_APPS.includes(appId)) {
                // Only block if user explicitly has this app in their list AND it's set to off
                // For now, auto-enabled apps are always on at user level
            } else if (!userEnabledApps.includes(appId)) {
                return false;
            }
        }
        // Org-level gating applies to all integrations except exempt ones
        if (!ORG_EXEMPT_APPS.includes(appId) && orgEnabledIntegrations && !orgEnabledIntegrations.includes(appId)) return false;
        return true;
    };

    const addTools = (toolArray) => {
        for (const tool of toolArray) {
            if (!tools.find(t => t.function.name === tool.function.name)) {
                tools.push(tool);
            }
        }
    };

    // Google integrations — require OAuth
    if (session?.oauthProvider === 'google' && session?.accessToken) {
        if (isAppOn('gmail')) addTools(GMAIL_TOOLS);
        if (isAppOn('google-calendar')) addTools(CALENDAR_TOOLS);
        if (isAppOn('google-drive')) addTools(DRIVE_TOOLS);
        if (isAppOn('google-docs')) addTools(DOCS_TOOLS);
        if (isAppOn('google-contacts')) addTools(CONTACTS_TOOLS);
        if (isAppOn('google-keep')) addTools(KEEP_TOOLS);
        if (isAppOn('google-groups')) addTools(GOOGLE_GROUPS_TOOLS);
    }

    // Microsoft integrations — require Microsoft OAuth
    if (session?.oauthProvider === 'microsoft' && session?.accessToken) {
        if (isAppOn('outlook')) addTools(OUTLOOK_TOOLS);
        if (isAppOn('outlook-readonly')) addTools(OUTLOOK_READONLY_TOOLS);
        if (isAppOn('ms-calendar')) addTools(MS_CALENDAR_TOOLS);
        if (isAppOn('onedrive')) addTools(ONEDRIVE_TOOLS);
        if (isAppOn('ms-contacts')) addTools(MS_CONTACTS_TOOLS);
    }

    // Image Generation — requires Google API key
    const hasGoogleKey = !!(await configStore.getSecret('google_api_key'));
    if (hasGoogleKey && isAppOn('image-gen')) {
        addTools(IMAGE_GEN_TOOLS);
    }

    // Video Generation — requires Google API key (Veo 3.1)
    if (hasGoogleKey && isAppOn('video-gen')) {
        addTools(VIDEO_GEN_TOOLS);
    }

    // ElevenLabs — Music (with vocals), TTS, Sound Effects
    const hasElevenLabsKey = !!(await configStore.getSecret('elevenlabs_api_key'));
    if (hasElevenLabsKey && isAppOn('elevenlabs')) {
        addTools(ELEVENLABS_TOOLS);
    }

    // Agent Search — self-hosted AI search with reranking, or Bing Web Search
    const hasAgentSearchUrl = !!process.env.SEARCH_SERVICE_URL || !!(await configStore.getConfig('agent_search_url'));
    const searchProvider = await configStore.getConfig('search_provider') || 'agent-search';
    const hasBingSearchKey = !!(await configStore.getSecret('bing_search_key'));
    const searchAvailable = searchProvider !== 'disabled' && ((searchProvider === 'bing' && hasBingSearchKey) || hasAgentSearchUrl);
    if (searchAvailable && isAppOn('agent-search')) {
        addTools(AGENT_SEARCH_TOOLS);
    }

    // Fireflies — requires user API key
    const hasFirefliesKey = !!(await configStore.getSecret(`fireflies_api_key_user_${userId}`));
    if (hasFirefliesKey && isAppOn('fireflies')) {
        addTools(FIREFLIES_TOOLS);
    }

    // YouTrack — requires user URL + token
    const hasYouTrackConfig = !!(await configStore.getSecret(`youtrack_url_user_${userId}`)) && !!(await configStore.getSecret(`youtrack_token_user_${userId}`));
    if (hasYouTrackConfig && isAppOn('youtrack')) {
        addTools(YOUTRACK_TOOLS);
    }

    // Gamma — requires user API key
    const hasGammaKey = !!(await configStore.getSecret(`gamma_api_key_user_${userId}`));
    if (hasGammaKey && isAppOn('gamma')) {
        addTools(GAMMA_TOOLS);
    }

    // SignRequest — requires user subdomain + token
    const hasSignRequestConfig = !!(await configStore.getSecret(`signrequest_subdomain_user_${userId}`)) && !!(await configStore.getSecret(`signrequest_token_user_${userId}`));
    if (hasSignRequestConfig && isAppOn('signrequest')) {
        addTools(SIGNREQUEST_TOOLS);
    }

    // N8N workflows — org-level config. Read/run tools are implicit for every
    // member once the org has n8n configured (umbrella 'n8n' toggle, handled by
    // AUTO_ENABLED_APPS so legacy users with stale enabledApps lists don't lose
    // access). Only the write-bucket is permission-gated via modify_n8n_workflows.
    try {
        if (userOrgId) {
            n8nOrgId = userOrgId;
            const n8nUrl = await configStore.getConfig(`n8n_url_org_${n8nOrgId}`);
            const n8nKey = await configStore.getSecret(`n8n_api_key_org_${n8nOrgId}`);
            if (n8nUrl && n8nKey && isAppOn('n8n')) {
                const canModify = await hasPermission(userId, 'modify_n8n_workflows', session);

                // Dynamic webhook-trigger tools — umbrella gating.
                // A user who has 'n8n' enabled (or is covered by AUTO_ENABLED_APPS)
                // gets every configured workflow, no per-workflow toggle required.
                const n8nTools = await buildN8nTools(n8nOrgId);
                for (const n8nTool of n8nTools) {
                    const { _n8n, ...cleanTool } = n8nTool;
                    if (!tools.find(t => t.function.name === cleanTool.function.name)) {
                        tools.push(cleanTool);
                    }
                }

                // Workflow-management tools — split by permission bucket:
                //   read-only (list/get/nodes_find/execution reads) → always included
                //   write / execute / delete / activate             → modify_n8n_workflows
                for (const tool of N8N_WORKFLOW_TOOLS) {
                    const perm = getN8nToolPermission(tool.function.name);
                    if (perm === 'modify_n8n_workflows' && !canModify) continue;
                    if (!tools.find(t => t.function.name === tool.function.name)) {
                        tools.push(tool);
                    }
                }
            }
        }
    } catch (e) {
        console.error('[IntegrationTools] n8n tool injection error:', e.message);
    }

    // Regex Generator — admin only
    if (isAdmin) {
        addTools(REGEX_GENERATOR_TOOLS);
    }

    // Workspace/Notebook — check feature flag (disabled from admin panel = no tools)
    const notebooksFeatureEnabled = (await configStore.getConfig('feature_notebooks_enabled')) !== false;
    if (notebooksFeatureEnabled && isAppOn('workspace')) {
        addTools(WORKSPACE_TOOLS);
    }

    // KB Search — available when agent has knowledge bases configured
    // This lets agents explicitly search KB with custom queries (e.g., after reading an email)
    if (agentConfig?.knowledge_base_ids?.length > 0) {
        addTools(KB_SEARCH_TOOLS);
    }

    // LinkedIn — requires user OAuth tokens
    const hasLinkedIn = !!(await configStore.getSecret(`linkedin_access_token_user_${userId}`));
    if (hasLinkedIn && isAppOn('linkedin')) {
        addTools(LINKEDIN_TOOLS);
    }

    // Google Maps — requires Maps API key
    const hasMapsKey = !!(await configStore.getSecret('google_maps_api_key'));
    if (hasMapsKey && isAppOn('google-maps')) {
        addTools(MAPS_TOOLS);
    }

    // GitHub — requires user PAT
    const hasGitHub = !!(await configStore.getSecret(`github_token_user_${userId}`));
    if (hasGitHub && isAppOn('github')) {
        addTools(GITHUB_TOOLS);
    }

    // Nextcloud — OAuth path (parity with Google/Microsoft above) with
    // app-password fallback for users not logged in via Nextcloud OAuth.
    // Once a Nextcloud connection (either mode) is established, every
    // sub-app (files, calendar, contacts, Deck, notifications) gates on its
    // own per-app toggle so admins can disable individual surfaces.
    try {
        const oauthCfg = (await configStore.getConfig('oauth')) || {};
        if (oauthCfg.nextcloudUrl) {
            let nextcloudConnected = false;
            if (session?.oauthProvider === 'nextcloud' && session?.accessToken) {
                nextcloudConnected = true;
            } else {
                const userStoreLocal = require('../stores/userStore');
                const ncCreds = await userStoreLocal.getAppPassword(userId);
                if (ncCreds?.username && ncCreds?.password) nextcloudConnected = true;
            }
            if (nextcloudConnected) {
                if (isAppOn('nextcloud')) addTools(NEXTCLOUD_TOOLS);
                if (isAppOn('nextcloud-calendar')) addTools(NEXTCLOUD_CALENDAR_TOOLS);
                if (isAppOn('nextcloud-contacts')) addTools(NEXTCLOUD_CONTACTS_TOOLS);
                if (isAppOn('nextcloud-deck')) addTools(NEXTCLOUD_DECK_TOOLS);
                if (isAppOn('nextcloud-notifications')) addTools(NEXTCLOUD_NOTIFICATIONS_TOOLS);
                if (isAppOn('nextcloud-talk')) addTools(NEXTCLOUD_TALK_TOOLS);
                if (isAppOn('nextcloud-tasks')) addTools(NEXTCLOUD_TASKS_TOOLS);
                if (isAppOn('nextcloud-notes')) addTools(NEXTCLOUD_NOTES_TOOLS);
                if (isAppOn('nextcloud-activity')) addTools(NEXTCLOUD_ACTIVITY_TOOLS);
                if (isAppOn('nextcloud-status')) addTools(NEXTCLOUD_STATUS_TOOLS);
            }
        }
    } catch (e) { /* ignore — credentials missing or store unavailable */ }

    // Transcription — requires existing Mistral API key
    const hasMistralKey = !!(await configStore.getSecret('mistral_api_key'));
    if (hasMistralKey && isAppOn('transcription')) {
        addTools(TRANSCRIPTION_TOOLS);
    }

    // WhatsApp — requires active Baileys session
    try {
        const whatsappSession = require('../integrations/whatsappSession');
        const waStatus = whatsappSession.getStatus(userId);
        if ((waStatus === 'connected' || waStatus === 'saved') && isAppOn('whatsapp')) {
            addTools(WHATSAPP_TOOLS);
            // Auto-restore saved session if not already active
            if (waStatus === 'saved') {
                whatsappSession.restoreSession(userId).catch(e =>
                    console.warn('[IntegrationTools] WhatsApp restore failed:', e.message)
                );
            }
        }
    } catch (e) {
        console.warn('[IntegrationTools] WhatsApp check error:', e.message);
    }

    return { tools, n8nOrgId };
}

/**
 * Build human-readable integration hints for the system prompt.
 * @param {Array} tools - Tool definitions array
 * @returns {string} Integration hint string to append to system prompt
 */
async function buildToolHint(tools, userId = null) {
    if (tools.length === 0) return '';

    const integrations = [];
    if (tools.some(t => t.function.name.startsWith('gmail_'))) integrations.push('Gmail (search, read, compose, send, and reply to emails — the user approves before anything is sent)');
    if (tools.some(t => t.function.name.startsWith('calendar_'))) integrations.push('Google Calendar (list, search, create, update, delete events)');
    if (tools.some(t => t.function.name.startsWith('drive_'))) integrations.push('Google Drive (search, list, manage files and folders)');
    if (tools.some(t => t.function.name.startsWith('docs_'))) integrations.push('Google Docs (create, read, append, replace text in documents)');
    if (tools.some(t => t.function.name.startsWith('contacts_'))) integrations.push('Google Contacts (search, list, create, update contacts — create/update require user approval)');
    if (tools.some(t => t.function.name.startsWith('keep_'))) integrations.push('Google Keep (list, get, create, delete notes — create/delete require user approval, enterprise Workspace only)');
    if (tools.some(t => t.function.name.startsWith('groups_'))) integrations.push('Google Groups (list conversations in a group, read full conversation threads, reply to group conversations — replies require user approval before sending)');
    if (tools.some(t => t.function.name.startsWith('youtrack_'))) integrations.push('YouTrack (search, create, update issues)');
    if (tools.some(t => t.function.name.startsWith('signrequest_'))) integrations.push('SignRequest (send documents for e-signature, check signing status, list documents, cancel requests)');
    if (tools.some(t => t.function.name.startsWith('fireflies_'))) integrations.push('Fireflies (meeting transcripts)');
    if (tools.some(t => t.function.name.startsWith('gamma_'))) integrations.push('Gamma (create presentations/documents/webpages/social posts, generate from templates using gammaId or a pasted gamma.app/docs URL, poll generation status, list themes/folders; create tools start asynchronous jobs and return generationId first, then use gamma_get_generation_status to retrieve gammaUrl/exportUrl; existing Gammas cannot be read by URL or edited in place via the public API. If the user asks to create/remix a new Gamma from a URL, call gamma_create_from_template instead of saying the URL cannot be used)');
    if (tools.some(t => t.function.name.startsWith('n8n_run_'))) {
        const n8nNames = tools.filter(t => t.function.name.startsWith('n8n_run_')).map(t => t.function.description || t.function.name);
        integrations.push(`n8n Workflows (${n8nNames.join(', ')})`);
    }
    if (tools.some(t => t.function.name.startsWith('n8n_workflow_') || t.function.name.startsWith('n8n_execution_'))) {
        const hasWrite = tools.some(t => ['n8n_workflow_create','n8n_workflow_update','n8n_workflow_patch','n8n_workflow_delete','n8n_workflow_execute','n8n_workflow_activate','n8n_workflow_deactivate'].includes(t.function.name));
        if (hasWrite) {
            integrations.push(
                'n8n Workflow Management (list, get, nodes_find, create, patch, activate, execute, debug executions). RULES: '
                + '(1) ALWAYS call n8n_workflow_list first to discover IDs — never guess a workflow_id. '
                + '(2) For targeted edits use n8n_workflow_patch with node_operations {action,node_name,node_data} — NOT wholesale update. '
                + '(3) For searching nodes use n8n_workflow_nodes_find instead of pulling the full workflow. '
                + '(4) nodes/connections/parameters are real JSON arrays/objects, never stringified. '
                + '(5) Do NOT send `settings` in a patch unless explicitly changing one — the server preserves/sanitises existing settings automatically. '
                + '(6) To add documentation to the canvas, use sticky notes: type "n8n-nodes-base.stickyNote" with parameters.content — no connections needed. '
                + '(7) Always confirm with the user before n8n_workflow_delete or n8n_workflow_activate. '
                + '(8) On failure, debug via n8n_execution_list → n8n_execution_get_detail for per-node errors.'
            );
        } else {
            integrations.push('n8n Workflow Inspection (list, get, nodes_find, execution_list, execution_get_detail — read-only). To modify workflows you need the "Modify n8n Workflows" permission.');
        }
    }
    if (tools.some(t => t.function.name === 'generate_image')) integrations.push('Image generation');
    if (tools.some(t => t.function.name === 'generate_music')) integrations.push('Music generation (instrumental AI music via Lyria)');
    if (tools.some(t => t.function.name === 'generate_video')) integrations.push('Video generation (short AI video clips via Veo 3.1 — takes 1-3 minutes)');
    if (tools.some(t => t.function.name === 'agent_search')) integrations.push('Agent Search (AI-powered web search with reranking)');
    if (tools.some(t => t.function.name.startsWith('workspace_') || t.function.name.startsWith('notebook_'))) integrations.push('Notebook (read and write a persistent rich-text document alongside the conversation)');
    if (tools.some(t => t.function.name === 'kb_search')) integrations.push('Knowledge Base Search (look up internal documentation when the user asks a specific question — do NOT search for greetings or small-talk)');
    if (tools.some(t => t.function.name.startsWith('maps_'))) integrations.push('Google Maps (get directions between locations with route maps, search for places/businesses — IMPORTANT: after getting results, always output the map as a ```map-embed code block containing JSON with embedUrl, title, and mapsLink fields so it renders as an interactive map in the chat)');
    if (tools.some(t => t.function.name.startsWith('linkedin_'))) integrations.push('LinkedIn (create posts — user approves before publishing)');
    if (tools.some(t => t.function.name.startsWith('github_'))) integrations.push('GitHub (list repos, view code, create repos, manage branches)');
    if (tools.some(t => t.function.name.startsWith('whatsapp_'))) integrations.push('WhatsApp (list chats, read messages, compose with approval). WORKFLOW: 1) Use whatsapp_list_chats to find chats (supports search query). 2) Use whatsapp_read_messages with a contact name or JID from the list. 3) Use whatsapp_compose to draft a message — it will be shown to the user for approval before sending. Messages are captured from the moment the user connected, so very old history may not be available. Always use JIDs from whatsapp_list_chats for accuracy.');
    if (tools.some(t => t.function.name.startsWith('outlook_'))) {
        // Check if compose tool is present — if not, it's read-only mode
        const hasCompose = tools.some(t => t.function.name === 'outlook_compose');
        if (hasCompose) {
            integrations.push('Outlook Mail (search, list recent, read, compose, send, and reply to emails — the user approves before anything is sent)');
        } else {
            integrations.push('Outlook Mail (search, list recent, and read emails only — read-only access, no sending capability)');
        }
    }
    if (tools.some(t => t.function.name.startsWith('ms_calendar_'))) integrations.push('Microsoft Calendar (list, search, create, update, delete events — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('onedrive_'))) integrations.push('OneDrive (search, list, manage files and folders)');
    if (tools.some(t => t.function.name.startsWith('ms_contacts_'))) integrations.push('Microsoft Contacts (search, list, create, update contacts — create/update require user approval)');
    if (tools.some(t => t.function.name === 'transcribe_audio')) integrations.push('Meeting Transcription (transcribe uploaded audio files with speaker diarization using Voxtral AI — supports up to 3 hours of audio, Dutch and other languages)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_calendar_'))) integrations.push('Nextcloud Calendar (list calendars, list/search/get events, create/update/delete events via CalDAV — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_contacts_'))) integrations.push('Nextcloud Contacts (list address books, list/search/get contacts, create/update/delete contacts via CardDAV — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_deck_'))) integrations.push('Nextcloud Deck (list boards/stacks/cards, search cards, create/update/move/archive/delete cards, manage labels, add comments — create/update/move require user approval, delete always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_notifications_'))) integrations.push('Nextcloud Notifications (list pending notifications, dismiss one or all — dismiss-all always requires user confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_talk_'))) integrations.push('Nextcloud Talk (list conversations, list/search messages, post messages with optional reply, react with emoji, mark rooms read, create rooms — sending messages always requires user approval, deletion always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_tasks_'))) integrations.push('Nextcloud Tasks (VTODO via CalDAV — list lists, list/search/get tasks, create, update, mark complete/incomplete, delete — create/update require user approval, delete always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_notes_'))) integrations.push('Nextcloud Notes (list/search/get notes, create/update/delete notes, list categories — create/update require user approval, delete always requires confirmation)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_activity_'))) integrations.push('Nextcloud Activity (read-only feed of recent file changes, shares, comments, mentions, calendar invites — useful for "what happened recently?" questions)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_status_'))) integrations.push('Nextcloud User Status (get / set / clear the user\'s availability and custom message — setting status requires user approval, except when auto-deriving from a calendar event the user explicitly asked about)');
    if (tools.some(t => t.function.name.startsWith('nextcloud_') && !t.function.name.startsWith('nextcloud_calendar_') && !t.function.name.startsWith('nextcloud_contacts_') && !t.function.name.startsWith('nextcloud_deck_') && !t.function.name.startsWith('nextcloud_notifications_') && !t.function.name.startsWith('nextcloud_talk_') && !t.function.name.startsWith('nextcloud_tasks_') && !t.function.name.startsWith('nextcloud_notes_') && !t.function.name.startsWith('nextcloud_activity_') && !t.function.name.startsWith('nextcloud_status_'))) integrations.push('Nextcloud Files (list/search/read/upload/delete files, create folders, share with public links / users / groups / email, manage shares, file comments, system tags, trash bin recovery, file version history via WebDAV — destructive ops require user approval, permanent deletes always require confirmation)');

    // MCP (Model Context Protocol) tools — dynamically discovered from connected external servers
    const mcpTools = tools.filter(t => t.function?.name?.startsWith('mcp_'));
    console.log(`[MCP-DEBUG] buildToolHint: ${tools.length} total tools received, ${mcpTools.length} are MCP tools`);
    if (mcpTools.length > 0) {
        // Group by server: mcp_{serverId}_{toolName}
        const serverMap = {};
        for (const t of mcpTools) {
            const parts = t.function.name.split('_');
            // mcp_{serverId}_{rest...} — server ID is the second segment
            const serverId = parts[1] || 'unknown';
            if (!serverMap[serverId]) serverMap[serverId] = [];
            serverMap[serverId].push(t.function.description || t.function.name);
        }
        console.log(`[MCP-DEBUG] buildToolHint: MCP servers found: ${Object.keys(serverMap).join(', ')}`);
        for (const [serverId, toolDescs] of Object.entries(serverMap)) {
            const label = serverId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            integrations.push(`${label} via MCP (${toolDescs.length} tools: ${toolDescs.slice(0, 5).join(', ')}${toolDescs.length > 5 ? `, ... and ${toolDescs.length - 5} more` : ''})`);
        }
    }

    let hint = ' You have access to tools — use them when they would help answer the user\'s question. You can call multiple tools in parallel when appropriate.';
    if (integrations.length > 0) {
        hint += ` Your available integrations: ${integrations.join(', ')}.`;
    }
    console.log(`[MCP-DEBUG] buildToolHint final integrations: [${integrations.join(', ')}]`);

    // Inject email writing style profile when gmail or outlook tools are active
    if (userId && (tools.some(t => t.function.name.startsWith('gmail_')) || tools.some(t => t.function.name.startsWith('outlook_')))) {
        try {
            const toneProfile = await configStore.getConfig(`email_tone_profile_user_${userId}`);
            if (toneProfile) {
                hint += `\n\n[EMAIL WRITING STYLE — ALREADY LOADED]\nYou already have the user's writing style profile below. Do NOT search for it — just apply it directly when composing, replying to, or drafting any email. Write as if you ARE this person. Match their language, tone, greetings, sign-offs, sentence structure, and vocabulary exactly:\n\n${toneProfile}\n\n[END OF WRITING STYLE — apply this immediately when writing emails, no need to fetch it]`;
            }
        } catch (e) {
            // Ignore — tone profile not available
        }
    }

    return hint;
}

module.exports = { getIntegrationTools, buildToolHint };
