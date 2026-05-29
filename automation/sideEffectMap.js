/**
 * Side-Effect Map — declares which tool names produce externally-visible effects.
 *
 * The runner uses this to (a) refuse side-effect calls during dry-run,
 * (b) require a one-time first-run confirmation before unleashing the
 * automation unattended.
 *
 * **Policy: fail-closed.** Any tool not listed below is treated as
 * sideEffect = true. This means new write-capable integrations get
 * conservative handling automatically.
 */

const READ_ONLY = new Set([
    // Gmail
    'gmail_search', 'gmail_read', 'gmail_read_attachment', 'gmail_list_labels',
    // Calendar
    'calendar_list_events', 'calendar_search_events', 'calendar_get_event',
    // Drive / Docs / Sheets
    'drive_search', 'drive_list_files', 'drive_read_file',
    'docs_read', 'docs_list',
    'sheets_list', 'sheets_get_values',
    'slides_list', 'slides_get', 'slides_export_pdf',
    // Contacts / Keep / Groups
    'contacts_search', 'contacts_list',
    'keep_list', 'keep_search',
    // Outlook / MS
    'outlook_search', 'outlook_read', 'outlook_list_folders',
    'ms_calendar_list_events', 'ms_calendar_get_event',
    'onedrive_search', 'onedrive_list',
    'ms_contacts_search', 'ms_contacts_list',
    // YouTrack / GitHub / LinkedIn read-only
    'youtrack_search_issues', 'youtrack_get_issue', 'youtrack_get_issue_comments',
    'github_search_repos', 'github_get_repo', 'github_list_issues', 'github_get_issue',
    'linkedin_search_profiles', 'linkedin_get_profile',
    // Maps / Search / KB
    'maps_search_places', 'maps_geocode', 'maps_directions',
    'agent_search', 'kb_search',
    // Fireflies
    'fireflies_search_meetings', 'fireflies_get_meeting',
    // ── Nextcloud (read-only) — names verified against the tool modules ──
    // Files & WebDAV
    'nextcloud_list_files', 'nextcloud_search_files', 'nextcloud_read_file',
    'nextcloud_list_shares', 'nextcloud_list_file_comments',
    'nextcloud_list_tags', 'nextcloud_find_files_by_tag',
    'nextcloud_list_trash', 'nextcloud_list_versions',
    // Calendar
    'nextcloud_calendar_list', 'nextcloud_calendar_list_events',
    'nextcloud_calendar_search_events', 'nextcloud_calendar_get_event',
    // Contacts
    'nextcloud_contacts_list_addressbooks', 'nextcloud_contacts_list',
    'nextcloud_contacts_search', 'nextcloud_contacts_get',
    // Deck
    'nextcloud_deck_list_boards', 'nextcloud_deck_get_board',
    'nextcloud_deck_list_stacks', 'nextcloud_deck_list_cards',
    'nextcloud_deck_search_cards', 'nextcloud_deck_get_card',
    'nextcloud_deck_list_comments',
    // Talk
    'nextcloud_talk_list_rooms', 'nextcloud_talk_get_room',
    'nextcloud_talk_list_messages', 'nextcloud_talk_search_messages',
    // Tasks
    'nextcloud_tasks_list_lists', 'nextcloud_tasks_list',
    'nextcloud_tasks_search', 'nextcloud_tasks_get',
    // Notes
    'nextcloud_notes_list', 'nextcloud_notes_search',
    'nextcloud_notes_get', 'nextcloud_notes_list_categories',
    // Notifications / Activity / Status
    'nextcloud_notifications_list',
    'nextcloud_activity_list', 'nextcloud_activity_list_for_file',
    'nextcloud_status_get',
    // Nextcloud Mail (read-only)
    'nextcloud_mail_list_accounts', 'nextcloud_mail_list_mailboxes',
    'nextcloud_mail_search', 'nextcloud_mail_read', 'nextcloud_mail_read_attachment',
    // Webpages (read-only — writes are listed implicitly via fail-closed default)
    'webpages_list', 'webpage_db_schema', 'webpage_db_query', 'webpage_file_read',
]);

/**
 * Returns true when calling this tool produces a user-visible side-effect.
 * Fail-closed: unlisted tools are treated as side-effecting.
 */
function isSideEffect(toolName) {
    if (!toolName || typeof toolName !== 'string') return true;
    return !READ_ONLY.has(toolName);
}

module.exports = { isSideEffect, READ_ONLY };
