/**
 * Task Executor — runs a single approved task's actions
 *
 * Uses Gmail tools + AI to carry out task actions like labeling,
 * archiving, summarizing emails, creating drafts, etc.
 *
 * ⚠️  Double-checks approval before execution. The approval gate
 *     in taskStore.updateTaskStatus() is the final safeguard.
 */

const { executeGmailTool, createGmailClient } = require('./gmailTools');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const configStore = require('../stores/configStore');
const taskStore = require('../stores/taskStore');
const notificationStore = require('../stores/notificationStore');

// Helper: send notification without breaking task execution
async function notify(userId, taskId, category, title, message) {
    try {
        if (userId) {
            await notificationStore.createNotification({ userId, taskId, category, title, message });
        }
    } catch (err) {
        console.error('[TaskExecutor] Notification error:', err.message);
    }
}

// ── Gmail helpers for real operations ───────────────────

/**
 * Get or create a Gmail label by name (supports nested labels like "Invoices/Auto").
 */
async function getOrCreateLabel(gmail, labelName) {
    const res = await gmail.users.labels.list({ userId: 'me' });
    const existing = (res.data.labels || []).find(l => l.name === labelName);
    if (existing) return existing.id;

    // Create the label
    const created = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
            name: labelName,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show',
        },
    });
    console.log(`[TaskExecutor] Created label: ${labelName} (${created.data.id})`);
    return created.data.id;
}

/**
 * Modify multiple messages (add/remove labels).
 */
async function modifyMessages(gmail, messageIds, addLabelIds = [], removeLabelIds = []) {
    let modified = 0;
    for (const id of messageIds) {
        try {
            await gmail.users.messages.modify({
                userId: 'me',
                id,
                requestBody: { addLabelIds, removeLabelIds },
            });
            modified++;
        } catch (err) {
            console.error(`[TaskExecutor] Modify ${id} failed:`, err.message);
        }
    }
    return modified;
}

/**
 * Search emails and return message IDs.
 */
async function searchEmailIds(gmail, query, maxResults = 20) {
    const res = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults,
    });
    return (res.data.messages || []).map(m => m.id);
}

/**
 * Error classification for actionable messages
 */
function classifyError(err) {
    const msg = err.message || '';
    if (msg.includes('insufficient authentication scopes') || msg.includes('Insufficient Permission')) {
        return { type: 'SCOPE_ERROR', message: 'Re-authenticate with Google to grant updated permissions (gmail.modify, drive). Go to Settings → Connections → Reconnect Google.', original: msg };
    }
    if (msg.includes('401') || msg.includes('Unauthorized') || msg.includes('not connected')) {
        return { type: 'AUTH_ERROR', message: 'Authentication expired. Please re-login with Google.', original: msg };
    }
    if (msg.includes('429') || msg.includes('rate_limit') || msg.includes('Rate Limit')) {
        return { type: 'RATE_LIMIT', message: 'API rate limit hit. Will retry automatically later.', original: msg };
    }
    return { type: 'API_ERROR', message: msg, original: msg };
}

/**
 * Execute a single task.
 */
