/**
 * Integration Tools — Shared tool injection for direct chat and agent chat
 * 
 * Builds the list of available integration tools (Gmail, Calendar, Sheets,
 * Docs, Drive, Slides, Fireflies, YouTrack, Gamma, N8N, Tavily, Image Gen,
 * Video Gen, Terminal, Regex Generator) based on user session,
 * org settings, and enabled apps.
 */

const configStore = require('../stores/configStore');
const { GMAIL_TOOLS } = require('../integrations/gmailTools');
const { CALENDAR_TOOLS } = require('../integrations/calendarTools');
const { SLIDES_TOOLS } = require('../integrations/slidesTools');
const { DRIVE_TOOLS } = require('../integrations/driveTools');
const { SHEETS_TOOLS } = require('../integrations/sheetsTools');
const { DOCS_TOOLS } = require('../integrations/docsTools');
const { CONTACTS_TOOLS } = require('../integrations/contactsTools');
const { KEEP_TOOLS } = require('../integrations/keepTools');
const { FIREFLIES_TOOLS } = require('../integrations/firefliesTools');
const { YOUTRACK_TOOLS } = require('../integrations/youtrackTools');
const { GAMMA_TOOLS } = require('../integrations/gammaTools');
const { buildN8nTools } = require('../integrations/n8nTools');
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
const { OUTLOOK_TOOLS } = require('../integrations/outlookTools');
const { MS_CALENDAR_TOOLS } = require('../integrations/msCalendarTools');
const { ONEDRIVE_TOOLS } = require('../integrations/oneDriveTools');
const { MS_CONTACTS_TOOLS } = require('../integrations/msContactsTools');
const { TRANSCRIPTION_TOOLS } = require('../integrations/transcriptionTools');

