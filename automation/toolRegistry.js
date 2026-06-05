/**
 * Tool Registry — maps each app to its TOOLS array module so the catalog
 * endpoint can introspect existing integration tool definitions.
 *
 * `enabledKey` mirrors the keys used by integrationTools.js's isAppOn() check,
 * so the catalog only surfaces apps the user has actually connected/enabled.
 *
 * `availableTo` declares which execution contexts the app's tools may be
 * surfaced in. Phase 1 metadata only — consumers continue to use ad-hoc
 * imports today; later phases switch them to query this metadata via
 * `availableForContext()`. Valid contexts:
 *   - 'agent'           — agent runtime (chat tool-use loop)
 *   - 'routine_step'    — automation step (integration_action)
 *   - 'routine_trigger' — surface as a routine trigger (currently only used
 *                          by the trigger bus; here for future symmetry)
 *
 * The default is `['agent', 'routine_step']` — both contexts. Apps that
 * are currently agent-only (kb-search, agent-search) keep their narrow
 * scope until §16 flips them.
 */

const DEFAULT_AVAILABILITY = ['agent', 'routine_step'];

const TOOL_REGISTRY = [
    { app: 'gmail',                   label: 'Gmail',                  module: '../integrations/gmailTools',                arrayName: 'GMAIL_TOOLS',                enabledKey: 'gmail' },
    { app: 'google-calendar',         label: 'Google Calendar',        module: '../integrations/calendarTools',             arrayName: 'CALENDAR_TOOLS',             enabledKey: 'google-calendar' },
    { app: 'google-drive',            label: 'Google Drive',           module: '../integrations/driveTools',                arrayName: 'DRIVE_TOOLS',                enabledKey: 'google-drive' },
    { app: 'google-docs',             label: 'Google Docs',            module: '../integrations/docsTools',                 arrayName: 'DOCS_TOOLS',                 enabledKey: 'google-docs' },
    { app: 'google-sheets',           label: 'Google Sheets',          module: '../integrations/sheetsTools',               arrayName: 'SHEETS_TOOLS',               enabledKey: 'google-sheets' },
    { app: 'google-slides',           label: 'Google Slides',          module: '../integrations/slidesTools',               arrayName: 'SLIDES_TOOLS',               enabledKey: 'google-slides' },
    { app: 'google-contacts',         label: 'Google Contacts',        module: '../integrations/contactsTools',             arrayName: 'CONTACTS_TOOLS',             enabledKey: 'google-contacts' },
    { app: 'google-keep',             label: 'Google Keep',            module: '../integrations/keepTools',                 arrayName: 'KEEP_TOOLS',                 enabledKey: 'google-keep' },
    { app: 'google-groups',           label: 'Google Groups',          module: '../integrations/googleGroupsTools',         arrayName: 'GOOGLE_GROUPS_TOOLS',        enabledKey: 'google-groups' },
    { app: 'fireflies',               label: 'Fireflies',              module: '../integrations/firefliesTools',            arrayName: 'FIREFLIES_TOOLS',            enabledKey: 'fireflies' },
    { app: 'youtrack',                label: 'YouTrack',               module: '../integrations/youtrackTools',             arrayName: 'YOUTRACK_TOOLS',             enabledKey: 'youtrack' },
    { app: 'signrequest',             label: 'SignRequest',            module: '../integrations/signrequestTools',          arrayName: 'SIGNREQUEST_TOOLS',          enabledKey: 'signrequest' },
    { app: 'gamma',                   label: 'Gamma',                  module: '../integrations/gammaTools',                arrayName: 'GAMMA_TOOLS',                enabledKey: 'gamma' },
    { app: 'agent-search',            label: 'Web Search',             module: '../integrations/agentSearchTools',          arrayName: 'AGENT_SEARCH_TOOLS',         enabledKey: 'agent-search',         availableTo: ['agent', 'routine_step'] },
    { app: 'maps',                    label: 'Google Maps',            module: '../integrations/mapsTools',                 arrayName: 'MAPS_TOOLS',                 enabledKey: 'google-maps' },
    { app: 'linkedin',                label: 'LinkedIn',               module: '../integrations/linkedinTools',             arrayName: 'LINKEDIN_TOOLS',             enabledKey: 'linkedin' },
    { app: 'github',                  label: 'GitHub',                 module: '../integrations/githubTools',               arrayName: 'GITHUB_TOOLS',               enabledKey: 'github' },
    { app: 'outlook',                 label: 'Outlook',                module: '../integrations/outlookTools',              arrayName: 'OUTLOOK_TOOLS',              enabledKey: 'outlook' },
    { app: 'ms-calendar',             label: 'Microsoft Calendar',     module: '../integrations/msCalendarTools',           arrayName: 'MS_CALENDAR_TOOLS',          enabledKey: 'ms-calendar' },
    { app: 'onedrive',                label: 'OneDrive',               module: '../integrations/oneDriveTools',             arrayName: 'ONEDRIVE_TOOLS',             enabledKey: 'onedrive' },
    { app: 'ms-contacts',             label: 'Microsoft Contacts',     module: '../integrations/msContactsTools',           arrayName: 'MS_CONTACTS_TOOLS',          enabledKey: 'ms-contacts' },
    { app: 'kb-search',               label: 'Knowledge Base',         module: '../integrations/kbSearchTools',             enabledKey: 'kb-search',          arrayName: 'KB_SEARCH_TOOLS',            availableTo: ['agent', 'routine_step'] },
    { app: 'kb-ingest',               label: 'Knowledge Base Ingest',  module: '../integrations/kbIngestTools',             enabledKey: 'kb-ingest',          arrayName: 'KB_INGEST_TOOLS',            availableTo: ['routine_step'] },
    { app: 'nextcloud',               label: 'Nextcloud',              module: '../integrations/nextcloudTools',            arrayName: 'NEXTCLOUD_TOOLS',            enabledKey: 'nextcloud' },
    { app: 'nextcloud-calendar',      label: 'Nextcloud Calendar',     module: '../integrations/nextcloudCalendarTools',    arrayName: 'NEXTCLOUD_CALENDAR_TOOLS',   enabledKey: 'nextcloud-calendar' },
    { app: 'nextcloud-contacts',      label: 'Nextcloud Contacts',     module: '../integrations/nextcloudContactsTools',    arrayName: 'NEXTCLOUD_CONTACTS_TOOLS',   enabledKey: 'nextcloud-contacts' },
    { app: 'nextcloud-deck',          label: 'Nextcloud Deck',         module: '../integrations/nextcloudDeckTools',        arrayName: 'NEXTCLOUD_DECK_TOOLS',       enabledKey: 'nextcloud-deck' },
    { app: 'nextcloud-talk',          label: 'Nextcloud Talk',         module: '../integrations/nextcloudTalkTools',        arrayName: 'NEXTCLOUD_TALK_TOOLS',       enabledKey: 'nextcloud-talk' },
    { app: 'nextcloud-tasks',         label: 'Nextcloud Tasks',        module: '../integrations/nextcloudTasksTools',       arrayName: 'NEXTCLOUD_TASKS_TOOLS',      enabledKey: 'nextcloud-tasks' },
    { app: 'nextcloud-notes',         label: 'Nextcloud Notes',        module: '../integrations/nextcloudNotesTools',       arrayName: 'NEXTCLOUD_NOTES_TOOLS',      enabledKey: 'nextcloud-notes' },
    { app: 'nextcloud-mail',          label: 'Nextcloud Mail',         module: '../integrations/nextcloudMailTools',        arrayName: 'NEXTCLOUD_MAIL_TOOLS',       enabledKey: 'nextcloud-mail' },
    { app: 'nextcloud-activity',      label: 'Nextcloud Activity',     module: '../integrations/nextcloudActivityTools',    arrayName: 'NEXTCLOUD_ACTIVITY_TOOLS',   enabledKey: 'nextcloud-activity' },
    { app: 'nextcloud-notifications', label: 'Nextcloud Notifications',module: '../integrations/nextcloudNotificationsTools', arrayName: 'NEXTCLOUD_NOTIFICATIONS_TOOLS', enabledKey: 'nextcloud-notifications' },
    { app: 'nextcloud-status',        label: 'Nextcloud Status',       module: '../integrations/nextcloudStatusTools',      arrayName: 'NEXTCLOUD_STATUS_TOOLS',     enabledKey: 'nextcloud-status' },
    { app: 'n8n',                     label: 'n8n',                    module: '../integrations/n8nWorkflowTools',          arrayName: 'N8N_WORKFLOW_TOOLS',         enabledKey: 'n8n' },
    { app: 'webpages',                label: 'Webpages',               module: '../integrations/webpageAutomationTools',    arrayName: 'WEBPAGE_AUTOMATION_TOOLS',   enabledKey: 'webpages' },
    // ── AI-only integrations promoted to first-class automation actions ──
    // Tool dispatchers for these already exist in core/toolDispatcher.js
    // (chat path uses them too); registry entries surface them in the
    // automation catalog so the palette can drag them onto the canvas.
    { app: 'image-gen',               label: 'Image Generation',       module: '../routes/ai/imageGenTool',                 arrayName: 'IMAGE_GEN_TOOLS',            enabledKey: 'image-gen' },
    { app: 'video-gen',               label: 'Video Generation',       module: '../routes/ai/videoGenTool',                 arrayName: 'VIDEO_GEN_TOOLS',            enabledKey: 'video-gen' },
    { app: 'elevenlabs',              label: 'ElevenLabs',             module: '../routes/ai/elevenLabsTools',              arrayName: 'ELEVENLABS_TOOLS',           enabledKey: 'elevenlabs' },
    { app: 'transcription',           label: 'Transcription',          module: '../integrations/transcriptionTools',        arrayName: 'TRANSCRIPTION_TOOLS',        enabledKey: 'transcription' },
    { app: 'outlook-readonly',        label: 'Outlook (read-only)',    module: '../integrations/outlookTools',              arrayName: 'OUTLOOK_READONLY_TOOLS',     enabledKey: 'outlook-readonly' },
];

