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
    // Drive / Docs
    'drive_search', 'drive_list_files', 'drive_read_file',
    'docs_read', 'docs_list',
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
    // Fireflies / Nextcloud read
    'fireflies_search_meetings', 'fireflies_get_meeting',
    'nextcloud_list', 'nextcloud_read',
    'nextcloud_calendar_list_events',
    'nextcloud_contacts_list', 'nextcloud_contacts_search',
    'nextcloud_deck_list', 'nextcloud_deck_list_boards', 'nextcloud_deck_list_stacks', 'nextcloud_deck_list_cards', 'nextcloud_deck_list_comments',
    'nextcloud_tasks_list', 'nextcloud_notes_list',
    'nextcloud_activity_list', 'nextcloud_status_get',
    // Nextcloud Mail (read-only)
    'nextcloud_mail_list_accounts', 'nextcloud_mail_list_mailboxes',
    'nextcloud_mail_search', 'nextcloud_mail_read', 'nextcloud_mail_read_attachment',
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