// IDs that are gated by org-level enabledIntegrations
const ORG_GATED_APPS = ['fireflies', 'youtrack', 'gamma', 'n8n', 'linkedin', 'github'];

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
    const AUTO_ENABLED_APPS = ['agent-search', 'workspace', 'image-gen', 'music-gen', 'video-gen', 'elevenlabs', 'google-maps', 'linkedin', 'github', 'google-contacts', 'google-keep'];

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
        // Org-level gating only applies to third-party integrations
        if (ORG_GATED_APPS.includes(appId) && orgEnabledIntegrations && !orgEnabledIntegrations.includes(appId)) return false;
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
        if (isAppOn('google-slides')) addTools(SLIDES_TOOLS);
        if (isAppOn('google-drive')) addTools(DRIVE_TOOLS);
        if (isAppOn('google-sheets')) addTools(SHEETS_TOOLS);
        if (isAppOn('google-docs')) addTools(DOCS_TOOLS);
        if (isAppOn('google-contacts')) addTools(CONTACTS_TOOLS);
        if (isAppOn('google-keep')) addTools(KEEP_TOOLS);
    }

    // Microsoft integrations — require Microsoft OAuth
    if (session?.oauthProvider === 'microsoft' && session?.accessToken) {
        if (isAppOn('outlook')) addTools(OUTLOOK_TOOLS);
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

    // Agent Search — self-hosted AI search with reranking
    const hasAgentSearchUrl = !!(await configStore.getConfig('agent_search_url'));
    if (hasAgentSearchUrl && isAppOn('agent-search')) {
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

    // N8N workflows — org-level config
    try {
        if (userOrgId) {
            n8nOrgId = userOrgId;
            const n8nUrl = await configStore.getConfig(`n8n_url_org_${n8nOrgId}`);
            const n8nKey = await configStore.getSecret(`n8n_api_key_org_${n8nOrgId}`);
            if (n8nUrl && n8nKey) {
                const n8nTools = await buildN8nTools(n8nOrgId);
                for (const n8nTool of n8nTools) {
                    const toolId = n8nTool.function.name;
                    // Respect user-level toggle for this specific workflow
                    if (userEnabledApps && !userEnabledApps.includes(toolId)) continue;
                    // Strip internal metadata before sending to LLM
                    const { _n8n, ...cleanTool } = n8nTool;
                    if (!tools.find(t => t.function.name === cleanTool.function.name)) {
                        tools.push(cleanTool);
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

    // Workspace — always available (no external credentials needed)
    if (isAppOn('workspace')) {
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
    if (tools.some(t => t.function.name.startsWith('slides_'))) integrations.push('Google Slides (list, read, create presentations and slides)');
    if (tools.some(t => t.function.name.startsWith('drive_'))) integrations.push('Google Drive (search, list, manage files and folders)');
    if (tools.some(t => t.function.name.startsWith('sheets_'))) integrations.push('Google Sheets (create, read, append, update spreadsheets)');
    if (tools.some(t => t.function.name.startsWith('docs_'))) integrations.push('Google Docs (create, read, append, replace text in documents)');
    if (tools.some(t => t.function.name.startsWith('contacts_'))) integrations.push('Google Contacts (search, list, create, update contacts — create/update require user approval)');
    if (tools.some(t => t.function.name.startsWith('keep_'))) integrations.push('Google Keep (list, get, create, delete notes — create/delete require user approval, enterprise Workspace only)');
    if (tools.some(t => t.function.name.startsWith('youtrack_'))) integrations.push('YouTrack (search, create, update issues)');
    if (tools.some(t => t.function.name.startsWith('fireflies_'))) integrations.push('Fireflies (meeting transcripts)');
    if (tools.some(t => t.function.name.startsWith('gamma_'))) integrations.push('Gamma (presentation generation)');
    if (tools.some(t => t.function.name.startsWith('n8n_'))) {
        const n8nNames = tools.filter(t => t.function.name.startsWith('n8n_')).map(t => t.function.description || t.function.name);
        integrations.push(`n8n Workflows (${n8nNames.join(', ')})`);
    }
    if (tools.some(t => t.function.name === 'generate_image')) integrations.push('Image generation');
    if (tools.some(t => t.function.name === 'generate_music')) integrations.push('Music generation (instrumental AI music via Lyria)');
    if (tools.some(t => t.function.name === 'generate_video')) integrations.push('Video generation (short AI video clips via Veo 3.1 — takes 1-3 minutes)');
    if (tools.some(t => t.function.name === 'agent_search')) integrations.push('Agent Search (AI-powered web search with reranking)');
    if (tools.some(t => t.function.name.startsWith('workspace_'))) integrations.push('Workspace (read and write a persistent document alongside the conversation)');
    if (tools.some(t => t.function.name === 'kb_search')) integrations.push('Knowledge Base Search (search internal knowledge base with custom queries — use this after reading emails or documents to find relevant internal information)');
    if (tools.some(t => t.function.name.startsWith('maps_'))) integrations.push('Google Maps (get directions between locations with route maps, search for places/businesses — IMPORTANT: after getting results, always output the map as a ```map-embed code block containing JSON with embedUrl, title, and mapsLink fields so it renders as an interactive map in the chat)');
    if (tools.some(t => t.function.name.startsWith('linkedin_'))) integrations.push('LinkedIn (create posts — user approves before publishing)');
    if (tools.some(t => t.function.name.startsWith('github_'))) integrations.push('GitHub (list repos, view code, create repos, manage branches)');
    if (tools.some(t => t.function.name.startsWith('whatsapp_'))) integrations.push('WhatsApp (list chats, read messages, compose with approval). WORKFLOW: 1) Use whatsapp_list_chats to find chats (supports search query). 2) Use whatsapp_read_messages with a contact name or JID from the list. 3) Use whatsapp_compose to draft a message — it will be shown to the user for approval before sending. Messages are captured from the moment the user connected, so very old history may not be available. Always use JIDs from whatsapp_list_chats for accuracy.');
    if (tools.some(t => t.function.name.startsWith('outlook_'))) integrations.push('Outlook Mail (search, read, compose, send, and reply to emails — the user approves before anything is sent)');
    if (tools.some(t => t.function.name.startsWith('ms_calendar_'))) integrations.push('Microsoft Calendar (list, search, create, update, delete events — create/update/delete require user approval)');
    if (tools.some(t => t.function.name.startsWith('onedrive_'))) integrations.push('OneDrive (search, list, manage files and folders)');
    if (tools.some(t => t.function.name.startsWith('ms_contacts_'))) integrations.push('Microsoft Contacts (search, list, create, update contacts — create/update require user approval)');
    if (tools.some(t => t.function.name === 'transcribe_audio')) integrations.push('Meeting Transcription (transcribe uploaded audio files with speaker diarization using Voxtral AI — supports up to 3 hours of audio, Dutch and other languages)');

    let hint = ' You have access to tools — use them when they would help answer the user\'s question. You can call multiple tools in parallel when appropriate.';
    if (integrations.length > 0) {
        hint += ` Your available integrations: ${integrations.join(', ')}.`;
    }

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
