/**
 * Gmail Task Scanner — AI-powered email analysis to identify automatable tasks
 *
 * Gives the AI gmail_search and gmail_read tools to explore the inbox freely,
 * just like in direct chat. Tool results are truncated to keep context lean
 * and avoid rate limits. Includes retry logic for rate limit errors.
 *
 * All proposed tasks require explicit user approval before execution.
 */

const crypto = require('crypto');
const { GMAIL_TOOLS, executeGmailTool } = require('./gmailTools');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const configStore = require('../stores/configStore');
const { parseProposals } = require('./proposalParser');

// ── System prompt — gives AI freedom to explore ────────

const SCAN_SYSTEM_PROMPT = `You are an email automation analyst. You have Gmail tools to search and read the user's emails.

EXPLORATION STRATEGY:
1. Start with a broad search of recent emails
2. Search 3-4 DIFFERENT categories to find diverse patterns:
   - Invoices / receipts / billing
   - Newsletters / digests
   - Recurring notifications from services
   - Emails with attachments
3. Only use gmail_read on 1-2 emails max — the search snippets usually have enough info
4. Be efficient — you have limited rounds. Prefer broad searches over deep reading.

After exploring, respond with ONLY a JSON array of automation proposals.
Each proposal must include a JavaScript automation script.

AVAILABLE ctx API:
- ctx.gmail.search(query, maxResults?) → [{id, from, subject, date, snippet}]
- ctx.gmail.read(messageId) → {from, subject, body, date, attachments: [{filename, mimeType, size, attachmentId}]}
- ctx.gmail.getAttachment(messageId, attachmentId) → {data (base64), size}
- ctx.gmail.compose(to, subject, body) → creates draft
- ctx.gmail.label(messageId, labelName) → adds label
- ctx.gmail.archive(messageId) → removes from inbox
- ctx.gmail.forward(messageId, to) → forwards email
- ctx.drive.search(query, maxResults?) → [{id, name, mimeType}]
- ctx.drive.createFolder(name, parentFolderId?) → {id, name, link}
- ctx.drive.uploadFile({name, data (base64), mimeType, folderId}) → {fileId, name, link}
- ctx.drive.getFile(fileId) → file metadata
- ctx.calendar.listEvents(daysAhead?, maxResults?) → events
- ctx.calendar.createEvent({title, startTime, endTime, description})
- ctx.sheets.create({title, sheetNames?, folderId?}) → {spreadsheetId, url, title}
- ctx.sheets.getValues(spreadsheetId, range) → [[cell values]]
- ctx.sheets.appendRows(spreadsheetId, range, [[row1], [row2], ...]) → {updatedRows}
- ctx.sheets.updateValues(spreadsheetId, range, [[values]]) → {updatedRows}
- ctx.docs.create({title, body?, folderId?}) → {documentId, url, title}
- ctx.docs.read(documentId) → string (document text content)
- ctx.docs.append(documentId, text) → appends text to document
- ctx.docs.replaceText(documentId, findText, replaceText, matchCase?) → {replacements}
- ctx.ai.process(prompt) → string (for fuzzy matching or text transformation on plain text, uses fast model)
- ctx.ai.ocr(base64Data, prompt, mimeType?) → string (OCR/extract data from PDF or image using Mistral vision model)
- ctx.notify(title, message, category?) → sends in-app notification to user. Categories: "info" (default), "heads_up", "urgent"
- ctx.approved → boolean (false=preview, true=execute)
- ctx.task.lastRunAt → ISO string or null
- ctx.ledger.filterNew(items, idField?) → filters out already-processed items (checks by item ID hash)
- ctx.ledger.hasProcessed(itemId) → boolean, check if a specific item was already handled
- ctx.ledger.markProcessed(itemId, action) → manually record an item as done (auto-called by archive/label/forward/moveFile)

IMPORTANT — When to use ai.ocr vs ai.process:
- To extract data from PDF/image ATTACHMENTS: use ctx.gmail.getAttachment(messageId, attachmentId) to get base64 data, then ctx.ai.ocr(attachment.data, "Extract: invoice number, date, amount, vendor. Return JSON.")
- To process plain TEXT (email body, fuzzy matching): use ctx.ai.process(prompt)
- NEVER use ai.process to extract invoice data from email body text — invoices are in PDF attachments, use ai.ocr on them instead.

DEDUPLICATION — CRITICAL:
- ALWAYS use ctx.ledger.filterNew(items) after fetching items to skip already-processed ones
- archive/label/forward/moveFile auto-record to the ledger on success
- For extra safety: add "in:inbox" to archive queries, "-label:X" to label queries
- Tasks run repeatedly. Your script MUST be idempotent.

SCRIPT TEMPLATE:
async function run(ctx) {
  // 1. Search for items
  const allEmails = await ctx.gmail.search('in:inbox from:sender subject:"keyword"', 10);
  // 2. Filter out already-processed items via ledger
  const emails = await ctx.ledger.filterNew(allEmails);
  if (emails.length === 0) return { changes: [] };
  // 3. Build preview
  const changes = emails.map(e => ({ type: 'archive', target: e.from + ': ' + e.subject, detail: 'Archive email' }));
  if (!ctx.approved) return { changes };
  // 4. Execute (archive auto-records to ledger)
  for (const email of emails) { await ctx.gmail.archive(email.id); }
  return { changes, executed: true };
}

JSON FORMAT:
[{
  "title": "Short name",
  "description": "What it does",
  "trigger": { "type": "schedule|email_received|email_pattern|manual", "config": { ... } },
  "conditions": [{ "field": "...", "operator": "...", "value": "...", "description": "..." }],
  "script": "async function run(ctx) { ... }",
  "priority": "low|medium|high",
  "reasoning": "Why, referencing specific emails/senders found"
}]

RULES:
- Each automation MUST be unique
- ALWAYS use ctx.ledger.filterNew() after fetching items to skip already-processed ones
- Scripts MUST be idempotent — running twice must not re-process the same items
- Scripts MUST use the two-phase pattern (preview when !ctx.approved, execute when ctx.approved)
- Only use ctx.ai.process() for fuzzy matching — NOT for simple logic
- Reference actual senders/subjects you found
- Propose a VARIETY of types
- Final message = ONLY the JSON array`;

