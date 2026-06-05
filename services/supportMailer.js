/**
 * Support Mailer — outbound replies for the tenant Support inbox.
 *
 * Sends FROM a connected mailbox's stored, decrypted tokens (no live session),
 * threading the reply into the customer's existing conversation:
 *   - Gmail: RFC822 MIME (via nodemailer MailComposer) with In-Reply-To +
 *     References + the Gmail threadId.
 *   - Outlook/Graph: createReply (preserves conversationId threading) when we
 *     have the source message id, else a plain sendMail.
 *
 * A thin provider switch (`PROVIDER_SENDERS`) keeps room for more providers.
 */

const crypto = require('crypto');
const MailComposer = require('nodemailer/lib/mail-composer');
const { gmailClientFromTokens, graphFetchFromTokens } = require('./email/providerClients');
const supportInboxStore = require('../stores/supportInboxStore');

function senderDomain(email) {
    const at = String(email || '').split('@')[1];
    return (at && at.trim()) || 'beeflow.nl';
}

/** Conservative HTML sanitisation for outbound bodies (agent output is untrusted-ish). */
function sanitizeHtml(html) {
    if (!html) return '';
    return String(html)
        .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
        .replace(/<\s*style[^>]*>[\s\S]*?<\s*\/\s*style\s*>/gi, '')
        .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
        .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
        .replace(/javascript:/gi, '');
}

function textToHtml(text) {
    if (!text) return '';
    const esc = String(text)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(/\n/g, '<br>');
}

function _escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline markdown on ALREADY-HTML-ESCAPED text: links, bold, italic, code.
function _inlineMd(escaped) {
    return String(escaped)
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Minimal, dependency-free Markdown → HTML for outbound email bodies. Covers
 * what the support agent emits: headings, ordered/unordered lists, paragraphs,
 * bold/italic/code, links. Output is further sanitised by sanitizeHtml().
 */
function markdownToHtml(md) {
    if (!md) return '';
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let listType = null;
    let para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; } };
    const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) { flushPara(); closeList(); continue; }
        let m;
        if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
            flushPara(); closeList();
            const level = Math.min(m[1].length + 1, 6);
            out.push(`<h${level}>${_inlineMd(_escapeHtml(m[2]))}</h${level}>`);
        } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
            flushPara();
            if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
            out.push(`<li>${_inlineMd(_escapeHtml(m[1]))}</li>`);
        } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
            flushPara();
            if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
            out.push(`<li>${_inlineMd(_escapeHtml(m[1]))}</li>`);
        } else {
            if (listType) closeList();
            para.push(_inlineMd(_escapeHtml(line)));
        }
    }
    flushPara(); closeList();
    return out.join('\n');
}

function htmlToText(html) {
    if (!html) return '';
    return String(html)
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\s*\/\s*p\s*>/gi, '\n\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function buildRawMime({ fromName, fromEmail, to, subject, text, html, inReplyTo, references, messageId }) {
    const composer = new MailComposer({
        from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
        to,
        subject,
        text: text || undefined,
        html: html || undefined,
        inReplyTo: inReplyTo || undefined,
        references: references || undefined,
        messageId,
    });
    return new Promise((resolve, reject) => {
        composer.compile().build((err, msg) => (err ? reject(err) : resolve(msg)));
    });
}

async function sendViaGmail(inbox, onRefresh, { to, subject, textBody, htmlBody, inReplyTo, references, providerThreadId, thread }) {
    const gmail = await gmailClientFromTokens(inbox.tokens, onRefresh);
    const messageId = `<support-${thread.id}-${crypto.randomUUID()}@${senderDomain(inbox.email_address)}>`;
    // Full References chain = prior references + parent Message-ID.
    const refChain = [references, inReplyTo].filter(Boolean).join(' ').trim() || undefined;
    const raw = await buildRawMime({
        fromName: inbox.display_name, fromEmail: inbox.email_address,
        to, subject, text: textBody, html: sanitizeHtml(htmlBody),
        inReplyTo: inReplyTo || undefined, references: refChain, messageId,
    });
    const encoded = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const requestBody = { raw: encoded };
    if (providerThreadId) requestBody.threadId = providerThreadId;
    const sent = await gmail.users.messages.send({ userId: 'me', requestBody });
    return {
        providerMessageId: sent.data.id || null,
        providerThreadId: sent.data.threadId || providerThreadId || null,
        rfc822MessageId: messageId,
    };
}

