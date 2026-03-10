/**
 * Cross-App Task Scanner — Phased AI exploration across multiple apps.
 *
 * Phase 1: DISCOVERY — Broad exploration of all connected apps
 * Phase 2: ANALYSIS  — Deep-dive into cross-app connections
 * Phase 3: PROPOSALS — Generate structured automation proposals
 *
 * Each phase emits SSE events so the frontend can show progress.
 */

const crypto = require('crypto');
const { GMAIL_TOOLS, executeGmailTool } = require('./gmailTools');
const { CALENDAR_TOOLS, executeCalendarTool } = require('./calendarTools');
const { DRIVE_TOOLS, executeDriveTool } = require('./driveTools');
const { SLIDES_TOOLS, executeSlidesTool } = require('./slidesTools');
const { FIREFLIES_TOOLS, executeFirefliesTool } = require('./firefliesTools');
const { YOUTRACK_TOOLS, executeYouTrackTool } = require('./youtrackTools');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const configStore = require('../stores/configStore');
const { parseProposals } = require('./proposalParser');

// ── Phase prompts ───────────────────────────────────────

const PHASE_1_PROMPT = `You are an automation analyst. Phase 1: DISCOVERY.

AVAILABLE APPS & TOOLS:
{{TOOL_SUMMARY}}

IMPORTANT: You can ONLY use the apps and tools listed above. Do NOT reference or suggest any apps that are not listed.

YOUR TASK: Do a BROAD survey of the user's data across the available apps.
Use each available tool to explore the user's data — search for patterns, list items, and get an overview.

EFFICIENCY RULES:
- Call 4+ tools per round simultaneously — batch aggressively
- Do NOT use gmail_read in this phase — search snippets are enough
- Do NOT use drive_get_file — file listings are enough
- You only have 2 rounds, make them count

When you have a good overview, respond with a SHORT text summary (max 300 words):

DISCOVERY SUMMARY:
(list only the apps you actually have access to)
- [App]: [what you found]`;

const PHASE_2_PROMPT = `You are an automation analyst. Phase 2: ANALYSIS.

AVAILABLE APPS & TOOLS:
{{TOOL_SUMMARY}}

IMPORTANT: You can ONLY use the apps and tools listed above. Do NOT reference or suggest any apps that are not listed.

PREVIOUS DISCOVERY:
{{DISCOVERY_SUMMARY}}

YOUR TASK: Dig deeper into the TOP 3-4 most promising automation opportunities using ONLY the available apps.
- Read max 3 specific emails (use gmail_read only for high-value candidates)
- Check detailed event info only for recurring/important ones
- Look for patterns that can be automated

EFFICIENCY RULES:
- Call 4+ tools per round simultaneously
- You only have 2 rounds — be targeted, not exhaustive
- Focus on actionable patterns

Respond with a SHORT analysis (max 200 words):

PATTERNS FOUND:
1. [pattern description with real data]
2. [another pattern]
...`;

// Phase 3 prompt is built dynamically — see buildPhase3Prompt()

const CTX_API_BY_APP = {
    gmail: [
        '- ctx.gmail.search(query, maxResults?) → [{id, from, subject, date, snippet}]',
        '- ctx.gmail.read(messageId) → {from, subject, body, date, attachments: [{filename, mimeType, size, attachmentId}]}',
        '- ctx.gmail.getAttachment(messageId, attachmentId) → {data (base64), size}',
        '- ctx.gmail.compose(to, subject, body) → creates draft',
        '- ctx.gmail.label(messageId, labelName) → adds label',
        '- ctx.gmail.archive(messageId) → removes from inbox',
        '- ctx.gmail.forward(messageId, to) → forwards email',
    ],
    calendar: [
        '- ctx.calendar.listEvents(daysAhead?, maxResults?) → events',
        '- ctx.calendar.searchEvents(query, daysAhead?) → events',
        '- ctx.calendar.createEvent({title, startTime, endTime, description, location})',
    ],
    drive: [
        '- ctx.drive.search(query, maxResults?) → [{id, name, mimeType, ...}]',
        '- ctx.drive.listFiles(folderId) → [{id, name, mimeType, ...}]',
        '- ctx.drive.getFile(fileId) → file metadata',
        '- ctx.drive.createFolder(name, parentFolderId?) → {id, name, link}',
        '- ctx.drive.moveFile(fileId, destinationFolderId)',
        '- ctx.drive.uploadFile({name, data (base64), mimeType, folderId}) → {fileId, name, link}',
    ],
    youtrack: [
        '- ctx.youtrack.createIssue({projectId, summary, description})',
    ],
    fireflies: [
        '- ctx.fireflies.listTranscripts(limit?) → transcripts',
        '- ctx.fireflies.getSummary(transcriptId) → summary',
    ],
    gamma: [
        '- ctx.gamma.create({inputText, textMode?, language?, audience?, imageSource?, imageStyle?, exportAs?}) → {gammaId, gammaUrl, exportUrl, status}',
    ],
    sheets: [
        '- ctx.sheets.create({title, sheetNames?, folderId?}) → {spreadsheetId, url, title}',
        '- ctx.sheets.getValues(spreadsheetId, range) → [[cell values]]',
        '- ctx.sheets.appendRows(spreadsheetId, range, [[row1], [row2], ...]) → {updatedRows}',
        '- ctx.sheets.updateValues(spreadsheetId, range, [[values]]) → {updatedRows}',
    ],
    docs: [
        '- ctx.docs.create({title, body?, folderId?}) → {documentId, url, title}',
        '- ctx.docs.read(documentId) → string (document text content)',
        '- ctx.docs.append(documentId, text) → appends text to document',
        '- ctx.docs.replaceText(documentId, findText, replaceText, matchCase?) → {replacements}',
    ],
};

