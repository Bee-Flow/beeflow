/**
 * Deep Research Agent v2 — Main Entry Point
 *
 * Complete multi-agent research pipeline:
 *   Phase 1: Clarification → Query Planning (DAG)
 *   Phase 2: Multi-source Research (web + KB + document analysis)
 *   Phase 3: Iterative Refinement (reflection loop)
 *   Phase 4: Synthesis (outline → write → review) + Citations
 *
 * Depth Presets:
 *   ⚡ fast     — 3 questions, 1 round, single-pass draft
 *   📋 normal   — 5 questions, 2 rounds, draft + review
 *   🔬 detailed — 8-10 questions, 3 rounds, outline + draft + review
 *
 * Replaces: agents/swarm/deepResearch.js
 */

const { clarifyQuery } = require('./clarifierAgent');
const { planResearch, DEPTH_PRESETS } = require('./queryPlanner');
const { executeResearch } = require('./researchOrchestrator');
const { CitationManager } = require('./citations/citationManager');
const { generateOutline } = require('./synthesis/outlineGenerator');
const { writeReport } = require('./synthesis/reportWriter');
const { reviewReport } = require('./synthesis/reportReviewer');

// ─── Main Pipeline ───────────────────────────────────────────────────────

/**
 * Run the deep research pipeline.
 *
 * @param {string} query - User's research question
 * @param {object} options - { depth: 'fast'|'normal'|'detailed', model, userId, clarificationAnswers }
 * @param {function} onEvent - (type, data) callback for SSE events
 * @returns {Promise<{ report: string, sources: object[], metadata: object }>}
 */
async function runDeepResearch(query, options = {}, onEvent = () => {}) {
    const startTime = Date.now();
    const depth = options.depth || 'normal';
    const preset = DEPTH_PRESETS[depth] || DEPTH_PRESETS.normal;

    onEvent('research_start', {
        query,
        depth,
        preset: { ...preset, key: depth },
        message: `Starting deep research (${depth} mode)...`
    });

    // ── Phase 1A: Clarification ──────────────────────────────────────

    let refinedQuery = query;
    let researchScope = null;

    if (!options.clarificationAnswers) {
        onEvent('phase', { phase: 'clarify', message: 'Analyzing query...' });

        const clarification = await clarifyQuery(query, { model: options.model });

        if (clarification.needsClarification && clarification.questions.length > 0) {
            onEvent('clarification_needed', {
                questions: clarification.questions,
                refinedQuery: clarification.refinedQuery,
                researchScope: clarification.researchScope
            });

            // Return early — caller must re-invoke with clarificationAnswers
            return {
                phase: 'clarification',
                needsClarification: true,
                questions: clarification.questions,
                refinedQuery: clarification.refinedQuery,
                researchScope: clarification.researchScope,
                elapsed: Date.now() - startTime
            };
        }

        refinedQuery = clarification.refinedQuery;
        researchScope = clarification.researchScope;
        onEvent('phase_done', { phase: 'clarify', message: 'Query clear — proceeding' });
    } else {
        // User provided clarification answers — enrich the query
        const answers = options.clarificationAnswers;
        const answerText = typeof answers === 'string'
            ? answers
            : Object.entries(answers).map(([k, v]) => `- ${k}: ${v}`).join('\n');
        refinedQuery = `${query}\n\nUser Clarifications:\n${answerText}`;
        researchScope = options.researchScope || null;
    }

    // ── Phase 1B: Query Planning (DAG) ───────────────────────────────

    onEvent('phase', { phase: 'planning', message: 'Creating research plan...' });

    const plan = await planResearch(refinedQuery, {
        depth,
        model: options.model,
        researchScope
    });

    onEvent('research_plan', {
        topic: plan.topic,
        summary: plan.summary,
        nodeCount: plan.nodes.length,
        executionGroups: plan.executionOrder.length,
        nodes: plan.nodes.map(n => ({ id: n.id, question: n.question, focus: n.focus, strategy: n.searchStrategy })),
        depth
    });

    // ── Phase 2+3: Research + Reflection ──────────────────────────────

    onEvent('phase', { phase: 'research', message: `Researching ${plan.nodes.length} sub-questions...` });

    const researchOutput = await executeResearch(plan, {
        model: options.model,
        userId: options.userId,
        onEvent
    });

    const successful = researchOutput.results.filter(r => r.success);
    onEvent('research_summary', {
        total: researchOutput.results.length,
        successful: successful.length,
        totalSources: researchOutput.allSources.length,
        rounds: researchOutput.rounds
    });

    if (successful.length === 0) {
        throw new Error('All research workers failed. Check your search tool configuration.');
    }

    // ── Phase 4A: Citation Registration ──────────────────────────────

    const citationManager = new CitationManager();
    citationManager.registerFromResults(researchOutput.results);

    onEvent('citations_registered', { count: citationManager.count });

    // ── Phase 4B: Outline (Detailed mode only) ───────────────────────

    let outline = null;
    if (preset.reportPasses >= 3) {
        onEvent('phase', { phase: 'outline', message: 'Generating report outline...' });
        outline = await generateOutline(plan.topic, researchOutput.results, { model: options.model });
        onEvent('outline_ready', {
            title: outline.title,
            sections: outline.sections.map(s => ({ title: s.title, description: s.description }))
        });
    }

    // ── Phase 4C: Report Writing ─────────────────────────────────────

    onEvent('phase', { phase: 'writing', message: 'Writing research report...' });

    const report = await writeReport(plan.topic, researchOutput.results, citationManager, {
        model: options.model,
        outline,
        onEvent
    });

    // ── Phase 4D: Report Review (Normal + Detailed modes) ────────────

    let review = null;
    if (preset.reportPasses >= 2) {
        review = await reviewReport(report, researchOutput.results, {
            model: options.model,
            onEvent
        });
    }

    // ── Finalize ─────────────────────────────────────────────────────

    // Append source list to report
    const fullReport = report + citationManager.formatReferenceList();

    const elapsed = Date.now() - startTime;

    onEvent('done', {
        elapsed,
        topic: plan.topic,
        depth,
        questionsSearched: plan.nodes.length,
        researchRounds: researchOutput.rounds,
        sourcesFound: citationManager.count,
        reportLength: fullReport.length,
        reviewScore: review?.overallScore || null
    });

    return {
        report: fullReport,
        sources: citationManager.getAllSources(),
        metadata: {
            topic: plan.topic,
            depth,
            elapsed,
            questionsSearched: plan.nodes.length,
            researchRounds: researchOutput.rounds,
            sourcesCount: citationManager.count,
            reviewScore: review?.overallScore || null,
            review: review || null,
            plan: {
                nodes: plan.nodes.map(n => ({ id: n.id, question: n.question, focus: n.focus })),
                executionOrder: plan.executionOrder
            }
        }
    };
}

module.exports = { runDeepResearch, DEPTH_PRESETS };
