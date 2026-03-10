/**
 * YouTrack Task Scanner — AI-powered issue tracking analysis
 */

const crypto = require('crypto');
const { YOUTRACK_TOOLS, executeYouTrackTool } = require('./youtrackTools');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const configStore = require('../stores/configStore');
const { parseProposals } = require('./proposalParser');

const SCAN_SYSTEM_PROMPT = `You are a project management automation analyst. You have YouTrack tools to explore issues.

EXPLORATION STRATEGY:
1. List available projects
2. Search for open issues, especially overdue or unassigned
3. Look for patterns: stale issues, recurring tasks, bottlenecks

After exploring, respond with ONLY a JSON array of automation proposals.
Each proposal must include a JavaScript automation script.

AVAILABLE ctx API:
- ctx.youtrack.listIssues(query?) → issues
- ctx.youtrack.createIssue({projectId, summary, description})
- ctx.youtrack.updateIssue(opts)
- ctx.gmail.compose(to, subject, body) → creates draft
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
  "reasoning": "Why, referencing specific issues/projects found"
}]

RULES:
- Scripts MUST use the two-phase pattern (preview when !ctx.approved, execute when ctx.approved)
- Reference actual projects/issues found
- Propose cleanup, monitoring, and workflow automations
- Final message = ONLY the JSON array`;

function truncateToolResult(result) {
    const str = JSON.stringify(result);
    if (result.issues && Array.isArray(result.issues)) {
        const trimmed = result.issues.slice(0, 10).map(i => ({
            id: i.id, summary: i.summary?.substring(0, 80), state: i.state,
            priority: i.priority, assignee: i.assignee, project: i.project,
        }));
        return JSON.stringify({ issues: trimmed, total: result.total });
    }
    if (result.projects) {
        return JSON.stringify({ projects: result.projects.slice(0, 10) });
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

async function scanYouTrack(session, userId, options = {}, onProgress = () => { }) {
    if (typeof options === 'function') { onProgress = options; options = {}; }
    const scanId = crypto.randomUUID();
    onProgress('scan_started', { scanId });

    const ytUrl = await configStore.getSecret(`youtrack_url_user_${userId}`);
    const ytToken = await configStore.getSecret(`youtrack_token_user_${userId}`);
    if (!ytUrl || !ytToken) throw new Error('YouTrack not configured — add URL and token in settings');

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

    console.log(`[YouTrackScanner] Using model: ${modelId}`);
    onProgress('status', { message: 'AI is exploring your YouTrack issues...' });

    const scanTools = YOUTRACK_TOOLS.filter(t =>
        ['youtrack_search_issues', 'youtrack_get_issue', 'youtrack_list_projects'].includes(t.function.name)
    );

    const systemPrompt = options.existingContext
        ? SCAN_SYSTEM_PROMPT + '\n\n' + options.existingContext
        : SCAN_SYSTEM_PROMPT;

    let userMsg = 'Explore my YouTrack. List projects, search for open/overdue issues, and identify automation opportunities for issue management.';
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
                console.log(`[YouTrackScanner] Tool: ${toolName}`, toolArgs);
                toolCallCount++;
                onProgress('status', { message: `Exploring YouTrack (${toolCallCount} queries)...` });
                let toolResult;
                try { toolResult = await executeYouTrackTool(toolName, toolArgs, userId); }
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
                if (data.issues) findings.push(`Issues: ${data.issues.map(i => `${i.id}: "${i.summary}" [${i.state}]`).join('; ')}`);
                if (data.projects) findings.push(`Projects: ${data.projects.map(p => p.name || p.shortName).join(', ')}`);
            } catch (e) { }
        }
    }
    return `Based on YouTrack exploration:\n\n${findings.join('\n\n')}\n\nPropose automation tasks as a JSON array.`;
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
        reasoning: p.reasoning || '', scanId, source: 'youtrack',
    }));
    for (const p of normalized) onProgress('task_proposed', { proposal: p });
    onProgress('scan_complete', { scanId, toolCallsUsed: toolCallCount, proposalCount: normalized.length });
    console.log(`[YouTrackScanner] Done: ${toolCallCount} tool calls, ${normalized.length} proposals`);
    return { scanId, proposals: normalized };
}

module.exports = { scanYouTrack };
