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
            date: 'string', body: 'string (plain text)', html: 'string (optional)',
            attachments: 'array of { id, filename, mimeType, size }',
        },
        sample: {
            id: 'msg-1', threadId: 'th-1',
            from: 'sender@example.com', to: 'me@example.com',
            subject: 'Sample invoice', date: 'Mon, 06 Apr 2026 08:23:19 -0700',
            body: 'Beste klant,\n\nHierbij ontvangt u onze factuur met nummer 2026-001.\n\nBedrag: €1,234.50 (incl. BTW)\nBetalingstermijn: 30 dagen.\n\nMet vriendelijke groet.',
            attachments: [],
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
    nextcloud_mail_send: {
        shape: { sent: 'boolean', messageId: 'string', message: 'string' },
        sample: { sent: true, messageId: 'nc-mail-1', message: 'Email sent via Nextcloud Mail.' },
    },
    nextcloud_talk_send_message: {
        shape: { id: 'integer', token: 'string', message: 'string', sent: 'boolean' },
        sample: { id: 1, token: 'room-token', message: 'Message text', sent: true },
    },
    nextcloud_calendar_create_event: {
        shape: { id: 'string', uri: 'string', summary: 'string', start: 'string', end: 'string' },
        sample: { id: 'nc-evt-1', uri: '/event/uri', summary: 'Created event', start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() },
    },
    nextcloud_notifications_send: {
        shape: { sent: 'boolean', notificationId: 'integer' },
        sample: { sent: true, notificationId: 1 },
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

module.exports = { OUTPUT_SCHEMAS, getOutputSchema, synthesizeDryRunOutput, describeShape };
