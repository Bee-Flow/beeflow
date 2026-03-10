/**
 * Deep Research Swarm — Multi-agent research pipeline for chat
 * 
 * Pipeline:
 *   1. Orchestrator decomposes query into sub-questions
 *   2. Parallel search workers research each sub-question (tavily_search)
 *   3. Synthesizer combines findings into a structured markdown report
 */

const multiAgentDesigner = require('../designer/coordinator');
const { callLLM, getSearchTools, executeToolCalls, extractJSON } = multiAgentDesigner;
const { getAIConfig, getProviderForModel } = require('../../core/aiAgent');
const swarmStore = require('../../stores/swarmStore');

// ============ Orchestrator: Decompose query ============

async function decomposeQuery(query, agentConfig = {}) {
    console.log(`[DeepResearch:DEBUG] Decomposing with model: ${agentConfig.model} (global: ${agentConfig.globalModel})`);
    const maxQuestions = agentConfig.maxSubQuestions || 5;
    const systemPrompt = agentConfig.system_prompt;

    if (!systemPrompt) {
        throw new Error('Decompose Query failed: Missing system_prompt in agent configuration (Database).');
    }

    const prompt = systemPrompt.replace('3-5', `3-${maxQuestions}`);

    const data = await multiAgentDesigner.callLLM({
        systemPrompt: prompt,
        messages: [{ role: 'user', content: query }],
        model: agentConfig.model || agentConfig.globalModel,
        temperature: 0.3,
        maxTokens: 1000
    });

    const content = data.choices[0].message.content || '';
    const parsed = multiAgentDesigner.extractJSON(content);
    if (!parsed || !parsed.subQuestions?.length) {
        // Fallback: use query as a single sub-question
        return {
            topic: query,
            subQuestions: [
                { id: 1, question: query, focus: 'main topic' },
                { id: 2, question: `${query} latest developments`, focus: 'recent updates' },
                { id: 3, question: `${query} comparison alternatives`, focus: 'alternatives' }
            ]
        };
    }
    return parsed;
}

// ============ Search Workers: Research sub-questions ============

async function searchWorker(subQuestion, tools, agentConfig = {}, onEvent, phase = 'research') {
    const workerId = `search_${subQuestion.id}`;
    onEvent('search_start', { id: subQuestion.id, question: subQuestion.question, focus: subQuestion.focus });

    if (!agentConfig.system_prompt) {
        throw new Error(`Search Worker ${subQuestion.id} failed: Missing system_prompt in agent configuration (Database).`);
    }

    const messages = [{ role: 'user', content: `Research this question: "${subQuestion.question}"\nFocus area: ${subQuestion.focus}` }];
    let result = null;
    let iterations = 0;
    const maxIter = agentConfig.maxSearchIterations || 5;

    try {
        while (iterations < maxIter) {
            iterations++;
            const data = await multiAgentDesigner.callLLM({
                systemPrompt: agentConfig.system_prompt,
                messages,
                tools,
                model: agentConfig.model || agentConfig.globalModel,
                temperature: 0.3,
                maxTokens: 3000
            });

            const assistantMsg = data.choices[0].message;

            if (assistantMsg.tool_calls?.length > 0) {
                messages.push(assistantMsg);
                const toolResults = await multiAgentDesigner.executeToolCalls(assistantMsg.tool_calls, onEvent, workerId, phase);
                for (const { tc, result: toolRes } of toolResults) {
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: toolRes });
                }
                continue;
            }

            result = multiAgentDesigner.extractJSON(assistantMsg.content || '') || {
                question: subQuestion.question,
                findings: [(assistantMsg.content || '').slice(0, 500)],
                sources: [],
                summary: (assistantMsg.content || '').slice(0, 200)
            };
            break;
        }

        onEvent('search_done', {
            id: subQuestion.id, question: subQuestion.question, success: true,
            sourcesCount: result?.sources?.length || 0, findingsCount: result?.findings?.length || 0
        });
        return { id: subQuestion.id, ...result, success: true };

    } catch (error) {
        console.error(`[DeepResearch] Search worker ${subQuestion.id} failed:`, error.message);
        onEvent('search_done', { id: subQuestion.id, question: subQuestion.question, success: false, error: error.message });
        return { id: subQuestion.id, question: subQuestion.question, findings: [], sources: [], summary: `Search failed: ${error.message}`, success: false };
    }
}

// ============ Synthesizer: Combine findings into report ============

