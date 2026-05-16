/**
 * Per-automation notification policy defaults.
 *
 * Shape stored under `definition.notificationSettings`:
 *   {
 *     onSuccess:  { enabled, level },
 *     onError:    { enabled, level },
 *     onApproval: { enabled, level },
 *   }
 *
 * Defaults are silent on success (the screenshot showed the user's bell
 * flooded with one "🤖 <title>" per run) and loud on the two paths that
 * need user attention. Missing fields on existing automations are merged
 * against these defaults so no DB migration is needed.
 *
 * Mirrored verbatim in
 *   agent-hub/src/components/admin/AITasksDesigner/Builder/notificationDefaults.js
 * because this repo doesn't use a shared package — keep the two files
 * in sync by hand.
 */

const NOTIFICATION_DEFAULTS = Object.freeze({
    onSuccess:  Object.freeze({ enabled: false, level: 'ai_task' }),
    onError:    Object.freeze({ enabled: true,  level: 'urgent' }),
    onApproval: Object.freeze({ enabled: true,  level: 'heads_up' }),
});

const VALID_LEVELS = Object.freeze(['info', 'heads_up', 'urgent', 'ai_task']);

module.exports = { NOTIFICATION_DEFAULTS, VALID_LEVELS };
