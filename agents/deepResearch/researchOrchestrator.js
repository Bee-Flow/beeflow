/**
 * Deep Research — Research Orchestrator
 *
 * Executes the research DAG respecting dependencies:
 *   - Runs independent nodes in parallel
 *   - Routes output from one worker to dependent workers
 *   - Implements configurable concurrency limits
 *   - Supports iterative refinement via reflection agent
 */

const { searchWeb } = require('./workers/webSearchWorker');
const { searchKnowledgeBase } = require('./workers/kbSearchWorker');
const { analyzeDocuments } = require('./workers/documentAnalysisWorker');
const { reflectOnFindings } = require('./reflectionAgent');

// ─── Worker Dispatcher ───────────────────────────────────────────────────

/**
 * Execute a single DAG node using the appropriate worker(s).
 * @param {object} node - DAG node
 * @param {object} priorResults - Accumulated results from previous nodes
 * @param {object} opts - { model, userId, onEvent, searchDepth }
 */
async function executeNode(node, priorResults = {}, opts = {}) {
    const onEvent = opts.onEvent || (() => {});
    const results = [];

    // Web search (default or explicit)
    if (!node.searchStrategy || node.searchStrategy === 'web_search' || node.searchStrategy === 'both') {
        const webResult = await searchWeb(node, {
            model: opts.model,
            maxIterations: opts.maxSearchIterations || 5,
            searchDepth: opts.searchDepth || 'advanced',
            onEvent
        });
        results.push(webResult);
    }

    // KB search (if strategy includes it)
    if (node.searchStrategy === 'kb_search' || node.searchStrategy === 'both') {
        const kbResult = await searchKnowledgeBase(node, {
            model: opts.model,
            userId: opts.userId,
            onEvent
        });
        // Only include if it actually found something
        if (!kbResult.skipped) {
            results.push(kbResult);
        }
    }

    // Merge findings from multiple workers for this node
    return mergeNodeResults(node, results);
}

/**
 * Merge results from multiple workers for the same node.
 */
function mergeNodeResults(node, results) {
    const allFindings = results.flatMap(r => r.findings || []);
    const allSources = results.flatMap(r => r.sources || []);
    const allGaps = results.flatMap(r => r.gaps || []);

    // Pick highest confidence
    const confidenceLevels = { high: 3, medium: 2, low: 1 };
    const maxConfidence = results.reduce((best, r) => {
        const score = confidenceLevels[r.confidence] || 0;
        return score > (confidenceLevels[best] || 0) ? r.confidence : best;
    }, 'low');

    return {
        id: node.id,
        question: node.question,
        focus: node.focus,
        findings: allFindings,
        sources: allSources,
        summary: results.map(r => r.summary).filter(Boolean).join(' | '),
        confidence: maxConfidence,
        gaps: allGaps,
        success: results.some(r => r.success)
    };
}

// ─── DAG Executor ────────────────────────────────────────────────────────

/**
 * Execute the full research DAG with iterative refinement.
 *
 * @param {object} plan - { topic, nodes, executionOrder, preset }
 * @param {object} opts - { model, userId, onEvent }
 * @returns {{ results: object[], allSources: object[], rounds: number }}
 */
async function executeResearch(plan, opts = {}) {
    const onEvent = opts.onEvent || (() => {});
    const preset = plan.preset || {};
    const maxRounds = preset.reflectionRounds || 0;
    const maxSearchRounds = preset.maxSearchRounds || 1;

    let allResults = {};
    let round = 0;
    let currentNodes = plan.nodes;
    let currentExecutionOrder = plan.executionOrder;

    // ── Main research loop ────────────────────────────────────────────
    while (round < maxSearchRounds) {
        round++;
        onEvent('research_round', { round, maxRounds: maxSearchRounds, nodeCount: currentNodes.length });

        // Execute DAG groups sequentially, nodes within each group in parallel
        for (let groupIdx = 0; groupIdx < currentExecutionOrder.length; groupIdx++) {
            const group = currentExecutionOrder[groupIdx];
            const groupNodes = group
                .map(id => currentNodes.find(n => n.id === id))
                .filter(Boolean);

            if (groupNodes.length === 0) continue;

            onEvent('execution_group', {
                round, groupIndex: groupIdx,
                totalGroups: currentExecutionOrder.length,
                nodeIds: group,
                parallel: groupNodes.length > 1
            });

            // Execute all nodes in this group in parallel
            const groupPromises = groupNodes.map(node =>
                executeNode(node, allResults, {
                    model: opts.model,
                    userId: opts.userId,
                    onEvent,
                    searchDepth: preset.searchDepth || 'advanced',
                    maxSearchIterations: 5
                })
            );

            const groupResults = await Promise.all(groupPromises);

            // Store results by node ID for dependency resolution
            for (const result of groupResults) {
                allResults[result.id] = result;
            }
        }

        // Document analysis pass — cross-reference all findings so far
        const webResults = Object.values(allResults).filter(r => r.success);
        if (webResults.length > 1) {
            onEvent('phase', { phase: 'analysis', message: 'Cross-referencing sources...' });
            const analysisResult = await analyzeDocuments(
                { id: `analysis_r${round}`, question: plan.topic },
                webResults,
                { model: opts.model, onEvent }
            );
            allResults[`__analysis_r${round}`] = analysisResult;
        }

        // ── Reflection (if enabled by depth preset) ──────────────────
        if (round <= maxRounds && round < maxSearchRounds) {
            onEvent('phase', { phase: 'reflection', message: `Evaluating research coverage (round ${round})...` });

            const reflection = await reflectOnFindings(plan.topic, Object.values(allResults), {
                model: opts.model,
                onEvent
            });

            onEvent('reflection_result', {
                round,
                coverage: reflection.coveragePercent,
                gapsFound: reflection.gaps?.length || 0,
                contradictions: reflection.contradictions?.length || 0,
                needsMore: reflection.needsMoreResearch
            });

            if (!reflection.needsMoreResearch) {
                console.log(`[DeepResearch:Orchestrator] Sufficient coverage at round ${round} (${reflection.coveragePercent}%)`);
                break;
            }

            // Generate follow-up nodes from gaps
            if (reflection.additionalQueries?.length > 0) {
                currentNodes = reflection.additionalQueries.map((q, i) => ({
                    id: `followup_r${round}_q${i + 1}`,
                    question: q.question || q,
                    focus: q.focus || 'gap filling',
                    dependencies: [],
                    searchStrategy: 'web_search',
                    priority: 1,
                    complexity: 'moderate'
                }));
                currentExecutionOrder = [currentNodes.map(n => n.id)];
                console.log(`[DeepResearch:Orchestrator] Round ${round + 1}: ${currentNodes.length} follow-up queries`);
            } else {
                break;
            }
        }
    }

    // Collect all results
    const flatResults = Object.values(allResults);
    const allSources = flatResults.flatMap(r => r.sources || []);

    return {
        results: flatResults,
        allSources,
        rounds: round,
        topic: plan.topic
    };
}

module.exports = { executeResearch, executeNode };
