/**
 * Talk recording auto-ingest.
 *
 * Invoked as a side-effect tap from `triggerBus.dispatchEvent` on every
 * Nextcloud `file.new` event (connector push or polling fallback). When the
 * new file is a Talk call recording AND the owning org/user has enabled
 * auto-transcription, it runs the recording through Bee Flow's transcription
 * pipeline and (optionally) posts the summary back into the Talk room.
 *
 * Requires ZERO connector changes — it rides the existing file.new event.
 * Never throws into the dispatcher (the tap is fire-and-forget).
 */

const path = require('path');
const transcriptionStore = require('../../stores/transcriptionStore');
const { resolveTalkNotesSettings } = require('./talkNotesSettings');
const { ingestNextcloudRecording, parseTalkRoomToken, ACCEPTED_RECORDING_EXTS } = require('./ingestNextcloudRecording');

async function resolveOrgIdForUser(userId) {
    if (!userId) return null;
    try {
        const { getUser } = require('../../stores/userStore');
        const u = await getUser(userId);
        return u?.organizationId || null;
    } catch (_) { return null; }
}

/**
 * @param {object} args
 * @param {object} args.payload  normalized file.new payload ({ path, name, extension, actor, ... })
 * @param {string|null} args.userId  Bee Flow user mapped from the event actor (may be null)
 * @param {string|null} args.orgId   org the event belongs to (from the connector instance)
 */
async function maybeIngest({ payload, userId = null, orgId = null }) {
    const ncPath = payload?.path;
    if (!ncPath) return;

    // Cheap extension reject before touching config.
    const ext = path.extname(ncPath).toLowerCase();
    if (!ACCEPTED_RECORDING_EXTS.includes(ext)) return;

    // Resolve org if the dispatcher didn't carry one.
    if (!orgId && userId) orgId = await resolveOrgIdForUser(userId);

    const settings = await resolveTalkNotesSettings({ orgId, userId });

    // Must live under the Talk recordings folder as <folder>/<token>/<file>.
    const token = parseTalkRoomToken(ncPath, settings.recordingFolder);
    if (!token) return;

    // ── Attribution ──────────────────────────────────────
    // Prefer the mapped event actor; fall back to the org's default owner when
    // the recording was created by a bot/federated actor we can't map.
    let ownerId = userId || settings.defaultOwnerUserId || null;
    if (!ownerId) {
        console.warn('[TalkAutoIngest] Talk recording with no mappable owner — skipping', { path: ncPath, actor: payload?.actor, orgId });
        return;
    }
    if (!orgId) orgId = await resolveOrgIdForUser(ownerId);

    // ── Gate ─────────────────────────────────────────────
    // Transcribe if the folder-level autoTranscribe is on, OR if WE started this
    // recording via auto-record (an "armed" token) — so auto-record always
    // produces a note even when autoTranscribe is off.
    let armed = false;
    if (!settings.autoTranscribe) {
        try { armed = await require('./talkAutoRecord').isArmed(ownerId, token); } catch (_) { armed = false; }
        if (!armed) return;
    }

    // ── Dedup ────────────────────────────────────────────
    const sourceUri = `talk://${token}/${path.basename(ncPath)}`;
    const existing = await transcriptionStore.getTranscriptionBySourceUri(sourceUri);
    if (existing) return;

    // ── Background auth (connector pseudo-session / vault token) ──
    const triggerBus = require('../../automation/triggerBus');
    const session = await triggerBus.loadSession(ownerId);
    if (!session) {
        console.warn('[TalkAutoIngest] no Nextcloud credentials for owner — skipping', { ownerId, path: ncPath });
        return;
    }

    console.log(`[TalkAutoIngest] ingesting Talk recording ${ncPath} (room ${token}) for user ${ownerId}`);
    try {
        const out = await ingestNextcloudRecording({
            userId: ownerId, session, orgId,
            ncPath, language: settings.language,
            source: 'talk-auto', sourceUri, talkRoomToken: token,
            postSummaryBack: settings.postSummaryBack,
        });
        if (out?.dedup) console.log(`[TalkAutoIngest] already ingested ${sourceUri}`);
        else console.log(`[TalkAutoIngest] created Meeting Note ${out?.id} from ${sourceUri}` + (out?.writeBack ? ` (write-back: ${out.writeBack.ok ? 'ok' : out.writeBack.error})` : ''));
        // Clear the armed flag now that this room's recording has been ingested.
        if (armed) { try { await require('./talkAutoRecord').disarmToken(ownerId, token); } catch (_) {} }
    } catch (err) {
        // Surface, don't swallow — but keep it out of the dispatcher's path.
        console.error(`[TalkAutoIngest] ingest failed for ${ncPath} [${err.code || 'error'}]: ${err.message}`);
    }
}

module.exports = { maybeIngest };
