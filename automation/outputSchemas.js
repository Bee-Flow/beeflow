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
        shape: { success: 'boolean', messageId: 'string', message: 'string' },
        sample: { success: true, messageId: 'msg-sent-1', message: 'Email sent via Gmail' },
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

    // ── Notification (built-in step) ──────────────────────────────
    // Not technically a tool, but exposed for symmetry.
};

function getOutputSchema(toolName) {
    return OUTPUT_SCHEMAS[toolName] || null;
}

/**
 * Synthesize a typed placeholder output for dry-run when a tool has a
 * declared schema. Falls back to a sentinel object describing what
 * *would* have been called.
 *
 * Returns a deep clone so callers can mutate freely.
 */
function synthesizeDryRunOutput(toolName, args) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (schema?.sample !== undefined) {
        return JSON.parse(JSON.stringify(schema.sample));
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
