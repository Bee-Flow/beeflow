/**
 * Support audit emission — the single front-door for writing to the unified
 * support_audit_log. Wraps supportStore.recordAuditEvent so emission is always
 * fire-and-forget (never throws into a request/engine path) and consistently
 * stamps the actor kind, actor id and request metadata.
 *
 * ACTION_CATALOG is the canonical "what kind of actor performs this action" map,
 * shared with the frontend's auditMeta categorisation so the two never drift.
 */

const supportStore = require('../stores/supportStore');

// Canonical actor kind per action. Includes the historical action strings the
// engine already emits (so backfilled + legacy events categorise correctly) and
// the new config/admin actions added by the refactor. The frontend's auditMeta
// mirrors these categories.
const ACTION_CATALOG = {
    // ── system (mailbox/runtime, no human or model decision) ──
    email_ingested: 'system',
    email_sent: 'system',
    email_send_failed: 'system',
    email_failed: 'system',
    auto_assigned: 'system',
    // ── automation (rule/classifier/SLA engine acted) ──
    classified_not_support: 'automation',
    classifier_filtered: 'automation',
    sla_breach: 'automation',
    kb_ingested: 'automation',
    // ── ai (the model drafted/sent/decided) ──
    ai_action: 'ai',
    ai_escalated: 'ai',
    ai_draft: 'ai',
    ai_reply: 'ai',
    ai_draft_generated: 'ai',
    ai_reply_sent: 'ai',
    ai_resolved: 'ai',
    ai_status_changed: 'ai',
    ai_tool_called: 'ai',
    // ── staff (a teammate acted) ──
    staff_reply: 'staff',
    staff_reply_sent: 'staff',
    internal_note: 'staff',
    updated: 'staff',
    status_changed: 'staff',
    assign: 'staff',
    assigned: 'staff',
    assignee_change: 'staff',
    priority_change: 'staff',
    tags_change: 'staff',
    tagged: 'staff',
    resolved: 'staff',
    marked_not_support: 'staff',
    restored_to_support: 'staff',
    inbox_connected: 'staff',
    inbox_created: 'staff',
    inbox_settings_changed: 'staff',
    inbox_access_changed: 'staff',
    kb_automation_changed: 'staff',
    scan_started: 'staff',
    inbox_deleted: 'staff',
    tag_created: 'staff',
    tag_deleted: 'staff',
    canned_created: 'staff',
    canned_updated: 'staff',
    canned_deleted: 'staff',
    sla_policy_changed: 'staff',
    // ── requester (the customer acted) ──
    reply: 'requester',
    requester_reply: 'requester',
    reopened: 'requester',
    resolution_disputed: 'requester',
    csat: 'requester',
};

function actorKindFor(action, fallback = 'system') {
    return ACTION_CATALOG[action] || fallback;
}

function clientIp(req) {
    if (!req) return null;
    const xf = req.headers?.['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || null;
}

function clientUa(req) {
    if (!req) return null;
    const ua = req.headers?.['user-agent'];
    return ua ? String(ua).slice(0, 400) : null;
}

/**
 * Emit an audit event from a route handler. Resolves the staff actor + request
 * metadata automatically. Fire-and-forget: any failure is swallowed so a logging
 * problem can never break the user's action.
 */
function emit(req, { organizationId = null, inboxId = null, threadId = null, action, actorKind, actorUserId, payload = {} }) {
    try {
        if (!action) return;
        const kind = actorKind || actorKindFor(action, 'staff');
        const uid = actorUserId !== undefined
            ? actorUserId
            : (kind === 'staff' ? (req?.session?.user?.id || null) : null);
        supportStore.recordAuditEvent({
            organizationId, inboxId, threadId,
            actorKind: kind, actorUserId: uid, action, payload,
            ip: clientIp(req), ua: clientUa(req),
        }).catch(() => { /* never break the request */ });
    } catch (_) { /* never break the request */ }
}

/**
 * Emit an audit event from a service (no req). Same fire-and-forget contract.
 */
function emitSystem({ organizationId = null, inboxId = null, threadId = null, action, actorKind, actorUserId = null, payload = {} }) {
    try {
        if (!action) return;
        supportStore.recordAuditEvent({
            organizationId, inboxId, threadId,
            actorKind: actorKind || actorKindFor(action, 'system'),
            actorUserId, action, payload,
        }).catch(() => {});
    } catch (_) { /* swallow */ }
}

module.exports = { ACTION_CATALOG, actorKindFor, emit, emitSystem, clientIp, clientUa };
