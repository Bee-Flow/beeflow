/**
 * Calendar Task Scanner — AI-powered calendar analysis for automation proposals
 */

const crypto = require('crypto');
const { CALENDAR_TOOLS, executeCalendarTool } = require('./calendarTools');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const configStore = require('../stores/configStore');
const { parseProposals } = require('./proposalParser');

const SCAN_SYSTEM_PROMPT = `You are a calendar automation analyst. You have Google Calendar tools to explore the user's schedule.

EXPLORATION STRATEGY:
1. List upcoming events (next 2 weeks)
2. Search for recurring meetings
3. Look for patterns: prep-needed meetings, follow-ups, gaps in schedule

After exploring, respond with ONLY a JSON array of automation proposals.
Each proposal must include a JavaScript automation script.

AVAILABLE ctx API:
- ctx.calendar.listEvents(daysAhead?, maxResults?) → events
- ctx.calendar.searchEvents(query, daysAhead?) → events
- ctx.calendar.createEvent({title, startTime, endTime, description, location})
- ctx.calendar.updateEvent(opts)
- ctx.gmail.compose(to, subject, body) → creates draft
- ctx.ai.process(prompt) → string (ONLY for fuzzy matching)
- ctx.approved → boolean (false=preview, true=execute)
- ctx.task.lastRunAt → ISO string or null

SCRIPT TEMPLATE:
async function run(ctx) {
  const events = await ctx.calendar.listEvents(7);
  if (!events?.events?.length) return { changes: [] };
  const changes = [];
  for (const evt of events.events) {
    changes.push({ type: 'block_time', target: evt.title, detail: 'Block prep time 30min before' });
  }
  if (!ctx.approved) return { changes };
  // execute changes here
  return { changes, executed: true };
}

[{
  "title": "Short name",
  "description": "What it does",
  "trigger": { "type": "schedule|event_upcoming|event_ended|manual", "config": { ... } },
  "conditions": [{ "field": "...", "operator": "...", "value": "...", "description": "..." }],
  "script": "async function run(ctx) { ... }",
  "priority": "low|medium|high",
  "reasoning": "Why, referencing specific events found"
}]

RULES:
- Scripts MUST use the two-phase pattern (preview when !ctx.approved, execute when ctx.approved)
- Reference actual events/patterns found
- Propose diverse automation types (prep, follow-up, blocking, reminders)
- Final message = ONLY the JSON array`;

function truncateToolResult(result) {
    const str = JSON.stringify(result);
    if (result.events && Array.isArray(result.events)) {
        const trimmed = result.events.slice(0, 10).map(e => ({
            id: e.id, title: e.title, start: e.start, end: e.end,
            location: e.location, isRecurring: e.isRecurring,
            attendees: e.attendees?.slice(0, 3),
        }));
        return JSON.stringify({ events: trimmed, total: result.total });
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

async function scanCalendar(session, options = {}, onProgress = () => { }) {
    if (typeof options === 'function') { onProgress = options; options = {}; }
    const scanId = crypto.randomUUID();
    onProgress('scan_started', { scanId });

    if (!session?.accessToken) throw new Error('Google Calendar not connected');

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

    console.log(`[CalendarScanner] Using model: ${modelId}`);
    onProgress('status', { message: 'AI is exploring your calendar...' });

    const scanTools = CALENDAR_TOOLS.filter(t =>
        ['calendar_list_events', 'calendar_search_events'].includes(t.function.name)
    );

    const systemPrompt = options.existingContext
        ? SCAN_SYSTEM_PROMPT + '\n\n' + options.existingContext
        : SCAN_SYSTEM_PROMPT;

    let userMsg = 'Explore my Google Calendar and identify automation opportunities. Look at upcoming events, recurring meetings, and schedule patterns.';
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
            if (err.message?.includes('429')) { onProgress('status', { message: 'Rate limit hit — generating proposals...' }); break; }
            throw new Error(`AI analysis failed: ${err.message}`);
        }

        if (result.toolCalls?.length > 0) {
            messages.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls });
            round++;
            const toolResults = await Promise.all(result.toolCalls.map(async (tc) => {
                const toolName = tc.function?.name || tc.name;
                let toolArgs = {}; try { toolArgs = JSON.parse(tc.function?.arguments || '{}'); } catch (e) { }
                console.log(`[CalendarScanner] Tool: ${toolName}`, toolArgs);
                toolCallCount++;
                onProgress('status', { message: `Exploring calendar (${toolCallCount} queries)...` });
                let toolResult;
                try { toolResult = await executeCalendarTool(toolName, toolArgs, session); }
                catch (err) { toolResult = { error: err.message }; }
                return { role: 'tool', tool_call_id: tc.id, content: truncateToolResult(toolResult) };
            }));
            messages.push(...toolResults);
            continue;
        }

        const inlineContent = result.content || '';
        const match = inlineContent.match(/\[[\s\S]*\]/);
        if (match) {
            try { return finalizeProposals(parseProposals(match[0]), scanId, toolCallCount, onProgress, 'calendar'); }
            catch (e) { }
        }
        break;
    }

    onProgress('status', { message: 'AI is formulating proposals...' });
    const finalResult = await callWithRetry(async () =>
        adapter.chat(providerConfig.apiKey, apiUrl, modelId, [
            { role: 'system', content: SCAN_SYSTEM_PROMPT },
            { role: 'user', content: buildSummaryPrompt(messages) },
        ], { maxTokens: 3072, temperature: 0.3 })
    );

    let proposals = [];
    try {
        const m = (finalResult.content || '').match(/\[[\s\S]*\]/);
        if (m) proposals = parseProposals(m[0]);
    } catch (e) { }

    return finalizeProposals(proposals, scanId, toolCallCount, onProgress, 'calendar');
}

function buildSummaryPrompt(messages) {
    const findings = [];
    for (const msg of messages) {
        if (msg.role === 'tool' && msg.content) {
            try {
                const data = JSON.parse(msg.content);
                if (data.events) findings.push(`Events: ${data.events.map(e => `"${e.title}" at ${e.start}`).join('; ')}`);
            } catch (e) { }
        }
    }
    return `Based on calendar exploration:\n\n${findings.join('\n\n')}\n\nPropose automation tasks as a JSON array.`;
}

function finalizeProposals(proposals, scanId, toolCallCount, onProgress, source) {
    if (!Array.isArray(proposals)) proposals = [];
    const seen = new Set();
    proposals = proposals.filter(p => {
        const key = (p.title || '').toLowerCase().trim();
        if (seen.has(key)) return false;
        seen.add(key); return true;
    });
    const normalized = proposals.map(p => ({
        id: crypto.randomUUID(),
        title: p.title || 'Untitled automation',
        description: p.description || '',
        trigger: { type: p.trigger?.type || 'manual', config: p.trigger?.config || {} },
        conditions: Array.isArray(p.conditions) ? p.conditions : [],
        actions: Array.isArray(p.actions) ? p.actions : [],
        script: p.script || null,
        requires_ai: !!p.requires_ai,
        priority: ['low', 'medium', 'high'].includes(p.priority) ? p.priority : 'medium',
        reasoning: p.reasoning || '',
        scanId, source,
    }));
    for (const p of normalized) onProgress('task_proposed', { proposal: p });
    onProgress('scan_complete', { scanId, toolCallsUsed: toolCallCount, proposalCount: normalized.length });
    console.log(`[CalendarScanner] Done: ${toolCallCount} tool calls, ${normalized.length} proposals`);
    return { scanId, proposals: normalized };
}

module.exports = { scanCalendar };