async function synthesizeReport(topic, searchResults, agentConfig = {}, onEvent) {
    onEvent('synthesizing', { message: 'Combining research findings into report...' });

    if (!agentConfig.system_prompt) {
        throw new Error('Synthesize Report failed: Missing system_prompt in agent configuration (Database).');
    }

    const findingsText = searchResults.map(r =>
        `### Sub-question: ${r.question}\n**Findings:**\n${(r.findings || []).map(f => `- ${f}`).join('\n')}\n**Sources:** ${(r.sources || []).map(s => `[${s.title}](${s.url})`).join(', ') || 'none'}\n**Summary:** ${r.summary || 'N/A'}`
    ).join('\n\n---\n\n');

    const userPrompt = `## Research Topic: ${topic}\n\n## Collected Research\n${findingsText}\n\nPlease synthesize these findings into a comprehensive markdown research report.`;

    // Use streaming for the final report
    const baseConfig = await getAIConfig();
    const useModel = agentConfig.model || agentConfig.globalModel || baseConfig.model;
    const providerConfig = await getProviderForModel(useModel);

    let apiUrl = providerConfig.url.replace(/\/+$/, '');
    if (!apiUrl.endsWith('/v1')) apiUrl = `${apiUrl}/v1`;

    const headers = { 'Content-Type': 'application/json' };
    if (providerConfig.apiKey) headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;

    const response = await fetch(`${apiUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: useModel,
            messages: [
                { role: 'system', content: agentConfig.system_prompt },
                { role: 'user', content: userPrompt }
            ],
            temperature: 0.4,
            max_tokens: 6000,
            stream: true
        })
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Synthesizer API error: ${response.status} - ${error}`);
    }

    // Stream the report chunks
    let fullReport = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(l => l.startsWith('data: '));

        for (const line of lines) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
                const parsed = JSON.parse(data);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) {
                    fullReport += delta;
                    onEvent('chunk', { content: delta });
                }
            } catch { /* skip malformed chunks */ }
        }
    }

    return fullReport;
}

// ============ Main Pipeline ============

/**
 * Run the deep research pipeline.
 * @param {string} query - User's research question
 * @param {object} options - { model?: string }
 * @param {function} onEvent - (type, data) callback for SSE events
 * @returns {Promise<string>} The final markdown report
 */
async function runDeepResearch(query, options = {}, onEvent = () => { }) {
    const startTime = Date.now();
    const config = { model: options.model || null };

    // Get Swarm Config from DB
    const swarm = swarmStore.getSwarm('deep-research');
    if (!swarm) {
        throw new Error("Swarm 'deep-research' not found in database. Please run database seeding.");
    }

    const phases = swarm.phases || [];

    // Helper to find agent by role or name
    const getAgent = async (role, nameFallback) => {
        for (const p of phases) {
            if (p.agents) {
                const found = p.agents.find(a => a.role === role || a.name === nameFallback);
                if (found) {
                    // Use agent model, or fallback to passed config.model (request-specific), or fallback to system default
                    const baseConfig = await getAIConfig();
                    const globalModel = config.model || baseConfig.model;
                    const finalModel = found.model || globalModel;
                    console.log(`[DeepResearch:DEBUG] Resolved agent ${role} model: ${finalModel} (configured: ${found.model}, global: ${globalModel})`);
                    return { ...found, globalModel, model: finalModel };
                }
            }
        }
        return null; // Return null if not found to enforce check
    };

    const plannerConfig = await getAgent('orchestrator', 'Query Planner');
    if (!plannerConfig) throw new Error("Agent 'Orchestrator' not found in Deep Research swarm config.");
    // Pass global config limits to planner
    if (swarm.config.maxSubQuestions) plannerConfig.maxSubQuestions = swarm.config.maxSubQuestions;

    const searcherConfig = await getAgent('searcher', 'Web Searcher');
    if (!searcherConfig) throw new Error("Agent 'Web Searcher' not found in Deep Research swarm config.");
    // Pass global config limits to searcher
    if (swarm.config.maxSearchIterations) searcherConfig.maxSearchIterations = swarm.config.maxSearchIterations;

    const synthesizerConfig = await getAgent('synthesizer', 'Report Writer');
    if (!synthesizerConfig) throw new Error("Agent 'Report Writer' not found in Deep Research swarm config.");

    onEvent('research_start', { query, message: 'Starting deep research...' });

    // Step 1: Decompose 
    onEvent('phase', { phase: 'decompose', message: 'Analyzing question and planning research...' });
    const plan = await decomposeQuery(query, plannerConfig);
    onEvent('research_questions', {
        topic: plan.topic,
        questions: plan.subQuestions,
        count: plan.subQuestions.length
    });

    // Step 2: Parallel search
    onEvent('phase', { phase: 'search', message: `Searching ${plan.subQuestions.length} sub-questions in parallel...` });
    const tools = multiAgentDesigner.getSearchTools();
    if (!tools.length) {
        throw new Error('tavily_search component not found. Deep research requires the Tavily Search component.');
    }

    const searchPromises = plan.subQuestions.map(sq => searchWorker(sq, tools, searcherConfig, onEvent, 'search'));
    const searchResults = await Promise.all(searchPromises);

    const successful = searchResults.filter(r => r.success);
    const allSources = searchResults.flatMap(r => r.sources || []);
    onEvent('search_summary', {
        total: searchResults.length,
        successful: successful.length,
        totalSources: allSources.length
    });

    if (successful.length === 0) {
        throw new Error('All search workers failed. Check your tavily_search configuration.');
    }

    // Step 3: Synthesize
    onEvent('phase', { phase: 'synthesize', message: 'Synthesizing findings into report...' });
    const report = await synthesizeReport(plan.topic, successful, synthesizerConfig, onEvent);

    const elapsed = Date.now() - startTime;
    onEvent('done', {
        elapsed,
        topic: plan.topic,
        questionsSearched: plan.subQuestions.length,
        sourcesFound: allSources.length,
        reportLength: report.length
    });

    return report;
}

module.exports = { runDeepResearch };
