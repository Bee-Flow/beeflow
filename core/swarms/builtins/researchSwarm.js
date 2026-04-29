/**
 * Built-in swarm: Research Swarm
 *
 * Three parallel researcher workers tackle the user's request from different
 * angles, each with the full direct-chat tool stack (agent_search, KB lookup,
 * gmail/drive/calendar/notebook tools, MCP, …). A synthesiser worker then
 * reads the Hive Mind and writes the final answer streamed as ordinary
 * `content` events.
 *
 * Worker manifest is deterministic in v2; v3 swaps in a dynamic LLM planner
 * that derives the manifest from the user's actual message.
 */

const MANIFEST = {
    id: 'builtin:research_swarm',
    name: 'Research Swarm',
    icon: '/BeeFlow-logo-Icon-2026.svg',
    description: 'Three researchers work in parallel — each with the full direct-chat tool set — and a writer synthesises one answer.',
    bestFor: 'Open-ended questions where multiple angles or sources matter: market scans, briefings, post-drafting that needs source material.',
    notFor: 'Quick factual questions (use Fast or Flow), or short edits.',
    phases: [
        { id: 'research',  name: 'Researching', description: 'Three workers explore in parallel and write findings to the Hive Mind' },
        { id: 'synthesis', name: 'Writing',     description: 'A writer synthesises the Hive Mind into one final answer' },
    ],
};

// Researcher prompt template. Each researcher gets the same body but a
// different "angle" so the parallel workers actually diverge instead of
// duplicating each other's work.
function researcherPrompt({ angle }) {
    return [
        `You are a researcher inside a swarm. Your specific angle for this request is: **${angle}**.`,
        '',
        'Use the tools available — they are the same integrations the user has in direct chat (web search, knowledge base, gmail, calendar, drive, notebook, MCP servers, custom components, …). Pick whichever fit your angle.',
        '',
        'When you have enough material, stop calling tools and respond with a concise structured summary of your findings:',
        '  - Key facts / data points (with sources where you found them)',
        '  - Anything surprising or contradictory',
        '  - Gaps you couldn\'t fill in (so the writer can decide what to do about them)',
        '',
        'Keep your output focused on YOUR angle — don\'t try to write the final answer. The synthesiser worker does that.',
        'Cite sources inline when you have them: include URLs or document names so the writer can use them in the final answer.',
        'If you can\'t make progress on this angle (e.g. no relevant sources), say so honestly in 1–2 sentences and stop.',
    ].join('\n');
}

const SYNTHESISER_PROMPT = [
    'You are the synthesiser inside a swarm. Three researcher workers have already gathered material under different angles and written their findings into the Hive Mind (above this line, in the system prompt).',
    '',
    'Your job: produce the FINAL answer to the user\'s request, using the Hive Mind as your source material.',
    '',
    'Guidelines:',
    '  - Write as a single coherent voice, not a "committee report". The user asked one question; give one answer.',
    '  - When researchers found sources, cite them. When researchers said something failed or had gaps, write around the gap rather than hiding it.',
    '  - Match the user\'s language exactly (Dutch in / Dutch out, English in / English out).',
    '  - Match the user\'s requested format. If they asked for a LinkedIn post, return a LinkedIn post; if they asked for a list, return a list. Don\'t wrap your answer in meta-commentary about the swarm.',
    '  - You may use tools yourself if you need to fill a small gap (e.g. a final fact-check), but most of your work should be assembling the Hive Mind into a polished answer.',
].join('\n');

/**
 * v2: deterministic manifest — three angles + one synthesiser.
 * v3 swap-in point: replace this function with a planner that calls an LLM
 * to derive workers from the user message (mirroring sessionSkillRuntime's
 * bootstrapSessionSkills).
 */
async function getWorkerManifest({ message }) {
    const angles = [
        'Facts, data, and recent sources — what is objectively true about this topic?',
        'Context and stakeholders — who cares, what are the constraints, what is the practical situation?',
        'Risks, counterarguments, and gaps — where could the obvious answer be wrong or incomplete?',
    ];
    const researchers = angles.map((angle, idx) => ({
        id: `researcher_${idx + 1}`,
        role: 'researcher',
        name: `Researcher ${idx + 1}`,
        tier: 'thinking',
        systemPrompt: researcherPrompt({ angle }),
        toolAllowlist: [],   // empty = full directChat tool stack
    }));
    const synthesiser = {
        id: 'synthesiser',
        role: 'writer',
        name: 'Writer',
        tier: 'writer',
        systemPrompt: SYNTHESISER_PROMPT,
        toolAllowlist: [],   // can also use any tool if it needs to fact-check
    };
    return [
        { id: 'research', name: 'Researching', workers: researchers },
        { id: 'synthesis', name: 'Writing', workers: [synthesiser], synthesiser: true },
    ];
}

module.exports = { MANIFEST, getWorkerManifest };
