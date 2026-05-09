/**
 * Single source of truth for the 11 Nextcloud integrations that an org-admin
 * can toggle for a NC-bound organisation.
 *
 * The IDs match the existing isAppOn() gates in integrationTools.js — never
 * rename them without also updating the gates and the persisted
 * `organizations.enabledIntegrations` arrays.
 *
 * Used by:
 *   - server/routes/admin/ncIntegrations.js   (whitelist for org-admin writes)
 *   - server/core/integrationTools.js          (per-group deny-check scope)
 *   - agent-hub OrgNcIntegrationsPanel        (UI rows + labels)
 */

const NC_INTEGRATIONS = [
    { id: 'nextcloud',                name: 'Files & WebDAV',  description: 'List, search, read, upload, share files' },
    { id: 'nextcloud-calendar',       name: 'Calendar',        description: 'CalDAV — list, search, create, update, delete events' },
    { id: 'nextcloud-contacts',       name: 'Contacts',        description: 'CardDAV — list, search, create, update, delete contacts' },
    { id: 'nextcloud-deck',           name: 'Deck',            description: 'Kanban — boards, stacks, cards, labels, comments' },
    { id: 'nextcloud-mail',           name: 'Mail',            description: 'Read and send mail through Nextcloud Mail' },
    { id: 'nextcloud-notifications',  name: 'Notifications',   description: 'List and dismiss Nextcloud notifications' },
    { id: 'nextcloud-talk',           name: 'Talk',            description: 'Chat rooms, messages, reactions' },
    { id: 'nextcloud-tasks',          name: 'Tasks',           description: 'VTODO via CalDAV — list, create, update, complete' },
    { id: 'nextcloud-notes',          name: 'Notes',           description: 'Plain-text / markdown notes' },
    { id: 'nextcloud-activity',       name: 'Activity',        description: 'Read-only feed of recent file changes, shares, mentions' },
    { id: 'nextcloud-status',         name: 'User Status',     description: "Get / set / clear the user's availability and custom message" },
];

const NC_INTEGRATION_IDS = NC_INTEGRATIONS.map(i => i.id);
const NC_INTEGRATION_ID_SET = new Set(NC_INTEGRATION_IDS);

function isNcIntegrationId(id) {
    return NC_INTEGRATION_ID_SET.has(id);
}

function filterToNcIds(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(isNcIntegrationId);
}

module.exports = {
    NC_INTEGRATIONS,
    NC_INTEGRATION_IDS,
    NC_INTEGRATION_ID_SET,
    isNcIntegrationId,
    filterToNcIds,
};
