/**
 * provisionRoutine — create / activate / tear down an automation routine from
 * server code (no HTTP layer). Used by the Support settings panel to auto-
 * provision the "resolved tickets → knowledge base" routine per inbox.
 *
 * It mirrors the validation + subscription logic of POST /automation/:id/activate
 * (server/routes/automation.js) and reuses the same building blocks
 * (validateDefinition, the permitted-tool catalog, automationStore) so there is
 * one definition of what "active" means.
 *
 * Scope note: the app_event subscription is created in polling mode with no
 * remote (msgraph/github) provisioning. That is correct for the internal
 * `support` provider — its events are dispatched directly in-process via
 * triggerBus.dispatchSupportEvent, which only needs the subscription row to
 * exist. Do NOT use this helper for providers that require remote webhook
 * provisioning; use the automation route's syncAppEventSubscription for those.
 */

const automationStore = require('../stores/automationStore');
const { validateDefinition } = require('./validate');
const { getDeliverableEvents } = require('./deliverableEvents');
const { TOOL_REGISTRY, loadTools } = require('./toolRegistry');

/** Build the permitted-tool catalog so activation rejects unknown/unpermitted tools. */
async function buildToolCatalog({ userId, session, isAdmin = false }) {
    try {
        const { getUserPermittedApps } = require('../core/integrationTools');
        const permitted = await getUserPermittedApps({ userId, session, isAdmin: !!isAdmin });
        const availableTools = new Set();
        const toolRequiredParams = {};
        for (const entry of TOOL_REGISTRY) {
            const permittedApp = permitted.has(entry.app);
            for (const t of loadTools(entry)) {
                const name = t?.function?.name;
                if (!name) continue;
                if (permittedApp) availableTools.add(name);
                const rq = t?.function?.parameters?.required;
                if (Array.isArray(rq)) toolRequiredParams[name] = rq;
            }
        }
        return { availableTools, toolRequiredParams };
    } catch (e) {
        console.warn('[provisionRoutine] tool catalog build failed; activating without tool checks:', e.message);
        return { availableTools: null, toolRequiredParams: null };
    }
}

/** Reconcile the app_event subscription row (delete-then-create) in polling mode. */
async function ensureAppEventSubscription(automationId, userId, def) {
    await automationStore.deleteSubscriptionsForAutomation(automationId);
    const trig = def?.trigger;
    if (!trig || trig.kind !== 'app_event') return;
    const provider = trig.appEvent?.provider;
    const event = trig.appEvent?.event;
    if (!provider || !event) return;
    await automationStore.createSubscription({
        automationId, userId, provider, eventType: event,
        mode: 'polling', filter: trig.appEvent?.filter || null,
    });
}

/**
 * Validate + activate a routine and (re)arm its app_event subscription.
 * @throws {Error} with `.details` (validation errors array) when the definition is invalid.
 */
async function activateRoutine(automationId, { userId, session, isAdmin = false }) {
    const a = await automationStore.getAutomation(automationId);
    if (!a) throw new Error('Automation not found');
    const { availableTools, toolRequiredParams } = await buildToolCatalog({ userId, session, isAdmin });
    const deliverableEvents = getDeliverableEvents();
    const v = validateDefinition(a.definition || {}, { availableTools, toolRequiredParams, deliverableEvents });
    if (!v.ok) { const err = new Error('Invalid definition'); err.details = v.errors; throw err; }
    const automation = await automationStore.updateAutomation(automationId, {
        isActive: true, isDraft: false, needsFirstRunConfirm: false,
    }, userId);
    await ensureAppEventSubscription(automationId, userId, a.definition);
    return { automation, warnings: v.warnings || [] };
}

/** Tear down a provisioned routine: remove its subscriptions, then delete it. */
async function teardownRoutine(automationId) {
    if (!automationId) return false;
    try { await automationStore.deleteSubscriptionsForAutomation(automationId); } catch (_) { /* ignore */ }
    return automationStore.deleteAutomation(automationId).catch(() => false);
}

module.exports = { buildToolCatalog, ensureAppEventSubscription, activateRoutine, teardownRoutine };
