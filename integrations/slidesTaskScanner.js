/**
 * Google Slides Task Scanner — AI-powered presentation analysis
 */

const crypto = require('crypto');
const { SLIDES_TOOLS, executeSlidesTool } = require('./slidesTools');
const { getAIConfig, getProviderForModel } = require('../core/aiAgent');
const { getAdapter } = require('../core/providers');
const configStore = require('../stores/configStore');
const { parseProposals } = require('./proposalParser');

const SCAN_SYSTEM_PROMPT = `You are a presentation automation analyst. You have Google Slides tools to explore presentations.

EXPLORATION STRATEGY:
1. List recent presentations
2. Read 1-2 presentations to check content quality
3. Look for patterns: outdated content, recurring formats, templates

After exploring, respond with ONLY a JSON array of automation proposals.
Each proposal must include a JavaScript automation script.

AVAILABLE ctx API:
- ctx.slides.list(query?) → presentations
- ctx.slides.create({title, slides, theme})
- ctx.slides.addSlide(opts)
- ctx.ai.process(prompt) → string (ONLY for fuzzy matching)
- ctx.approved → boolean (false=preview, true=execute)
- ctx.task.lastRunAt → ISO string or null

[{
  "title": "Short name",
  "description": "What it does",
  "trigger": { "type": "schedule|manual|event_upcoming", "config": { ... } },
  "conditions": [{ "field": "...", "operator": "...", "value": "...", "description": "..." }],
  "script": "async function run(ctx) { ... }",
  "priority": "low|medium|high",
  "reasoning": "Why, referencing specific presentations found"
}]

RULES:
- Scripts MUST use the two-phase pattern (preview when !ctx.approved, execute when ctx.approved)
- Reference actual presentations found
- Propose template, prep, and content update automations
- Final message = ONLY the JSON array`;

function truncateToolResult(result) {
    const str = JSON.stringify(result);
    if (result.presentations && Array.isArray(result.presentations)) {
        const trimmed = result.presentations.slice(0, 8).map(p => ({
            id: p.id, title: p.title, modifiedTime: p.modifiedTime, slideCount: p.slideCount,
        }));
        return JSON.stringify({ presentations: trimmed, total: result.total });
    }
    if (result.slides && Array.isArray(result.slides)) {
        const trimmed = result.slides.slice(0, 5).map(s => ({
            index: s.index, title: s.title, text: s.text?.substring(0, 200),
        }));
        return JSON.stringify({ title: result.title, slides: trimmed, slideCount: result.slideCount });
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

async function scanSlides(session, options = {}, onProgress = () => { }) {
    if (typeof options === 'function') { onProgress = options; options = {}; }
    const scanId = crypto.randomUUID();
    onProgress('scan_started', { scanId });

    if (!session?.accessToken) throw new Error('Google Slides not connected');

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

    console.log(`[SlidesScanner] Using model: ${modelId}`);
    onProgress('status', { message: 'AI is exploring your presentations...' });

    const scanTools = SLIDES_TOOLS.filter(t =>
        ['slides_list_presentations', 'slides_get_presentation'].includes(t.function.name)
    );

    const systemPrompt = options.existingContext
        ? SCAN_SYSTEM_PROMPT + '\n\n' + options.existingContext
        : SCAN_SYSTEM_PROMPT;

    let userMsg = 'Explore my Google Slides presentations. List recent ones and check for patterns. Identify automation opportunities.';
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
                console.log(`[SlidesScanner] Tool: ${toolName}`, toolArgs);
                toolCallCount++;
                onProgress('status', { message: `Exploring presentations (${toolCallCount} queries)...` });
                let toolResult;
                try { toolResult = await executeSlidesTool(toolName, toolArgs, session); }
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
                if (data.presentations) findings.push(`Presentations: ${data.presentations.map(p => `"${p.title}"`).join(', ')}`);
                if (data.slides) findings.push(`"${data.title}": ${data.slideCount} slides`);
            } catch (e) { }
        }
    }
    return `Based on Slides exploration:\n\n${findings.join('\n\n')}\n\nPropose automation tasks as a JSON array.`;
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
        reasoning: p.reasoning || '', scanId, source: 'slides',
    }));
    for (const p of normalized) onProgress('task_proposed', { proposal: p });
    onProgress('scan_complete', { scanId, toolCallsUsed: toolCallCount, proposalCount: normalized.length });
    console.log(`[SlidesScanner] Done: ${toolCallCount} tool calls, ${normalized.length} proposals`);
    return { scanId, proposals: normalized };
}

module.exports = { scanSlides };