async function buildPhase3Prompt(enabledApps) {
    // Build ctx API section from only the enabled apps
    const apiLines = [];
    const allApps = enabledApps && enabledApps.length > 0 ? enabledApps : Object.keys(CTX_API_BY_APP);
    for (const app of allApps) {
        if (CTX_API_BY_APP[app]) apiLines.push(...CTX_API_BY_APP[app]);
    }
    // Always include utility APIs
    apiLines.push(
        '- ctx.ai.process(prompt) → string (for fuzzy matching or text transformation on plain text, uses fast model)',
        '- ctx.ai.ocr(base64Data, prompt, mimeType?) → string (OCR/extract data from PDF or image using Mistral vision model)',
        '- ctx.notify(title, message, category?) → sends in-app notification to user. Categories: "info" (default), "heads_up", "urgent"',
        '- ctx.approved → boolean (false in preview, true when user approved)',
        '- ctx.task.lastRunAt → ISO string or null',
        '- ctx.ledger.filterNew(items, idField?) → filters out already-processed items (checks by item ID hash)',
        '- ctx.ledger.hasProcessed(itemId) → boolean, check if a specific item was already handled',
        '- ctx.ledger.markProcessed(itemId, action) → manually record an item as done (auto-called by archive/label/forward/moveFile)',
    );

    const isMultiApp = allApps.length > 1;
    const appConnectionRule = isMultiApp
        ? '- Proposals SHOULD connect multiple apps when it makes sense, but single-app automations are also fine'
        : '- Proposals should focus on automations within the available app';

    return `You are an automation analyst. Phase 3: PROPOSALS.

DISCOVERY FINDINGS:
{{DISCOVERY_SUMMARY}}

PATTERNS & CONNECTIONS:
{{ANALYSIS_SUMMARY}}

Generate automation proposals. Each proposal must include a JavaScript automation script.
IMPORTANT: You can ONLY use the apps listed below. Do NOT reference or suggest any apps that are not listed.

AVAILABLE ctx API (passed to your script):
${apiLines.join('\n')}

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
  const allEmails = await ctx.gmail.search('in:inbox from:someone@example.com', 10);
  // 2. Filter out already-processed items via ledger
  const emails = await ctx.ledger.filterNew(allEmails);
  if (emails.length === 0) return { changes: [] };

  // 3. Build changes preview
  const changes = emails.map(e => ({
    type: 'archive', target: e.from + ': ' + e.subject, detail: 'Archive email'
  }));

  // 4. If not approved, return preview only (no mutations!)
  if (!ctx.approved) return { changes };

  // 5. Execute approved changes (archive auto-records to ledger)
  for (const email of emails) {
    await ctx.gmail.archive(email.id);
  }
  return { changes, executed: true };
}

Respond with ONLY a JSON array:
[{
  "title": "Short descriptive name",
  "description": "What it does (max 2 sentences)",
  "trigger": { "type": "schedule|email_received|event_upcoming|event_ended|meeting_ended|manual", "config": {} },
  "conditions": [{ "field": "...", "operator": "...", "value": "...", "description": "..." }],
  "script": "async function run(ctx) { ... }",
  "priority": "low|medium|high",
  "reasoning": "Why — reference specific data found"
}]

RULES:
${appConnectionRule}
- ALWAYS use ctx.ledger.filterNew() after fetching items to skip already-processed ones
- Scripts MUST be idempotent — running twice must not re-process the same items
- The script MUST use the two-phase pattern (preview when !ctx.approved, execute when ctx.approved)
- Only use ctx.ai.process() when you need fuzzy matching or text transformation — NOT for simple logic
- Reference REAL sender names, event titles, file names from the discovery
- Maximum 6 proposals — quality over quantity
- Do NOT use any ctx.* APIs that are not listed above
- Respond with ONLY the JSON array — no markdown fences, no explanation`;
}


