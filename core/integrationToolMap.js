/**
 * Integration Tool Map — Maps tool names to their integration metadata.
 *
 * This centralized mapping identifies which tools are "external integrations"
 * and records the server/endpoint they connect to, the data direction,
 * and what categories of data they typically handle.
 *
 * Used by the tool dispatcher in chatStream.js / directChat.js to decide
 * whether a tool call should be logged in the integration_activity_log.
 */

const INTEGRATION_TOOL_MAP = {
    // ── Gmail ────────────────────────────────────────────────
    gmail_search: {
        integration: 'gmail',
        label: 'Gmail',
        serverFn: () => 'gmail.googleapis.com',
        direction: 'both',
        dataCategories: 'email_content, search_query',
    },
    gmail_read: {
        integration: 'gmail',
        label: 'Gmail',
        serverFn: () => 'gmail.googleapis.com',
        direction: 'received',
        dataCategories: 'email_content, senders, subject',
    },
    gmail_read_attachment: {
        integration: 'gmail',
        label: 'Gmail',
        serverFn: () => 'gmail.googleapis.com',
        direction: 'received',
        dataCategories: 'email_attachment, file_content',
    },
    gmail_compose: {
        integration: 'gmail',
        label: 'Gmail',
        serverFn: () => 'gmail.googleapis.com',
        direction: 'sent',
        dataCategories: 'email_content, recipients, subject',
    },

    // ── Outlook ──────────────────────────────────────────────
    outlook_search: {
        integration: 'outlook',
        label: 'Outlook',
        serverFn: () => 'graph.microsoft.com',
        direction: 'both',
        dataCategories: 'email_content, search_query',
    },
    outlook_read: {
        integration: 'outlook',
        label: 'Outlook',
        serverFn: () => 'graph.microsoft.com',
        direction: 'received',
        dataCategories: 'email_content, senders, subject',
    },
    outlook_compose: {
        integration: 'outlook',
        label: 'Outlook',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'email_content, recipients, subject',
    },

    // ── Legacy Email (generic) ──────────────────────────────
    send_email: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'gmail.googleapis.com',
        direction: 'sent',
        dataCategories: 'email_content, recipients, subject',
    },
    read_emails: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'gmail.googleapis.com',
        direction: 'received',
        dataCategories: 'email_content, senders, subject',
    },
    search_emails: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'gmail.googleapis.com',
        direction: 'both',
        dataCategories: 'email_content, search_query',
    },

    // ── Google Calendar ──────────────────────────────────────
    calendar_list_events: {
        integration: 'google_calendar',
        label: 'Google Calendar',
        serverFn: () => 'www.googleapis.com/calendar',
        direction: 'received',
        dataCategories: 'calendar_events, attendees',
    },
    calendar_search_events: {
        integration: 'google_calendar',
        label: 'Google Calendar',
        serverFn: () => 'www.googleapis.com/calendar',
        direction: 'both',
        dataCategories: 'calendar_events, search_query',
    },
    calendar_create_event: {
        integration: 'google_calendar',
        label: 'Google Calendar',
        serverFn: () => 'www.googleapis.com/calendar',
        direction: 'sent',
        dataCategories: 'calendar_events, attendees, location',
    },
    calendar_update_event: {
        integration: 'google_calendar',
        label: 'Google Calendar',
        serverFn: () => 'www.googleapis.com/calendar',
        direction: 'sent',
        dataCategories: 'calendar_events, attendees',
    },
    calendar_delete_event: {
        integration: 'google_calendar',
        label: 'Google Calendar',
        serverFn: () => 'www.googleapis.com/calendar',
        direction: 'sent',
        dataCategories: 'calendar_events',
    },

    // ── Legacy Calendar (generic) ────────────────────────────
    read_calendar: {
        integration: 'calendar',
        label: 'Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'received',
        dataCategories: 'calendar_events, attendees, organizer',
    },
    create_calendar_event: {
        integration: 'calendar',
        label: 'Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'calendar_events, attendees, location',
    },

    // ── Microsoft Calendar ───────────────────────────────────
    ms_calendar_list_events: {
        integration: 'ms_calendar',
        label: 'Microsoft Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'received',
        dataCategories: 'calendar_events, attendees',
    },
    ms_calendar_search_events: {
        integration: 'ms_calendar',
        label: 'Microsoft Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'both',
        dataCategories: 'calendar_events, search_query',
    },
    ms_calendar_create_event: {
        integration: 'ms_calendar',
        label: 'Microsoft Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'calendar_events, attendees, location',
    },
    ms_calendar_update_event: {
        integration: 'ms_calendar',
        label: 'Microsoft Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'calendar_events, attendees',
    },
    ms_calendar_delete_event: {
        integration: 'ms_calendar',
        label: 'Microsoft Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'calendar_events',
    },

    // ── Google Drive ─────────────────────────────────────────
    drive_search: {
        integration: 'google_drive',
        label: 'Google Drive',
        serverFn: () => 'www.googleapis.com/drive',
        direction: 'both',
        dataCategories: 'file_metadata, search_query',
    },
    drive_list_files: {
        integration: 'google_drive',
        label: 'Google Drive',
        serverFn: () => 'www.googleapis.com/drive',
        direction: 'received',
        dataCategories: 'file_metadata',
    },
    drive_get_file: {
        integration: 'google_drive',
        label: 'Google Drive',
        serverFn: () => 'www.googleapis.com/drive',
        direction: 'received',
        dataCategories: 'file_metadata',
    },
    drive_get_content: {
        integration: 'google_drive',
        label: 'Google Drive',
        serverFn: () => 'www.googleapis.com/drive',
        direction: 'received',
        dataCategories: 'file_content',
    },
    drive_move_file: {
        integration: 'google_drive',
        label: 'Google Drive',
        serverFn: () => 'www.googleapis.com/drive',
        direction: 'sent',
        dataCategories: 'file_metadata',
    },
    drive_create_folder: {
        integration: 'google_drive',
        label: 'Google Drive',
        serverFn: () => 'www.googleapis.com/drive',
        direction: 'sent',
        dataCategories: 'folder_metadata',
    },

    // ── OneDrive ─────────────────────────────────────────────
    onedrive_search: {
        integration: 'onedrive',
        label: 'OneDrive',
        serverFn: () => 'graph.microsoft.com',
        direction: 'both',
        dataCategories: 'file_metadata, search_query',
    },
    onedrive_list_files: {
        integration: 'onedrive',
        label: 'OneDrive',
        serverFn: () => 'graph.microsoft.com',
        direction: 'received',
        dataCategories: 'file_metadata',
    },
    onedrive_get_file: {
        integration: 'onedrive',
        label: 'OneDrive',
        serverFn: () => 'graph.microsoft.com',
        direction: 'received',
        dataCategories: 'file_content',
    },
    onedrive_create_folder: {
        integration: 'onedrive',
        label: 'OneDrive',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'folder_metadata',
    },

    // ── Google Docs ──────────────────────────────────────────
    docs_create: {
        integration: 'google_docs',
        label: 'Google Docs',
        serverFn: () => 'docs.googleapis.com',
        direction: 'sent',
        dataCategories: 'document_content',
    },
    docs_read: {
        integration: 'google_docs',
        label: 'Google Docs',
        serverFn: () => 'docs.googleapis.com',
        direction: 'received',
        dataCategories: 'document_content',
    },
    docs_append: {
        integration: 'google_docs',
        label: 'Google Docs',
        serverFn: () => 'docs.googleapis.com',
        direction: 'sent',
        dataCategories: 'document_content',
    },
    docs_replace_text: {
        integration: 'google_docs',
        label: 'Google Docs',
        serverFn: () => 'docs.googleapis.com',
        direction: 'sent',
        dataCategories: 'document_content',
    },

    // ── Google Contacts ──────────────────────────────────────
    contacts_search: {
        integration: 'google_contacts',
        label: 'Google Contacts',
        serverFn: () => 'people.googleapis.com',
        direction: 'both',
        dataCategories: 'contact_info, search_query',
    },
    contacts_list: {
        integration: 'google_contacts',
        label: 'Google Contacts',
        serverFn: () => 'people.googleapis.com',
        direction: 'received',
        dataCategories: 'contact_info',
    },
    contacts_create: {
        integration: 'google_contacts',
        label: 'Google Contacts',
        serverFn: () => 'people.googleapis.com',
        direction: 'sent',
        dataCategories: 'contact_info',
    },
    contacts_update: {
        integration: 'google_contacts',
        label: 'Google Contacts',
        serverFn: () => 'people.googleapis.com',
        direction: 'sent',
        dataCategories: 'contact_info',
    },

    // ── Microsoft Contacts ───────────────────────────────────
    ms_contacts_search: {
        integration: 'ms_contacts',
        label: 'Microsoft Contacts',
        serverFn: () => 'graph.microsoft.com',
        direction: 'both',
        dataCategories: 'contact_info, search_query',
    },
    ms_contacts_list: {
        integration: 'ms_contacts',
        label: 'Microsoft Contacts',
        serverFn: () => 'graph.microsoft.com',
        direction: 'received',
        dataCategories: 'contact_info',
    },
    ms_contacts_create: {
        integration: 'ms_contacts',
        label: 'Microsoft Contacts',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'contact_info',
    },
    ms_contacts_update: {
        integration: 'ms_contacts',
        label: 'Microsoft Contacts',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'contact_info',
    },

    // ── Google Keep ──────────────────────────────────────────
    keep_list: {
        integration: 'google_keep',
        label: 'Google Keep',
        serverFn: () => 'keep.googleapis.com',
        direction: 'received',
        dataCategories: 'notes',
    },
    keep_get: {
        integration: 'google_keep',
        label: 'Google Keep',
        serverFn: () => 'keep.googleapis.com',
        direction: 'received',
        dataCategories: 'notes',
    },
    keep_create: {
        integration: 'google_keep',
        label: 'Google Keep',
        serverFn: () => 'keep.googleapis.com',
        direction: 'sent',
        dataCategories: 'notes',
    },
    keep_delete: {
        integration: 'google_keep',
        label: 'Google Keep',
        serverFn: () => 'keep.googleapis.com',
        direction: 'sent',
        dataCategories: 'notes',
    },

    // ── Google Groups ────────────────────────────────────────
    groups_list_conversations: {
        integration: 'google_groups',
        label: 'Google Groups',
        serverFn: () => 'www.googleapis.com/groups',
        direction: 'received',
        dataCategories: 'group_messages',
    },
    groups_read_conversation: {
        integration: 'google_groups',
        label: 'Google Groups',
        serverFn: () => 'www.googleapis.com/groups',
        direction: 'received',
        dataCategories: 'group_messages, participants',
    },
    groups_reply: {
        integration: 'google_groups',
        label: 'Google Groups',
        serverFn: () => 'www.googleapis.com/groups',
        direction: 'sent',
        dataCategories: 'group_messages',
    },

    // ── Fireflies ────────────────────────────────────────────
    fireflies_list_transcripts: {
        integration: 'fireflies',
        label: 'Fireflies',
        serverFn: () => 'api.fireflies.ai',
        direction: 'received',
        dataCategories: 'meeting_metadata',
    },
    fireflies_get_summary: {
        integration: 'fireflies',
        label: 'Fireflies',
        serverFn: () => 'api.fireflies.ai',
        direction: 'received',
        dataCategories: 'meeting_summary, participants, action_items',
    },
    fireflies_get_transcript: {
        integration: 'fireflies',
        label: 'Fireflies',
        serverFn: () => 'api.fireflies.ai',
        direction: 'received',
        dataCategories: 'meeting_transcript, participants',
    },

    // ── YouTrack ─────────────────────────────────────────────
    youtrack_search_issues: {
        integration: 'youtrack',
        label: 'YouTrack',
        serverFn: () => process.env.YOUTRACK_URL || 'youtrack.cloud',
        direction: 'both',
        dataCategories: 'issue_data, search_query',
    },
    youtrack_get_issue: {
        integration: 'youtrack',
        label: 'YouTrack',
        serverFn: () => process.env.YOUTRACK_URL || 'youtrack.cloud',
        direction: 'received',
        dataCategories: 'issue_data',
    },
    youtrack_create_issue: {
        integration: 'youtrack',
        label: 'YouTrack',
        serverFn: () => process.env.YOUTRACK_URL || 'youtrack.cloud',
        direction: 'sent',
        dataCategories: 'issue_data',
    },
    youtrack_add_comment: {
        integration: 'youtrack',
        label: 'YouTrack',
        serverFn: () => process.env.YOUTRACK_URL || 'youtrack.cloud',
        direction: 'sent',
        dataCategories: 'issue_comment',
    },
    youtrack_update_issue: {
        integration: 'youtrack',
        label: 'YouTrack',
        serverFn: () => process.env.YOUTRACK_URL || 'youtrack.cloud',
        direction: 'sent',
        dataCategories: 'issue_data',
    },
    youtrack_list_projects: {
        integration: 'youtrack',
        label: 'YouTrack',
        serverFn: () => process.env.YOUTRACK_URL || 'youtrack.cloud',
        direction: 'received',
        dataCategories: 'project_metadata',
    },

    // ── SignRequest ───────────────────────────────────────────
    signrequest_send_document: {
        integration: 'signrequest',
        label: 'SignRequest',
        serverFn: () => 'api.signrequest.com',
        direction: 'sent',
        dataCategories: 'document_content, signers',
    },
    signrequest_check_status: {
        integration: 'signrequest',
        label: 'SignRequest',
        serverFn: () => 'api.signrequest.com',
        direction: 'received',
        dataCategories: 'document_status',
    },
    signrequest_list_documents: {
        integration: 'signrequest',
        label: 'SignRequest',
        serverFn: () => 'api.signrequest.com',
        direction: 'received',
        dataCategories: 'document_metadata',
    },
    signrequest_cancel: {
        integration: 'signrequest',
        label: 'SignRequest',
        serverFn: () => 'api.signrequest.com',
        direction: 'sent',
        dataCategories: 'document_metadata',
    },

    // ── Gamma (Presentations) ────────────────────────────────
    gamma_create_presentation: {
        integration: 'gamma',
        label: 'Gamma',
        serverFn: () => 'gamma.app',
        direction: 'sent',
        dataCategories: 'presentation_content',
    },

    // ── Web Search ───────────────────────────────────────────
    agent_search: {
        integration: 'web_search',
        label: 'Web Search',
        serverFn: () => 'api.serper.dev (Google Search)',
        direction: 'sent',
        dataCategories: 'search_query',
    },

    // ── Maps / Places ────────────────────────────────────────
    maps_search_places: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'location_query, coordinates',
    },
    maps_directions: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'addresses, coordinates',
    },
    search_maps: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'location_query, coordinates',
    },
    get_directions: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'addresses, coordinates',
    },

    // ── LinkedIn ─────────────────────────────────────────────
    linkedin_create_post: {
        integration: 'linkedin',
        label: 'LinkedIn',
        serverFn: () => 'api.linkedin.com',
        direction: 'sent',
        dataCategories: 'social_post_content',
    },

    // ── WhatsApp ─────────────────────────────────────────────
    whatsapp_list_chats: {
        integration: 'whatsapp',
        label: 'WhatsApp',
        serverFn: () => 'web.whatsapp.com (local bridge)',
        direction: 'received',
        dataCategories: 'chat_metadata',
    },
    whatsapp_read_messages: {
        integration: 'whatsapp',
        label: 'WhatsApp',
        serverFn: () => 'web.whatsapp.com (local bridge)',
        direction: 'received',
        dataCategories: 'messages, participants',
    },
    whatsapp_compose: {
        integration: 'whatsapp',
        label: 'WhatsApp',
        serverFn: () => 'web.whatsapp.com (local bridge)',
        direction: 'sent',
        dataCategories: 'messages, recipients',
    },

    // ── GitHub ────────────────────────────────────────────────
    github_list_repos: {
        integration: 'github',
        label: 'GitHub',
        serverFn: () => 'api.github.com',
        direction: 'received',
        dataCategories: 'repository_metadata',
    },
    github_get_repo: {
        integration: 'github',
        label: 'GitHub',
        serverFn: () => 'api.github.com',
        direction: 'received',
        dataCategories: 'repository_metadata',
    },
    github_create_repo: {
        integration: 'github',
        label: 'GitHub',
        serverFn: () => 'api.github.com',
        direction: 'sent',
        dataCategories: 'repository_metadata',
    },
    github_list_branches: {
        integration: 'github',
        label: 'GitHub',
        serverFn: () => 'api.github.com',
        direction: 'received',
        dataCategories: 'branch_metadata',
    },
    github_get_file: {
        integration: 'github',
        label: 'GitHub',
        serverFn: () => 'api.github.com',
        direction: 'received',
        dataCategories: 'file_content',
    },
    github_list_contents: {
        integration: 'github',
        label: 'GitHub',
        serverFn: () => 'api.github.com',
        direction: 'received',
        dataCategories: 'file_metadata',
    },

    // ── Transcription ────────────────────────────────────────
    transcribe_audio: {
        integration: 'transcription',
        label: 'Transcription',
        serverFn: () => process.env.WHISPER_URL || 'whisper-service (local)',
        direction: 'both',
        dataCategories: 'audio_content, transcript',
    },

    // ── Media Generation ─────────────────────────────────────
    generate_image: {
        integration: 'image_gen',
        label: 'Image Generation',
        serverFn: () => 'api.openai.com/images',
        direction: 'both',
        dataCategories: 'prompt, generated_image',
    },
    generate_video: {
        integration: 'video_gen',
        label: 'Video Generation',
        serverFn: () => 'api.bananadev.com',
        direction: 'both',
        dataCategories: 'prompt, generated_video',
    },
    generate_music: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'prompt, generated_audio',
    },
    generate_song: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'prompt, lyrics, generated_audio',
    },
    generate_tts: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'text_content, generated_audio',
    },
    generate_sfx: {
        integration: 'elevenlabs',
        label: 'ElevenLabs',
        serverFn: () => 'api.elevenlabs.io',
        direction: 'both',
        dataCategories: 'prompt, generated_audio',
    },

    // ── n8n Workflows ────────────────────────────────────────
    n8n_execute: {
        integration: 'n8n',
        label: 'n8n Workflow',
        serverFn: (args, ctx) => ctx?.n8nUrl || 'n8n-server (configured)',
        direction: 'both',
        dataCategories: 'workflow_payload',
    },

    // ── MCP (Model Context Protocol) ─────────────────────────
    // MCP tools are dynamic — handled via a pattern match in resolveIntegration()
};