async function executeTask(task, session) {
    console.log(`[TaskExecutor] Starting: "${task.title}" (${task.id})`);

    const fresh = await taskStore.getTask(task.id);
    if (!fresh || !fresh.approved_by) {
        console.error(`[TaskExecutor] BLOCKED: Task ${task.id} not approved`);
        return { success: false, error: 'Task not approved' };
    }

    // ── Script-based execution (new path) ──
    if (fresh.script) {
        const { runPreview, runExecute } = require('./scriptExecutor');
        const isApprovedExecution = task._executeApproved === true;

        try {
            await taskStore.updateTaskStatus(task.id, 'running');
        } catch (err) {
            return { success: false, error: err.message };
        }

        try {
            if (isApprovedExecution) {
                // Phase 2: execute approved changes
                console.log(`[TaskExecutor] Script EXECUTE: "${task.title}"`);
                const result = await runExecute(fresh, session);
                const payload = {
                    results: (result.changes || []).map(c => ({ action: c.type, success: true, summary: `${c.target}: ${c.detail}` })),
                    log: (result.log || []).map(e => ({ tool: e.tool, args: e.args, success: e.success, summary: e.summary || e.error || '' })),
                    executedAt: new Date().toISOString(),
                    executed: true,
                };
                await taskStore.updateTaskStatus(task.id, 'completed', payload);
                await taskStore.markTaskRun(task.id, computeNextRun(task));
                // Reset to approved for recurring tasks
                if (task.type !== 'manual') {
                    await taskStore.query(
                        'UPDATE tasks SET status = $1, pending_changes = NULL, updated_at = $2 WHERE id = $3',
                        ['approved', new Date().toISOString(), task.id]
                    );
                }
                console.log(`[TaskExecutor] Script done: "${task.title}" → executed ${result.changes?.length || 0} changes`);
                const userId = session?.user?.id || fresh.created_for;
                await notify(userId, task.id, 'info', `✅ ${task.title}`, `Processed ${result.changes?.length || 0} items successfully.`);
                return { success: true, results: result.changes || [] };
            } else {
                // Phase 1: preview — find items, don't mutate
                console.log(`[TaskExecutor] Script PREVIEW: "${task.title}"`);
                const preview = await runPreview(fresh, session);
                const previewLog = (preview.log || []).map(e => ({ tool: e.tool, args: e.args, success: e.success, summary: e.summary || e.error || '' }));
                if (!preview.changes || preview.changes.length === 0) {
                    // Nothing to do — store the log so user can see what was checked
                    console.log(`[TaskExecutor] Script preview: no changes found for "${task.title}"`);
                    const logPayload = previewLog.length > 0 ? { log: previewLog, message: 'No matching items found', checkedAt: new Date().toISOString() } : null;
                    await taskStore.updateTaskStatus(task.id, 'approved', logPayload);
                    await taskStore.markTaskRun(task.id, computeNextRun(task));
                    return { success: true, results: [], noChanges: true };
                }
                // Store pending changes + log and set status to awaiting_approval
                const now = new Date().toISOString();
                const pendingData = { changes: preview.changes, log: previewLog };
                await taskStore.query(
                    'UPDATE tasks SET status = $1, pending_changes = $2, updated_at = $3 WHERE id = $4',
                    ['awaiting_approval', JSON.stringify(pendingData), now, task.id]
                );
                console.log(`[TaskExecutor] Script preview: ${preview.changes.length} changes pending approval for "${task.title}"`);
                const userId = session?.user?.id || fresh.created_for;
                await notify(userId, task.id, 'heads_up', `⏳ ${task.title}`, `${preview.changes.length} changes need your approval.`);
                return { success: true, results: preview.changes, awaitingApproval: true };
            }
        } catch (err) {
            console.error(`[TaskExecutor] Script error for "${task.title}":`, err.message);
            await taskStore.updateTaskStatus(task.id, 'failed', { error: err.message });
            const userId = session?.user?.id || fresh.created_for;
            await notify(userId, task.id, 'urgent', `❌ ${task.title}`, err.message);
            return { success: false, error: err.message };
        }
    }

    // ── Legacy action-based execution ──
    try {
        await taskStore.updateTaskStatus(task.id, 'running');
    } catch (err) {
        console.error(`[TaskExecutor] Gate blocked:`, err.message);
        return { success: false, error: err.message };
    }

    const actions = task.actions || [];
    if (actions.length === 0) {
        await taskStore.updateTaskStatus(task.id, 'completed', { message: 'No actions to execute' });
        return { success: true, results: [] };
    }

    // Create Gmail client once for all actions
    let gmail = null;
    try { gmail = await createGmailClient(session); } catch (e) {
        console.error('[TaskExecutor] Gmail client failed:', e.message);
    }

    const results = [];
    let failCount = 0;
    let scopeError = false;

    for (const action of actions) {
        try {
            console.log(`[TaskExecutor] Action: ${action.type}`, action.config || {});
            const result = await executeAction(action, task, session, gmail);
            results.push({ action: action.type, success: true, ...result });
        } catch (err) {
            const classified = classifyError(err);
            console.error(`[TaskExecutor] Action ${action.type} failed [${classified.type}]:`, classified.message);
            results.push({ action: action.type, success: false, errorType: classified.type, error: classified.message });
            failCount++;
            if (classified.type === 'SCOPE_ERROR') scopeError = true;
        }
    }

    // Determine final status: all failed, partially, or fully completed
    let finalStatus;
    if (failCount === actions.length) {
        finalStatus = 'failed';
    } else if (failCount > 0) {
        finalStatus = 'completed'; // partial success still counts
    } else {
        finalStatus = 'completed';
    }

    const resultPayload = {
        results,
        executedAt: new Date().toISOString(),
        partialSuccess: failCount > 0 && failCount < actions.length,
        scopeError,
    };

    await taskStore.updateTaskStatus(task.id, finalStatus, resultPayload);
    await taskStore.markTaskRun(task.id, computeNextRun(task));

    if (failCount === 0 && task.type !== 'manual') {
        const now = new Date().toISOString();
        await taskStore.query(
            'UPDATE tasks SET status = $1, updated_at = $2 WHERE id = $3',
            ['approved', now, task.id]
        );
    }

    console.log(`[TaskExecutor] Done: "${task.title}" → ${finalStatus} (${actions.length - failCount}/${actions.length} actions succeeded)`);
    const userId = session?.user?.id || fresh.created_for;
    if (finalStatus === 'failed') {
        await notify(userId, task.id, 'urgent', `❌ ${task.title}`, `All ${actions.length} actions failed.`);
    } else if (failCount > 0) {
        await notify(userId, task.id, 'heads_up', `⚠️ ${task.title}`, `${actions.length - failCount}/${actions.length} actions succeeded.`);
    } else {
        await notify(userId, task.id, 'info', `✅ ${task.title}`, `All ${actions.length} actions completed successfully.`);
    }
    return { success: failCount === 0, results };
}

