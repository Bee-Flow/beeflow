/**
 * Talk auto-record engine.
 *
 * Polls (no connector changes — the connector forwards no call events) the
 * active Talk calls of users who enabled auto-record, and STARTS recording the
 * ones they moderate that match their scope/exclusions. Talk auto-stops the
 * recording when the call ends and uploads the file → the existing `file.new`
 * tap (`talkAutoIngest`) then transcribes it into a Meeting Note.
 *
 * `scanAndRecord()` is the per-tick body; the advisory-lock wrapper +
 * scheduling live in `automationRunner.js` (mirrors `processPollingAndRenewals`).
 *
 * Recording start requires: the recording backend (`recording-v1` capability),
 * an ACTIVE call (`hasCall`), and the user being owner/moderator
 * (`participantType ∈ {1,2}`). Status: 2 = audio, 1 = video.
 */

const configStore = require('../../stores/configStore');
const { resolveTalkNotesSettings } = require('./talkNotesSettings');

const ARMED_KEY = (userId) => `talk_autorecord_armed_${userId}`;

// Guard: don't re-issue start for the same room within this window (the room's
// callRecording state is eventually consistent across a 60s tick).
const RECENT_TTL_MS = 5 * 60 * 1000;
const _recentStarts = new Map(); // token → ts
// Skip-cache for rooms we can't/shouldn't record (not a moderator, backend off).
const SKIP_TTL_MS = 10 * 60 * 1000;
const _skip = new Map(); // `${userId}:${token}` → ts

function recentlyStarted(token) {
    const ts = _recentStarts.get(token);
    return !!ts && (Date.now() - ts) < RECENT_TTL_MS;
}
function markStarted(token) { _recentStarts.set(token, Date.now()); }
function isSkipped(userId, token) {
    const ts = _skip.get(`${userId}:${token}`);
    return !!ts && (Date.now() - ts) < SKIP_TTL_MS;
}
function markSkip(userId, token) { _skip.set(`${userId}:${token}`, Date.now()); }

// ── Armed-token set (so auto-recorded calls transcribe even if autoTranscribe is off) ──
async function armToken(userId, token) {
    const cur = (await configStore.getConfig(ARMED_KEY(userId)).catch(() => null)) || [];
    const set = new Set(Array.isArray(cur) ? cur : []);
    set.add(token);
    await configStore.setConfig(ARMED_KEY(userId), Array.from(set));
}
async function isArmed(userId, token) {
    const cur = (await configStore.getConfig(ARMED_KEY(userId)).catch(() => null)) || [];
    return Array.isArray(cur) && cur.includes(token);
}
async function disarmToken(userId, token) {
    const cur = (await configStore.getConfig(ARMED_KEY(userId)).catch(() => null)) || [];
    if (!Array.isArray(cur) || !cur.includes(token)) return;
    await configStore.setConfig(ARMED_KEY(userId), cur.filter(t => t !== token));
}

async function resolveOrgIdForUser(userId) {
    try {
        const { getUser } = require('../../stores/userStore');
        return (await getUser(userId))?.organizationId || null;
    } catch (_) { return null; }
}

/**
 * Build the candidate user set: everyone with a user_talk_notes_* doc, plus
 * members of any org whose org_talk_notes_* doc enabled autoRecord (so an org
 * can turn it on for members who never opened their own settings).
 */
async function listCandidateUsers() {
    const all = await configStore.getAllConfig().catch(() => ({}));
    const userIds = new Set();
    const orgIds = new Set();
    for (const key of Object.keys(all || {})) {
        if (key.startsWith('user_talk_notes_')) userIds.add(key.slice('user_talk_notes_'.length));
        else if (key.startsWith('org_talk_notes_')) orgIds.add(key.slice('org_talk_notes_'.length));
    }
    if (orgIds.size) {
        const enabledOrgs = [];
        for (const orgId of orgIds) {
            const s = await resolveTalkNotesSettings({ orgId }).catch(() => null);
            if (s?.autoRecord) enabledOrgs.push(orgId);
        }
        if (enabledOrgs.length) {
            try {
                const { getAllUsers } = require('../../stores/userStore');
                const users = await getAllUsers();
                for (const u of users) {
                    if (u.organizationId && enabledOrgs.includes(u.organizationId)) userIds.add(u.id);
                }
            } catch (_) { /* best-effort */ }
        }
    }
    return Array.from(userIds);
}