async function sendViaOutlook(inbox, onRefresh, { to, subject, htmlBody, sourceProviderMessageId, providerThreadId }) {
    const html = sanitizeHtml(htmlBody);
    if (sourceProviderMessageId) {
        // createReply → patch body/recipients → send. Preserves conversationId.
        const draft = await graphFetchFromTokens(inbox.tokens, onRefresh,
            `/me/messages/${encodeURIComponent(sourceProviderMessageId)}/createReply`,
            { method: 'POST', body: JSON.stringify({}) });
        const draftId = draft.id;
        await graphFetchFromTokens(inbox.tokens, onRefresh, `/me/messages/${draftId}`, {
            method: 'PATCH',
            body: JSON.stringify({ body: { contentType: 'HTML', content: html } }),
        });
        await graphFetchFromTokens(inbox.tokens, onRefresh, `/me/messages/${draftId}/send`, { method: 'POST' });
        return { providerMessageId: draftId, providerThreadId: providerThreadId || null, rfc822MessageId: null };
    }
    await graphFetchFromTokens(inbox.tokens, onRefresh, '/me/sendMail', {
        method: 'POST',
        body: JSON.stringify({
            message: {
                subject,
                body: { contentType: 'HTML', content: html },
                toRecipients: [{ emailAddress: { address: to } }],
            },
            saveToSentItems: true,
        }),
    });
    return { providerMessageId: null, providerThreadId: providerThreadId || null, rfc822MessageId: null };
}

/**
 * AI-disclosure footer appended to EVERY automatic AI reply (not to human-sent
 * staff replies). Makes it unambiguous that the message was written by an AI
 * assistant and that a human can take over — satisfies AI-transparency
 * expectations and sets the right tone. Inline styles only (email clients strip
 * <style>); neutral greys, no brand-clashing colours.
 */
function buildAiDisclosureHtml(inbox) {
    const name = (inbox.display_name && inbox.display_name.trim()) || inbox.email_address || 'Support';
    return `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;`
        + `color:#6b7280;font-size:12px;line-height:1.5;`
        + `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`
        + `<div style="font-weight:600;color:#374151;margin-bottom:2px">${_escapeHtml(name)}</div>`
        + `<div><span aria-hidden="true">🤖</span> Dit antwoord is automatisch opgesteld door onze AI-assistent. `
        + `Klopt er iets niet, of spreek je liever een collega? Antwoord dan gewoon op deze e-mail — een medewerker kijkt mee.</div>`
        + `</div>`;
}

const AI_DISCLOSURE_TEXT =
    '— Dit antwoord is automatisch opgesteld door onze AI-assistent. Antwoord gerust op deze e-mail; een medewerker kijkt mee.';

const PROVIDER_SENDERS = { gmail: sendViaGmail, outlook: sendViaOutlook };

/**
 * Send a reply from a connected inbox into a thread's conversation.
 *
 * @param {string} inboxId
 * @param {object} thread  support_threads row (needs id, requester_email, subject, provider_thread_id)
 * @param {object} opts    { bodyText, bodyHtml, subject?, inReplyTo?, references?, sourceProviderMessageId? }
 * @returns {Promise<{providerMessageId, providerThreadId, rfc822MessageId, status}>}
 */
async function sendReply(inboxId, thread, opts = {}) {
    const inbox = await supportInboxStore.getInboxWithTokens(inboxId);
    if (!inbox) throw new Error('Inbox not found');
    if (!inbox.tokens || !inbox.tokens.accessToken) throw new Error('Inbox is not connected — reconnect the mailbox.');
    const sender = PROVIDER_SENDERS[inbox.provider];
    if (!sender) throw new Error(`Unsupported provider: ${inbox.provider}`);

    const onRefresh = (t) => supportInboxStore.updateTokens(inbox.id, t).catch(() => {});
    const to = thread.requester_email;
    const baseSubject = opts.subject || thread.subject || '(no subject)';
    const subject = /^\s*re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;
    const sig = inbox.signature ? String(inbox.signature) : '';
    // Agent/staff bodies are Markdown → render to HTML so the email isn't a wall
    // of literal **bold** and "1." markers. The signature is authored as HTML.
    // AI auto-replies (isAiReply) get an automatic AI-disclosure footer; human
    // staff replies do not (a person reviewed + sent them).
    let htmlBody = (opts.bodyHtml || markdownToHtml(opts.bodyText));
    if (sig) htmlBody += `<br><br>${sig}`;
    if (opts.isAiReply) htmlBody += buildAiDisclosureHtml(inbox);
    let textBody = (opts.bodyText || htmlToText(opts.bodyHtml));
    if (sig) textBody += `\n\n${htmlToText(sig)}`;
    if (opts.isAiReply) textBody += `\n\n${AI_DISCLOSURE_TEXT}`;

    const result = await sender(inbox, onRefresh, {
        to, subject, textBody, htmlBody,
        inReplyTo: opts.inReplyTo, references: opts.references,
        sourceProviderMessageId: opts.sourceProviderMessageId,
        providerThreadId: thread.provider_thread_id,
        thread,
    });
    return { ...result, status: { ok: true, provider: inbox.provider, at: new Date().toISOString() } };
}

module.exports = { sendReply, sanitizeHtml, htmlToText, textToHtml, markdownToHtml };
