/**
 * Output Schemas — JSON-schema-lite definitions for the outputs of
 * commonly-chained integration tools. Used by:
 *   1. The Builder agent — to know what fields are available downstream.
 *   2. The runner — during dry-run, to synthesize realistic placeholder
 *      output for side-effect tools (which we never call in dry-run).
 *
 * V1 covers ~12 chainable tools. Tools without an entry are treated as
 * opaque (string output) — chaining still works, but the AI must use
 * raw "ref" bindings without field hints.
 */

const OUTPUT_SCHEMAS = {
    gmail_search: {
        type: 'object',
        properties: {
            items: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        threadId: { type: 'string' },
                        from: { type: 'string' },
                        to: { type: 'string' },
                        subject: { type: 'string' },
                        snippet: { type: 'string' },
                        date: { type: 'string' },
                        labels: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
            count: { type: 'integer' },
        },
        sample: {
            items: [
                { id: 'msg-1', threadId: 'th-1', from: 'sender@example.com', to: 'me@example.com', subject: 'Sample subject', snippet: 'Sample body snippet…', date: new Date().toISOString(), labels: ['INBOX'] },
            ],
            count: 1,
        },
    },

    gmail_read: {
        type: 'object',
        properties: {
            id: { type: 'string' },
            from: { type: 'string' },
            to: { type: 'string' },
            subject: { type: 'string' },
            body: { type: 'string' },
            date: { type: 'string' },
            attachments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, filename: { type: 'string' }, mimeType: { type: 'string' }, size: { type: 'integer' } } } },
        },
        sample: { id: 'msg-1', from: 'sender@example.com', to: 'me@example.com', subject: 'Sample subject', body: 'Sample full email body…', date: new Date().toISOString(), attachments: [] },
    },

    calendar_list_events: {
        type: 'object',
        properties: {
            events: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        summary: { type: 'string' },
                        start: { type: 'string' },
                        end: { type: 'string' },
                        location: { type: 'string' },
                        attendees: { type: 'array', items: { type: 'string' } },
                    },
                },
            },
        },
        sample: { events: [{ id: 'evt-1', summary: 'Sample meeting', start: new Date(Date.now() + 3600_000).toISOString(), end: new Date(Date.now() + 7200_000).toISOString(), location: '', attendees: [] }] },
    },

    calendar_create_event: {
        type: 'object',
        properties: { id: { type: 'string' }, htmlLink: { type: 'string' }, summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } },
        sample: { id: 'evt-new', htmlLink: 'https://calendar.google.com/event?eid=…', summary: 'Created event', start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() },
    },

    drive_search: {
        type: 'object',
        properties: {
            files: {
                type: 'array',
                items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, mimeType: { type: 'string' }, webViewLink: { type: 'string' }, modifiedTime: { type: 'string' } } },
            },
        },
        sample: { files: [{ id: 'file-1', name: 'Sample.pdf', mimeType: 'application/pdf', webViewLink: 'https://drive.google.com/file/d/file-1', modifiedTime: new Date().toISOString() }] },
    },

    docs_create: {
        type: 'object',
        properties: { documentId: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' } },
        sample: { documentId: 'doc-1', title: 'New document', url: 'https://docs.google.com/document/d/doc-1' },
    },

    docs_append_text: {
        type: 'object',
        properties: { documentId: { type: 'string' }, success: { type: 'boolean' } },
        sample: { documentId: 'doc-1', success: true },
    },

    outlook_search: {
        type: 'object',
        properties: {
            items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, from: { type: 'string' }, subject: { type: 'string' }, preview: { type: 'string' }, receivedDateTime: { type: 'string' } } } },
        },
        sample: { items: [{ id: 'msg-1', from: 'sender@example.com', subject: 'Sample', preview: '…', receivedDateTime: new Date().toISOString() }] },
    },

    ms_calendar_list_events: {
        type: 'object',
        properties: {
            events: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, subject: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } } } },
        },
        sample: { events: [{ id: 'evt-1', subject: 'Sample', start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() }] },
    },

    agent_search: {
        type: 'object',
        properties: {
            results: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, snippet: { type: 'string' } } } },
        },
        sample: { results: [{ url: 'https://example.com', title: 'Sample result', snippet: 'Sample snippet…' }] },
    },

    kb_search: {
        type: 'object',
        properties: {
            chunks: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, source: { type: 'string' }, score: { type: 'number' } } } },
        },
        sample: { chunks: [{ id: 'chunk-1', content: 'Sample knowledge…', source: 'doc.pdf', score: 0.92 }] },
    },

    youtrack_search_issues: {
        type: 'object',
        properties: {
            issues: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, summary: { type: 'string' }, state: { type: 'string' }, assignee: { type: 'string' }, url: { type: 'string' } } } },
        },
        sample: { issues: [{ id: 'PROJ-1', summary: 'Sample issue', state: 'Open', assignee: 'someone', url: 'https://youtrack.example.com/issue/PROJ-1' }] },
    },
};

function getOutputSchema(toolName) {
    return OUTPUT_SCHEMAS[toolName] || null;
}

/**
 * Synthesize a typed placeholder output for dry-run when a tool has a
 * declared schema. Falls back to a sentinel object describing what
 * *would* have been called.
 */
function synthesizeDryRunOutput(toolName, args) {
    const schema = OUTPUT_SCHEMAS[toolName];
    if (schema?.sample) {
        // Deep-clone so callers can mutate freely.
        return JSON.parse(JSON.stringify(schema.sample));
    }
    return { _dryRun: true, wouldHaveCalled: toolName, withArgs: args || {} };
}

module.exports = { OUTPUT_SCHEMAS, getOutputSchema, synthesizeDryRunOutput };
