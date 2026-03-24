/**
 * Deep Research — Query Planner
 *
 * Generates a research DAG (Directed Acyclic Graph) from the user's query.
 * Each node is a sub-question with dependencies, priority, and search strategy.
 *
 * Supports 3 depth presets:  fast | normal | detailed
 */

const { callLLM, extractJSON } = require('../../pipeline/llmHelpers');

// ─── Depth Preset Configurations ─────────────────────────────────────────

const DEPTH_PRESETS = {
    fast: {
        maxSubQuestions: 3,
        maxSearchRounds: 1,
        reflectionRounds: 0,
        reportPasses: 1,      // single-pass draft
        searchDepth: 'basic',
        maxTokenBudget: 20000,
        description: 'Quick overview — 3 sub-questions, no reflection'
    },
    normal: {
        maxSubQuestions: 5,
        maxSearchRounds: 2,
        reflectionRounds: 1,
        reportPasses: 2,      // draft + review
        searchDepth: 'advanced',
        maxTokenBudget: 50000,
        description: 'Balanced research — 5 sub-questions, 1 reflection round'
    },
    detailed: {
        maxSubQuestions: 10,
        maxSearchRounds: 3,
        reflectionRounds: 2,
        reportPasses: 3,      // outline + draft + review
        searchDepth: 'advanced',
        maxTokenBudget: 100000,
        description: 'Thorough deep-dive — up to 10 sub-questions, 2 reflection rounds'
    }
};

// ─── Planner System Prompt ───────────────────────────────────────────────

function getPlannerPrompt(preset) {
    return `You are a Deep Research Planner. Given a research query, decompose it into a structured research plan.

## Depth Setting: ${preset.description}
Maximum sub-questions: ${preset.maxSubQuestions}

## Instructions
1. Identify the core topic and break it into ${preset.maxSubQuestions} or fewer sub-questions
2. For each sub-question, determine:
   - Dependencies (which other questions must be answered first)
   - Search strategy (web_search, kb_search, or both)
   - Priority (1 = most important)
   - Estimated complexity (simple, moderate, complex)
3. Structure them so independent questions can run in parallel

## Response Format
Respond with ONLY a JSON object:
{
  "topic": "Main research topic (refined)",
  "summary": "One-line summary of the research goal",
  "nodes": [
    {
      "id": "q1",
      "question": "Specific research question",
      "focus": "What aspect this covers",
      "dependencies": [],
      "searchStrategy": "web_search",
      "priority": 1,
      "complexity": "moderate"
    }
  ],
  "executionOrder": [
    ["q1", "q2"],
    ["q3"]
  ]
}

executionOrder is an array of arrays — each inner array contains node IDs that can run in parallel.
The outer array is sequential: all nodes in group[0] must complete before group[1] starts.

Make questions specific and searchable. Avoid vague or overly broad questions.`;
}

/**
 * Generate a research DAG from a query.
 * @param {string} query - The (possibly refined) research query
 * @param {object} opts - { depth: 'fast'|'normal'|'detailed', model, researchScope }
 * @returns {{ topic, summary, nodes[], executionOrder[][], preset }}
 */
async function planResearch(query, opts = {}) {
    const depthKey = opts.depth || 'normal';
    const preset = DEPTH_PRESETS[depthKey] || DEPTH_PRESETS.normal;

    // If we have a research scope from the clarifier, enrich the prompt
    let enrichedQuery = query;
    if (opts.researchScope) {
        const scope = opts.researchScope;
        enrichedQuery = `${query}\n\nResearch Scope:\n- Main topic: ${scope.mainTopic}\n- Subtopics to cover: ${(scope.subtopics || []).join(', ') || 'auto-detect'}\n- Perspective: ${scope.perspective || 'general'}\n- Timeframe: ${scope.timeframe || 'current'}`;
    }

    const data = await callLLM({
        systemPrompt: getPlannerPrompt(preset),
        messages: [{ role: 'user', content: enrichedQuery }],
        model: opts.model || null,
        temperature: 0.3,
        maxTokens: 2000
    });

    const content = data.choices[0].message.content || '';
    const parsed = extractJSON(content);

    if (!parsed || !parsed.nodes?.length) {
        // Fallback: simple linear plan
        return buildFallbackPlan(query, preset);
    }

    // Validate and clean up the plan
    const validatedNodes = parsed.nodes.slice(0, preset.maxSubQuestions).map((node, i) => ({
        id: node.id || `q${i + 1}`,
        question: node.question,
        focus: node.focus || node.question,
        dependencies: Array.isArray(node.dependencies) ? node.dependencies : [],
        searchStrategy: node.searchStrategy || 'web_search',
        priority: node.priority || (i + 1),
        complexity: node.complexity || 'moderate'
    }));

    // Build execution order if not provided or invalid
    let executionOrder = parsed.executionOrder;
    if (!executionOrder || !Array.isArray(executionOrder) || executionOrder.length === 0) {
        executionOrder = buildExecutionOrder(validatedNodes);
    }

    return {
        topic: parsed.topic || query,
        summary: parsed.summary || `Research: ${query}`,
        nodes: validatedNodes,
        executionOrder,
        preset: { key: depthKey, ...preset }
    };
}

/**
 * Build execution order from dependencies using topological sort.
 */
function buildExecutionOrder(nodes) {
    const nodeIds = new Set(nodes.map(n => n.id));
    const inDegree = {};
    const dependents = {};

    for (const node of nodes) {
        inDegree[node.id] = 0;
        dependents[node.id] = [];
    }

    for (const node of nodes) {
        for (const dep of node.dependencies) {
            if (nodeIds.has(dep)) {
                inDegree[node.id]++;
                dependents[dep].push(node.id);
            }
        }
    }

    const order = [];
    const remaining = new Set(nodeIds);

    while (remaining.size > 0) {
        // Find all nodes with no unresolved dependencies
        const ready = [...remaining].filter(id => inDegree[id] === 0);
        if (ready.length === 0) {
            // Circular dependency — just add remaining
            order.push([...remaining]);
            break;
        }

        order.push(ready);

        for (const id of ready) {
            remaining.delete(id);
            for (const dependent of dependents[id]) {
                inDegree[dependent]--;
            }
        }
    }

    return order;
}

/**
 * Fallback plan when LLM output is unparseable.
 */
function buildFallbackPlan(query, preset) {
    const maxQ = Math.min(preset.maxSubQuestions, 3);
    const nodes = [
        { id: 'q1', question: query, focus: 'main topic', dependencies: [], searchStrategy: 'web_search', priority: 1, complexity: 'moderate' },
    ];

    if (maxQ >= 2) {
        nodes.push({ id: 'q2', question: `${query} — latest developments and trends`, focus: 'recent updates', dependencies: [], searchStrategy: 'web_search', priority: 2, complexity: 'simple' });
    }
    if (maxQ >= 3) {
        nodes.push({ id: 'q3', question: `${query} — comparisons and alternatives`, focus: 'alternatives', dependencies: [], searchStrategy: 'web_search', priority: 3, complexity: 'simple' });
    }

    return {
        topic: query,
        summary: `Research: ${query}`,
        nodes,
        executionOrder: [nodes.map(n => n.id)],
        preset: { key: 'fallback', ...preset }
    };
}

module.exports = { planResearch, DEPTH_PRESETS, buildExecutionOrder };
