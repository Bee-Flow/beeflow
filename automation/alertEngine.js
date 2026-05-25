/**
 * Alert engine for automation runs (§11 scaffolding).
 *
 * Subscribes to runEventBus (§10) and evaluates per-automation alert
 * rules. Rule shape:
 *   {
 *     id, automationId, when, threshold?, window?, channels[],
 *     dedupeKey?, quietHours?, enabled
 *   }
 *
 * `when` values:
 *   - 'failure'         — every run.failed event
 *   - 'duration_gt'     — run.finished where durationMs > threshold
 *   - 'missed_schedule' — cron expected, no run started in window
 *   - 'rate_error'      — failure rate over window crosses threshold
 *
 * Channels are dispatched by /server/integrations/alertChannels/*.
 *
 * Phase 2 work: wires the subscriptions, persists events to
 * automation_alert_events for dedupe, and adds the missed-schedule
 * scheduler.
 */

const { onAny } = require('../core/runEventBus');

let started = false;
const rulesByAutomationId = new Map();

function loadRules(/* automationId */) {
    // Phase 2: load from automation_alert_rules. Until then we return
    // empty so the engine no-ops cleanly when started.
    return [];
}

function evaluate(event) {
    const rules = rulesByAutomationId.get(event?.automationId) || [];
    for (const rule of rules) {
        // Phase 2: evaluate window + threshold + dedupe + channel dispatch.
        if (!rule.enabled) continue;
        // Intentionally empty during Phase 1 scaffolding.
        void rule;
    }
}

function start() {
    if (started) return;
    started = true;
    onAny(evaluate);
}

module.exports = { start, loadRules };
