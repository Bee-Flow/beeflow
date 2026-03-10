/**
 * Sequential Thinking Tool — Shared module for normal + terminal agents
 *
 * Ported from the MCP sequential-thinking-server (sequentialthinking/).
 * Provides an OpenAI function-calling tool definition and an executor
 * that tracks thought history per session.
 */

// ─── Per-session state ──────────────────────────────────────────
// Key = sessionId (e.g. agentId + conversationId), value = { history, branches }
const sessions = new Map();

function getSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { history: [], branches: {} });
    }
    return sessions.get(sessionId);
}

function clearSession(sessionId) {
    sessions.delete(sessionId);
}

// ─── Tool Definition (OpenAI function-calling format) ───────────
const SEQUENTIAL_THINKING_TOOL = {
    type: 'function',
    function: {
        name: 'sequentialthinking',
        description: `A tool for structured problem-solving through compact sequential thoughts.

CRITICAL: Each thought MUST be concise — 1-2 sentences max. Be direct and to the point. No filler, no elaboration, no repeating yourself. Think of each thought as a brief bullet point, not a paragraph.

When to use:
- Breaking down complex problems into steps
- Planning and design with room for revision
- Problems where the full scope isn't clear initially

Rules:
1. Keep each thought SHORT (1-2 sentences, under 100 words)
2. Each thought should add new insight, not restate previous ones
3. Use the minimum number of thoughts needed — don't pad
4. Adjust totalThoughts down if you finish early
5. Only set nextThoughtNeeded to false when truly done
6. Branch or revise only when genuinely changing direction`,
        parameters: {
            type: 'object',
            properties: {
                thought: {
                    type: 'string',
                    description: 'Your current thinking step — keep it to 1-2 concise sentences'
                },
                nextThoughtNeeded: {
                    type: 'boolean',
                    description: 'Whether another thought step is needed'
                },
                thoughtNumber: {
                    type: 'integer',
                    description: 'Current thought number (1-based)'
                },
                totalThoughts: {
                    type: 'integer',
                    description: 'Estimated total thoughts needed (can be adjusted)'
                },
                isRevision: {
                    type: 'boolean',
                    description: 'Whether this revises previous thinking'
                },
                revisesThought: {
                    type: 'integer',
                    description: 'Which thought number is being reconsidered'
                },
                branchFromThought: {
                    type: 'integer',
                    description: 'Branching point thought number'
                },
                branchId: {
                    type: 'string',
                    description: 'Branch identifier'
                },
                needsMoreThoughts: {
                    type: 'boolean',
                    description: 'If more thoughts are needed beyond the current total'
                }
            },
            required: ['thought', 'nextThoughtNeeded', 'thoughtNumber', 'totalThoughts']
        }
    }
};

// ─── Executor ───────────────────────────────────────────────────
/**
 * Process a single thought step.
 *
 * @param {object}  args      - Tool arguments from the LLM
 * @param {string} [sessionId] - Optional session key for multi-turn tracking
 * @returns {string} JSON result string
 */
function executeSequentialThinking(args, sessionId = 'default') {
    try {
        const session = getSession(sessionId);

        // Auto-adjust totalThoughts if we've gone past it
        if (args.thoughtNumber > args.totalThoughts) {
            args.totalThoughts = args.thoughtNumber;
        }

        // Record the thought
        session.history.push({
            thought: args.thought,
            thoughtNumber: args.thoughtNumber,
            totalThoughts: args.totalThoughts,
            nextThoughtNeeded: args.nextThoughtNeeded,
            isRevision: args.isRevision || false,
            revisesThought: args.revisesThought,
            branchFromThought: args.branchFromThought,
            branchId: args.branchId,
            needsMoreThoughts: args.needsMoreThoughts
        });

        // Track branches
        if (args.branchFromThought && args.branchId) {
            if (!session.branches[args.branchId]) {
                session.branches[args.branchId] = [];
            }
            session.branches[args.branchId].push(session.history[session.history.length - 1]);
        }

        // Build prefix for logging
        let prefix = '💭 Thought';
        if (args.isRevision) prefix = '🔄 Revision';
        else if (args.branchFromThought) prefix = '🌿 Branch';

        console.log(`[SequentialThinking] ${prefix} ${args.thoughtNumber}/${args.totalThoughts}: ${args.thought.substring(0, 120)}...`);

        const result = {
            thoughtNumber: args.thoughtNumber,
            totalThoughts: args.totalThoughts,
            nextThoughtNeeded: args.nextThoughtNeeded,
            thought: args.thought,
            branches: Object.keys(session.branches),
            thoughtHistoryLength: session.history.length
        };

        // When thinking is complete, include full thought chain so the model
        // can reference its reasoning when composing the final response
        if (!args.nextThoughtNeeded) {
            result.allThoughts = session.history.map(t =>
                `Step ${t.thoughtNumber}: ${t.thought}`
            ).join('\n');
            result.instruction = 'Thinking complete. Use the reasoning above to craft your response.';
            clearSession(sessionId);
        }

        return JSON.stringify(result, null, 2);
    } catch (error) {
        return JSON.stringify({
            error: error.message || String(error),
            status: 'failed'
        }, null, 2);
    }
}

module.exports = {
    SEQUENTIAL_THINKING_TOOL,
    executeSequentialThinking,
    clearSession
};
