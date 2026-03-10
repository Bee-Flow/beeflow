/**
 * Fireflies.ai Task Scanner — AI-powered meeting transcript analysis
 */

const crypto = require('crypto');
const { FIREFLIES_TOOLS, executeFirefliesTool } = require('./firefliesTools');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const configStore = require('../stores/configStore');
const { parseProposals } = require('./proposalParser');

const SCAN_SYSTEM_PROMPT = `You are a meeting automation analyst. You have Fireflies.ai tools to explore meeting transcripts.

EXPLORATION STRATEGY:
1. List recent transcripts
2. Get summaries of key meetings
3. Identify patterns: recurring meetings, action items, follow-ups

After exploring, respond with ONLY a JSON array of automation proposals.
Each proposal must include a JavaScript automation script.

AVAILABLE ctx API:
- ctx.fireflies.listTranscripts(limit?) → transcripts
- ctx.fireflies.getSummary(transcriptId) → summary
- ctx.gmail.compose(to, subject, body) → creates draft
- ctx.youtrack.createIssue({projectId, summary, description})
- ctx.ai.process(prompt) → string (ONLY for fuzzy matching)
- ctx.approved → boolean (false=preview, true=execute)
- ctx.task.lastRunAt → ISO string or null

[{
  "title": "Short name",
  "description": "What it does",
  "trigger": { "type": "schedule|meeting_ended|manual", "config": { ... } },
  "conditions": [{ "field": "...", "operator": "...", "value": "...", "description": "..." }],
  "script": "async function run(ctx) { ... }",
  "priority": "low|medium|high",
  "reasoning": "Why, referencing specific meetings found"
}]

RULES:
- Scripts MUST use the two-phase pattern (preview when !ctx.approved, execute when ctx.approved)
- Reference actual meetings/speakers found
- Propose cross-app automations (meeting → email summary, meeting → YouTrack issue)
- Final message = ONLY the JSON array`;

function truncateToolResult(result) {
    const str = JSON.stringify(result);
    if (result.transcripts && Array.isArray(result.transcripts)) {
        const trimmed = result.transcripts.slice(0, 8).map(t => ({
            id: t.id, title: t.title, date: t.date, duration: t.duration,
            organizer: t.organizer_email, participants: t.participants?.slice(0, 5),
        }));
        return JSON.stringify({ transcripts: trimmed, total: result.total });
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

async function scanFireflies(session, userId, options = {}, onProgress = () => { }) {
    if (typeof options === 'function') { onProgress = options; options = {}; }
    const scanId = crypto.randomUUID();
    onProgress('scan_started', { scanId });

    const apiKey = await configStore.getSecret(`fireflies_api_key_user_${userId}`);
    if (!apiKey) throw new Error('Fireflies.ai not configured — add API key in settings');

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

    console.log(`[FirefliesScanner] Using model: ${modelId}`);
    onProgress('status', { message: 'AI is exploring your meeting transcripts...' });

    const scanTools = FIREFLIES_TOOLS.filter(t =>
        ['fireflies_list_transcripts', 'fireflies_get_summary'].includes(t.function.name)
    );

    const systemPrompt = options.existingContext
        ? SCAN_SYSTEM_PROMPT + '\n\n' + options.existingContext
        : SCAN_SYSTEM_PROMPT;

    let userMsg = 'Explore my Fireflies.ai meeting transcripts. List recent meetings and get summaries of key ones. Identify automation opportunities for follow-ups, action items, and summaries.';
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
                console.log(`[FirefliesScanner] Tool: ${toolName}`, toolArgs);
                toolCallCount++;
                onProgress('status', { message: `Exploring transcripts (${toolCallCount} queries)...` });
                let toolResult;
                try { toolResult = await executeFirefliesTool(toolName, toolArgs, userId); }
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
                if (data.transcripts) findings.push(`Meetings: ${data.transcripts.map(t => `"${t.title}" on ${t.date}`).join('; ')}`);
                if (data.summary) findings.push(`Summary: ${JSON.stringify(data.summary).substring(0, 500)}`);
            } catch (e) { }
        }
    }
    return `Based on meeting exploration:\n\n${findings.join('\n\n')}\n\nPropose automation tasks as a JSON array.`;
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
        reasoning: p.reasoning || '', scanId, source: 'fireflies',
    }));
    for (const p of normalized) onProgress('task_proposed', { proposal: p });
    onProgress('scan_complete', { scanId, toolCallsUsed: toolCallCount, proposalCount: normalized.length });
    console.log(`[FirefliesScanner] Done: ${toolCallCount} tool calls, ${normalized.length} proposals`);
    return { scanId, proposals: normalized };
}

module.exports = { scanFireflies };