// ── Truncate tool results to save tokens ────────────────

function truncateToolResult(result) {
    const str = JSON.stringify(result);
    // If search results, keep only the first 5 results and trim snippets
    if (result.results && Array.isArray(result.results)) {
        const trimmed = result.results.slice(0, 5).map(r => ({
            id: r.id,
            from: r.from?.substring(0, 50),
            subject: r.subject?.substring(0, 80),
            date: r.date,
            snippet: r.snippet?.substring(0, 80),
        }));
        return JSON.stringify({ results: trimmed, total: result.total, query: result.query });
    }
    // If email read, truncate body
    if (result.body) {
        return JSON.stringify({
            from: result.from, subject: result.subject, date: result.date,
            body: result.body.substring(0, 400),
            attachments: result.attachments?.slice(0, 3),
        });
    }
    // Generic: truncate
    return str.length > 1200 ? str.substring(0, 1200) + '...' : str;
}

// ── Retry helper for rate limits ────────────────────────

async function callWithRetry(fn, maxRetries = 1) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isRateLimit = err.message?.includes('429') || err.message?.includes('rate_limit');
            if (isRateLimit && attempt < maxRetries) {
                const waitSec = (attempt + 1) * 20; // 20s, 40s
                console.log(`[GmailScanner] Rate limited, waiting ${waitSec}s...`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
                continue;
            }
            throw err;
        }
    }
}

// ── Scanner with tool-calling loop ──────────────────────

