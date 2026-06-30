/**
 * Few-shot worked dialogues for the builder agent (§WS5, extracted verbatim
 * from builderPrompt.js).
 */

/**
 * Few-shot messages prepended to the conversation when the model profile
 * asks for them (small / mid / reasoning profiles set `fewShots: 1 or 2`).
 *
 * Each example is a short [user, assistant_with_tool_calls, tool_result]
 * triplet that teaches a concrete tool-call sequence. Small models learn
 * the binding format from these much faster than from a wall of prose.
 *
 * Returns an array of OpenAI-format messages suitable for splicing into
 * the existing messages list right after the system prompt.
 *
 * The tool_call ids are sentinels (\`ex_*\`); applyToolCall is never called
 * on them — they only exist to teach the protocol.
 */
function buildFewShotMessages(count = 0) {
    if (count <= 0) return [];

    const examples = [
        // Example 1: a schedule trigger + AI step + notification.
        // Demonstrates literal bindings, ref bindings, outputSchema.
        [
            { role: 'user', content: 'Every Monday at 9am, summarise unread emails labeled "invoices" and send me the summary.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_t1', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({ kind: 'schedule', cron: '0 9 * * 1', tz: 'Europe/Amsterdam' }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_t1', content: JSON.stringify({ ok: true, trigger: { id: 'trg', kind: 'schedule' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_t2', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            tool: 'gmail_search',
                            inputs: {
                                q: { kind: 'literal', value: 'label:invoices is:unread newer_than:7d' },
                                maxResults: { kind: 'literal', value: 50 },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_t2', content: JSON.stringify({ ok: true, stepId: 's_a1' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_t3', type: 'function',
                    function: {
                        name: 'builder_add_ai_step',
                        arguments: JSON.stringify({
                            afterStepId: 's_a1',
                            prompt: 'Summarise these invoice emails into a one-paragraph digest. Respond with JSON {"summary":"..."}.',
                            outputSchema: { summary: 'string' },
                            inputs: { messages: { kind: 'ref', path: 'steps.s_a1.output.messages' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_t3', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_t4', type: 'function',
                    function: {
                        name: 'builder_add_notification',
                        arguments: JSON.stringify({
                            afterStepId: 's_ai',
                            title: { kind: 'literal', value: 'Weekly invoice digest' },
                            body: { kind: 'ref', path: 'steps.s_ai.output.summary' },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_t4', content: JSON.stringify({ ok: true, stepId: 's_n1' }) },
        ],
        // Example 2: INSPECT-THEN-BIND. The catalog only shows an input count,
        // so the agent inspects gmail_search first to learn the exact `q` param
        // and `results` output field — then binds those exactly (no guessing).
        [
            { role: 'user', content: 'Every morning search my Gmail for unread invoices and notify me with the list.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_i0', type: 'function',
                    function: { name: 'builder_inspect_tool', arguments: JSON.stringify({ tool: 'gmail_search' }) },
                }],
            },
            {
                role: 'tool', tool_call_id: 'ex_i0',
                content: JSON.stringify({
                    tool: 'gmail_search',
                    inputs: { q: { type: 'string', required: true }, maxResults: { type: 'number', required: false } },
                    requiredInputs: ['q'],
                    shape: 'results: array of { id, from, subject, date, snippet }; total: integer',
                    iterableFields: ['results'],
                }),
            },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_i1', type: 'function',
                    function: { name: 'builder_propose_trigger', arguments: JSON.stringify({ kind: 'schedule', cron: '0 8 * * *', tz: 'Europe/Amsterdam' }) },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_i1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_i2', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            tool: 'gmail_search',
                            inputs: { q: { kind: 'literal', value: 'label:invoices is:unread' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_i2', content: JSON.stringify({ ok: true, stepId: 's_search' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_i3', type: 'function',
                    function: {
                        name: 'builder_add_notification',
                        arguments: JSON.stringify({
                            afterStepId: 's_search',
                            title: { kind: 'literal', value: 'Unread invoices' },
                            body: { kind: 'ref', path: 'steps.s_search.output.results' },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_i3', content: JSON.stringify({ ok: true, stepId: 's_notif' }) },
        ],
        // Example 3: UPDATE-IN-PLACE. Build an ai_step, then EDIT it with
        // builder_update_step (keeps the id + wiring) — never delete + re-add.
        [
            { role: 'user', content: 'Draft a reply to incoming support emails — then make it use the thinking model and reply in Dutch.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_e1', type: 'function',
                    function: { name: 'builder_propose_trigger', arguments: JSON.stringify({ kind: 'app_event', appProvider: 'gmail', appEvent: 'mail.new' }) },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_e1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_e2', type: 'function',
                    function: {
                        name: 'builder_add_ai_step',
                        arguments: JSON.stringify({
                            prompt: 'Draft a short, friendly reply. Respond with JSON {"replyText":"..."}.',
                            outputSchema: { replyText: 'string' },
                            inputs: { snippet: { kind: 'ref', path: 'trigger.output.snippet' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_e2', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_e3', type: 'function',
                    function: {
                        name: 'builder_update_step',
                        arguments: JSON.stringify({
                            stepId: 's_ai',
                            patch: { modelTier: 'thinking', systemPrompt: 'You are a courteous support agent. Always reply in Dutch.' },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_e3', content: JSON.stringify({ updated: { id: 's_ai', type: 'ai_step' } }) },
        ],
        // Example 4: an app_event trigger (Gmail) + reply via ai_step + compose.
        // Demonstrates template bindings and replyToMessageId.
        [
            { role: 'user', content: 'When an email comes from boss@example.com, draft a polite acknowledgement and reply.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_u1', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({
                            kind: 'app_event',
                            appProvider: 'gmail',
                            appEvent: 'mail.new',
                            filter: { from: 'boss@example.com', excludeFromSelf: true },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_u1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_u2', type: 'function',
                    function: {
                        name: 'builder_add_ai_step',
                        arguments: JSON.stringify({
                            systemPrompt: 'You are a courteous customer-support assistant. Keep replies warm, concise, and professional.',
                            prompt: 'Draft a polite acknowledgement to this email. Respond with JSON {"replyText":"..."}.',
                            outputSchema: { replyText: 'string' },
                            inputs: {
                                from: { kind: 'ref', path: 'trigger.output.from' },
                                subject: { kind: 'ref', path: 'trigger.output.subject' },
                                snippet: { kind: 'ref', path: 'trigger.output.snippet' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_u2', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_u3', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_ai',
                            tool: 'gmail_compose',
                            inputs: {
                                replyToMessageId: { kind: 'ref', path: 'trigger.output.messageId' },
                                body: { kind: 'ref', path: 'steps.s_ai.output.replyText' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_u3', content: JSON.stringify({ ok: true, stepId: 's_send' }) },
        ],
        // Example 5 (Nextcloud): file.new (poller-backed) → read the file →
        // AI summarise → post to a Talk room. Teaches the NC binding shapes
        // (trigger.output.path, nextcloud_read_file.content) and that
        // nextcloud_talk_send_message needs a `token` (the Talk room token).
        [
            { role: 'user', content: 'When a PDF lands in my Nextcloud Documents folder, summarise it and post the summary to my Talk room.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_n1', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({
                            kind: 'app_event',
                            appProvider: 'nextcloud',
                            appEvent: 'file.new',
                            filter: { inFolder: '/Documents/', extension: 'pdf' },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_n1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_n2', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            tool: 'nextcloud_read_file',
                            inputs: { path: { kind: 'ref', path: 'trigger.output.path' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_n2', content: JSON.stringify({ ok: true, stepId: 's_read' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_n3', type: 'function',
                    function: {
                        name: 'builder_add_ai_step',
                        arguments: JSON.stringify({
                            afterStepId: 's_read',
                            prompt: 'Summarise this document in 3 sentences. Respond with JSON {"summary":"..."}.',
                            outputSchema: { summary: 'string' },
                            inputs: { text: { kind: 'ref', path: 'steps.s_read.output.content' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_n3', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_n4', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_ai',
                            tool: 'nextcloud_talk_send_message',
                            inputs: {
                                // `token` is the Talk room token — ask the user for it
                                // (this placeholder must be replaced before activating).
                                token: { kind: 'literal', value: '<your-talk-room-token>' },
                                message: { kind: 'ref', path: 'steps.s_ai.output.summary' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_n4', content: JSON.stringify({ ok: true, stepId: 's_post' }) },
        ],
        // Example 6: mail attachment → Google Drive via sourceHandle (no base64
        // through the AI context). Demonstrates filter.hasAttachment, the
        // attachments[] payload, the sourceHandle pattern, and chained
        // drive_create_folder for the invoices/year/month/supplier path.
        [
            { role: 'user', content: 'When an invoice email comes in, file the PDF in Google Drive under invoices/year/month/supplier.' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v1', type: 'function',
                    function: {
                        name: 'builder_propose_trigger',
                        arguments: JSON.stringify({
                            kind: 'app_event',
                            appProvider: 'gmail',
                            appEvent: 'mail.new',
                            filter: { hasAttachment: true },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v1', content: JSON.stringify({ ok: true, trigger: { id: 'trg' } }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v2', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            tool: 'gmail_read_attachment',
                            inputs: {
                                messageId: { kind: 'ref', path: 'trigger.output.messageId' },
                                attachmentId: { kind: 'ref', path: 'trigger.output.attachments.0.attachmentId' },
                                filename: { kind: 'ref', path: 'trigger.output.attachments.0.filename' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v2', content: JSON.stringify({ ok: true, stepId: 's_read' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v3', type: 'function',
                    function: {
                        name: 'builder_add_ai_step',
                        arguments: JSON.stringify({
                            afterStepId: 's_read',
                            prompt: 'Determine if this text is an invoice. If yes, extract supplier, year (YYYY) and month (MM). Respond with JSON.',
                            outputSchema: { isInvoice: 'boolean', supplier: 'string', year: 'string', month: 'string' },
                            inputs: { text: { kind: 'ref', path: 'steps.s_read.output.content' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v3', content: JSON.stringify({ ok: true, stepId: 's_ai' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v4', type: 'function',
                    function: {
                        name: 'builder_add_condition',
                        arguments: JSON.stringify({
                            afterStepId: 's_ai',
                            expr: 'steps.s_ai.output.isInvoice === true',
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v4', content: JSON.stringify({ ok: true, stepId: 's_if' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v5', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_if',
                            tool: 'drive_create_folder',
                            inputs: { name: { kind: 'ref', path: 'steps.s_ai.output.year' } },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v5', content: JSON.stringify({ ok: true, stepId: 's_year' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v6', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_year',
                            tool: 'drive_create_folder',
                            inputs: {
                                name: { kind: 'ref', path: 'steps.s_ai.output.month' },
                                parentFolderId: { kind: 'ref', path: 'steps.s_year.output.folderId' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v6', content: JSON.stringify({ ok: true, stepId: 's_month' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v7', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_month',
                            tool: 'drive_create_folder',
                            inputs: {
                                name: { kind: 'ref', path: 'steps.s_ai.output.supplier' },
                                parentFolderId: { kind: 'ref', path: 'steps.s_month.output.folderId' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v7', content: JSON.stringify({ ok: true, stepId: 's_supp' }) },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id: 'ex_v8', type: 'function',
                    function: {
                        name: 'builder_add_action',
                        arguments: JSON.stringify({
                            afterStepId: 's_supp',
                            tool: 'drive_upload_file',
                            inputs: {
                                name: { kind: 'ref', path: 'trigger.output.attachments.0.filename' },
                                parentFolderId: { kind: 'ref', path: 'steps.s_supp.output.folderId' },
                                sourceHandle: { kind: 'ref', path: 'steps.s_read.output.sourceHandle' },
                            },
                        }),
                    },
                }],
            },
            { role: 'tool', tool_call_id: 'ex_v8', content: JSON.stringify({ ok: true, stepId: 's_up' }) },
        ],
    ];

    return examples.slice(0, count).flat();
}

module.exports = { buildFewShotMessages };
