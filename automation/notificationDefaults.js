/**
 * Per-automation notification policy defaults.
 *
 * Shape stored under `definition.notificationSettings`:
 *   {
 *     onSuccess:  { enabled, level, channels },
 *     onError:    { enabled, level, channels },
 *     onApproval: { enabled, level, channels },
 *   }
 *
 * Defaults are silent on success (the screenshot showed the user's bell
 * flooded with one "🤖 <title>" per run) and loud on the two paths that
 * need user attention. Missing fields on existing automations are merged
 * against these defaults so no DB migration is needed.
 *
 * `channels` is the *where*: 'inapp' (the bell) is always present and
 * non-removable; 'email' opts the event into a real email via
 * utils/emailService.sendServiceEmail (only delivers when a service Google
 * account is connected). slack/push are intentionally NOT here — there is
 * no backend for them yet, so the UI shows them disabled ("coming soon").
 *
 * Mirrored verbatim in
 *   agent-hub/src/components/admin/AITasksDesigner/Builder/notificationDefaults.js
 * because this repo doesn't use a shared package — keep the two files
 * in sync by hand.
 */

const NOTIFICATION_DEFAULTS = Object.freeze({
    onSuccess:  Object.freeze({ enabled: false, level: 'ai_task',  channels: Object.freeze(['inapp']) }),
    onError:    Object.freeze({ enabled: true,  level: 'urgent',   channels: Object.freeze(['inapp']) }),
    onApproval: Object.freeze({ enabled: true,  level: 'heads_up', channels: Object.freeze(['inapp']) }),
});

const VALID_LEVELS = Object.freeze(['info', 'heads_up', 'urgent', 'ai_task']);

const VALID_CHANNELS = Object.freeze(['inapp', 'email']);

/**
 * Normalize a stored channels array against the allowlist. The in-app bell
 * is always included (it's the non-removable default), unknown channels are
 * dropped, and duplicates collapsed. Returns a fresh array.
 */
function normalizeChannels(channels) {
    const valid = Array.isArray(channels) ? channels.filter(c => VALID_CHANNELS.includes(c)) : [];
    return Array.from(new Set(['inapp', ...valid]));
}

module.exports = { NOTIFICATION_DEFAULTS, VALID_LEVELS, VALID_CHANNELS, normalizeChannels };
