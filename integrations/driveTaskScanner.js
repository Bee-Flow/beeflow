/**
 * Google Drive Task Scanner — AI-powered file analysis for automation proposals
 */

const crypto = require('crypto');
const { DRIVE_TOOLS, executeDriveTool } = require('./driveTools');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const configStore = require('../stores/configStore');
const { parseProposals } = require('./proposalParser');

const SCAN_SYSTEM_PROMPT = `You are a file organization analyst. You have Google Drive tools to explore the user's files.

EXPLORATION STRATEGY:
1. List recent files in root
2. Search for common file types (PDFs, spreadsheets, docs)
3. Look for disorganized files, stale content, shared files

After exploring, respond with ONLY a JSON array of automation proposals.
Each proposal must include a JavaScript automation script.

AVAILABLE ctx API:
- ctx.drive.search(query, maxResults?) → files
- ctx.drive.listFiles(folderId) → files
- ctx.drive.createFolder(name, parentFolderId?)
- ctx.drive.moveFile(fileId, destinationFolderId)
- ctx.ai.process(prompt) → string (ONLY for fuzzy matching)
- ctx.approved → boolean (false=preview, true=execute)
- ctx.task.lastRunAt → ISO string or null

[{
  "title": "Short name",
  "description": "What it does",
  "trigger": { "type": "schedule|manual", "config": { ... } },
  "conditions": [{ "field": "...", "operator": "...", "value": "...", "description": "..." }],
  "script": "async function run(ctx) { ... }",
  "priority": "low|medium|high",
  "reasoning": "Why, referencing specific files/patterns found"
}]

RULES:
- Scripts MUST use the two-phase pattern (preview when !ctx.approved, execute when ctx.approved)
- Reference actual files found
- Propose organization, cleanup, and monitoring tasks
- Final message = ONLY the JSON array`;

function truncateToolResult(result) {
    const str = JSON.stringify(result);
    if (result.results && Array.isArray(result.results)) {
        const trimmed = result.results.slice(0, 8).map(f => ({
            id: f.id, name: f.name, mimeType: f.mimeType,
            modifiedTime: f.modifiedTime, shared: f.shared,
        }));
        return JSON.stringify({ results: trimmed, total: result.resultCount, query: result.query });
    }
    return str.length > 2000 ? str.substring(0, 2000) + '..."' : str;
}

async function callWithRetry(fn, maxRetries = 1) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try { return await fn(); } catch (err) {
            if ((err.message?.includes('429') || err.message?.includes('rate_limit')) && attempt < maxRetries) {
                await new Promise(r => setTimeout(r, (attempt + 1) * 20000));
                continue;
            }
            throw err;
        }
    }
}