/**
 * Execute a single action — all actions perform real Gmail operations.
 */
async function executeAction(action, task, session, gmail) {
    const triggerCfg = task.trigger_config?.config || task.trigger_config || {};
    const query = buildSearchQuery(triggerCfg, task.conditions, task.last_run_at);

    switch (action.type) {
        case 'label': {
            if (!gmail) throw new Error('Gmail not connected');
            const labelName = action.config?.label || action.config?.name || 'AutoTask';
            const labelId = await getOrCreateLabel(gmail, labelName);
            const ids = await searchEmailIds(gmail, query);
            const modified = await modifyMessages(gmail, ids, [labelId]);
            console.log(`[TaskExecutor] Labeled ${modified}/${ids.length} emails with "${labelName}"`);
            return { type: 'label', label: labelName, matched: ids.length, labeled: modified };
        }

        case 'archive': {
            if (!gmail) throw new Error('Gmail not connected');
            const ids = await searchEmailIds(gmail, query + ' in:inbox');
            const modified = await modifyMessages(gmail, ids, [], ['INBOX']);
            console.log(`[TaskExecutor] Archived ${modified}/${ids.length} emails`);
            return { type: 'archive', matched: ids.length, archived: modified };
        }

        case 'summarize': {
            const searchResult = await executeGmailTool('gmail_search', { query, maxResults: 10 }, session);
            const emails = searchResult?.results || [];
            if (emails.length === 0) {
                return { type: 'summarize', summary: 'No matching emails found.', emailCount: 0 };
            }
            const fullEmails = [];
            for (const email of emails.slice(0, 5)) {
                try {
                    const full = await executeGmailTool('gmail_read', { messageId: email.id }, session);
                    fullEmails.push({ from: full.from, subject: full.subject, body: (full.body || '').substring(0, 500) });
                } catch (e) { /* skip */ }
            }
            const summary = await aiProcess(
                `Summarize these ${fullEmails.length} emails concisely:\n\n${fullEmails.map(e => `From: ${e.from}\nSubject: ${e.subject}\n${e.body}\n---`).join('\n')}\n\nProvide a brief, organized summary.`
            );
            return { type: 'summarize', summary, emailCount: emails.length };
        }

        case 'create_draft': {
            if (!gmail) throw new Error('Gmail not connected');

            // If explicit to/subject/body → simple draft
            if (action.config?.to && action.config?.subject && action.config?.body) {
                const result = await executeGmailTool('gmail_compose', {
                    to: action.config.to,
                    subject: action.config.subject,
                    body: action.config.body,
                }, session);
                return { type: 'create_draft', draft: result, draftsCreated: 1 };
            }

            // Otherwise: search matching emails, read them, and compose contextual drafts
            const searchResult = await executeGmailTool('gmail_search', { query, maxResults: 5 }, session);
            const emails = searchResult?.results || [];
            if (emails.length === 0) {
                return { type: 'create_draft', message: 'No matching emails found to draft a reply for.', draftsCreated: 0 };
            }

            const drafts = [];
            for (const email of emails.slice(0, 3)) {
                try {
                    const full = await executeGmailTool('gmail_read', { messageId: email.id }, session);
                    const senderEmail = (full.from || '').match(/<([^>]+)>/)?.[1] || full.from || '';
                    const senderName = (full.from || '').replace(/<[^>]+>/, '').trim();

                    // Use AI to compose a reply based on the task config + email content
                    const draftBody = await aiProcess(
                        `You are composing an email reply draft.\n\n` +
                        `TASK: "${task.title}"\n` +
                        `DESCRIPTION: ${task.description}\n` +
                        `TEMPLATE/CONFIG: ${JSON.stringify(action.config || {})}\n\n` +
                        `ORIGINAL EMAIL:\nFrom: ${full.from}\nSubject: ${full.subject}\nBody: ${(full.body || '').substring(0, 1500)}\n\n` +
                        `Write ONLY the email body (no subject line, no greeting format instructions). ` +
                        `Match the language of the original email (Dutch if Dutch, English if English). ` +
                        `Keep it professional and concise. Fill in any template variables with real context from the email.`
                    );

                    const replySubject = (full.subject || '').startsWith('Re:') ? full.subject : `Re: ${full.subject || task.title}`;
                    const result = await executeGmailTool('gmail_compose', {
                        to: senderEmail,
                        subject: replySubject,
                        body: draftBody,
                    }, session);

                    drafts.push({ to: senderEmail, subject: replySubject, messageId: email.id });
                    console.log(`[TaskExecutor] Draft created for ${senderName} (${senderEmail})`);
                } catch (err) {
                    console.error(`[TaskExecutor] Draft for email ${email.id} failed:`, err.message);
                }
            }

            return { type: 'create_draft', draftsCreated: drafts.length, drafts };
        }

        case 'extract_data': {
            const searchResult = await executeGmailTool('gmail_search', { query, maxResults: 5 }, session);
            const emails = searchResult?.results || [];
            const emailTexts = [];
            for (const email of emails.slice(0, 3)) {
                try {
                    const full = await executeGmailTool('gmail_read', { messageId: email.id }, session);
                    emailTexts.push(`From: ${full.from}\nSubject: ${full.subject}\n${(full.body || '').substring(0, 500)}`);
                } catch (e) { /* skip */ }
            }
            const extracted = await aiProcess(
                `Extract the following data from these emails: ${JSON.stringify(action.config?.fields || action.config?.extract || 'key information')}\n\n${emailTexts.join('\n---\n')}\n\nReturn as structured text.`
            );
            return { type: 'extract_data', data: extracted, emailCount: emails.length };
        }

        case 'notify': {
            return { type: 'notify', message: action.description || action.config?.message || 'Task completed' };
        }

        case 'forward': {
            if (!gmail) throw new Error('Gmail not connected');
            const to = action.config?.to;
            if (!to) return { type: 'forward', error: 'No forwarding address configured' };
            const ids = await searchEmailIds(gmail, query, 5);
            let forwarded = 0;
            for (const id of ids.slice(0, 5)) {
                try {
                    const full = await executeGmailTool('gmail_read', { messageId: id }, session);
                    await executeGmailTool('gmail_compose', {
                        to,
                        subject: `Fwd: ${full.subject || '(no subject)'}`,
                        body: `---------- Forwarded message ----------\nFrom: ${full.from}\nSubject: ${full.subject}\n\n${(full.body || '').substring(0, 2000)}`,
                    }, session);
                    forwarded++;
                } catch (e) { /* skip */ }
            }
            return { type: 'forward', matched: ids.length, forwarded, to };
        }

        // ── Calendar actions ────────────────────────────
        case 'calendar_create_event': {
            const { executeCalendarTool } = require('./calendarTools');
            const result = await executeCalendarTool('calendar_create_event', {
                title: action.config?.title || task.title,
                startTime: action.config?.startTime,
                endTime: action.config?.endTime,
                description: action.config?.description || task.description,
                location: action.config?.location,
            }, session);
            return { type: 'calendar_create_event', event: result };
        }
        case 'calendar_update_event': {
            const { executeCalendarTool } = require('./calendarTools');
            const result = await executeCalendarTool('calendar_update_event', action.config || {}, session);
            return { type: 'calendar_update_event', event: result };
        }
        case 'calendar_block_time': {
            const { executeCalendarTool } = require('./calendarTools');
            const result = await executeCalendarTool('calendar_create_event', {
                title: action.config?.title || '🔒 Focus Time',
                startTime: action.config?.startTime,
                endTime: action.config?.endTime,
                description: 'Auto-created by task automation',
            }, session);
            return { type: 'calendar_block_time', event: result };
        }
        case 'calendar_remind': {
            return { type: 'calendar_remind', message: action.description || 'Reminder set' };
        }

        // ── Drive actions ───────────────────────────────
        case 'drive_move_files': {
            const { executeDriveTool } = require('./driveTools');
            const fileId = action.config?.fileId;
            const destId = action.config?.destinationFolderId;
            if (!fileId || !destId) return { type: 'drive_move_files', error: 'Missing fileId or destination' };
            const result = await executeDriveTool('drive_move_file', { fileId, destinationFolderId: destId }, session);
            return { type: 'drive_move_files', ...result };
        }
        case 'drive_create_folder': {
            const { executeDriveTool } = require('./driveTools');
            const result = await executeDriveTool('drive_create_folder', {
                name: action.config?.name || 'Auto-created',
                parentFolderId: action.config?.parentFolderId,
            }, session);
            return { type: 'drive_create_folder', ...result };
        }
        case 'drive_rename': {
            return { type: 'drive_rename', message: 'Rename not yet implemented (requires Drive API update)' };
        }

        // ── YouTrack actions ────────────────────────────
        case 'youtrack_create_issue':
        case 'create_youtrack_issue': {
            const { executeYouTrackTool } = require('./youtrackTools');
            const userId = session?.user?.id || session?.userId;
            const result = await executeYouTrackTool('youtrack_create_issue', {
                projectId: action.config?.projectId,
                summary: action.config?.summary || task.title,
                description: action.config?.description || task.description,
            }, userId);
            return { type: 'youtrack_create_issue', issue: result };
        }
        case 'youtrack_update_issue': {
            const { executeYouTrackTool } = require('./youtrackTools');
            const userId = session?.user?.id || session?.userId;
            const result = await executeYouTrackTool('youtrack_update_issue', action.config || {}, userId);
            return { type: 'youtrack_update_issue', result };
        }
        case 'youtrack_comment': {
            const { executeYouTrackTool } = require('./youtrackTools');
            const userId = session?.user?.id || session?.userId;
            const result = await executeYouTrackTool('youtrack_add_comment', {
                issueId: action.config?.issueId,
                text: action.config?.text || action.description,
            }, userId);
            return { type: 'youtrack_comment', result };
        }

        // ── Slides actions ──────────────────────────────
        case 'slides_create_presentation': {
            const { executeSlidesTool } = require('./slidesTools');
            const content = await aiProcess(
                `Create a slide outline for: "${task.title}"\nDescription: ${task.description}\nConfig: ${JSON.stringify(action.config || {})}\n\nReturn JSON with: title, slides: [{ title, body }], theme: { bg, accent, titleColor, bodyColor }`
            );
            let slideData;
            try { slideData = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '{}'); } catch (e) { }
            if (slideData?.slides) {
                const result = await executeSlidesTool('slides_create_presentation', slideData, session);
                return { type: 'slides_create_presentation', presentation: result };
            }
            return { type: 'slides_create_presentation', raw: content };
        }
        case 'slides_add_slide': {
            const { executeSlidesTool } = require('./slidesTools');
            const result = await executeSlidesTool('slides_add_slide', action.config || {}, session);
            return { type: 'slides_add_slide', slide: result };
        }

        // ── Fireflies actions ───────────────────────────
        case 'fireflies_summarize': {
            const { executeFirefliesTool } = require('./firefliesTools');
            const userId = session?.user?.id || session?.userId;
            const transcriptId = action.config?.transcriptId;
            if (!transcriptId) return { type: 'fireflies_summarize', error: 'No transcript ID' };
            const result = await executeFirefliesTool('fireflies_get_summary', { transcriptId }, userId);
            return { type: 'fireflies_summarize', summary: result };
        }
        case 'fireflies_extract_actions': {
            const { executeFirefliesTool } = require('./firefliesTools');
            const userId = session?.user?.id || session?.userId;
            const result = await executeFirefliesTool('fireflies_get_summary', { transcriptId: action.config?.transcriptId }, userId);
            const extracted = await aiProcess(
                `Extract action items from this meeting summary:\n${JSON.stringify(result).substring(0, 2000)}\n\nList each action item clearly.`
            );
            return { type: 'fireflies_extract_actions', actions: extracted };
        }

        default:
            return { type: action.type, message: `Action type '${action.type}' not yet implemented` };
    }
}