/**
 * Load the TOOLS array for an app entry. Returns [] on failure.
 */
function loadTools(entry) {
    try {
        // eslint-disable-next-line global-require
        const mod = require(entry.module);
        const arr = mod[entry.arrayName];
        return Array.isArray(arr) ? arr : [];
    } catch (e) {
        console.warn(`[toolRegistry] Failed to load ${entry.app} (${entry.module}):`, e.message);
        return [];
    }
}

/**
 * Find the registry entry that owns a specific tool name.
 * Returns null if no app claims the tool.
 */
function findOwnerOfTool(toolName) {
    for (const entry of TOOL_REGISTRY) {
        const tools = loadTools(entry);
        if (tools.some(t => t?.function?.name === toolName)) return entry;
    }
    return null;
}

/**
 * Return the declared availability for an app — entry-level override
 * if present, otherwise the registry-wide default. Centralised so any
 * future consumer reads one source of truth.
 */
function availabilityFor(entry) {
    if (entry && Array.isArray(entry.availableTo)) return entry.availableTo;
    return DEFAULT_AVAILABILITY;
}

/**
 * Filter the registry to apps that are available in a given execution
 * context. Phase 1 wiring is metadata-only: consumers (agent runtime,
 * automation builder) still import their tools directly today; later
 * phases switch them to this helper so a single edit on the registry
 * row controls whether the tool surfaces in chats vs canvases.
 */
function availableForContext(context) {
    if (!context) return TOOL_REGISTRY.slice();
    return TOOL_REGISTRY.filter(entry => availabilityFor(entry).includes(context));
}

module.exports = {
    TOOL_REGISTRY,
    DEFAULT_AVAILABILITY,
    loadTools,
    findOwnerOfTool,
    availabilityFor,
    availableForContext,
};
