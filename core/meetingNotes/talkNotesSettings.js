/**
 * Nextcloud Talk → Meeting Notes settings (org + user dual scope).
 *
 * Mirrors the privacy-shield pattern (`server/core/orgShield.js`): an org-level
 * config doc and a user-level config doc, resolved with the ORG value winning
 * per field, falling back to the user value, then a built-in default. Stored
 * via configStore under:
 *   - org_talk_notes_${orgId}
 *   - user_talk_notes_${userId}
 *
 * Fields:
 *   - autoTranscribe       when a new Talk recording appears, auto-create a note
 *   - postSummaryBack      post the summary + action items back into the Talk room
 *   - recordingFolder      the Nextcloud Files folder Talk saves recordings to
 *   - language             default transcription language for auto-ingest
 *   - defaultOwnerUserId   (org only) fallback note owner when the recording's
 *                          actor can't be mapped to a Bee Flow user (bot actor)
 */

const configStore = require('../../stores/configStore');

const DEFAULTS = {
    autoTranscribe: false,
    postSummaryBack: false,
    recordingFolder: '/Talk',
    language: 'nl',
    defaultOwnerUserId: null,
};

function orgKey(orgId) { return `org_talk_notes_${orgId}`; }
function userKey(userId) { return `user_talk_notes_${userId}`; }

/**
 * Resolve effective settings. Org value wins per-field, else user, else default.
 */
async function resolveTalkNotesSettings({ orgId = null, userId = null } = {}) {
    const org = orgId ? await configStore.getConfig(orgKey(orgId)).catch(() => null) : null;
    const user = userId ? await configStore.getConfig(userKey(userId)).catch(() => null) : null;
    const pick = (k) => (org && k in org) ? org[k]
        : (user && k in user) ? user[k]
        : DEFAULTS[k];
    return {
        autoTranscribe: !!pick('autoTranscribe'),
        postSummaryBack: !!pick('postSummaryBack'),
        recordingFolder: (pick('recordingFolder') || '/Talk').trim() || '/Talk',
        language: pick('language') || 'nl',
        // defaultOwnerUserId is an org-only concept.
        defaultOwnerUserId: (org && org.defaultOwnerUserId) || null,
    };
}

async function getOrgSettings(orgId) {
    const stored = orgId ? await configStore.getConfig(orgKey(orgId)) : null;
    return { ...DEFAULTS, ...(stored || {}) };
}

async function getUserSettings(userId) {
    const stored = userId ? await configStore.getConfig(userKey(userId)) : null;
    // defaultOwnerUserId is org-only; don't surface it on the user doc.
    const { defaultOwnerUserId, ...userDefaults } = DEFAULTS;
    return { ...userDefaults, ...(stored || {}) };
}

function sanitizeFolder(folder) {
    const cleaned = '/' + String(folder || '/Talk').split('/').filter(Boolean).join('/');
    return cleaned === '/' ? '/Talk' : cleaned;
}

async function saveOrgSettings(orgId, patch, updatedBy) {
    const config = {
        autoTranscribe: !!patch.autoTranscribe,
        postSummaryBack: !!patch.postSummaryBack,
        recordingFolder: sanitizeFolder(patch.recordingFolder),
        language: patch.language || 'nl',
        defaultOwnerUserId: patch.defaultOwnerUserId || null,
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || null,
    };
    await configStore.setConfig(orgKey(orgId), config);
    return config;
}

async function saveUserSettings(userId, patch) {
    const config = {
        autoTranscribe: !!patch.autoTranscribe,
        postSummaryBack: !!patch.postSummaryBack,
        recordingFolder: sanitizeFolder(patch.recordingFolder),
        language: patch.language || 'nl',
        updatedAt: new Date().toISOString(),
        updatedBy: userId,
    };
    await configStore.setConfig(userKey(userId), config);
    return config;
}

module.exports = {
    DEFAULTS,
    resolveTalkNotesSettings,
    getOrgSettings,
    getUserSettings,
    saveOrgSettings,
    saveUserSettings,
};
