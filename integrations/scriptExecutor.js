/**
 * Script Executor — runs AI-generated JavaScript automation scripts.
 *
 * Each script is a function `async function run(ctx) { ... }` that:
 * - Phase 1 (preview): finds matching items, returns { changes: [...] }
 * - Phase 2 (execute): with ctx.approved = true, performs the changes
 *
 * The ctx object provides tool APIs for all connected apps + ai.process()
 * for fuzzy matching only. All tool calls are logged for visibility.
 */

const { executeGmailTool, createGmailClient } = require('./gmailTools');
const { executeCalendarTool } = require('./calendarTools');
const { executeDriveTool, createDriveClient } = require('./driveTools');
const { Readable } = require('stream');
const { executeSlidesTool } = require('./slidesTools');
const { executeFirefliesTool } = require('./firefliesTools');
const { executeYouTrackTool } = require('./youtrackTools');
const { executeSheetsTool } = require('./sheetsTools');
const { executeDocsTool } = require('./docsTools');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const configStore = require('../stores/configStore');
const taskStore = require('../stores/taskStore');
const notificationStore = require('../stores/notificationStore');

/**
 * Build the ctx object that scripts use to interact with tools.
 * Every tool call is logged into ctx._log for visibility.
 */
async function buildContext(task, session, approved = false) {
    const userId = session?.user?.id || session?.userId;
    const log = []; // Captures every tool call

    // Helper: wraps an async function to log its call and result
    async function tracked(category, method, fn) {
        return async (...args) => {
            const entry = { tool: `${category}.${method}`, args: summarizeArgs(args), ts: Date.now() };
            try {
                const result = await fn(...args);
                entry.success = true;
                entry.summary = summarizeResult(category, method, result);
                log.push(entry);
                console.log(`[ScriptExecutor] ${entry.tool}(${entry.args}) → ${entry.summary}`);
                return result;
            } catch (err) {
                entry.success = false;
                entry.error = err.message;
                log.push(entry);
                console.error(`[ScriptExecutor] ${entry.tool}(${entry.args}) → ERROR: ${err.message}`);
                throw err;
            }
        };
    }

    // Gmail helpers
    let gmail = null;
    try { gmail = await createGmailClient(session); } catch (e) { }

    // Drive client for direct API access (upload)
    let drive = null;
    try { drive = await createDriveClient(session); } catch (e) { }

    const ctx = {
        approved,
        _log: log,
        task: {
            id: task.id,
            title: task.title,
            description: task.description,
            lastRunAt: task.last_run_at || null,
        },

        // ── Ledger — deduplication across runs ──────────
        ledger: {
            /**
             * Check if an item was already processed by this task.
             * @param {string} itemId - The item identifier (e.g. email ID, file ID)
             */
            hasProcessed: async (itemId) => {
                return taskStore.isProcessed(task.id, itemId);
            },
            /**
             * Mark an item as processed by this task.
             * @param {string} itemId - The item identifier
             * @param {string} [action='processed'] - What was done
             */
            markProcessed: async (itemId, action = 'processed') => {
                return taskStore.recordProcessed(task.id, itemId, action);
            },
            /**
             * Filter an array of items to only those not yet processed.
             * @param {Array} items - Array of items with an `id` field
             * @param {string} [idField='id'] - Which field to use as identifier
             * @returns {Array} Only the unprocessed items
             */
            filterNew: async (items, idField = 'id') => {
                if (!items || items.length === 0) return [];
                const processed = await taskStore.getProcessedHashes(task.id);
                return items.filter(item => {
                    const val = item[idField];
                    if (!val) return true; // keep items without ID
                    const h = taskStore.hashItem(val);
                    return !processed.has(h);
                });
            },
        },

        // ── Notifications — send alerts to the user ─────
        notify: tracked('notify', 'send', async (title, message, category = 'info') => {
            const validCats = ['info', 'heads_up', 'urgent'];
            await notificationStore.createNotification({
                userId,
                taskId: task.id,
                category: validCats.includes(category) ? category : 'info',
                title,
                message: message || '',
            });
            return { sent: true };
        }),

        // ── Gmail ───────────────────────────────────────
        gmail: {
            search: tracked('gmail', 'search', async (query, maxResults = 10) => {
                const result = await executeGmailTool('gmail_search', { query, maxResults }, session);
                return (result?.results || []).map(r => ({
                    id: r.id,
                    from: r.from || '',
                    subject: r.subject || '',
                    date: r.date || '',
                    snippet: r.snippet || '',
                }));
            }),
            read: tracked('gmail', 'read', async (messageId) => {
                return executeGmailTool('gmail_read', { messageId }, session);
            }),
            compose: tracked('gmail', 'compose', async (to, subject, body) => {
                return executeGmailTool('gmail_compose', { to, subject, body }, session);
            }),
            label: tracked('gmail', 'label', async (messageId, labelName) => {
                if (!gmail) throw new Error('Gmail not connected');
                const labelsRes = await gmail.users.labels.list({ userId: 'me' });
                let labelId = (labelsRes.data.labels || []).find(l => l.name.toLowerCase() === labelName.toLowerCase())?.id;
                if (!labelId) {
                    try {
                        const created = await gmail.users.labels.create({
                            userId: 'me',
                            requestBody: { name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
                        });
                        labelId = created.data.id;
                    } catch (e) {
                        // Label may already exist (case-insensitive conflict) — re-list and find it
                        const retry = await gmail.users.labels.list({ userId: 'me' });
                        labelId = (retry.data.labels || []).find(l => l.name.toLowerCase() === labelName.toLowerCase())?.id;
                        if (!labelId) throw e; // truly unexpected error
                    }
                }
                await gmail.users.messages.modify({
                    userId: 'me', id: messageId,
                    requestBody: { addLabelIds: [labelId] },
                });
                // Auto-record in ledger
                await taskStore.recordProcessed(task.id, messageId, 'label:' + labelName);
                return { labeled: true, label: labelName };
            }),
            archive: tracked('gmail', 'archive', async (messageId) => {
                if (!gmail) throw new Error('Gmail not connected');
                await gmail.users.messages.modify({
                    userId: 'me', id: messageId,
                    requestBody: { removeLabelIds: ['INBOX'] },
                });
                // Auto-record in ledger
                await taskStore.recordProcessed(task.id, messageId, 'archive');
                return { archived: true };
            }),
            forward: tracked('gmail', 'forward', async (messageId, to) => {
                const full = await executeGmailTool('gmail_read', { messageId }, session);
                const result = await executeGmailTool('gmail_compose', {
                    to,
                    subject: `Fwd: ${full.subject || '(no subject)'}`,
                    body: `---------- Forwarded message ----------\nFrom: ${full.from}\nSubject: ${full.subject}\n\n${(full.body || '').substring(0, 3000)}`,
                }, session);
                // Auto-record in ledger
                await taskStore.recordProcessed(task.id, messageId, 'forward');
                return result;
            }),
            getAttachment: tracked('gmail', 'getAttachment', async (messageId, attachmentId) => {
                if (!gmail) throw new Error('Gmail not connected');
                const attachment = await gmail.users.messages.attachments.get({
                    userId: 'me', messageId, id: attachmentId,
                });
                const base64Data = attachment.data.data;
                if (!base64Data) throw new Error('Attachment data is empty');
                // Convert from URL-safe base64 to standard base64
                const standardBase64 = base64Data.replace(/-/g, '+').replace(/_/g, '/');
                return { data: standardBase64, size: standardBase64.length };
            }),
        },

        // ── Calendar ────────────────────────────────────
        calendar: {
            listEvents: tracked('calendar', 'listEvents', async (daysAhead = 7, maxResults = 20) => {
                return executeCalendarTool('calendar_list_events', { daysAhead, maxResults }, session);
            }),
            searchEvents: tracked('calendar', 'searchEvents', async (query, daysAhead = 30) => {
                return executeCalendarTool('calendar_search_events', { query, daysAhead }, session);
            }),
            createEvent: tracked('calendar', 'createEvent', async (opts) => {
                return executeCalendarTool('calendar_create_event', opts, session);
            }),
            updateEvent: tracked('calendar', 'updateEvent', async (opts) => {
                return executeCalendarTool('calendar_update_event', opts, session);
            }),
        },

        // ── Drive ───────────────────────────────────────
        drive: {
            search: tracked('drive', 'search', async (query, maxResults = 10) => {
                const result = await executeDriveTool('drive_search', { query, maxResults }, session);
                return result?.results || [];
            }),
            listFiles: tracked('drive', 'listFiles', async (folderId) => {
                const result = await executeDriveTool('drive_list_files', { folderId }, session);
                return result?.results || [];
            }),
            createFolder: tracked('drive', 'createFolder', async (name, parentFolderId) => {
                const result = await executeDriveTool('drive_create_folder', { name, parentFolderId }, session);
                // Return both id and folderId so scripts can use either
                return { id: result?.folderId, folderId: result?.folderId, name: result?.name, link: result?.link, success: result?.success };
            }),
            moveFile: tracked('drive', 'moveFile', async (fileId, destinationFolderId) => {
                const result = await executeDriveTool('drive_move_file', { fileId, destinationFolderId }, session);
                // Auto-record in ledger
                await taskStore.recordProcessed(task.id, fileId, 'move');
                return result;
            }),
            getFile: tracked('drive', 'getFile', async (fileId) => {
                return executeDriveTool('drive_get_file', { fileId }, session);
            }),
            uploadFile: tracked('drive', 'uploadFile', async ({ name, data, mimeType, folderId }) => {
                if (!drive) throw new Error('Drive not connected');
                const buffer = Buffer.from(data, 'base64');
                const res = await drive.files.create({
                    requestBody: {
                        name,
                        mimeType: mimeType || 'application/octet-stream',
                        parents: folderId ? [folderId] : undefined,
                    },
                    media: {
                        mimeType: mimeType || 'application/octet-stream',
                        body: Readable.from(buffer),
                    },
                    supportsAllDrives: true,
                    fields: 'id, name, webViewLink',
                });
                return {
                    success: true,
                    fileId: res.data.id,
                    name: res.data.name,
                    link: res.data.webViewLink,
                };
            }),
        },

        // ── Slides ──────────────────────────────────────
        slides: {
            list: tracked('slides', 'list', async (query) => {
                return executeSlidesTool('slides_list_presentations', { query }, session);
            }),
            create: tracked('slides', 'create', async (opts) => {
                return executeSlidesTool('slides_create_presentation', opts, session);
            }),
            addSlide: tracked('slides', 'addSlide', async (opts) => {
                return executeSlidesTool('slides_add_slide', opts, session);
            }),
        },

        // ── YouTrack ────────────────────────────────────
        youtrack: {
            listIssues: tracked('youtrack', 'listIssues', async (query) => {
                return executeYouTrackTool('youtrack_list_issues', { query }, userId);
            }),
            createIssue: tracked('youtrack', 'createIssue', async (opts) => {
                return executeYouTrackTool('youtrack_create_issue', opts, userId);
            }),
            updateIssue: tracked('youtrack', 'updateIssue', async (opts) => {
                return executeYouTrackTool('youtrack_update_issue', opts, userId);
            }),
        },

        // ── Fireflies ───────────────────────────────────
        fireflies: {
            listTranscripts: tracked('fireflies', 'listTranscripts', async (limit = 10) => {
                return executeFirefliesTool('fireflies_list_transcripts', { limit }, userId);
            }),
            getSummary: tracked('fireflies', 'getSummary', async (transcriptId) => {
                return executeFirefliesTool('fireflies_get_summary', { transcriptId }, userId);
            }),
        },

        // ── Gamma ────────────────────────────────────────
        gamma: {
            create: tracked('gamma', 'create', async (opts) => {
                const { executeGammaTool } = require('./gammaTools');
                return executeGammaTool('gamma_create_presentation', opts, userId);
            }),
        },


        // ── Sheets ──────────────────────────────────────
        sheets: {
            create: tracked('sheets', 'create', async ({ title, sheetNames, folderId }) => {
                return executeSheetsTool('sheets_create', { title, sheetNames, folderId }, session);
            }),
            getValues: tracked('sheets', 'getValues', async (spreadsheetId, range) => {
                const result = await executeSheetsTool('sheets_get_values', { spreadsheetId, range }, session);
                return result?.values || [];
            }),
            appendRows: tracked('sheets', 'appendRows', async (spreadsheetId, range, rows) => {
                return executeSheetsTool('sheets_append_rows', { spreadsheetId, range, rows }, session);
            }),
            updateValues: tracked('sheets', 'updateValues', async (spreadsheetId, range, values) => {
                return executeSheetsTool('sheets_update_values', { spreadsheetId, range, values }, session);
            }),
        },

        // ── Docs ────────────────────────────────────────
        docs: {
            create: tracked('docs', 'create', async ({ title, body, folderId }) => {
                return executeDocsTool('docs_create', { title, body, folderId }, session);
            }),
            read: tracked('docs', 'read', async (documentId) => {
                const result = await executeDocsTool('docs_read', { documentId }, session);
                return result?.text || '';
            }),
            append: tracked('docs', 'append', async (documentId, text) => {
                return executeDocsTool('docs_append', { documentId, text }, session);
            }),
            replaceText: tracked('docs', 'replaceText', async (documentId, findText, replaceText, matchCase) => {
                return executeDocsTool('docs_replace_text', { documentId, findText, replaceText, matchCase }, session);
            }),
        },

        // ── AI (for fuzzy matching/transforms only — always uses fast tier) ──
        ai: {
            process: tracked('ai', 'process', async (prompt) => {
                // Always use the "fast" tier model for script AI calls
                const tiers = configStore.getConfig('chat_model_tiers') || {};
                const fastTier = tiers.fast || {};
                const fastModelId = fastTier.modelId;
                const defaultConfig = await getAIConfig();

                let modelId = fastModelId || defaultConfig.defaultModel || defaultConfig.model;
                let providerConfig;
                try {
                    providerConfig = await getProviderForModel(modelId);
                } catch (e) {
                    providerConfig = defaultConfig;
                }
                modelId = providerConfig.model || modelId;
                const providerType = providerConfig.providerType || providerConfig.provider || 'openai';
                const adapter = getAdapter(providerType);
                const baseUrl = (providerConfig.url || defaultConfig.url || '').replace(/\/+$/, '');
                const apiKey = providerConfig.apiKey || defaultConfig.apiKey || '';
                const result = await adapter.chat(
                    apiKey, baseUrl,
                    modelId, [
                    { role: 'system', content: 'You are a data processing assistant. Be concise.' },
                    { role: 'user', content: prompt },
                ], { maxTokens: 1024, temperature: 0.2 }
                );
                return result.content || '';
            }),
            /**
             * OCR a document (PDF/image) using Mistral's vision model.
             * @param {string} base64Data - Base64-encoded file data
             * @param {string} prompt - What to extract from the document
             * @param {string} [mimeType] - MIME type (default: application/pdf)
             * @returns {string} Extracted text / structured response
             */
            ocr: tracked('ai', 'ocr', async (base64Data, prompt, mimeType = 'application/pdf') => {
                const defaultConfig = await getAIConfig();
                // Use pixtral-large for OCR, fall back to fast tier
                const ocrModel = 'pixtral-large-latest';
                let providerConfig;
                try {
                    providerConfig = await getProviderForModel(ocrModel);
                } catch (e) {
                    // If pixtral not available, try fast tier
                    const tiers = configStore.getConfig('chat_model_tiers') || {};
                    const fastModelId = tiers.fast?.modelId;
                    try {
                        providerConfig = await getProviderForModel(fastModelId || defaultConfig.defaultModel || defaultConfig.model);
                    } catch (e2) {
                        providerConfig = defaultConfig;
                    }
                }
                const modelId = providerConfig.model || ocrModel;
                const providerType = providerConfig.providerType || providerConfig.provider || 'mistral';
                const apiKey = providerConfig.apiKey || defaultConfig.apiKey || '';

                // Use Mistral OCR API directly for PDF/image extraction
                const dataUrl = `data:${mimeType};base64,${base64Data}`;
                try {
                    const { Mistral } = require('@mistralai/mistralai');
                    const client = new Mistral({ apiKey });
                    const ocrResult = await client.ocr.process({
                        model: 'mistral-ocr-latest',
                        document: { type: 'document_url', documentUrl: dataUrl },
                    });
                    // Extract text from OCR pages
                    const ocrText = (ocrResult.pages || []).map(p => p.markdown || p.text || '').join('\n');
                    if (ocrText && prompt) {
                        // Pass OCR text through AI for structured extraction
                        const adapter = getAdapter(providerType);
                        const baseUrl = (providerConfig.url || defaultConfig.url || '').replace(/\/+$/, '');
                        const result = await adapter.chat(
                            apiKey, baseUrl, modelId, [
                            { role: 'system', content: 'You are a document processing assistant. Extract information accurately. Be structured and precise.' },
                            { role: 'user', content: `Document content:\n${ocrText}\n\n${prompt}` },
                        ], { maxTokens: 2048, temperature: 0.1 }
                        );
                        return result.content || ocrText;
                    }
                    return ocrText;
                } catch (ocrErr) {
                    console.warn('[ScriptExecutor] Mistral OCR API failed, falling back to chat:', ocrErr.message);
                    // Fallback: send base64 as text description
                    const adapter = getAdapter(providerType);
                    const baseUrl = (providerConfig.url || defaultConfig.url || '').replace(/\/+$/, '');
                    const result = await adapter.chat(
                        apiKey, baseUrl, modelId, [
                        { role: 'system', content: 'You are a document processing assistant. Extract information accurately. Be structured and precise.' },
                        { role: 'user', content: prompt },
                    ], { maxTokens: 2048, temperature: 0.1 }
                    );
                    return result.content || '';
                }
            }),
        },
    };

    return ctx;
}

// ── Helpers for log readability ──────────────────────────

function summarizeArgs(args) {
    return args.map(a => {
        if (a === undefined || a === null) return '';
        if (typeof a === 'string') return a.length > 60 ? a.substring(0, 60) + '…' : a;
        if (typeof a === 'number') return String(a);
        if (typeof a === 'object') {
            const s = JSON.stringify(a);
            return s.length > 60 ? s.substring(0, 60) + '…' : s;
        }
        return String(a);
    }).filter(Boolean).join(', ');
}

function summarizeResult(category, method, result) {
    if (!result) return 'null';
    if (Array.isArray(result)) return `${result.length} items`;
    if (typeof result === 'string') return result.length > 80 ? result.substring(0, 80) + '…' : result;
    // Special summaries
    if (result.labeled) return `labeled "${result.label}"`;
    if (result.archived) return `archived`;
    if (result.events) return `${result.events?.length || 0} events`;
    if (result.files) return `${result.files?.length || 0} files`;
    if (result.from) return `${result.from}: ${(result.subject || '').substring(0, 40)}`;
    const s = JSON.stringify(result);
    return s.length > 80 ? s.substring(0, 80) + '…' : s;
}

/**
 * Run a script in preview mode (Phase 1) — no mutations.
 * Returns { changes, log } — log contains every tool call made.
 */
async function runPreview(task, session) {
    if (!task.script) throw new Error('Task has no script');

    const ctx = await buildContext(task, session, false);
    const result = await executeScript(task.script, ctx);

    return {
        changes: result?.changes || [],
        summary: result?.summary || '',
        log: ctx._log,
    };
}

/**
 * Run a script in execute mode (Phase 2) — performs actual changes.
 * Returns { changes, executed, log } with full tool call history.
 */
async function runExecute(task, session) {
    if (!task.script) throw new Error('Task has no script');

    const ctx = await buildContext(task, session, true);
    const result = await executeScript(task.script, ctx);

    return {
        changes: result?.changes || [],
        executed: result?.executed || false,
        results: result?.results || [],
        log: ctx._log,
    };
}

/**
 * Execute a script string safely.
 * The script should define `async function run(ctx) { ... }`
 * May also define helper functions outside run().
 */
async function executeScript(scriptStr, ctx) {
    try {
        const trimmed = scriptStr.trim();
        // Wrap entire script so all function definitions are available, then call run(ctx)
        const wrapper = `
            ${trimmed}
            return run(ctx);
        `;
        const AsyncFunction = Object.getPrototypeOf(async function () { }).constructor;
        const fn = new AsyncFunction('ctx', wrapper);
        const result = await fn(ctx);
        return result || { changes: [] };
    } catch (err) {
        console.error('[ScriptExecutor] Script execution error:', err.message);
        throw new Error(`Script error: ${err.message}`);
    }
}

module.exports = { runPreview, runExecute, buildContext, executeScript };
