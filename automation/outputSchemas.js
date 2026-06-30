/**
 * Output Schemas — JSON-schema-lite definitions matching what the actual
 * integration tools return at runtime. Used by:
 *   1. The Builder agent — to know exactly what fields are available
 *      downstream (so it doesn't have to guess "items" vs "results").
 *   2. The runner — during dry-run, to synthesize realistic placeholder
 *      output for side-effect tools (which we never call in dry-run).
 *
 * These shapes were verified against the actual `return` statements in
 * server/integrations/*. When you change a tool's output shape, update
 * the matching entry here.
 *
 * The "shape" field is a flat description of the top-level fields the
 * AI most commonly needs to bind to. The "sample" field is a realistic
 * value used for dry-run synthesis.
 */

const OUTPUT_SCHEMAS = {
    // ── Gmail ─────────────────────────────────────────────────────
    gmail_search: {
        shape: {
            results: 'array of { id, from, to, subject, date, snippet }',
            total: 'integer (estimated total result count)',
            message: 'string (only present when results is empty)',
        },
        sample: {
            results: [
                { id: 'msg-1', from: 'sender@example.com', to: 'me@example.com', subject: 'Sample invoice', date: 'Mon, 06 Apr 2026 08:23:19 -0700', snippet: 'Beste klant, hierbij uw factuur...' },
                { id: 'msg-2', from: 'biller@example.com', to: 'me@example.com', subject: 'Factuur januari', date: 'Mon, 06 Apr 2026 09:15:42 -0700', snippet: 'Bedrag: €234.50' },
            ],
            total: 2,
        },
    },
    gmail_read: {
        shape: {
            id: 'string', threadId: 'string',
            from: 'string', to: 'string', subject: 'string',
            date: 'string', body: 'string (plain text)',
            attachments: 'array of { attachmentId, filename, mimeType, size, canOCR, messageId, threadId }',
        },
        sample: {
            id: 'msg-1', threadId: 'th-1',
            from: 'sender@example.com', to: 'me@example.com',
            subject: 'Sample invoice', date: 'Mon, 06 Apr 2026 08:23:19 -0700',
            body: 'Beste klant,\n\nHierbij ontvangt u onze factuur met nummer 2026-001.\n\nBedrag: €1,234.50 (incl. BTW)\nBetalingstermijn: 30 dagen.\n\nMet vriendelijke groet.',
            // Non-empty so the builder's variable tree / LoopOverPicker / auto-map
            // expose the per-attachment fields. Each item carries messageId so a
            // "for each attachment" loop can feed gmail_read_attachment directly.
            attachments: [
                { attachmentId: 'attach-1', filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf', size: 45678, canOCR: true, messageId: 'msg-1', threadId: 'th-1' },
            ],
        },
    },
    gmail_read_attachment: {
        shape: {
            filename: 'string', mimeType: 'string',
            content: 'string (extracted text)', charCount: 'integer',
            truncated: 'boolean', extractedVia: 'string (pdfjs|azure|mistral|documentParser|utf8)',
            sourceHandle: 'opaque { kind, messageId, attachmentId, filename, mimeType, size } — pass to drive_upload_file / nextcloud_upload_file to forward the raw bytes',
            error: 'string (only when extraction failed; sourceHandle still provided)',
        },
        sample: {
            filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf',
            content: 'INVOICE 2026-001\nDate: 2026-04-06\nAmount Due: €1,234.50',
            charCount: 1847, truncated: false, extractedVia: 'pdfjs',
            sourceHandle: { kind: 'gmail_attachment', messageId: 'msg-1', attachmentId: 'attach-1', filename: 'invoice_2026-001.pdf', mimeType: 'application/pdf', size: 45678 },
        },
    },
    gmail_compose: {
        // Automation runtime sets autoSend=true, so the live result is the
        // sent-email shape, not a draft envelope. Sample matches what the
        // tool actually returns now (see integrations/gmailTools.js).
        shape: {
            sent: 'boolean', messageId: 'string', threadId: 'string',
            to: 'string', subject: 'string', message: 'string',
        },
        sample: { sent: true, messageId: 'msg-sent-1', threadId: 'th-sent-1', to: 'recipient@example.com', subject: 'Sample subject', message: 'Email sent.' },
    },
    gmail_compose_reply: {
        shape: { sent: 'boolean', messageId: 'string', threadId: 'string', message: 'string' },
        sample: { sent: true, messageId: 'msg-reply-1', threadId: 'th-1', message: 'Reply sent.' },
    },
    gmail_list_labels: {
        shape: { labels: 'array of { id, name, type }' },
        sample: { labels: [
            { id: 'INBOX', name: 'INBOX', type: 'system' },
            { id: 'UNREAD', name: 'UNREAD', type: 'system' },
            { id: 'Label_3', name: 'Work', type: 'user' },
        ] },
    },
    gmail_modify_labels: {
        shape: { messageId: 'string', labelIds: 'array of string (labels after the change)', addLabelIds: 'array of string', removeLabelIds: 'array of string', modified: 'boolean' },
        sample: { messageId: 'msg-1', labelIds: ['INBOX', 'Label_3'], addLabelIds: ['Label_3'], removeLabelIds: [], modified: true },
    },
    gmail_mark_read: {
        shape: { messageId: 'string', labelIds: 'array of string', read: 'boolean' },
        sample: { messageId: 'msg-1', labelIds: ['INBOX'], read: true },
    },
    gmail_mark_unread: {
        shape: { messageId: 'string', labelIds: 'array of string', read: 'boolean' },
        sample: { messageId: 'msg-1', labelIds: ['INBOX', 'UNREAD'], read: false },
    },
    gmail_archive: {
        shape: { messageId: 'string', labelIds: 'array of string', archived: 'boolean' },
        sample: { messageId: 'msg-1', labelIds: [], archived: true },
    },
    gmail_trash: {
        shape: { messageId: 'string', trashed: 'boolean', labelIds: 'array of string' },
        sample: { messageId: 'msg-1', trashed: true, labelIds: ['TRASH'] },
    },
    gmail_create_draft: {
        shape: { draftId: 'string', messageId: 'string', threadId: 'string', to: 'string', subject: 'string', message: 'string' },
        sample: { draftId: 'draft-1', messageId: 'msg-draft-1', threadId: 'th-1', to: 'recipient@example.com', subject: 'Re: Sample subject', message: 'Draft saved.' },
    },

    // ── Google Calendar ───────────────────────────────────────────
    calendar_list_events: {
        shape: {
            results: 'array of { id, summary, start, end, location, attendees, description, htmlLink }',
            total: 'integer',
        },
        sample: {
            results: [
                { id: 'evt-1', summary: 'Team standup', start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 5400_000).toISOString(), location: '', attendees: [], description: '', htmlLink: 'https://calendar.google.com/event?eid=…' },
            ],
            total: 1,
        },
    },
    calendar_search_events: {
        shape: { results: 'array (same as calendar_list_events.results)' },
        sample: { results: [] },
    },
    calendar_create_event: {
        shape: { id: 'string', htmlLink: 'string', summary: 'string', start: 'string', end: 'string' },
        sample: { id: 'evt-new', htmlLink: 'https://calendar.google.com/event?eid=…', summary: 'Created event', start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() },
    },

    // ── Google Drive ──────────────────────────────────────────────
    drive_search: {
        shape: { results: 'array of { id, name, mimeType, webViewLink, modifiedTime, size }' },
        sample: { results: [{ id: 'file-1', name: 'Sample.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/file-1', modifiedTime: new Date().toISOString(), size: 12345 }] },
    },
    drive_list_files: {
        shape: { results: 'array (same as drive_search.results)' },
        sample: { results: [{ id: 'file-1', name: 'Sample.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/file-1', modifiedTime: new Date().toISOString(), size: 12345 }] },
    },
    drive_read_file: {
        shape: { id: 'string', name: 'string', mimeType: 'string', content: 'string (text content)' },
        sample: { id: 'file-1', name: 'Sample.pdf', mimeType: 'application/pdf', content: 'Sample document text…' },
    },

    // ── Google Docs ───────────────────────────────────────────────
    docs_create: {
        shape: { documentId: 'string', title: 'string', url: 'string' },
        sample: { documentId: 'doc-1', title: 'New document', url: 'https://docs.google.com/document/d/doc-1' },
    },
    docs_append_text: {
        shape: { documentId: 'string', appended: 'boolean', textLength: 'integer' },
        sample: { documentId: 'doc-1', appended: true, textLength: 42 },
    },
    docs_read: {
        shape: { documentId: 'string', title: 'string', content: 'string' },
        sample: { documentId: 'doc-1', title: 'Doc title', content: 'Document body text…' },
    },

    // ── Outlook (Microsoft) ───────────────────────────────────────
    outlook_search: {
        shape: { results: 'array of { id, from, subject, preview, receivedDateTime, hasAttachments }' },
        sample: { results: [{ id: 'msg-1', from: 'sender@example.com', subject: 'Sample', preview: '…', receivedDateTime: new Date().toISOString(), hasAttachments: false }] },
    },
    outlook_read: {
        shape: { id: 'string', from: 'string', subject: 'string', body: 'string', receivedDateTime: 'string' },
        sample: { id: 'msg-1', from: 'sender@example.com', subject: 'Sample', body: 'Email body…', receivedDateTime: new Date().toISOString() },
    },

    // ── Microsoft Calendar ────────────────────────────────────────
    ms_calendar_list_events: {
        shape: { events: 'array of { id, subject, start, end, location, attendees }' },
        sample: { events: [{ id: 'evt-1', subject: 'Sample meeting', start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString(), location: '', attendees: [] }] },
    },

    // ── Web search ────────────────────────────────────────────────
    // agent_search returns a Markdown STRING — wrap at the runner so the
    // automation can still bind to "the search result". We expose a
    // string-typed schema and the dry-run synth returns sample markdown.
    agent_search: {
        shape: { _string: 'markdown string with results, sources, citations' },
        sample: '# Search Results for: "sample query"\n\n[1] Result title — Snippet of result one.\n\n[2] Another title — Snippet of result two.\n\n## Sources\n[1] [Result title](https://example.com/1)\n[2] [Another title](https://example.com/2)',
    },

    // ── KB ────────────────────────────────────────────────────────
    kb_search: {
        shape: { results: 'array of { chunk_id, content, source, score }' },
        sample: { results: [{ chunk_id: 'chunk-1', content: 'Sample knowledge content…', source: 'doc.pdf', score: 0.92 }] },
    },
    kb_fetch: {
        shape: { chunks: 'array of { chunk_id, content, source }' },
        sample: { chunks: [{ chunk_id: 'chunk-1', content: 'Sample chunk body', source: 'doc.pdf' }] },
    },

    // ── YouTrack ──────────────────────────────────────────────────
    youtrack_search_issues: {
        shape: { results: 'array of { id, summary, state, assignee, url, project }', count: 'integer' },
        sample: { results: [{ id: 'PROJ-1', summary: 'Sample issue', state: 'Open', assignee: 'someone', url: 'https://youtrack.example.com/issue/PROJ-1', project: 'PROJ' }], count: 1 },
    },
    youtrack_get_issue: {
        shape: { id: 'string', summary: 'string', description: 'string', state: 'string', assignee: 'string', comments: 'array' },
        sample: { id: 'PROJ-1', summary: 'Sample issue', description: 'Issue body…', state: 'Open', assignee: 'someone', comments: [] },
    },

    // ── Outlook / Microsoft 365 ───────────────────────────────────
    outlook_send: {
        shape: { sent: 'boolean', messageId: 'string', conversationId: 'string', message: 'string' },
        sample: { sent: true, messageId: 'msg-sent-1', conversationId: 'conv-1', message: 'Email sent via Outlook.' },
    },
    outlook_compose: {
        shape: { sent: 'boolean', messageId: 'string', message: 'string' },
        sample: { sent: true, messageId: 'msg-sent-1', message: 'Email sent.' },
    },
    ms_calendar_create_event: {
        shape: { id: 'string', subject: 'string', start: 'string', end: 'string', webLink: 'string' },
        sample: { id: 'evt-new', subject: 'Created event', start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString(), webLink: 'https://outlook.office.com/calendar/event/evt-new' },
    },

    // ── Calendar writes ───────────────────────────────────────────
    calendar_update_event: {
        shape: { id: 'string', summary: 'string', updated: 'boolean', htmlLink: 'string' },
        sample: { id: 'evt-1', summary: 'Updated event', updated: true, htmlLink: 'https://calendar.google.com/event?eid=…' },
    },
    calendar_delete_event: {
        shape: { id: 'string', deleted: 'boolean' },
        sample: { id: 'evt-1', deleted: true },
    },

    // ── YouTrack ──────────────────────────────────────────────────
    youtrack_create_issue: {
        shape: { id: 'string', summary: 'string', url: 'string', project: 'string' },
        sample: { id: 'PROJ-42', summary: 'Created issue', url: 'https://youtrack.example.com/issue/PROJ-42', project: 'PROJ' },
    },
    youtrack_update_issue: {
        shape: { id: 'string', updated: 'boolean' },
        sample: { id: 'PROJ-42', updated: true },
    },
    youtrack_add_comment: {
        shape: { id: 'string', issueId: 'string', commentId: 'string', added: 'boolean' },
        sample: { id: 'comment-1', issueId: 'PROJ-42', commentId: 'comment-1', added: true },
    },

    // ── Drive / Docs writes ───────────────────────────────────────
    drive_create_folder: {
        shape: { id: 'string', name: 'string', webViewLink: 'string' },
        sample: { id: 'folder-1', name: 'New folder', webViewLink: 'https://drive.google.com/drive/folders/folder-1' },
    },
    drive_move_file: {
        shape: { id: 'string', moved: 'boolean', newParentId: 'string' },
        sample: { id: 'file-1', moved: true, newParentId: 'folder-1' },
    },
    drive_upload_file: {
        shape: { fileId: 'string', name: 'string', webViewLink: 'string', parents: 'array of string', mimeType: 'string', bytesUploaded: 'number', updated: 'boolean' },
        sample: { fileId: 'file-1', name: 'factuur.pdf', webViewLink: 'https://drive.google.com/file/d/file-1/view', parents: ['folder-supp'], mimeType: 'application/pdf', bytesUploaded: 81234, updated: false },
    },

    // ── Contacts ──────────────────────────────────────────────────
    contacts_create: {
        shape: { resourceName: 'string', name: 'string', email: 'string' },
        sample: { resourceName: 'people/c12345', name: 'Sample contact', email: 'sample@example.com' },
    },

    // ── LinkedIn ──────────────────────────────────────────────────
    linkedin_create_post: {
        shape: { id: 'string', url: 'string', published: 'boolean' },
        sample: { id: 'urn:li:share:1', url: 'https://www.linkedin.com/feed/update/urn:li:share:1', published: true },
    },

    // ── SignRequest ───────────────────────────────────────────────
    signrequest_send_document: {
        shape: { id: 'string', uuid: 'string', url: 'string', signers: 'array of { email, status }' },
        sample: { id: 'sr-1', uuid: 'doc-uuid-1', url: 'https://signrequest.com/d/doc-uuid-1', signers: [{ email: 'recipient@example.com', status: 'pending' }] },
    },

    // ── Nextcloud Mail / Talk / Calendar / Notifications ──────────
    // Shapes verified against the tool modules' actual return statements.
    nextcloud_mail_send: {
        shape: { success: 'boolean', outboxId: 'integer', to: 'string', subject: 'string' },
        sample: { success: true, outboxId: 1, to: 'recipient@example.com', subject: 'Sample subject' },
    },
    nextcloud_talk_send_message: {
        shape: { success: 'boolean', message: '{ id, actor, actorId, message, timestamp }' },
        sample: { success: true, message: { id: 1, actor: 'Alice', actorId: 'alice', message: 'Message text', timestamp: Math.floor(Date.now() / 1000) } },
    },
    nextcloud_calendar_create_event: {
        shape: { success: 'boolean', calendar: 'string', uid: 'string', etag: 'string' },
        sample: { success: true, calendar: 'personal', uid: 'nc-evt-1@cloud.example.com', etag: '"abc123"' },
    },
    nextcloud_notifications_send: {
        shape: { success: 'boolean', userId: 'string', sentToSelf: 'boolean', shortMessage: 'string', longMessage: 'string|null' },
        sample: { success: true, userId: 'alice', sentToSelf: true, shortMessage: 'Heads up', longMessage: null },
    },
    nextcloud_activity_list: {
        shape: { count: 'integer', activities: 'array of { id, type, subject, message, actor, objectType, objectId, objectName, link, datetime }' },
        sample: { count: 1, activities: [{ id: 42, type: 'file_created', subject: 'You created Report.pdf', message: '', actor: 'alice', objectType: 'files', objectId: 1234, objectName: '/Documents/Report.pdf', link: 'https://cloud.example.com/f/1234', datetime: new Date().toISOString() }] },
    },
    nextcloud_calendar_list_events: {
        shape: { calendar: 'string', count: 'integer', events: 'array of { uid, summary, description, location, attendees, dtstart, dtend, organizer, allDay }' },
        sample: { calendar: 'personal', count: 1, events: [{ uid: 'evt-1@cloud.example.com', summary: 'Standup', description: null, location: null, attendees: [], dtstart: new Date(Date.now() + 600_000).toISOString(), dtend: new Date(Date.now() + 2400_000).toISOString(), organizer: null, allDay: false }] },
    },
    nextcloud_deck_create_card: {
        // Returns the raw Deck card JSON (POST .../cards). Demo write tool.
        shape: { id: 'integer', title: 'string', description: 'string', stackId: 'integer', type: 'string', order: 'integer', archived: 'boolean', duedate: 'string|null', createdAt: 'integer', lastModified: 'integer' },
        sample: { id: 4521, title: 'Follow up with Nextcloud', description: '', stackId: 34, type: 'plain', order: 999, archived: false, duedate: null, createdAt: Math.floor(Date.now() / 1000), lastModified: Math.floor(Date.now() / 1000) },
    },

    // ── GitHub writes ─────────────────────────────────────────────
    github_create_repo: {
        shape: { id: 'integer', name: 'string', fullName: 'string', htmlUrl: 'string', private: 'boolean' },
        sample: { id: 1, name: 'new-repo', fullName: 'org/new-repo', htmlUrl: 'https://github.com/org/new-repo', private: false },
    },

    // ── Notification (built-in step) ──────────────────────────────
    // Not technically a tool, but exposed for symmetry.

    // ── Webpages ─────────────────────────────────────────────────
    webpages_list: {
        shape: { webpages: 'array of { id, name, description, isOwner, isPublished, updatedAt }' },
        sample: { webpages: [
            { id: 'wp-sample-1', name: 'Move Move Facturen', description: 'Fuel invoice tracker', isOwner: true, isPublished: false, updatedAt: new Date().toISOString() },
        ], message: '1 accessible webpage.' },
    },
    webpage_db_schema: {
        shape: { tables: 'array of { name, sql, columns: [{ name, type, notNull, defaultValue, primaryKey }] }', message: 'string' },
        sample: { tables: [
            { name: 'facturen', sql: 'CREATE TABLE facturen (...)', columns: [
                { name: 'id', type: 'TEXT', notNull: 1, defaultValue: null, primaryKey: 1 },
                { name: 'datum', type: 'TEXT', notNull: 1, defaultValue: null, primaryKey: 0 },
                { name: 'incl_btw', type: 'REAL', notNull: 1, defaultValue: null, primaryKey: 0 },
            ] },
        ], message: '1 table: facturen' },
    },
    webpage_db_query: {
        shape: { rows: 'array of row objects', columns: 'array of column names', truncated: 'boolean', message: 'string' },
        sample: { rows: [{ id: 'sample-row', datum: '2026-05-05', incl_btw: 69.99 }], columns: ['id', 'datum', 'incl_btw'], truncated: false, message: 'Returned 1 row.' },
    },
    webpage_db_exec: {
        shape: { changes: 'integer', lastInsertRowid: 'integer', multi: 'boolean', message: 'string' },
        sample: { changes: 1, lastInsertRowid: 42, multi: false, message: 'OK — 1 row affected, lastInsertRowid=42.' },
    },
    webpage_file_read: {
        shape: { file: 'string', content: 'string', lineCount: 'integer', message: 'string' },
        sample: { file: 'js', content: '// sample js', lineCount: 1, message: 'Read 1 line.' },
    },
    webpage_file_write: {
        shape: { message: 'string', file: 'string', webpageId: 'string' },
        sample: { message: 'File written.', file: 'js', webpageId: 'wp-sample-1' },
    },
    webpage_file_replace: {
        shape: { message: 'string', file: 'string', webpageId: 'string' },
        sample: { message: 'Replaced 1 occurrence.', file: 'js', webpageId: 'wp-sample-1' },
    },
    webpage_file_patch: {
        shape: { message: 'string', file: 'string', webpageId: 'string' },
        sample: { message: 'Patched lines 5–7.', file: 'js', webpageId: 'wp-sample-1' },
    },
    webpage_set_metadata: {
        shape: { message: 'string', webpageId: 'string' },
        sample: { message: 'Webpage metadata updated.', webpageId: 'wp-sample-1' },
    },
    webpage_create: {
        shape: { webpageId: 'string', url: 'string', name: 'string', message: 'string' },
        sample: { webpageId: 'wp-new-1', url: '/app/webpages/wp-new-1', name: 'New Webpage', message: 'Created webpage "New Webpage".' },
    },

    // ── AI-only integrations promoted to automation actions ──
    generate_image: {
        shape: { url: 'string', prompt: 'string', mimeType: 'string', sizeBytes: 'integer' },
        sample: { url: 'https://storage.example/img-abc.png', prompt: '<your prompt>', mimeType: 'image/png', sizeBytes: 248_000 },
    },
    generate_video: {
        shape: { url: 'string', durationSec: 'number', mimeType: 'string', prompt: 'string' },
        sample: { url: 'https://storage.example/vid-abc.mp4', durationSec: 6, mimeType: 'video/mp4', prompt: '<your prompt>' },
    },
    elevenlabs_music: {
        shape: { url: 'string', durationSec: 'number', prompt: 'string' },
        sample: { url: 'https://storage.example/track.mp3', durationSec: 30, prompt: '<your prompt>' },
    },
    elevenlabs_tts: {
        shape: { url: 'string', durationSec: 'number', voiceId: 'string', text: 'string' },
        sample: { url: 'https://storage.example/tts.mp3', durationSec: 4, voiceId: 'EXAVITQu4vr4xnSDxMaL', text: '<spoken text>' },
    },
    elevenlabs_sfx: {
        shape: { url: 'string', durationSec: 'number', prompt: 'string' },
        sample: { url: 'https://storage.example/sfx.mp3', durationSec: 2, prompt: '<sound description>' },
    },
    // ── Google Sheets ──
    sheets_list: {
        shape: { results: 'array of { id, name, url, modifiedTime }', total: 'integer' },
        sample: {
            results: [
                { id: '1AbCDeFgHiJkLmNoPqRsTuV', name: 'Invoice tracker 2026', url: 'https://docs.google.com/spreadsheets/d/1AbCDeFgHiJkLmNoPqRsTuV/edit', modifiedTime: '2026-05-12T10:23:00Z' },
                { id: '1WxYzAbCDeFgHiJkLmNoPq', name: 'Customer leads', url: 'https://docs.google.com/spreadsheets/d/1WxYzAbCDeFgHiJkLmNoPq/edit', modifiedTime: '2026-05-09T14:51:00Z' },
            ],
            total: 2,
        },
    },
    sheets_get_values: {
        shape: { spreadsheetId: 'string', range: 'string', values: 'array of arrays (rows × columns)', rowCount: 'integer', colCount: 'integer' },
        sample: {
            spreadsheetId: '1AbCDeFgHiJkLmNoPqRsTuV',
            range: "Sheet1!A1:C3",
            values: [
                ['Name', 'Email', 'Amount'],
                ['Alice', 'alice@example.com', '125.00'],
                ['Bob', 'bob@example.com', '90.50'],
            ],
            rowCount: 3,
            colCount: 3,
        },
    },
    sheets_append_rows: {
        shape: { spreadsheetId: 'string', updatedRange: 'string', rowsAppended: 'integer', cellsAppended: 'integer' },
        sample: { spreadsheetId: '1AbCDeFgHiJkLmNoPqRsTuV', updatedRange: 'Sheet1!A5:C5', rowsAppended: 1, cellsAppended: 3 },
    },
    sheets_update_range: {
        shape: { spreadsheetId: 'string', updatedRange: 'string', rowsUpdated: 'integer', cellsUpdated: 'integer' },
        sample: { spreadsheetId: '1AbCDeFgHiJkLmNoPqRsTuV', updatedRange: 'Sheet1!B2:B2', rowsUpdated: 1, cellsUpdated: 1 },
    },
    sheets_create: {
        shape: { spreadsheetId: 'string', url: 'string', title: 'string' },
        sample: { spreadsheetId: '1NewSheetIdABCDEF', url: 'https://docs.google.com/spreadsheets/d/1NewSheetIdABCDEF/edit', title: 'New spreadsheet' },
    },

    // ── Google Slides ──
    slides_list: {
        shape: { results: 'array of { id, name, url, modifiedTime }', total: 'integer' },
        sample: {
            results: [
                { id: '1PrEsIdSlIdEsAbCdEfG', name: 'Q1 review template', url: 'https://docs.google.com/presentation/d/1PrEsIdSlIdEsAbCdEfG/edit', modifiedTime: '2026-04-22T08:11:00Z' },
            ],
            total: 1,
        },
    },
    slides_get: {
        shape: { presentationId: 'string', title: 'string', slides: 'array of { index, objectId, text }', slideCount: 'integer' },
        sample: {
            presentationId: '1PrEsIdSlIdEsAbCdEfG',
            title: 'Q1 review template',
            slides: [
                { index: 0, objectId: 'p1', text: 'Q1 Review\nPrepared by: {{NAME}}' },
                { index: 1, objectId: 'p2', text: 'Highlights\n- Revenue up 12%\n- Two new partners' },
            ],
            slideCount: 2,
        },
    },
    slides_replace_text: {
        shape: { presentationId: 'string', replacements: 'integer (total substitutions across deck)', replacementCount: 'integer (pairs supplied)' },
        sample: { presentationId: '1PrEsIdSlIdEsAbCdEfG', replacements: 4, replacementCount: 2 },
    },
    slides_create: {
        shape: { presentationId: 'string', url: 'string', title: 'string' },
        sample: { presentationId: '1NewSlidesIdABCDEF', url: 'https://docs.google.com/presentation/d/1NewSlidesIdABCDEF/edit', title: 'New presentation' },
    },
    slides_export_pdf: {
        shape: { presentationId: 'string', url: 'string', mimeType: 'string' },
        sample: { presentationId: '1PrEsIdSlIdEsAbCdEfG', url: 'https://www.googleapis.com/drive/v3/files/1PrEsIdSlIdEsAbCdEfG/export?mimeType=application%2Fpdf', mimeType: 'application/pdf' },
    },

    transcribe_audio: {
        shape: { text: 'string', durationSec: 'number', language: 'string', segments: 'array of { start, end, text, speaker? }' },
        sample: {
            text: '<full transcript>',
            durationSec: 120,
            language: 'en',
            segments: [
                { start: 0, end: 4.2, text: '<segment>', speaker: 'SPEAKER_00' },
                { start: 4.2, end: 8.5, text: '<segment>', speaker: 'SPEAKER_01' },
            ],
        },
    },
};

