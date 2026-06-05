/**
 * Support transcript + genuine-customer-contact gate.
 *
 * Shared by both resolve-dispatch sites (route + sync engine) so the KB only
 * ever learns from REAL customer conversations:
 *   - include only customer-facing messages: inbound requester messages + AI/
 *     staff replies that were ACTUALLY SENT to the customer;
 *   - drop internal notes, system messages, and unsent drafts;
 *   - require ≥1 genuine inbound customer message (sender not no-reply/bulk/self)
 *     AND ≥1 outbound reply that reached the customer.
 *
 * Bodies are cleaned + PII-redacted with the same helpers the ITIL Ticket
 * Assistant uses, before the transcript ever leaves the support boundary.
 */

const { isGenuineCustomerSender } = require('./email/parse');

/**
 * Did this outbound message actually reach the customer?
 *  - null/undefined  → legacy company-inbox send (recorded separately) → sent
 *  - { ok: true }    → delivered
 *  - { ok: false }   → send failed → NOT delivered
 *  - { state: ... }  → 'draft' | 'queued' | 'failed' → not yet delivered
 */
function wasSentToCustomer(msg) {
    const s = msg && msg.email_send_status;
    if (s === null || s === undefined) return true;
    if (typeof s === 'object') {
        if (s.ok === true) return true;
        if (s.ok === false) return false;
        if (s.state) return false;
    }
    return false;
}

/** Is this an outbound reply authored by the AI or a staff member? */
function _isOutbound(m) {
    return m && (m.author_kind === 'ai' || m.author_kind === 'staff');
}

/**
 * Build a customer-facing transcript (cleaned + PII-redacted). AI and staff are
 * both labelled "Agent" so the distilled article stays actor-neutral.
 *
 * @param {Array<object>} messages — support_messages rows (internal notes
 *   already excluded by getThreadMessages({includeInternal:false}))
 * @param {object} [opts]
 * @param {boolean} [opts.redactPII=true]
 * @returns {string}
 */
function buildCustomerTranscript(messages = [], { redactPII = true } = {}) {
    const { cleanEmail, redactPII: redact } = require('../core/ticketAssistantProcessor');
    const out = [];
    for (const m of messages) {
        if (!m || m.internal_note === true) continue;
        if (m.author_kind === 'system') continue;
        if (_isOutbound(m) && !wasSentToCustomer(m)) continue; // unsent draft / failed
        if (m.author_kind !== 'requester' && !_isOutbound(m)) continue;
        const who = m.author_kind === 'requester' ? 'Customer' : 'Agent';
        let text = cleanEmail(m.body || '');
        if (redactPII) text = redact(text);
        text = String(text || '').trim();
        if (!text) continue;
        out.push(`${who}: ${text}`);
    }
    return out.join('\n\n').slice(0, 12000);
}

/**
 * Decide whether a resolved thread is a genuine customer conversation worth
 * distilling into the KB.
 *
 * @param {Array<object>} messages
 * @param {object} [opts]
 * @param {string|null} [opts.inboxAddress] — the connected mailbox address (self-loop guard)
 * @param {string|null} [opts.requesterEmail] — the ticket requester address
 * @returns {{ genuine:boolean, genuineInbound:boolean, outboundSent:boolean }}
 */
function evaluateGenuineContact(messages = [], { inboxAddress = null, requesterEmail = null } = {}) {
    const genuineInbound = messages.some(m =>
        m && m.author_kind === 'requester' && m.internal_note !== true &&
        isGenuineCustomerSender(requesterEmail || m.author_display, inboxAddress));
    const outboundSent = messages.some(m =>
        m && _isOutbound(m) && m.internal_note !== true && wasSentToCustomer(m));
    return { genuine: genuineInbound && outboundSent, genuineInbound, outboundSent };
}

module.exports = { wasSentToCustomer, buildCustomerTranscript, evaluateGenuineContact };
