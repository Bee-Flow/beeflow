/**
 * Unit tests for the Gmail tool helpers. Pure logic — no network/DB.
 *
 * Run: node integrations/gmailTools.test.js   (or: node --test)
 *
 * Covers the mapping fixes (attachments carry messageId/threadId), the
 * content-agnostic mimeType guessing, the shared MIME builder used by
 * compose + draft, label name→id resolution, and the tool registry.
 */

const assert = require('assert');

const {
    GMAIL_TOOLS,
    isGmailTool,
    extractAttachments,
    guessMimeTypeFromName,
    resolveLabelIds,
    buildRawMessage,
} = require('./gmailTools');

(async () => {
    // ── extractAttachments stamps messageId/threadId + recurses parts ───
    {
        const payload = {
            parts: [
                { mimeType: 'text/plain', body: { data: 'aGk=' } },
                { filename: 'invoice.pdf', mimeType: 'application/pdf', body: { size: 100, attachmentId: 'att-a' } },
                { mimeType: 'multipart/mixed', parts: [
                    { filename: 'logo.png', mimeType: 'image/png', body: { size: 50, attachmentId: 'att-b' } },
                ] },
            ],
        };
        const atts = extractAttachments(payload, { messageId: 'm1', threadId: 't1' });
        assert.strictEqual(atts.length, 2, 'finds nested + top-level attachments, skips body parts');
        assert.strictEqual(atts[0].attachmentId, 'att-a');
        assert.strictEqual(atts[0].messageId, 'm1', 'attachment carries messageId for self-contained forEach');
        assert.strictEqual(atts[0].threadId, 't1', 'attachment carries threadId');
        assert.strictEqual(atts[0].canOCR, true, 'pdf → canOCR true');
        assert.strictEqual(atts[1].filename, 'logo.png');
        assert.strictEqual(atts[1].canOCR, false, 'png → canOCR false');
        assert.strictEqual(atts[1].messageId, 'm1', 'nested attachment also carries messageId');
    }

    // ── extractAttachments: single-part message (payload IS the file) ───
    {
        const single = { filename: 'c.pdf', mimeType: 'application/pdf', body: { size: 10, attachmentId: 'att-c' } };
        const a = extractAttachments(single, { messageId: 'm2' });
        assert.strictEqual(a.length, 1);
        assert.strictEqual(a[0].messageId, 'm2');
        assert.strictEqual(a[0].threadId, null, 'threadId defaults to null when not provided');
    }

    // ── extractAttachments: no ctx → ids null (back-compat) ─────────────
    {
        const a = extractAttachments({ parts: [{ filename: 'x.pdf', mimeType: 'application/pdf', body: { attachmentId: 'z' } }] });
        assert.strictEqual(a[0].messageId, null);
        assert.strictEqual(a[0].threadId, null);
    }

    // ── guessMimeTypeFromName ──────────────────────────────────────────
    {
        assert.strictEqual(guessMimeTypeFromName('a.pdf'), 'application/pdf');
        assert.strictEqual(guessMimeTypeFromName('a.PNG'), 'image/png', 'case-insensitive extension');
        assert.strictEqual(guessMimeTypeFromName('a.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        assert.strictEqual(guessMimeTypeFromName('a.csv'), 'text/csv');
        assert.strictEqual(guessMimeTypeFromName('weird.xyz'), 'application/octet-stream', 'unknown ext → octet-stream');
        assert.strictEqual(guessMimeTypeFromName('noext'), 'application/octet-stream');
    }

    // ── resolveLabelIds: names→ids, ids/system pass through ─────────────
    {
        const fakeGmail = { users: { labels: { list: async () => ({ data: { labels: [
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'Label_3', name: 'Work', type: 'user' },
        ] } }) } } };
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, ['Work']), ['Label_3'], 'user-label name resolves to id');
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, ['INBOX', 'UNREAD']), ['INBOX', 'UNREAD'], 'system labels / unknown pass through');
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, 'Work'), ['Label_3'], 'single string is accepted');
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, []), [], 'empty → empty (no list call)');
        assert.deepStrictEqual(await resolveLabelIds(fakeGmail, undefined), [], 'undefined → empty');
    }

    // ── buildRawMessage: produces decodable RFC 2822 (compose + draft) ──
    {
        const decode = (raw) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
        const raw = buildRawMessage({ to: 'a@b.com', subject: 'Hello', body: 'Body text', userEmail: 'me@x.com' });
        const decoded = decode(raw);
        assert.ok(decoded.includes('To: a@b.com'), 'To header present');
        assert.ok(decoded.includes('From: me@x.com'), 'From header present');
        assert.ok(decoded.includes('Subject: Hello'), 'plain subject present');
        const body = decoded.split('\r\n\r\n')[1];
        assert.strictEqual(Buffer.from(body, 'base64').toString('utf-8'), 'Body text', 'body round-trips');

        // Non-ASCII subject is RFC 2047 encoded.
        const raw2 = buildRawMessage({ to: 'a@b', subject: 'Factüur €', body: 'x', userEmail: '' });
        assert.ok(decode(raw2).includes('=?UTF-8?B?'), 'non-ascii subject encoded');

        // Reply threading headers.
        const raw3 = buildRawMessage({ to: 'a@b', subject: 'Re: x', body: 'x', inReplyTo: '<msg-1@mail>', references: '<root@mail>' });
        const dec3 = decode(raw3);
        assert.ok(dec3.includes('In-Reply-To: <msg-1@mail>'), 'In-Reply-To header');
        assert.ok(dec3.includes('References: <root@mail> <msg-1@mail>'), 'References appends In-Reply-To');
    }

    // ── tool registry: new ops present + isGmailTool ───────────────────
    {
        const names = GMAIL_TOOLS.map(t => t.function.name);
        const expected = [
            'gmail_search', 'gmail_read', 'gmail_read_attachment', 'gmail_compose',
            'gmail_list_labels', 'gmail_modify_labels', 'gmail_mark_read', 'gmail_mark_unread',
            'gmail_archive', 'gmail_trash', 'gmail_create_draft',
        ];
        for (const n of expected) {
            assert.ok(names.includes(n), `GMAIL_TOOLS includes ${n}`);
            assert.ok(isGmailTool(n), `isGmailTool(${n}) is true`);
        }
        assert.ok(!isGmailTool('drive_search'), 'isGmailTool rejects non-gmail tools');
        // read_attachment exposes the new mimeType input.
        const ra = GMAIL_TOOLS.find(t => t.function.name === 'gmail_read_attachment');
        assert.ok(ra.function.parameters.properties.mimeType, 'gmail_read_attachment accepts mimeType');
    }

    console.log('integrations/gmailTools.test.js — all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