// ── Tool routing ────────────────────────────────────────

const TOOL_PREFIXES = {
    gmail_: { executor: (name, args, ctx) => executeGmailTool(name, args, ctx.session), label: 'Gmail' },
    calendar_: { executor: (name, args, ctx) => executeCalendarTool(name, args, ctx.session), label: 'Calendar' },
    drive_: { executor: (name, args, ctx) => executeDriveTool(name, args, ctx.session), label: 'Drive' },
    slides_: { executor: (name, args, ctx) => executeSlidesTool(name, args, ctx.session), label: 'Slides' },
    fireflies_: { executor: (name, args, ctx) => executeFirefliesTool(name, args, ctx.userId), label: 'Fireflies' },
    youtrack_: { executor: (name, args, ctx) => executeYouTrackTool(name, args, ctx.userId), label: 'YouTrack' },
};

function getToolApp(toolName) {
    for (const [prefix, config] of Object.entries(TOOL_PREFIXES)) {
        if (toolName.startsWith(prefix)) return config.label;
    }
    return 'Unknown';
}

async function routeToolCall(toolName, args, ctx) {
    for (const [prefix, config] of Object.entries(TOOL_PREFIXES)) {
        if (toolName.startsWith(prefix)) return config.executor(toolName, args, ctx);
    }
    return { error: `Unknown tool: ${toolName}` };
}

// ── Build tool set ──────────────────────────────────────

function buildToolSet(session, userId, enabledApps = null) {
    const tools = [];
    const appSummary = [];
    const isOn = (key) => !enabledApps || enabledApps.includes(key);

    if (session?.accessToken) {
        if (isOn('gmail')) {
            const gmailScanTools = GMAIL_TOOLS.filter(t =>
                ['gmail_search', 'gmail_read'].includes(t.function.name)
            );
            tools.push(...gmailScanTools);
            appSummary.push('📧 Gmail: gmail_search, gmail_read');
        }

        if (isOn('calendar')) {
            const calendarScanTools = CALENDAR_TOOLS.filter(t =>
                ['calendar_list_events', 'calendar_search_events'].includes(t.function.name)
            );
            tools.push(...calendarScanTools);
            appSummary.push('📅 Calendar: calendar_list_events, calendar_search_events');
        }

        if (isOn('drive')) {
            const driveScanTools = DRIVE_TOOLS.filter(t =>
                ['drive_search', 'drive_list_files', 'drive_get_file'].includes(t.function.name)
            );
            tools.push(...driveScanTools);
            appSummary.push('📁 Drive: drive_search, drive_list_files, drive_get_file');
        }

        if (isOn('slides')) {
            const slidesScanTools = SLIDES_TOOLS.filter(t =>
                ['slides_list_presentations', 'slides_get_presentation'].includes(t.function.name)
            );
            if (slidesScanTools.length > 0) {
                tools.push(...slidesScanTools);
                appSummary.push('📊 Slides: slides_list_presentations, slides_get_presentation');
            }
        }

        if (isOn('sheets')) {
            appSummary.push('📗 Sheets: (available via ctx.sheets in scripts)');
        }

        if (isOn('docs')) {
            appSummary.push('📝 Docs: (available via ctx.docs in scripts)');
        }
    }

    const ffKey = userId ? configStore.getUserConfig?.(userId, 'fireflies_api_key') : null;
    if (ffKey && isOn('fireflies')) {
        const ffScanTools = FIREFLIES_TOOLS.filter(t =>
            ['fireflies_list_transcripts', 'fireflies_get_transcript'].includes(t.function.name)
        );
        tools.push(...ffScanTools);
        appSummary.push('🎙️ Fireflies: fireflies_list_transcripts, fireflies_get_transcript');
    }

    const ytUrl = userId ? configStore.getUserConfig?.(userId, 'youtrack_url') : null;
    const ytToken = userId ? configStore.getUserConfig?.(userId, 'youtrack_token') : null;
    if (ytUrl && ytToken && isOn('youtrack')) {
        const ytScanTools = YOUTRACK_TOOLS.filter(t =>
            ['youtrack_list_issues', 'youtrack_get_issue', 'youtrack_list_projects'].includes(t.function.name)
        );
        tools.push(...ytScanTools);
        appSummary.push('🎯 YouTrack: youtrack_list_issues, youtrack_get_issue, youtrack_list_projects');
    }

    return { tools, appSummary };
}