async function scanUser(userId) {
    const orgId = await resolveOrgIdForUser(userId);
    const settings = await resolveTalkNotesSettings({ orgId, userId });
    if (!settings.autoRecord) return;

    const triggerBus = require('../../automation/triggerBus');
    const session = await triggerBus.loadSession(userId);
    if (!session) return;

    const talk = require('../../integrations/nextcloudTalkTools');
    const cap = await talk.getTalkRecordingCapability(session, userId);
    if (!cap.recordingEnabled) return;

    const roomsRes = await talk.executeNextcloudTalkTool('nextcloud_talk_list_rooms', {}, userId, session);
    if (!roomsRes || roomsRes.error || !Array.isArray(roomsRes.rooms)) return;
    const active = roomsRes.rooms.filter(r =>
        r.hasCall && [1, 2].includes(r.participantType) && (!r.callRecording || r.callRecording === 0));
    if (!active.length) return;

    // Exclusions (room tokens) + calendar scope.
    const excludedTokens = new Set(settings.excludedRoomTokens || []);
    let calendarTokens = null;
    if (settings.autoRecordScope === 'calendar') {
        const { listUpcomingTalkMeetings } = require('./talkCalendar');
        const meetings = await listUpcomingTalkMeetings({ session, userId, windowHours: 4 });
        calendarTokens = new Set();
        const excludedUids = new Set(settings.excludedEventUids || []);
        for (const m of meetings) {
            if (excludedUids.has(m.uid)) { excludedTokens.add(m.talkToken); continue; }
            calendarTokens.add(m.talkToken);
        }
    }

    for (const room of active) {
        const token = room.token;
        if (!token || excludedTokens.has(token) || recentlyStarted(token) || isSkipped(userId, token)) continue;
        if (settings.autoRecordScope === 'calendar') {
            const isMeeting = room.objectType === 'event' || (calendarTokens && calendarTokens.has(token));
            if (!isMeeting) continue;
        }
        const status = settings.recordingMode === 'video' ? 1 : 2;
        const res = await talk.executeNextcloudTalkTool('nextcloud_talk_start_recording', { token, status }, userId, session);
        if (res && res.success) {
            markStarted(token);
            await armToken(userId, token).catch(() => {});
            console.log(`[TalkAutoRecord] started ${status === 2 ? 'audio' : 'video'} recording for room ${token} (user ${userId})`);
        } else if (res && (res.error === 'not_moderator' || res.error === 'recording_backend_unavailable' || res.error === 'room_not_found')) {
            markSkip(userId, token);
        } else if (res && res.error === 'no_active_call') {
            // Call ended between list and start — ignore (will re-evaluate next tick).
        } else {
            markSkip(userId, token);
            console.warn(`[TalkAutoRecord] start failed for ${token}: ${res?.error || 'unknown'}`);
        }
    }
}

/**
 * One auto-record pass. Caller wraps this in the Postgres advisory lock so only
 * one pod runs it per tick.
 */
async function scanAndRecord() {
    let users;
    try { users = await listCandidateUsers(); } catch (e) { console.error('[TalkAutoRecord] candidate scan failed:', e.message); return; }
    for (const userId of users) {
        try { await scanUser(userId); }
        catch (e) { console.error(`[TalkAutoRecord] scan failed for user ${userId}: ${e.message}`); }
    }
}

module.exports = { scanAndRecord, isArmed, armToken, disarmToken };