function getOutputSchema(toolName) {
    return OUTPUT_SCHEMAS[toolName] || null;
}

/**
 * Synthesize a typed placeholder output for dry-run when a tool has a
 * declared schema. Falls back to a name-pattern guess (so unschema'd
 * write tools still produce a plausible shape the AI can bind against),
 * and a last-resort sentinel object.
 *
 * Returns a deep clone so callers can mutate freely.
 */
function synthesizeDryRunOutput(toolName, args) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (schema?.sample !== undefined) {
        return JSON.parse(JSON.stringify(schema.sample));
    }
    // Name-pattern fallback. Most write actions follow a verb suffix
    // convention; we synthesise a shape that matches what those tools
    // actually return at runtime so an automation built on top of an
    // unschema'd tool still gets a workable bind target during dry-run.
    return inferShapeFromName(toolName, args);
}

const VERB_SUFFIX_SHAPES = [
    { match: /_send(_message)?$/,     sample: () => ({ sent: true, id: 'sample-id', message: 'Sent (dry-run preview).' }) },
    { match: /_reply$/,                sample: () => ({ sent: true, id: 'sample-id', message: 'Reply sent (dry-run preview).' }) },
    { match: /_compose$/,              sample: () => ({ sent: true, id: 'sample-id', message: 'Sent (dry-run preview).' }) },
    { match: /_post$/,                 sample: () => ({ id: 'sample-id', published: true, url: 'https://example.com/sample-id' }) },
    { match: /_create(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', created: true, url: 'https://example.com/sample-id' }) },
    { match: /_add(_[a-z_]+)?$/,       sample: () => ({ id: 'sample-id', added: true }) },
    { match: /_update(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', updated: true }) },
    { match: /_set(_[a-z_]+)?$/,       sample: () => ({ id: 'sample-id', set: true }) },
    { match: /_delete(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', deleted: true }) },
    { match: /_remove(_[a-z_]+)?$/,    sample: () => ({ id: 'sample-id', removed: true }) },
    { match: /_move(_[a-z_]+)?$/,      sample: () => ({ id: 'sample-id', moved: true }) },
    { match: /_share(_[a-z_]+)?$/,     sample: () => ({ id: 'sample-id', shared: true, url: 'https://example.com/share/sample-id' }) },
    { match: /_write$/,                sample: () => ({ id: 'sample-id', written: true }) },
    { match: /_attach$/,               sample: () => ({ id: 'sample-id', attached: true }) },
];

function inferShapeFromName(toolName, args) {
    if (typeof toolName !== 'string') {
        return { _dryRun: true, wouldHaveCalled: toolName, withArgs: args || {} };
    }
    for (const { match, sample } of VERB_SUFFIX_SHAPES) {
        if (match.test(toolName)) {
            return { ...sample(), _dryRun: true, _inferred: true, wouldHaveCalled: toolName };
        }
    }
    return { _dryRun: true, wouldHaveCalled: toolName, withArgs: args || {} };
}

/**
 * Lightweight description of a tool's shape, used in the Builder system
 * prompt so the AI can bind correct paths on the first try. Returns a
 * string like "results: array of { id, subject, ... }, total: integer".
 */
function describeShape(toolName) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (!schema?.shape) return null;
    if (schema.shape._string) return `(returns a string: ${schema.shape._string})`;
    return Object.entries(schema.shape).map(([k, v]) => `${k}: ${v}`).join('; ');
}

/**
 * Output field names whose value is an ARRAY — the things a per-step `forEach`
 * can iterate over (overRef = `steps.<id>.output.<field>`). Derived from the
 * declared shape (values described as "array …") plus any array fields in the
 * sample. Returns [] when the tool returns no iterable list / is unknown.
 */
function iterableFieldsOf(toolName) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (!schema) return [];
    const out = new Set();
    if (schema.shape && typeof schema.shape === 'object' && !schema.shape._string) {
        for (const [k, v] of Object.entries(schema.shape)) {
            if (k.startsWith('_')) continue;
            if (typeof v === 'string' && /array/i.test(v)) out.add(k);
        }
    }
    const sample = schema.sample;
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
        for (const [k, v] of Object.entries(sample)) {
            if (Array.isArray(v)) out.add(k);
        }
    }
    return [...out];
}

/** Whether a tool's output contains (or is) a list the AI can forEach over. */
function producesList(toolName) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (!schema) return false;
    if (Array.isArray(schema.sample)) return true;            // top-level array output
    return iterableFieldsOf(toolName).length > 0;
}

module.exports = { OUTPUT_SCHEMAS, getOutputSchema, synthesizeDryRunOutput, describeShape, iterableFieldsOf, producesList };