// ── Truncate helpers ────────────────────────────────────

function truncateToolResult(result) {
    const str = JSON.stringify(result);
    if (result.events && Array.isArray(result.events)) {
        const trimmed = result.events.slice(0, 5).map(e => ({
            title: e.title, start: e.start, end: e.end, isRecurring: e.isRecurring,
        }));
        return JSON.stringify({ events: trimmed, total: result.total });
    }
    if (result.results && Array.isArray(result.results)) {
        // Gmail search results
        const trimmed = result.results.slice(0, 5).map(e => ({
            id: e.id, from: e.from?.substring(0, 50), subject: e.subject?.substring(0, 80), date: e.date, snippet: e.snippet?.substring(0, 80),
        }));
        return JSON.stringify({ results: trimmed, total: result.total });
    }
    if (result.emails && Array.isArray(result.emails)) {
        const trimmed = result.emails.slice(0, 5).map(e => ({
            id: e.id, from: e.from?.substring(0, 50), subject: e.subject?.substring(0, 80), date: e.date, snippet: e.snippet?.substring(0, 80),
        }));
        return JSON.stringify({ emails: trimmed, total: result.total || result.emails.length });
    }
    if (result.files && Array.isArray(result.files)) {
        const trimmed = result.files.slice(0, 5).map(f => ({
            name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime,
        }));
        return JSON.stringify({ files: trimmed, total: result.total || result.files.length });
    }
    // Email read — truncate body aggressively
    if (result.body) {
        return JSON.stringify({ from: result.from, subject: result.subject, date: result.date, body: result.body.substring(0, 400) });
    }
    return str.length > 1200 ? str.substring(0, 1200) + '...' : str;
}

// ── Tool-calling loop for a single phase ────────────────

