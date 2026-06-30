/**
 * Nextcloud Talk → Meeting Notes settings (org + user dual scope).
 *
 * Mirrors the privacy-shield pattern (`server/core/orgShield.js`): an org-level
 * config doc and a user-level config doc, resolved with the ORG value winning
 * per scalar field, falling back to the user value, then a built-in default.
 * Stored via configStore under:
 *   - org_talk_notes_${orgId}
 *   - user_talk_notes_${userId}
 *
 * Fields:
 *   - autoTranscribe       when a new Talk recording appears, auto-create a note
 *   - postSummaryBack      post the summary + action items back into the Talk room
 *   - recordingFolder      the Nextcloud Files folder Talk saves recordings to
 *   - language             default transcription language for auto-ingest
 *   - autoRecord           automatically START recording the user's active Talk calls
 *   - autoRecordScope      'calendar' (only scheduled meetings) | 'all' (any moderated call)
 *   - recordingMode        'audio' | 'video' — what auto-record captures
 *   - excludedEventUids[]  per-meeting opt-outs (user-scoped; union with org)
 *   - excludedRoomTokens[] per-room opt-outs (user-scoped; union with org)
 *   - defaultOwnerUserId   (org only) fallback note owner when the recording's
 *                          actor can't be mapped to a Bee Flow user (bot actor)
 *
 * Scalar toggles use org-overrides-user. Exclusion arrays are UNIONED across
 * org + user so an org can globally exclude a meeting and a user can
 * additionally exclude their own.
 */

const configStore = require('../../stores/configStore');

const DEFAULTS = {
    autoTranscribe: false,
    postSummaryBack: false,
    recordingFolder: '/Talk',
    language: 'nl',
    autoRecord: false,
    autoRecordScope: 'calendar',   // 'calendar' | 'all'
    recordingMode: 'audio',        // 'audio' | 'video'
    excludedEventUids: [],
    excludedRoomTokens: [],
    defaultOwnerUserId: null,
};

function orgKey(orgId) { return `org_talk_notes_${orgId}`; }
function userKey(userId) { return `user_talk_notes_${userId}`; }

function asScope(v) { return v === 'all' ? 'all' : 'calendar'; }
function asMode(v) { return v === 'video' ? 'video' : 'audio'; }
function asStrArray(v) { return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []; }
function unionStr(a, b) { return Array.from(new Set([...asStrArray(a), ...asStrArray(b)])); }

/**
 * Resolve effective settings. Org value wins per scalar field, else user, else
 * default. Exclusion arrays are the union of org + user.
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
        autoRecord: !!pick('autoRecord'),
        autoRecordScope: asScope(pick('autoRecordScope')),
        recordingMode: asMode(pick('recordingMode')),
        excludedEventUids: unionStr(org?.excludedEventUids, user?.excludedEventUids),
        excludedRoomTokens: unionStr(org?.excludedRoomTokens, user?.excludedRoomTokens),
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
        autoRecord: !!patch.autoRecord,
        autoRecordScope: asScope(patch.autoRecordScope),
        recordingMode: asMode(patch.recordingMode),
        excludedEventUids: asStrArray(patch.excludedEventUids),
        excludedRoomTokens: asStrArray(patch.excludedRoomTokens),
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
        autoRecord: !!patch.autoRecord,
        autoRecordScope: asScope(patch.autoRecordScope),
        recordingMode: asMode(patch.recordingMode),
        excludedEventUids: asStrArray(patch.excludedEventUids),
        excludedRoomTokens: asStrArray(patch.excludedRoomTokens),
        updatedAt: new Date().toISOString(),
        updatedBy: userId,
    };
    await configStore.setConfig(userKey(userId), config);
    return config;
}

/**
 * Toggle a single meeting's auto-record on/off for a user by mutating the
 * user's exclusion lists (record=false → add to excludes; record=true → remove).
 * Returns the updated user settings doc.
 */
async function setMeetingRecord(userId, { roomToken = null, eventUid = null, record }) {
    const current = await getUserSettings(userId);
    const tokens = new Set(asStrArray(current.excludedRoomTokens));
    const uids = new Set(asStrArray(current.excludedEventUids));
    const apply = (set, val) => { if (!val) return; if (record) set.delete(val); else set.add(val); };
    apply(tokens, roomToken);
    apply(uids, eventUid);
    return saveUserSettings(userId, {
        ...current,
        excludedRoomTokens: Array.from(tokens),
        excludedEventUids: Array.from(uids),
    });
}

module.exports = {
    DEFAULTS,
    resolveTalkNotesSettings,
    getOrgSettings,
    getUserSettings,
    saveOrgSettings,
    saveUserSettings,
    setMeetingRecord,
};
