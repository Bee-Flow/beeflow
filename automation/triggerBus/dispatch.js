/**
 * Event dispatch fan-out (§WS5, extracted verbatim from triggerBus.js).
 */

const automationStore = require('../../stores/automationStore');
const { applyDslFilter } = require('../triggers/dslFilters');
const { pickMatcher } = require('./filters');

// Providers whose subscriptions are strictly per-user and where a null userId
// is NEVER legitimate. For these, an inbound event MUST identify the subscriber
// or we refuse to fan out — otherwise a forged/unauthenticated push (e.g. the
// Gmail Pub/Sub or an unmatched MS Graph notification) would broadcast to EVERY
// subscriber across all tenants. (Nextcloud is intentionally excluded: it
// legitimately dispatches with a null userId + orgId for bot/federated actors.)
const USER_SCOPED_PROVIDERS = new Set(['gmail', 'msgraph']);

async function dispatchEvent({ provider, event, payload = {}, userId = null, orgId = null }) {
    // Security: never fan a user-scoped provider's event out to all tenants when
    // the subscriber is unknown. Drop it instead (fail closed).
    if (!userId && USER_SCOPED_PROVIDERS.has(provider)) {
        console.warn(`[TriggerBus] dropping ${provider}.${event} with no userId — user-scoped events must identify the subscriber (no cross-tenant fan-out)`);
        return [];
    }
    // Side-effect tap: a new Nextcloud file might be a Talk call recording we
    // should auto-transcribe into Meeting Notes. This runs independently of
    // user-created automation subscriptions and must never block their
    // fan-out, so it is fire-and-forget with its own error handling.
    if (provider === 'nextcloud' && event === 'file.new') {
        try {
            require('../../core/meetingNotes/talkAutoIngest').maybeIngest({ payload, userId, orgId })
                .catch(e => console.error('[TalkAutoIngest] tap error:', e.message));
        } catch (e) {
            console.error('[TalkAutoIngest] tap load error:', e.message);
        }
    }

    const subs = await automationStore.getSubscriptionsForProvider(provider, event);
    const runs = [];
    const baseMatcher = pickMatcher(provider, event);
    // Wrap baseMatcher with the rich-filter DSL so any/none/expr/age work
    // for every matcher consistently (Phase 1.4). The DSL is no-op when
    // the filter has no DSL keys, so existing flows are unchanged.
    const matcher = (p, f) => applyDslFilter(p, f, baseMatcher);
    for (const sub of subs) {
        if (userId && sub.userId !== userId) continue;
        const ok = matcher(payload, sub.filter);
        if (!ok) {
            console.log(`[TriggerBus] sub ${sub.id} filter rejected event (subject="${payload.subject || payload.objectName || ''}" from="${payload.from || payload.actor || ''}")`);
            continue;
        }
        const automation = await automationStore.getAutomation(sub.automationId);
        if (!automation) { console.warn(`[TriggerBus] sub ${sub.id} — automation ${sub.automationId} not found`); continue; }
        if (!automation.isActive) { console.log(`[TriggerBus] sub ${sub.id} — automation ${automation.id} is inactive; skipping`); continue; }
        if (automation.isDraft)   { console.log(`[TriggerBus] sub ${sub.id} — automation ${automation.id} is still a draft; skipping`); continue; }
        const runner = require('../../core/automationRunner');
        try {
            console.log(`[TriggerBus] dispatch automation=${automation.id} via sub ${sub.id} (subject="${payload.subject || ''}")`);
            const run = await runner.executeAutomation(automation, {
                triggerKind: 'app_event',
                triggerPayload: { provider, event, ...payload },
            });
            runs.push({ subId: sub.id, runId: run?.id });
        } catch (e) {
            console.error('[TriggerBus] dispatch error:', e.message);
        }
    }
    return runs;
}

/**
 * Org-scoped dispatch for the Ticket Assistant. Tickets / sync events live
 * at the organisation level (not user level), so we route to every
 * subscription whose subscriber belongs to `orgId`. Anyone outside that
 * org never sees the event — the regular `dispatchEvent` would have
 * required us to fan out one call per user, which is wasteful.
 *
 * Per-call cache keyed by userId avoids repeated `userStore.getUser`
 * lookups when many subscriptions share a subscriber.
 */
// §WS4.2 — single org-scoped fan-out. The Ticket-Assistant and Support paths
// were byte-for-byte twins differing only in the provider string + log prefix.
// Both events live at the ORG level (not user level), so we route to every
// subscription whose subscriber belongs to `orgId`. The per-call userId→orgId
// cache avoids repeated userStore.getUser lookups when many subscriptions share
// a subscriber.
async function dispatchOrgScopedEvent(provider, event, payload = {}, orgId = null) {
    if (!event) return [];
    const subs = await automationStore.getSubscriptionsForProvider(provider, event);
    if (subs.length === 0) return [];

    const userStore = require('../../stores/userStore');
    const orgCache = new Map(); // userId → orgId
    const lookupOrg = async (uid) => {
        if (orgCache.has(uid)) return orgCache.get(uid);
        const u = await userStore.getUser(uid).catch(() => null);
        const o = u?.organizationId || null;
        orgCache.set(uid, o);
        return o;
    };

    const runs = [];
    const matcher = pickMatcher(provider, event);
    for (const sub of subs) {
        if (orgId) {
            const subOrg = await lookupOrg(sub.userId);
            if (subOrg !== orgId) continue;
        }
        if (!matcher(payload, sub.filter)) continue;
        const automation = await automationStore.getAutomation(sub.automationId);
        if (!automation || !automation.isActive || automation.isDraft) continue;
        const runner = require('../../core/automationRunner');
        try {
            console.log(`[TriggerBus] dispatch automation=${automation.id} via ${provider} sub ${sub.id} (event=${event})`);
            const run = await runner.executeAutomation(automation, {
                triggerKind: 'app_event',
                triggerPayload: { provider, event, ...payload },
            });
            runs.push({ subId: sub.id, runId: run?.id });
        } catch (e) {
            console.error(`[TriggerBus] ${provider} dispatch error:`, e.message);
        }
    }
    return runs;
}

const dispatchTicketAssistantEvent = (event, payload = {}, orgId = null) =>
    dispatchOrgScopedEvent('ticket-assistant', event, payload, orgId);

const dispatchSupportEvent = (event, payload = {}, orgId = null) =>
    dispatchOrgScopedEvent('support', event, payload, orgId);

module.exports = { dispatchEvent, dispatchOrgScopedEvent, dispatchTicketAssistantEvent, dispatchSupportEvent };