async function runPhase(adapter, providerConfig, modelId, messages, tools, ctx, maxRounds, onProgress, phaseLabel) {
    let round = 0, toolCallCount = 0;
    const appsUsed = new Set();

    while (round < maxRounds) {
        let result;
        try {
            result = await adapter.chat(providerConfig.apiKey, (providerConfig.url || '').replace(/\/+$/, ''), modelId, messages, {
                maxTokens: 4096, temperature: 0.3, tools, toolChoice: 'auto',
            });
        } catch (err) {
            if (err.message?.includes('429') || err.status === 429) {
                onProgress('status', { message: 'Rate limit — pausing briefly...' });
                await new Promise(r => setTimeout(r, 15000));
                continue;
            }
            if (err.message?.includes('529') || err.status === 529 || err.message?.includes('overloaded')) {
                onProgress('status', { message: 'API overloaded — retrying in 10s...' });
                await new Promise(r => setTimeout(r, 10000));
                continue;
            }
            throw err;
        }

        if (result.toolCalls?.length > 0) {
            // Context compression: before adding new round, compress old tool results
            if (round > 0) {
                compressOldToolResults(messages);
            }

            messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
            round++;

            const toolResults = await Promise.all(result.toolCalls.map(async (tc) => {
                const toolName = tc.function?.name || tc.name;
                let toolArgs = {};
                try { toolArgs = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { }

                const app = getToolApp(toolName);
                appsUsed.add(app);
                console.log(`[CrossAppScanner] [${phaseLabel}] Tool: ${toolName}`, toolArgs);
                toolCallCount++;

                onProgress('tool_call', { phase: phaseLabel, tool: toolName, app, queryCount: toolCallCount });

                let toolResult;
                try { toolResult = await routeToolCall(toolName, toolArgs, ctx); }
                catch (err) { toolResult = { error: err.message }; }

                return { role: 'tool', tool_call_id: tc.id, content: truncateToolResult(toolResult) };
            }));

            messages.push(...toolResults);
            continue;
        }

        // AI responded with text — phase complete
        return { content: result.content || '', toolCallCount, appsUsed: [...appsUsed] };
    }

    // Max rounds reached — return what we have
    return { content: '', toolCallCount, appsUsed: [...appsUsed] };
}

// ── Context compression — keep messages lean across rounds ──
function compressOldToolResults(messages) {
    // Find tool result messages from earlier rounds and truncate them heavily
    for (let i = 0; i < messages.length - 2; i++) {
        if (messages[i].role === 'tool' && typeof messages[i].content === 'string') {
            const content = messages[i].content;
            if (content.length > 200) {
                // Keep just enough to maintain coherence
                messages[i].content = content.substring(0, 150) + '...(truncated)';
            }
        }
    }
}

// ── Main scan function — 3 phases ───────────────────────

async function scanCrossApp(session, options = {}, onProgress = () => { }) {
    if (typeof options === 'function') { onProgress = options; options = {}; }
    const scanId = crypto.randomUUID();
    const userId = session?.user?.id;
    onProgress('scan_started', { scanId });

    const enabledApps = options.enabledApps || null;
    const { tools, appSummary } = buildToolSet(session, userId, enabledApps);
    if (tools.length === 0) {
        throw new Error('No tools available — select at least one app.');
    }

    const modelId = options.modelId || 'claude-opus-4-6';
    const providerConfig = await getProviderForModel(modelId);
    const apiUrl = (providerConfig.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(providerConfig.providerType, apiUrl);
    const ctx = { session, userId };

    console.log(`[CrossAppScanner] Using model: ${modelId}, Apps: ${appSummary.length}`);

    const toolSummaryStr = appSummary.join('\n');
    let totalToolCalls = 0;

    // ════════════════════════════════════════════════════
    //  PHASE 1: DISCOVERY — Broad exploration
    // ════════════════════════════════════════════════════
    onProgress('phase_change', {
        phase: 'discovery',
        phaseIndex: 0,
        title: 'Discovery',
        description: 'Exploring your data across all connected apps...',
    });

    let phase1Prompt = PHASE_1_PROMPT.replace('{{TOOL_SUMMARY}}', toolSummaryStr);
    if (options.existingContext) {
        phase1Prompt += '\n\n' + options.existingContext;
    }
    let phase1UserMsg = `Explore the available apps broadly. You have: ${appSummary.map(s => s.split(':')[0]).join(', ')}. Use the tools you have to get a complete overview. Only use the listed apps — do not reference any apps you don't have access to.`;
    if (options.focus) phase1UserMsg += `\n\nUSER FOCUS: The user specifically wants you to focus on: "${options.focus}". Prioritize this area in your exploration and proposals.`;

    const phase1Messages = [
        { role: 'system', content: phase1Prompt },
        { role: 'user', content: phase1UserMsg },
    ];

    const phase1 = await runPhase(adapter, providerConfig, modelId, phase1Messages, tools, ctx, 2, onProgress, 'Discovery');
    totalToolCalls += phase1.toolCallCount;

    // If phase 1 didn't produce a text summary, ask for one
    let discoverySummary = phase1.content;
    if (!discoverySummary || discoverySummary.length < 50) {
        phase1Messages.push({
            role: 'user',
            content: 'Summarize what you discovered across all apps. Use format: DISCOVERY SUMMARY with bullet points per app.',
        });
        const summaryResult = await adapter.chat(providerConfig.apiKey, apiUrl, modelId, phase1Messages, {
            maxTokens: 2048, temperature: 0.3,
        });
        discoverySummary = summaryResult.content || 'Discovery complete.';
    }

    console.log(`[CrossAppScanner] Phase 1 done: ${phase1.toolCallCount} calls, ${phase1.appsUsed.length} apps`);
    onProgress('phase_complete', {
        phase: 'discovery',
        summary: discoverySummary,
        toolCalls: phase1.toolCallCount,
        appsUsed: phase1.appsUsed,
    });

    // ════════════════════════════════════════════════════
    //  PHASE 2: ANALYSIS — Deep-dive connections
    // ════════════════════════════════════════════════════
    onProgress('phase_change', {
        phase: 'analysis',
        phaseIndex: 1,
        title: 'Analysis',
        description: 'Identifying cross-app connections and patterns...',
    });

    const phase2Prompt = PHASE_2_PROMPT
        .replace('{{TOOL_SUMMARY}}', toolSummaryStr)
        .replace('{{DISCOVERY_SUMMARY}}', discoverySummary);
    const phase2Messages = [
        { role: 'system', content: phase2Prompt },
        { role: 'user', content: 'Now dig deeper into the most promising automation opportunities. Read specific items, check details, look for patterns. Only use the apps and tools listed above — do not reference any apps you do not have access to.' },
    ];

    const phase2 = await runPhase(adapter, providerConfig, modelId, phase2Messages, tools, ctx, 2, onProgress, 'Analysis');
    totalToolCalls += phase2.toolCallCount;

    let analysisSummary = phase2.content;
    if (!analysisSummary || analysisSummary.length < 50) {
        phase2Messages.push({
            role: 'user',
            content: 'Summarize the cross-app connections you found. Use format: CONNECTIONS FOUND with numbered items.',
        });
        const analysisResult = await adapter.chat(providerConfig.apiKey, apiUrl, modelId, phase2Messages, {
            maxTokens: 2048, temperature: 0.3,
        });
        analysisSummary = analysisResult.content || 'Analysis complete.';
    }

    console.log(`[CrossAppScanner] Phase 2 done: ${phase2.toolCallCount} calls`);
    onProgress('phase_complete', {
        phase: 'analysis',
        summary: analysisSummary,
        toolCalls: phase2.toolCallCount,
        appsUsed: phase2.appsUsed,
    });

    // ════════════════════════════════════════════════════
    //  PHASE 3: PROPOSALS — Generate automations
    // ════════════════════════════════════════════════════
    onProgress('phase_change', {
        phase: 'proposals',
        phaseIndex: 2,
        title: 'Proposals',
        description: 'Generating cross-app automation proposals...',
    });

    const phase3Prompt = buildPhase3Prompt(enabledApps)
        .replace('{{DISCOVERY_SUMMARY}}', discoverySummary)
        .replace('{{ANALYSIS_SUMMARY}}', analysisSummary);

    const proposalResult = await adapter.chat(providerConfig.apiKey, apiUrl, modelId, [
        { role: 'system', content: phase3Prompt },
        { role: 'user', content: 'Generate the cross-app automation proposals now. Respond with ONLY the JSON array.' },
    ], { maxTokens: 6144, temperature: 0.3 });

    let proposals = [];
    const finalContent = proposalResult.content || '';
    console.log(`[CrossAppScanner] Phase 3 response: ${finalContent.length} chars`);

    proposals = parseProposals(finalContent);
    if (proposals.length === 0) {
        console.warn('[CrossAppScanner] No proposals parsed, trying repair...');
        const cleaned = finalContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        proposals = repairTruncatedJSON(cleaned);
        console.log(`[CrossAppScanner] Repaired ${proposals.length} proposals`);
    }

    onProgress('phase_complete', {
        phase: 'proposals',
        summary: `Generated ${proposals.length} cross-app automations`,
        toolCalls: 0,
    });

    return finalizeProposals(proposals, scanId, totalToolCalls, onProgress);
}

// ── JSON repair ─────────────────────────────────────────

function repairTruncatedJSON(text) {
    const proposals = [];
    let depth = 0, start = -1;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') { if (depth === 0) start = i; depth++; }
        else if (text[i] === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                try { const obj = JSON.parse(text.substring(start, i + 1)); if (obj.title) proposals.push(obj); } catch (e) { }
                start = -1;
            }
        }
    }
    return proposals;
}

