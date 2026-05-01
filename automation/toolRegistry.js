/**
 * Tool Registry — maps each app to its TOOLS array module so the catalog
 * endpoint can introspect existing integration tool definitions.
 *
 * `enabledKey` mirrors the keys used by integrationTools.js's isAppOn() check,
 * so the catalog only surfaces apps the user has actually connected/enabled.
 */

const TOOL_REGISTRY = [
    { app: 'gmail',                   label: 'Gmail',                  module: '../integrations/gmailTools',                arrayName: 'GMAIL_TOOLS',                enabledKey: 'gmail' },
    { app: 'google-calendar',         label: 'Google Calendar',        module: '../integrations/calendarTools',             arrayName: 'CALENDAR_TOOLS',             enabledKey: 'google-calendar' },
    { app: 'google-drive',            label: 'Google Drive',           module: '../integrations/driveTools',                arrayName: 'DRIVE_TOOLS',                enabledKey: 'google-drive' },
    { app: 'google-docs',             label: 'Google Docs',            module: '../integrations/docsTools',                 arrayName: 'DOCS_TOOLS',                 enabledKey: 'google-docs' },
    { app: 'google-contacts',         label: 'Google Contacts',        module: '../integrations/contactsTools',             arrayName: 'CONTACTS_TOOLS',             enabledKey: 'google-contacts' },
    { app: 'google-keep',             label: 'Google Keep',            module: '../integrations/keepTools',                 arrayName: 'KEEP_TOOLS',                 enabledKey: 'google-keep' },
    { app: 'google-groups',           label: 'Google Groups',          module: '../integrations/googleGroupsTools',         arrayName: 'GOOGLE_GROUPS_TOOLS',        enabledKey: 'google-groups' },
    { app: 'fireflies',               label: 'Fireflies',              module: '../integrations/firefliesTools',            arrayName: 'FIREFLIES_TOOLS',            enabledKey: 'fireflies' },
    { app: 'youtrack',                label: 'YouTrack',               module: '../integrations/youtrackTools',             arrayName: 'YOUTRACK_TOOLS',             enabledKey: 'youtrack' },
    { app: 'signrequest',             label: 'SignRequest',            module: '../integrations/signrequestTools',          arrayName: 'SIGNREQUEST_TOOLS',          enabledKey: 'signrequest' },
    { app: 'gamma',                   label: 'Gamma',                  module: '../integrations/gammaTools',                arrayName: 'GAMMA_TOOLS',                enabledKey: 'gamma' },
    { app: 'agent-search',            label: 'Web Search',             module: '../integrations/agentSearchTools',          arrayName: 'AGENT_SEARCH_TOOLS',         enabledKey: 'agent-search' },
    { app: 'maps',                    label: 'Google Maps',            module: '../integrations/mapsTools',                 arrayName: 'MAPS_TOOLS',                 enabledKey: 'google-maps' },
    { app: 'linkedin',                label: 'LinkedIn',               module: '../integrations/linkedinTools',             arrayName: 'LINKEDIN_TOOLS',             enabledKey: 'linkedin' },
    { app: 'whatsapp',                label: 'WhatsApp',               module: '../integrations/whatsappTools',             arrayName: 'WHATSAPP_TOOLS',             enabledKey: 'whatsapp' },
    { app: 'github',                  label: 'GitHub',                 module: '../integrations/githubTools',               arrayName: 'GITHUB_TOOLS',               enabledKey: 'github' },
    { app: 'outlook',                 label: 'Outlook',                module: '../integrations/outlookTools',              arrayName: 'OUTLOOK_TOOLS',              enabledKey: 'outlook' },
    { app: 'ms-calendar',             label: 'Microsoft Calendar',     module: '../integrations/msCalendarTools',           arrayName: 'MS_CALENDAR_TOOLS',          enabledKey: 'ms-calendar' },
    { app: 'onedrive',                label: 'OneDrive',               module: '../integrations/oneDriveTools',             arrayName: 'ONEDRIVE_TOOLS',             enabledKey: 'onedrive' },
    { app: 'ms-contacts',             label: 'Microsoft Contacts',     module: '../integrations/msContactsTools',           arrayName: 'MS_CONTACTS_TOOLS',          enabledKey: 'ms-contacts' },
    { app: 'kb-search',               label: 'Knowledge Base',         module: '../integrations/kbSearchTools',             arrayName: 'KB_SEARCH_TOOLS',            enabledKey: 'kb-search' },
    { app: 'nextcloud',               label: 'Nextcloud',              module: '../integrations/nextcloudTools',            arrayName: 'NEXTCLOUD_TOOLS',            enabledKey: 'nextcloud' },
    { app: 'nextcloud-calendar',      label: 'Nextcloud Calendar',     module: '../integrations/nextcloudCalendarTools',    arrayName: 'NEXTCLOUD_CALENDAR_TOOLS',   enabledKey: 'nextcloud-calendar' },
    { app: 'nextcloud-contacts',      label: 'Nextcloud Contacts',     module: '../integrations/nextcloudContactsTools',    arrayName: 'NEXTCLOUD_CONTACTS_TOOLS',   enabledKey: 'nextcloud-contacts' },
    { app: 'nextcloud-deck',          label: 'Nextcloud Deck',         module: '../integrations/nextcloudDeckTools',        arrayName: 'NEXTCLOUD_DECK_TOOLS',       enabledKey: 'nextcloud-deck' },
    { app: 'nextcloud-talk',          label: 'Nextcloud Talk',         module: '../integrations/nextcloudTalkTools',        arrayName: 'NEXTCLOUD_TALK_TOOLS',       enabledKey: 'nextcloud-talk' },
    { app: 'nextcloud-tasks',         label: 'Nextcloud Tasks',        module: '../integrations/nextcloudTasksTools',       arrayName: 'NEXTCLOUD_TASKS_TOOLS',      enabledKey: 'nextcloud-tasks' },
    { app: 'nextcloud-notes',         label: 'Nextcloud Notes',        module: '../integrations/nextcloudNotesTools',       arrayName: 'NEXTCLOUD_NOTES_TOOLS',      enabledKey: 'nextcloud-notes' },
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

module.exports = { TOOL_REGISTRY, loadTools, findOwnerOfTool };
