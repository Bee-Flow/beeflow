/**
 * Email parsing + threading + loop-detection helpers shared by the support
 * inbox sync engine. Pure functions — no I/O.
 */

function getGmailHeader(headers, name) {
    const h = (headers || []).find(x => x.name && x.name.toLowerCase() === name.toLowerCase());
    return h?.value || '';
}

function decodeBase64Url(data) {
    if (!data) return '';
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf-8');
}

/** Pull both text/plain and text/html bodies out of a Gmail payload tree. */
function extractGmailBodies(payload) {
    let text = '';
    let html = '';
    const walk = (part) => {
        if (!part) return;
        const mime = part.mimeType || '';
        if (mime === 'text/plain' && part.body?.data && !text) text = decodeBase64Url(part.body.data);
        else if (mime === 'text/html' && part.body?.data && !html) html = decodeBase64Url(part.body.data);
        if (Array.isArray(part.parts)) part.parts.forEach(walk);
    };
    walk(payload);
    return { text, html };
}

/** Parse a References / In-Reply-To header into an ordered list of <message-id>. */
function splitMessageIds(headerValue) {
    if (!headerValue) return [];
    const m = String(headerValue).match(/<[^<>]+>/g);
    return m ? m.map(s => s.trim()) : [];
}

/** Normalise a subject for fallback threading: strip Re:/Fwd:/AW: + bracket tags. */
function normalizeSubject(subject) {
    return String(subject || '')
        .replace(/^\s*((re|fwd|fw|aw|antwoord|wg)\s*:\s*)+/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

const NOREPLY_RE = /(no-?reply|do-?not-reply|mailer-daemon|postmaster|bounce|notifications?@)/i;

/**
 * Decide whether an inbound message must NOT trigger an auto-reply (and usually
 * should not create a ticket at all): auto-responders, mailing lists, bounces.
 * `headers` is a case-insensitive lookup function (name) => value.
 * Returns { skip, reason } — skip=true means don't auto-reply / don't ingest.
 */
function detectAutoOrBulk(getHeader, { fromAddress = '', inboxAddress = '' } = {}) {
    const h = (n) => String(getHeader(n) || '').toLowerCase();
    const autoSubmitted = h('auto-submitted');
    if (autoSubmitted && autoSubmitted !== 'no') return { skip: true, reason: 'auto_submitted' };
    const precedence = h('precedence');
    if (['bulk', 'list', 'junk'].includes(precedence)) return { skip: true, reason: 'precedence_bulk' };
    if (getHeader('list-id') || getHeader('list-unsubscribe')) return { skip: true, reason: 'mailing_list' };
    if (getHeader('x-auto-response-suppress') || getHeader('x-autoreply') || getHeader('x-autorespond')) {
        return { skip: true, reason: 'autoreply_header' };
    }
    const contentType = h('content-type');
    if (contentType.includes('multipart/report') && contentType.includes('delivery-status')) {
        return { skip: true, reason: 'bounce_dsn' };
    }
    const from = String(fromAddress || '').toLowerCase();
    if (from && NOREPLY_RE.test(from)) return { skip: true, reason: 'noreply_sender' };
    // Self-loop: our own outbound landed back in the inbox.
    if (from && inboxAddress && from === String(inboxAddress).toLowerCase()) {
        return { skip: true, reason: 'self_loop' };
    }
    return { skip: false, reason: null };
}

/**
 * Is this sender a genuine human customer (not a no-reply/bulk address, and not
 * our own mailbox looping back)? Used by the KB customer-contact gate so only
 * real customer conversations feed the knowledge base.
 */
function isGenuineCustomerSender(fromAddress = '', inboxAddress = '') {
    const f = String(fromAddress || '').toLowerCase().trim();
    if (!f) return false;
    if (NOREPLY_RE.test(f)) return false;
    if (inboxAddress && f === String(inboxAddress).toLowerCase().trim()) return false;
    return true;
}

/** Extract the bare email address from a "Name <addr>" header value. */
function parseAddress(value) {
    if (!value) return '';
    const m = String(value).match(/<([^>]+)>/);
    return (m ? m[1] : String(value)).trim().toLowerCase();
}

/** Extract a display name from a "Name <addr>" header value. */
function parseDisplayName(value) {
    if (!value) return '';
    const m = String(value).match(/^\s*"?([^"<]+?)"?\s*</);
    return m ? m[1].trim() : '';
}

module.exports = {
    getGmailHeader,
    decodeBase64Url,
    extractGmailBodies,
    splitMessageIds,
    normalizeSubject,
    detectAutoOrBulk,
    isGenuineCustomerSender,
    parseAddress,
    parseDisplayName,
};