async function scanDrive(session, options = {}, onProgress = () => { }) {
    if (typeof options === 'function') { onProgress = options; options = {}; }
    const scanId = crypto.randomUUID();
    onProgress('scan_started', { scanId });

    if (!session?.accessToken) throw new Error('Google Drive not connected');

    let modelId = options.modelId;
    if (!modelId) {
        let tiers = configStore.getConfig('chat_model_tiers') || {};
        const smartTier = tiers.smart || tiers.balanced || tiers.fast || {};
        modelId = smartTier.modelId;
        if (!modelId) { const c = await getAIConfig(); modelId = c.model || 'mistral-small-latest'; }
    }

    const providerConfig = await getProviderForModel(modelId);
    const apiUrl = (providerConfig.url || '').replace(/\/+$/, '');
    const adapter = getAdapter(providerConfig.providerType, apiUrl);

    console.log(`[DriveScanner] Using model: ${modelId}`);
    onProgress('status', { message: 'AI is exploring your Google Drive...' });

    const scanTools = DRIVE_TOOLS.filter(t =>
        ['drive_search', 'drive_list_files', 'drive_get_file'].includes(t.function.name)
    );

    const systemPrompt = options.existingContext
        ? SCAN_SYSTEM_PROMPT + '\n\n' + options.existingContext
        : SCAN_SYSTEM_PROMPT;

    let userMsg = 'Explore my Google Drive. List root files, search for PDFs, spreadsheets, and shared files. Identify organization opportunities.';
    if (options.focus) userMsg += `\n\nUSER FOCUS: The user specifically wants you to focus on: "${options.focus}". Prioritize this area in your exploration.`;

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
    ];

    const MAX_ROUNDS = 2;
    let round = 0, toolCallCount = 0;

    while (round < MAX_ROUNDS) {
        let result;
        try {
            result = await adapter.chat(providerConfig.apiKey, apiUrl, modelId, messages, {
                maxTokens: 3072, temperature: 0.3, tools: scanTools, toolChoice: 'auto',
            });
        } catch (err) {
            if (err.message?.includes('429')) { onProgress('status', { message: 'Rate limit — generating proposals...' }); break; }
            throw new Error(`AI analysis failed: ${err.message}`);
        }

        if (result.toolCalls?.length > 0) {
            messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
            round++;
            const toolResults = await Promise.all(result.toolCalls.map(async (tc) => {
                const toolName = tc.function?.name || tc.name;
                let toolArgs = {}; try { toolArgs = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { }
                console.log(`[DriveScanner] Tool: ${toolName}`, toolArgs);
                toolCallCount++;
                onProgress('status', { message: `Exploring Drive (${toolCallCount} queries)...` });
                let toolResult;
                try { toolResult = await executeDriveTool(toolName, toolArgs, session); }
                catch (err) { toolResult = { error: err.message }; }
                return { role: 'tool', tool_call_id: tc.id, content: truncateToolResult(toolResult) };
            }));
            messages.push(...toolResults);
            continue;
        }

        const match = (result.content || '').match(/\[[\s\S]*\]/);
        if (match) { try { return finalize(parseProposals(match[0]), scanId, toolCallCount, onProgress); } catch (e) { } }
        break;
    }

    onProgress('status', { message: 'AI is formulating proposals...' });
    const finalResult = await callWithRetry(async () =>
        adapter.chat(providerConfig.apiKey, apiUrl, modelId, [
            { role: 'system', content: SCAN_SYSTEM_PROMPT },
            { role: 'user', content: buildSummary(messages) },
        ], { maxTokens: 3072, temperature: 0.3 })
    );
    let proposals = [];
    try { const m = (finalResult.content || '').match(/\[[\s\S]*\]/); if (m) proposals = parseProposals(m[0]); } catch (e) { }
    return finalize(proposals, scanId, toolCallCount, onProgress);
}

function buildSummary(messages) {
    const findings = [];
    for (const msg of messages) {
        if (msg.role === 'tool' && msg.content) {
            try {
                const data = JSON.parse(msg.content);
                if (data.results) findings.push(`Files: ${data.results.map(f => `"${f.name}" (${f.mimeType})`).join(', ')}`);
            } catch (e) { }
        }
    }
    return `Based on Drive exploration:\n\n${findings.join('\n\n')}\n\nPropose automation tasks as a JSON array.`;
}

function finalize(proposals, scanId, toolCallCount, onProgress) {
    if (!Array.isArray(proposals)) proposals = [];
    const seen = new Set();
    proposals = proposals.filter(p => { const k = (p.title || '').toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const normalized = proposals.map(p => ({
        id: crypto.randomUUID(), title: p.title || 'Untitled', description: p.description || '',
        trigger: { type: p.trigger?.type || 'manual', config: p.trigger?.config || {} },
        conditions: Array.isArray(p.conditions) ? p.conditions : [],
        actions: Array.isArray(p.actions) ? p.actions : [],
        script: p.script || null,
        requires_ai: !!p.requires_ai,
        priority: ['low', 'medium', 'high'].includes(p.priority) ? p.priority : 'medium',
        reasoning: p.reasoning || '', scanId, source: 'drive',
    }));
    for (const p of normalized) onProgress('task_proposed', { proposal: p });
    onProgress('scan_complete', { scanId, toolCallsUsed: toolCallCount, proposalCount: normalized.length });
    console.log(`[DriveScanner] Done: ${toolCallCount} tool calls, ${normalized.length} proposals`);
    return { scanId, proposals: normalized };
}

module.exports = { scanDrive };