// PII category descriptions for data sovereignty reports
const PII_CATEGORIES = [
    'Person Name', 'Email Address', 'Phone Number', 'Physical Address',
    'Credit Card', 'Bank Account', 'IBAN', 'SSN', 'Passport Number',
    'IP Address', 'URL', "Driver's License", 'EU National ID / BSN',
];

/**
 * Resolve tool metadata for logging.
 *
 * @param {string} toolName - The tool_name from the function call
 * @param {object} toolArgs - The arguments passed to the tool
 * @param {object} ctx - Runtime context (n8n URL, MCP config, etc.)
 * @returns {object|null} { integration, label, server, direction, dataCategories } or null for non-integration tools
 */
function resolveIntegration(toolName, toolArgs = {}, ctx = {}) {
    // Direct match
    const mapped = INTEGRATION_TOOL_MAP[toolName];
    if (mapped) {
        return {
            integration: mapped.integration,
            label: mapped.label,
            server: typeof mapped.serverFn === 'function' ? mapped.serverFn(toolArgs, ctx) : mapped.serverFn,
            direction: mapped.direction,
            dataCategories: mapped.dataCategories,
        };
    }

    // MCP tool pattern: mcp__<server>__<tool>
    if (toolName?.startsWith('mcp__') || toolName?.startsWith('mcp_')) {
        const parts = toolName.split('__');
        const mcpServer = parts[1] || 'unknown';
        return {
            integration: 'mcp',
            label: `MCP: ${mcpServer}`,
            server: ctx?.mcpEndpoint || `mcp-server://${mcpServer}`,
            direction: 'both',
            dataCategories: 'mcp_payload',
        };
    }

    // n8n dynamic tools (prefixed)
    if (toolName?.startsWith('n8n_')) {
        return {
            integration: 'n8n',
            label: 'n8n Workflow',
            server: ctx?.n8nUrl || 'n8n-server',
            direction: 'both',
            dataCategories: 'workflow_payload',
        };
    }

    // Not an external integration tool
    return null;
}

module.exports = {
    INTEGRATION_TOOL_MAP,
    PII_CATEGORIES,
    resolveIntegration,
};
