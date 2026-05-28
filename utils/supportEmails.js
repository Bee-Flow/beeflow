/**
 * Support email templates — branded shell mirroring `_renderEmailShell` from
 * emailService.js (which is private). All actual sending goes through
 * `sendServiceEmail` so retries, logging, and SMTP config stay centralized.
 *
 * The link to the thread for anonymous requesters uses an HMAC token built by
 * `supportStore.buildAccessToken`, so the route handler is responsible for
 * passing in the fully-formed URL.
 */

const { sendServiceEmail } = require('./emailService');

function _clientHost() {
    return `${process.env.CLIENT_PROTOCOL || 'https'}://${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}`;
}

function _escape(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function _shell({ title, intro, body, ctaLabel, ctaUrl, footer }) {
    const clientHost = _clientHost();
    const logoUrl = `${clientHost}/bee-flow-logo.svg`;
    const cta = (ctaLabel && ctaUrl)
        ? `<table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:14px 40px;background:#0f172a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">${_escape(ctaLabel)}</a>
            </td></tr>
        </table>`
        : '';
    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid rgba(0,0,0,0.06);overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #f0f0f0;">
          <img src="${logoUrl}" alt="BeeFlow" width="56" height="56" style="display:block;margin:0 auto 16px;border-radius:14px;" />
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">${_escape(title)}</h1>
        </td></tr>
        <tr><td style="padding:32px 40px 36px;">
          ${intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">${intro}</p>` : ''}
          <div style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#334155;">${body}</div>
          ${cta}
          ${footer ? `<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#94a3b8;">${footer}</p>` : ''}
        </td></tr>
        <tr><td style="padding:20px 40px;text-align:center;background:#fafafa;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:11px;color:#94a3b8;">
            Bee Flow B.V. · <a href="${clientHost}" style="color:#6b7280;text-decoration:none;">${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
}

function _bodyAsHtml(body) {
    // Treat the AI/staff reply as plain text; preserve paragraphs and line breaks.
    const esc = _escape(body || '');
    return esc
        .split(/\n{2,}/).map(p => `<p style="margin:0 0 12px;">${p.replace(/\n/g, '<br/>')}</p>`).join('');
}

/**
 * Confirmation to the requester right after a thread is created.
 */
async function sendThreadCreatedEmail({ to, requesterName, subject, threadUrl }) {
    const title = 'We got your message';
    const intro = `Hi <strong>${_escape(requesterName || 'there')}</strong>,`;
    const body = `
        <p style="margin:0 0 12px;">Thanks for reaching out to Bee Flow. We received your message about <strong>${_escape(subject)}</strong>.</p>
        <p style="margin:0 0 12px;">Our AI assistant is looking through our knowledge base right now and will reply within a few moments. If it can't fully resolve your question, a human from our team will take over.</p>
    `;
    const text = `Hi ${requesterName || 'there'},\n\nThanks for reaching out to Bee Flow. We received your message about "${subject}". Our AI is looking into it now and will reply shortly.\n\nView your conversation: ${threadUrl}`;
    return sendServiceEmail({
        to,
        subject: `Bee Flow: We received your message`,
        text,
        html: _shell({ title, intro, body, ctaLabel: 'View your conversation', ctaUrl: threadUrl, footer: 'You can reply directly on the conversation page.' }),
    });
}

/**
 * Posted by the AI auto-responder.
 */
async function sendAiReplyEmail({ to, requesterName, subject, replyBody, threadUrl, escalated = false }) {
    const title = escalated ? 'A human is taking a look' : 'A reply from our AI assistant';
    const intro = `Hi <strong>${_escape(requesterName || 'there')}</strong>,`;
    const escalationLine = escalated
        ? `<p style="margin:0 0 12px;color:#64748b;"><em>This question goes beyond what our AI could confidently answer — we've handed it to a Bee Flow teammate, who will get back to you soon. The AI's best attempt is included below.</em></p>`
        : '';
    const body = `
        ${escalationLine}
        ${_bodyAsHtml(replyBody)}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;">— Bee Flow Support (AI)</p>
    `;
    const text = `Hi ${requesterName || 'there'},\n\n${escalated ? '[Handed off to a human — AI attempt below]\n\n' : ''}${replyBody}\n\nView the full conversation: ${threadUrl}\n\n— Bee Flow Support (AI)`;
    return sendServiceEmail({
        to,
        subject: `Re: ${subject}`,
        text,
        html: _shell({ title, intro, body, ctaLabel: 'Continue the conversation', ctaUrl: threadUrl }),
    });
}

/**
 * Reply posted by Bee Flow staff.
 */
async function sendStaffReplyEmail({ to, requesterName, subject, staffName, replyBody, threadUrl }) {
    const title = 'A reply from Bee Flow';
    const intro = `Hi <strong>${_escape(requesterName || 'there')}</strong>,`;
    const body = `
        ${_bodyAsHtml(replyBody)}
        <p style="margin:16px 0 0;font-size:13px;color:#64748b;">— ${_escape(staffName || 'Bee Flow Support')}</p>
    `;
    const text = `Hi ${requesterName || 'there'},\n\n${replyBody}\n\n— ${staffName || 'Bee Flow Support'}\n\nView the full conversation: ${threadUrl}`;
    return sendServiceEmail({
        to,
        subject: `Re: ${subject}`,
        text,
        html: _shell({ title, intro, body, ctaLabel: 'Continue the conversation', ctaUrl: threadUrl }),
    });
}

/**
 * Build the CSAT rating + dispute block. `csatLinks` is { stars: [url×5], dispute }.
 */
function _csatBlock(csatLinks) {
    if (!csatLinks || !Array.isArray(csatLinks.stars) || csatLinks.stars.length !== 5) return '';
    const stars = csatLinks.stars.map((url, i) =>
        `<a href="${url}" target="_blank" style="display:inline-block;padding:8px 12px;margin:0 2px;font-size:20px;text-decoration:none;border-radius:8px;background:#f1f5f9;color:#0f172a;">${'★'.repeat(i + 1)}</a>`
    ).join('');
    return `
        <p style="margin:24px 0 8px;font-size:14px;color:#334155;text-align:center;font-weight:600;">How did we do?</p>
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:4px 0 12px;">
            ${csatLinks.stars.map((url, i) => `<a href="${url}" target="_blank" style="display:inline-block;width:40px;height:40px;line-height:40px;margin:0 3px;font-size:13px;font-weight:700;text-decoration:none;border-radius:50%;background:#f1f5f9;color:#0f172a;text-align:center;">${i + 1}</a>`).join('')}
        </td></tr></table>
        ${csatLinks.dispute ? `<p style="margin:4px 0 0;font-size:12px;color:#94a3b8;text-align:center;"><a href="${csatLinks.dispute}" target="_blank" style="color:#64748b;">This wasn't resolved — reopen my request</a></p>` : ''}
    `;
}

/**
 * Resolution notice. When `csatLinks` is supplied, embeds a 1-5 rating row and
 * a "not resolved" dispute link (both HMAC-token URLs built by the route).
 */
async function sendThreadResolvedEmail({ to, requesterName, subject, threadUrl, csatLinks = null }) {
    const title = 'Your request was resolved';
    const intro = `Hi <strong>${_escape(requesterName || 'there')}</strong>,`;
    const body = `
        <p style="margin:0 0 12px;">We've marked your support request <strong>${_escape(subject)}</strong> as resolved.</p>
        <p style="margin:0 0 12px;">If this didn't actually fix things, reply on the conversation page and we'll reopen it.</p>
        ${_csatBlock(csatLinks)}
    `;
    const text = `Hi ${requesterName || 'there'},\n\nWe've marked your support request "${subject}" as resolved. If this didn't actually fix things, reply on the conversation page and we'll reopen it.\n\nView: ${threadUrl}`;
    return sendServiceEmail({
        to,
        subject: `Bee Flow: "${subject}" resolved`,
        text,
        html: _shell({ title, intro, body, ctaLabel: 'View the conversation', ctaUrl: threadUrl }),
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Failure-aware wrapper
// ─────────────────────────────────────────────────────────────────────────
//
// Every outbound support email goes through `sendOrNotifyStaff` so a single
// SMTP outage doesn't silently swallow customer replies. On failure it:
//   1. Logs the error (with PII-redacted recipient).
//   2. Best-effort updates `support_messages.email_send_status` for the
//      related message, so the admin UI can surface a per-message warning.
//   3. Best-effort emits a single deduplicated staff notification (one per
//      thread+kind per hour) so admins notice in-app.
//   4. Records a `support_thread_events` audit row (action: 'email_failed').
//
// Always resolves (never rejects) so callers don't have to wrap every send
// in try/catch. Resolves to `{ ok: true }` on success or `{ ok: false, error }`.

const _recentNotify = new Map(); // dedupe key → last-notified epoch ms
const NOTIFY_DEDUPE_MS = 60 * 60 * 1000; // 1 hour

function _redactEmail(addr) {
    if (!addr || typeof addr !== 'string') return '(no addr)';
    const at = addr.indexOf('@');
    if (at < 1) return addr.slice(0, 3) + '***';
    return addr.slice(0, Math.min(2, at)) + '***@' + addr.slice(at + 1).split('.')[0].slice(0, 1) + '***';
}

async function _markMessageEmailStatus({ messageId, status }) {
    if (!messageId) return;
    try {
        const supportStore = require('../stores/supportStore');
        if (typeof supportStore.setMessageEmailStatus === 'function') {
            await supportStore.setMessageEmailStatus(messageId, status);
        }
    } catch (e) {
        console.warn('[SupportEmails] mark message status failed:', e.message);
    }
}

async function _notifyStaffOfFailure({ kind, threadId, errorMsg }) {
    const dedupeKey = `${threadId}:${kind}`;
    const now = Date.now();
    const last = _recentNotify.get(dedupeKey) || 0;
    if (now - last < NOTIFY_DEDUPE_MS) return;
    _recentNotify.set(dedupeKey, now);
    try {
        const supportRoute = require('../routes/support');
        if (typeof supportRoute.notifyStaff === 'function') {
            await supportRoute.notifyStaff({
                title: `Email send failed (${kind})`,
                message: `Thread ${threadId.slice(0, 8)}… — ${errorMsg.slice(0, 200)}`,
                threadId,
            });
        }
    } catch (e) {
        console.warn('[SupportEmails] notifyStaff fallback failed:', e.message);
    }
}

async function _recordAuditEvent({ threadId, kind, errorMsg }) {
    try {
        const supportStore = require('../stores/supportStore');
        if (typeof supportStore.recordThreadEvent === 'function') {
            await supportStore.recordThreadEvent({
                threadId,
                actorUserId: null,
                actorKind: 'system',
                action: 'email_failed',
                payload: { kind, error: errorMsg.slice(0, 500) },
            });
        }
    } catch {}
}

/**
 * Wraps a single send-call with surfacing logic.
 *
 * @param {Function} sendFn  one of sendThreadCreatedEmail / sendAiReplyEmail / …
 * @param {Object}   sendArgs  passed to `sendFn` verbatim
 * @param {Object}   ctx
 * @param {string}   ctx.kind       'thread_created' | 'ai_reply' | 'staff_reply' | 'resolved'
 * @param {string}   ctx.threadId   for notification + audit
 * @param {string}   [ctx.messageId] support_messages.id to annotate with email_send_status
 */
async function sendOrNotifyStaff(sendFn, sendArgs, ctx) {
    try {
        const result = await sendFn(sendArgs);
        if (result && result.success === false) {
            // sendServiceEmail returns `{ success, error }` on failure rather than throwing.
            throw new Error(result.error || 'unknown send error');
        }
        if (ctx?.messageId) {
            await _markMessageEmailStatus({
                messageId: ctx.messageId,
                status: { ok: true, at: new Date().toISOString() },
            });
        }
        return { ok: true };
    } catch (e) {
        const errorMsg = e?.message || String(e);
        console.warn(`[SupportEmails] send failed (kind=${ctx?.kind}, to=${_redactEmail(sendArgs?.to)}): ${errorMsg}`);
        if (ctx?.messageId) {
            await _markMessageEmailStatus({
                messageId: ctx.messageId,
                status: { ok: false, error: errorMsg, at: new Date().toISOString() },
            });
        }
        if (ctx?.threadId) {
            await _notifyStaffOfFailure({ kind: ctx.kind || 'unknown', threadId: ctx.threadId, errorMsg });
            await _recordAuditEvent({ threadId: ctx.threadId, kind: ctx.kind || 'unknown', errorMsg });
        }
        return { ok: false, error: errorMsg };
    }
}

module.exports = {
    sendThreadCreatedEmail,
    sendAiReplyEmail,
    sendStaffReplyEmail,
    sendThreadResolvedEmail,
    sendOrNotifyStaff,
};
