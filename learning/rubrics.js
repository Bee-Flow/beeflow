// Server-side rubric catalog for Learning Center exercises.
//
// The rubric for each exercise lives HERE, never on the client — so it can't leak
// to learners and an unknown exerciseId can't turn the coach endpoint into a free
// LLM. The frontend exercise step only carries an `exerciseId`; the coach endpoint
// (server/routes/ai/learning.js) looks the rubric up here when grading.
//
// Each rubric:
//   title       — short label (logs only)
//   task        — what the learner was asked to do (given to the grader)
//   criteria    — the concrete things a strong answer must show
//   passScore   — 0–100 threshold the grader uses for `passed`
//   guidance    — extra grading notes for the tutor (tone, common traps)

const RUBRICS = {
    'ex-basics-specific': {
        title: 'Make a vague prompt specific',
        task: 'Rewrite the weak prompt "write something about our new feature" into a strong prompt that includes context, a specific task, and the desired output format.',
        criteria: [
            'Adds context (who is writing, for which audience, or about what product/feature)',
            'States a specific, unambiguous task (not just "write something")',
            'Specifies an output format, length, or tone',
        ],
        passScore: 70,
        guidance: 'Reward prompts that a model could act on with little guessing. A prompt missing all context or still vague ("write a post about the feature") should score below pass.',
    },
    'ex-context-add': {
        title: 'Add context to a bare task',
        task: 'Take the bare task "suggest three blog post ideas" and add real context — the writer\'s role, the target audience, and the goal — so the ideas come back on-target.',
        criteria: [
            'Names the writer\'s role or company/product',
            'Names the target audience the ideas are for',
            'States a goal or outcome the ideas should drive toward',
        ],
        passScore: 70,
        guidance: 'The point of this exercise is context, not formatting. Reward concrete, specific context (a real-sounding audience and goal). Generic filler ("for everyone, to be helpful") should not pass.',
    },
    'ex-structure-format': {
        title: 'Specify a precise output format',
        task: 'Write a prompt that asks the model to compare three project-management tools and pins down the output format precisely (e.g. a table, named columns, a row/length limit, and a tone).',
        criteria: [
            'Defines a clear structure (e.g. a table or a fixed number of bullets)',
            'Specifies the columns/fields or what each item must contain',
            'Constrains length and/or tone (e.g. cell word limit, neutral tone)',
        ],
        passScore: 70,
        guidance: 'Reward prompts where the output shape is unambiguous. A prompt that just says "compare three tools" with no format constraints should score below pass.',
    },
    'ex-iterating-refine': {
        title: 'Write a targeted follow-up',
        task: 'The model produced a product description that is accurate but generic, too long, and salesy. Write the single follow-up message that would fix it.',
        criteria: [
            'Targets the specific problems (length, generic content, salesy tone)',
            'Gives concrete, actionable direction (a length target, words to drop, a benefit to lead with)',
            'Is a refinement of the existing answer, not a full restart from scratch',
        ],
        passScore: 70,
        guidance: 'Reward a crisp follow-up that a model could immediately act on. Vague feedback like "make it better" should score low. The learner does NOT need to rewrite the description themselves — just steer the next turn.',
    },
    'ex-system-prompt': {
        title: 'Write an agent system prompt',
        task: 'Write a system prompt for a custom agent. It should define the agent\'s role, its tone, and clear rules for what it should always and never do.',
        criteria: [
            'Defines a clear role / identity for the agent (who it is, what it helps with)',
            'Specifies a tone or style of response',
            'States at least one explicit rule — something it should always do and/or never do',
        ],
        passScore: 70,
        guidance: 'Reward a prompt that would actually shape an agent\'s behaviour. A one-line "be helpful" with no role, tone, or rules should score below pass. The agent\'s topic can be anything the learner chooses.',
    },
    'ex-advanced-technique': {
        title: 'Apply an advanced technique',
        task: 'Write a prompt that visibly uses few-shot examples OR an explicit step-by-step plan to get a hard task right.',
        criteria: [
            'Clearly applies an advanced technique (one or more worked input→output examples, or an explicit "think step by step / plan first" instruction)',
            'The technique is appropriate for the task and would plausibly improve the result',
            'The prompt is specific enough that the model could follow it',
        ],
        passScore: 70,
        guidance: 'Reward a genuine, well-formed use of few-shot or step-by-step prompting. Simply saying "use advanced techniques" without actually demonstrating one should not pass.',
    },
    'ex-automation-brief': {
        title: 'Brief an automation',
        task: 'Describe an automation you would actually use, in plain English: when it should run (the trigger), what data it works with, what should happen with it, and where the result goes.',
        criteria: [
            'Names a concrete trigger (a schedule, a webhook, or an app event — not just "automatically")',
            'Names the data or source the automation works with',
            'Describes the work to be done specifically enough to act on (steps, conditions, or AI processing)',
            'States where the result lands or who gets notified',
        ],
        passScore: 70,
        guidance: 'Reward a brief a builder could implement without follow-up questions. "Automate my reports" or any description missing the trigger or destination should score below pass. Conditions ("skip when empty") are a plus, not a requirement.',
    },
    'ex-admin-rollout': {
        title: 'Plan a feature rollout',
        task: 'Write a short rollout plan for introducing a new Bee Flow capability to an organisation: who pilots it first, how success is checked, and how it expands from there.',
        criteria: [
            'Starts with a small, named pilot group rather than enabling for everyone at once',
            'Includes a concrete way to evaluate the pilot (usage monitoring, run history, or collected feedback)',
            'Describes how and when access expands beyond the pilot',
        ],
        passScore: 70,
        guidance: 'Reward staged, verifiable plans. "Turn it on for everyone and see what happens" should score below pass. Mentioning training or pointing users at the Academy is a plus, not a requirement.',
    },
};

function getRubric(exerciseId) {
    return RUBRICS[exerciseId] || null;
}

module.exports = { RUBRICS, getRubric };
