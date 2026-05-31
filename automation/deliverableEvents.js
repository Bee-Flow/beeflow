/**
 * Single source of truth for "will this app_event trigger actually fire?"
 *
 * This drives a NON-BLOCKING validation WARNING and UI badges only. It does
 * NOT change how Nextcloud connects, how subscriptions are delivered, or how
 * the connector behaves — it is purely an honesty signal for the builder and
 * the routines gallery.
 *
 * Two disjoint sets for Nextcloud:
 *
 *   POLLER_BACKED  — events with a real triggerBus poller today, so they fire
 *                    on the SaaS poll tick with no connector dependency.
 *                    (Mirror of POLLERS.nextcloud keys in triggerBus.js:~1172
 *                    + calendar.event.upcoming. POLLERS is not exported, so we
 *                    keep this list in sync by hand — keep it aligned with
 *                    triggerBus and with NC_POLLER_EVENTS in routes/automation.js.)
 *
 *   PUSH_PENDING   — events that ONLY the Bee Flow ExApp connector can deliver
 *                    (connector mapEvent/refineEvent outputs minus the pollers).
 *                    These are flagged "requires Bee Flow ExApp connector —
 *                    pending validation" until the connector push pipeline is
 *                    validated against a live Nextcloud. We never report them
 *                    as deliverable here.
 */

const POLLER_BACKED = {
    nextcloud: new Set([
        'file.new',
        'file.changed',
        'share.received',
        'activity.new',
        'notification.new',
        'calendar.event.upcoming',
    ]),
};

// Connector-only event strings (automationEventsWebhook.js mapEvent + refineEvent
// outputs) that are NOT poller-backed. Copied as a plain constant — the connector
// repo is intentionally untouched.
const PUSH_PENDING = {
    nextcloud: new Set([
        'file.deleted',
        'file.renamed',
        'share.created',
        'share.deleted',
        'calendar.event.created',
        'calendar.event.changed',
        'calendar.event.deleted',
        'deck.card.created',
        'deck.card.changed',
        'deck.card.deleted',
        'deck.card.completed',
        'deck.card.moved',
        'talk.message.received',
    ]),
};

/**
 * The set passed to validateDefinition({ deliverableEvents }). Keyed by
 * provider; an event ABSENT from its provider's set yields the non-blocking
 * `trigger.app_event_undeliverable` warning (validate.js). We return the
 * POLLER-BACKED set only, so push-pending events correctly warn.
 */
function getDeliverableEvents() {
    return {
        nextcloud: new Set(POLLER_BACKED.nextcloud),
    };
}

/** True when an event needs the (deferred) connector push pipeline. */
function isPushPending(provider, event) {
    return !!PUSH_PENDING[provider]?.has(event);
}

/** True when an event fires today via a SaaS poller (no connector needed). */
function isPollerBacked(provider, event) {
    return !!POLLER_BACKED[provider]?.has(event);
}

/** Arrays (JSON-serialisable) for the /catalog payload consumed by the client. */
function deliverabilityForCatalog() {
    return {
        pollerBacked: { nextcloud: [...POLLER_BACKED.nextcloud] },
        pushPending: { nextcloud: [...PUSH_PENDING.nextcloud] },
    };
}

module.exports = {
    POLLER_BACKED,
    PUSH_PENDING,
    getDeliverableEvents,
    isPushPending,
    isPollerBacked,
    deliverabilityForCatalog,
};