/**
 * Build a Gmail search query from trigger config + conditions.
 * 
 * Handles the actual AI-proposed structures:
 * - trigger_config.config.from can be an array of senders
 * - conditions use operators like "contains_any" with array values
 * - conditions can have "from", "subject", "date_received" fields
 */
function buildSearchQuery(triggerCfg, conditions = [], lastRunAt = null) {
    const parts = [];

    // Extract from trigger config (may have from as string or array)
    if (triggerCfg.from) {
        const froms = Array.isArray(triggerCfg.from) ? triggerCfg.from : [triggerCfg.from];
        if (froms.length > 0) {
            parts.push('(' + froms.map(f => `from:${f.trim()}`).join(' OR ') + ')');
        }
    }
    if (triggerCfg.subject_contains) {
        const subjects = Array.isArray(triggerCfg.subject_contains) ? triggerCfg.subject_contains : [triggerCfg.subject_contains];
        parts.push('(' + subjects.map(s => `subject:"${s.trim()}"`).join(' OR ') + ')');
    }
    if (triggerCfg.has_attachment) {
        parts.push('has:attachment');
    }

    // Process conditions — handle arrays, contains_any, etc.
    let hasDateFilter = false;
    for (const cond of conditions) {
        const values = Array.isArray(cond.value) ? cond.value : [cond.value];

        switch (cond.field) {
            case 'from':
            case 'email.sender':
            case 'sender':
                if (cond.operator === 'not_in' || cond.operator === 'not_contains') {
                    // Exclude senders: -from:noreply@ -from:no-reply@
                    parts.push(values.map(v => `-from:${v.trim()}`).join(' '));
                } else if (cond.operator === 'contains_any' || cond.operator === 'is_any' || cond.operator === 'in') {
                    parts.push('(' + values.map(v => `from:${v.trim()}`).join(' OR ') + ')');
                } else {
                    parts.push(`from:${values[0]}`);
                }
                break;

            case 'subject':
            case 'email.subject':
                if (cond.operator === 'contains_any' || cond.operator === 'contains') {
                    parts.push('(' + values.map(v => `subject:"${v.trim()}"`).join(' OR ') + ')');
                } else {
                    parts.push(`subject:"${values[0]}"`);
                }
                break;

            case 'body':
            case 'email.body':
                // Gmail body search: plain text terms (no operator prefix needed)
                if (cond.operator === 'contains_any') {
                    parts.push('(' + values.map(v => `"${v.trim()}"`).join(' OR ') + ')');
                } else if (cond.operator === 'contains') {
                    parts.push(values.map(v => `"${v.trim()}"`).join(' '));
                } else {
                    parts.push(`"${values[0]}"`);
                }
                break;

            case 'date_received':
                hasDateFilter = true;
                if (cond.operator === 'within_last') {
                    // "7 days" → "7d", "1 month" → "1m"
                    const val = String(values[0]).toLowerCase();
                    const match = val.match(/(\d+)\s*(day|week|month|hour)/);
                    if (match) {
                        const num = match[1];
                        const unit = match[2][0]; // d, w, m, h
                        parts.push(`newer_than:${num}${unit}`);
                    } else {
                        parts.push('newer_than:7d');
                    }
                }
                break;

            case 'label':
                parts.push(`label:${values[0]}`);
                break;

            case 'newer_than':
                hasDateFilter = true;
                parts.push(`newer_than:${values[0]}`);
                break;
        }
    }

    // Use last_run_at if available (only process new items since last execution)
    if (!hasDateFilter && lastRunAt) {
        const epoch = Math.floor(new Date(lastRunAt).getTime() / 1000);
        parts.push(`after:${epoch}`);
        hasDateFilter = true;
    }

    // Default: last 7 days if no date filter and no last run
    if (!hasDateFilter) {
        parts.push('newer_than:7d');
    }

    const query = parts.join(' ');
    console.log(`[TaskExecutor] Built query: ${query}`);
    return query;
}