// ── Finalize ────────────────────────────────────────────

function finalizeProposals(proposals, scanId, toolCallCount, onProgress) {
    if (!Array.isArray(proposals)) proposals = [];
    const seen = new Set();
    proposals = proposals.filter(p => {
        const key = (p.title || '').toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
    const normalized = proposals.map(p => ({
        id: crypto.randomUUID(),
        title: p.title || 'Untitled cross-app automation',
        description: p.description || '',
        trigger: { type: p.trigger?.type || 'manual', config: p.trigger?.config || {} },
        conditions: Array.isArray(p.conditions) ? p.conditions : [],
        actions: Array.isArray(p.actions) ? p.actions : [],
        script: p.script || null,
        requires_ai: !!p.requires_ai,
        priority: ['low', 'medium', 'high'].includes(p.priority) ? p.priority : 'medium',
        reasoning: p.reasoning || '',
        scanId, source: 'cross_app',
    }));
    for (const p of normalized) onProgress('task_proposed', { proposal: p });
    onProgress('scan_complete', { scanId, toolCallsUsed: toolCallCount, proposalCount: normalized.length });
    console.log(`[CrossAppScanner] Done: ${toolCallCount} tool calls, ${normalized.length} proposals`);
    return { scanId, proposals: normalized };
}

module.exports = { scanCrossApp, buildToolSet, routeToolCall, truncateToolResult };
