/**
 * Compliance EventEmitter — turns business events into compliance signals.
 *
 * Producers `emit()` semantic events from where they happen (guardrail toggle,
 * integration call to non-EU, agent publish, DSR submitted). Consumers re-run
 * the relevant check and post a notification so admins see the impact without
 * waiting for the 6-hour scheduler sweep.
 *
 * Producers stay decoupled — they never reach into runner/notificationStore
 * directly. This file is the single coupling point and the only place that
 * needs to know which check to re-run for which event.
 */

const { EventEmitter } = require('events');

const _bus = new EventEmitter();
_bus.setMaxListeners(50);

// Lazy requires to avoid circular deps (runner -> checks -> events on cold boot).
let _runner = null;
let _notificationStore = null;
function _lazyRunner() {
    if (!_runner) _runner = require('./runner');
    return _runner;
}
function _lazyNotifications() {
    if (_notificationStore === null) {
        try { _notificationStore = require('../stores/notificationStore'); }
        catch { _notificationStore = false; }
    }
    return _notificationStore || null;
}

const EVENTS = {
    DLP_CONFIG_CHANGED: 'dlp_config_changed',
    EXTERNAL_TRANSFER_DETECTED: 'external_transfer_detected',
    AGENT_PUBLISHED: 'agent_published',
    DSR_SUBMITTED: 'dsr_submitted',
};

function emit(eventName, payload = {}) {
    try {
        _bus.emit(eventName, payload || {});
    } catch (e) {
        console.warn('[ComplianceEvents] emit error:', e.message);
    }
}

async function _notifyAdmins(orgId, category, title, message) {
    const store = _lazyNotifications();
    if (!store?.createNotification) return;
    try {
        const { getAll } = require('../db');
        const rows = await getAll(
            `SELECT id FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" = 'admin')`,
            [orgId],
        );
        for (const u of rows || []) {
            await store.createNotification({ userId: u.id, category, title, message }).catch(() => {});
        }
    } catch (e) {
        console.warn('[ComplianceEvents] notify failed:', e.message);
    }
}

// ─────────────── Wiring ───────────────
//
// All handlers are fire-and-forget. They never throw upstream — emitters keep
// running even if compliance is offline.

_bus.on(EVENTS.DLP_CONFIG_CHANGED, async ({ orgId }) => {
    if (!orgId) return;
    try { await _lazyRunner().runOne(orgId, 'GDPR-Art32-dlp-enabled', { runType: 'event' }); }
    catch (e) { console.warn('[ComplianceEvents] DLP rerun failed:', e.message); }
});

_bus.on(EVENTS.EXTERNAL_TRANSFER_DETECTED, async ({ orgId, operator, country_code }) => {
    if (!orgId) return;
    try { await _lazyRunner().runOne(orgId, 'GDPR-Art44-external-transfers', { runType: 'event' }); }
    catch (e) { console.warn('[ComplianceEvents] Art44 rerun failed:', e.message); }
    await _notifyAdmins(
        orgId,
        'heads_up',
        'External data transfer detected',
        `An integration call routed to ${operator || 'an external operator'}${country_code ? ` (${country_code})` : ''}. Confirm SCCs are in place under Compliance → Settings.`,
    );
});

_bus.on(EVENTS.AGENT_PUBLISHED, async ({ orgId, agentId }) => {
    if (!orgId) return;
    try {
        await _lazyRunner().runOne(orgId, 'AIA-Art50-ai-disclosure', { runType: 'event' });
    } catch (e) { console.warn('[ComplianceEvents] Art50 rerun failed:', e.message); }
    try {
        await _lazyRunner().runOne(orgId, 'GDPR-Art35-dpia-high-risk', { runType: 'event', subjectId: agentId });
    } catch (e) { console.warn('[ComplianceEvents] Art35 rerun failed:', e.message); }
});

_bus.on(EVENTS.DSR_SUBMITTED, async ({ orgId, requestType }) => {
    if (!orgId) return;
    const checkId = requestType === 'deletion'
        ? 'GDPR-Art17-dsr-deletion'
        : 'GDPR-Art15-dsr-access';
    try { await _lazyRunner().runOne(orgId, checkId, { runType: 'event' }); }
    catch (e) { console.warn('[ComplianceEvents] DSR rerun failed:', e.message); }
    await _notifyAdmins(
        orgId,
        'urgent',
        'New data-subject request',
        `A ${requestType || 'data-subject'} request was submitted. GDPR requires fulfilment within 30 days. Open Compliance → DSR Inbox to respond.`,
    );
});

module.exports = { emit, EVENTS, _bus };