/**
 * Use AI to process text (summarize, extract, compose).
 */
async function aiProcess(prompt) {
    let tiers = configStore.getConfig('chat_model_tiers') || {};
    const tier = tiers.fast || tiers.balanced || tiers.smart || {};
    let modelId = tier.modelId;
    if (!modelId) {
        const aiConfig = await getAIConfig();
        modelId = aiConfig.model || 'mistral-small-latest';
    }

    const providerConfig = await getProviderForModel(modelId);
    const apiUrl = (providerConfig.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(providerConfig.providerType, apiUrl);

    const result = await adapter.chat(providerConfig.apiKey, apiUrl, modelId, [
        { role: 'user', content: prompt },
    ], { maxTokens: 2048, temperature: 0.3 });

    return result.content || '';
}

/**
 * Compute the next run time for recurring tasks.
 */
function computeNextRun(task) {
    const trigger = task.trigger_config || {};
    const triggerType = trigger.type || task.type;

    if (triggerType === 'schedule' || triggerType === 'scheduled') {
        // Simple: add interval based on cron description
        const cfg = trigger.config || trigger;
        const human = (cfg.human_readable || '').toLowerCase();

        let intervalMs = 7 * 24 * 60 * 60 * 1000; // default: weekly
        if (human.includes('daily') || human.includes('every day')) intervalMs = 24 * 60 * 60 * 1000;
        if (human.includes('hourly') || human.includes('every hour')) intervalMs = 60 * 60 * 1000;
        if (human.includes('monthly')) intervalMs = 30 * 24 * 60 * 60 * 1000;

        return new Date(Date.now() + intervalMs).toISOString();
    }

    // For email triggers, check frequently
    if (triggerType === 'email_received' || triggerType === 'email_triggered') {
        return new Date(Date.now() + 5 * 60 * 1000).toISOString(); // Every 5 min
    }

    return null;
}

module.exports = { executeTask };