async function scanGmail(session, options = {}, onProgress = () => { }) {
    if (typeof options === 'function') { onProgress = options; options = {}; }
    const scanId = crypto.randomUUID();
    onProgress('scan_started', { scanId });

    if (!session?.accessToken) {
        throw new Error('Gmail not connected — user must log in with Google');
    }

    // Resolve AI model (use provided modelId or fall back to tier config)
    let modelId = options.modelId;
    if (!modelId) {
        let tiers = configStore.getConfig('chat_model_tiers') || {};
        const smartTier = tiers.smart || tiers.balanced || tiers.fast || {};
        modelId = smartTier.modelId;
        if (!modelId) {
            const aiConfig = await getAIConfig();
            modelId = aiConfig.model || 'mistral-small-latest';
        }
    }

    const providerConfig = await getProviderForModel(modelId);
    const apiUrl = (providerConfig.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(providerConfig.providerType, apiUrl);

    console.log(`[GmailScanner] Using model: ${modelId} with tool-calling loop`);
    onProgress('status', { message: 'AI is exploring your inbox...' });

    // Only search + read tools
    const scanTools = GMAIL_TOOLS.filter(t =>
        ['gmail_search', 'gmail_read'].includes(t.function.name)
    );

    const systemPrompt = options.existingContext
        ? SCAN_SYSTEM_PROMPT + '\n\n' + options.existingContext
        : SCAN_SYSTEM_PROMPT;

    let userMsg = 'Explore my Gmail inbox and identify email automation opportunities. Search different categories (invoices, newsletters, notifications, recurring emails). Be efficient with your searches.';
    if (options.focus) userMsg += `\n\nUSER FOCUS: The user specifically wants you to focus on: "${options.focus}". Prioritize this area in your exploration.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
    ];

    // ── Tool-calling loop ──
    const MAX_ROUNDS = 2;
    let round = 0;
    let toolCallCount = 0;

    while (round < MAX_ROUNDS) {
        let result;
        try {
            result = await adapter.chat(providerConfig.apiKey, apiUrl, modelId, messages, {
                maxTokens: 3072,
                temperature: 0.3,
                tools: scanTools,
                toolChoice: 'auto',
            });
        } catch (err) {
            // On rate limit, break and use what we have so far
            const isRateLimit = err.message?.includes('429') || err.message?.includes('rate_limit');
            if (isRateLimit) {
                console.log(`[GmailScanner] Rate limited at round ${round}, using findings so far`);
                onProgress('status', { message: 'Rate limit hit — generating proposals from collected data...' });
                break;
            }
            throw new Error(`AI analysis failed: ${err.message}`);
        }

        if (result.toolCalls && result.toolCalls.length > 0) {
            messages.push({
                role: 'assistant',
                content: result.content || null,
                tool_calls: result.toolCalls,
            });
            round++;

            const toolResults = await Promise.all(
                result.toolCalls.map(async (toolCall) => {
                    const toolName = toolCall.function?.name || toolCall.name;
                    let toolArgs = {};
                    try { toolArgs = JSON.parse(toolCall.function?.arguments || '{}'); } catch (e) { }

                    console.log(`[GmailScanner] Tool: ${toolName}`, toolArgs);
                    toolCallCount++;

                    if (toolName === 'gmail_search') {
                        onProgress('status', { message: `Searching: "${toolArgs.query || '...'}"` });
                    } else if (toolName === 'gmail_read') {
                        onProgress('status', { message: 'Reading email details...' });
                    }

                    let toolResult;
                    try {
                        toolResult = await executeGmailTool(toolName, toolArgs, session);
                    } catch (err) {
                        console.error(`[GmailScanner] Tool ${toolName} failed:`, err.message);
                        toolResult = { error: err.message };
                    }

                    // Truncate result to keep context lean
                    return {
                        role: 'tool',
                        tool_call_id: toolCall.id,
                        content: truncateToolResult(toolResult),
                    };
                })
            );

            messages.push(...toolResults);
            onProgress('analyzing', { message: `AI explored ${toolCallCount} queries...`, round, maxRounds: MAX_ROUNDS });
            continue;
        }

        // No tool calls — AI returned its final answer inline
        // Try to parse from the last assistant message
        const inlineContent = result.content || '';
        const inlineMatch = inlineContent.match(/\[[\s\S]*\]/);
        if (inlineMatch) {
            try {
                const inlineProposals = JSON.parse(inlineMatch[0]);
                return finalizeProposals(inlineProposals, scanId, toolCallCount, onProgress);
            } catch (e) { /* fall through to explicit final call */ }
        }
        break;
    }

    // ── Final call: ask for proposals explicitly ──
    onProgress('status', { message: 'AI is formulating automation proposals...' });

    // Build a compact summary of what was found instead of replaying the whole context
    const summaryMessages = [
        { role: 'system', content: SCAN_SYSTEM_PROMPT },
        { role: 'user', content: buildSummaryPrompt(messages) },
    ];

    const finalResult = await callWithRetry(async () => {
        return adapter.chat(providerConfig.apiKey, apiUrl, modelId, summaryMessages, {
            maxTokens: 3072,
            temperature: 0.3,
        });
    });

    let proposals = [];
    try {
        const content = finalResult.content || '';
        proposals = parseProposals(content);
        if (proposals.length === 0) {
            console.warn('[GmailScanner] No proposals parsed from response');
        }
    } catch (err) {
        console.error('[GmailScanner] Parse error:', err.message);
    }

    return finalizeProposals(proposals, scanId, toolCallCount, onProgress);
}

// ── Build a compact summary from the conversation ──────

function buildSummaryPrompt(messages) {
    const findings = [];
    for (const msg of messages) {
        if (msg.role === 'tool' && msg.content) {
            try {
                const data = JSON.parse(msg.content);
                if (data.results) {
                    findings.push(`Search "${data.query}": ${data.results.length} results — ` +
                        data.results.map(r => `${r.from}: "${r.subject}"`).join('; '));
                } else if (data.from) {
                    findings.push(`Email from ${data.from}: "${data.subject}" — ${(data.body || '').substring(0, 200)}`);
                }
            } catch (e) { /* skip */ }
        }
    }
    return `Based on my exploration of the user's Gmail, here is what I found:\n\n${findings.join('\n\n')}\n\nNow propose automation tasks as a JSON array.`;
}

// ── Deduplicate + normalize proposals ───────────────────

function finalizeProposals(proposals, scanId, toolCallCount, onProgress) {
    if (!Array.isArray(proposals)) proposals = [];

    const seen = new Set();
    proposals = proposals.filter(p => {
        const key = (p.title || '').toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const normalized = proposals.map(p => ({
        id: crypto.randomUUID(),
        title: p.title || 'Untitled automation',
        description: p.description || '',
        trigger: {
            type: p.trigger?.type || 'manual',
            config: p.trigger?.config || {},
        },
        conditions: Array.isArray(p.conditions) ? p.conditions : [],
        actions: Array.isArray(p.actions) ? p.actions : [],
        script: p.script || null,
        requires_ai: !!p.requires_ai,
        priority: ['low', 'medium', 'high'].includes(p.priority) ? p.priority : 'medium',
        reasoning: p.reasoning || '',
        scanId,
    }));

    for (const proposal of normalized) {
        onProgress('task_proposed', { proposal });
    }

    onProgress('scan_complete', { scanId, toolCallsUsed: toolCallCount, proposalCount: normalized.length });
    console.log(`[GmailScanner] Done: ${toolCallCount} tool calls, ${normalized.length} proposals`);

    return { scanId, proposals: normalized };
}

module.exports = { scanGmail };
