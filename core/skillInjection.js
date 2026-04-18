/**
 * Skill injection — shared logic for resolving active/attached skills into
 * a system-prompt addendum + an optional on-demand tool registration.
 *
 * Split behavior:
 *   - Static skills (dynamic_activation = false): full body injected into the
 *     system prompt on every turn (the original behavior).
 *   - Dynamic skills (dynamic_activation = true): only a 1-line manifest entry
 *     injected. The AI calls `activate_skill` to pull the full body into the
 *     conversation when it's actually relevant. Saves tokens when an agent
 *     has many skills attached but only a few apply per message.
 */

const skillStore = require('../stores/skillStore');

const SKILL_CAP = 5;
const ACTIVATE_SKILL_TOOL_NAME = 'activate_skill';

/**
 * Resolve merged skill ids into prompt text + tool registration data.
 *
 * @param {Object}   opts
 * @param {string[]} opts.sessionSkillIds  — user-toggled skills (activeSkillIds)
 * @param {string[]} opts.attachedSkillIds — agent.config.attachedSkillIds
 * @param {string}   opts.orgId
 * @param {string}   opts.userId
 * @returns {Promise<{
 *   systemPromptAddendum: string,
 *   tools: Array,
 *   dynamicSkillIds: string[],
 *   staticCount: number,
 * }>}
 */
async function buildSkillInjection({ sessionSkillIds = [], attachedSkillIds = [], orgId, userId }) {
    if (!orgId) return { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], staticCount: 0 };

    // Merge: attached first (so they survive the cap), then session-only
    const seen = new Set();
    const mergedIds = [];
    for (const id of [...attachedSkillIds, ...sessionSkillIds]) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        mergedIds.push(id);
        if (mergedIds.length >= SKILL_CAP) break;
    }
    if (mergedIds.length === 0) return { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], staticCount: 0 };

    let skills;
    try {
        skills = await skillStore.getSkillsByIds(mergedIds, orgId, userId);
    } catch (err) {
        console.warn('[skillInjection] getSkillsByIds failed:', err.message);
        return { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], staticCount: 0 };
    }
    if (!skills || skills.length === 0) return { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], staticCount: 0 };

    const staticSkills = skills.filter(s => !s.dynamicActivation);
    const dynamicSkills = skills.filter(s => s.dynamicActivation);

    let addendum = '';

    if (staticSkills.length > 0) {
        const blocks = staticSkills.map(s => {
            let b = `\n### SKILL — "${s.name}"`;
            if (s.instructions) b += `\nInstructions: ${s.instructions}`;
            if (s.workflow)     b += `\nWorkflow: ${s.workflow}`;
            if (s.rules)        b += `\nRules: ${s.rules}`;
            if (s.examples)     b += `\nExamples: ${s.examples}`;
            return b;
        }).join('\n');
        addendum += `\n\n[ACTIVE SKILLS]\nThe user has activated the following skills. Follow their instructions precisely when the task matches.${blocks}`;
    }

    const tools = [];
    if (dynamicSkills.length > 0) {
        const manifest = dynamicSkills
            .map(s => `- ${s.id} · ${s.name} — ${s.description || '(no description)'}`)
            .join('\n');
        addendum += `\n\n[AVAILABLE SKILLS — ON DEMAND]\nThese skills are available but not yet loaded. Their full instructions cost tokens, so only load what you need.\nWhen a user request matches one or more of these skills, call the \`${ACTIVATE_SKILL_TOOL_NAME}\` tool with the matching skill id(s) BEFORE replying. Do NOT call it speculatively. Once loaded within a conversation, the full instructions stay in context — don't call the tool again for the same skill.\n${manifest}`;

        tools.push({
            type: 'function',
            function: {
                name: ACTIVATE_SKILL_TOOL_NAME,
                description: 'Load the full instructions, workflow, rules, and examples for one or more skills listed under [AVAILABLE SKILLS — ON DEMAND]. Only call this when the user\'s request matches one of the listed skills. After this returns, follow the loaded skill\'s guidance for the rest of the conversation.',
                parameters: {
                    type: 'object',
                    properties: {
                        skill_ids: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Array of skill ids (UUIDs) from the manifest to load.',
                        },
                    },
                    required: ['skill_ids'],
                },
            },
        });
    }

    return {
        systemPromptAddendum: addendum,
        tools,
        dynamicSkillIds: dynamicSkills.map(s => s.id),
        staticCount: staticSkills.length,
    };
}

/**
 * Handler invoked when the model calls `activate_skill`. Returns a string
 * that the dispatcher feeds back as the tool result; the model then has the
 * full skill bodies available in conversation context for subsequent turns.
 */
async function executeActivateSkill({ args, orgId, userId }) {
    const ids = Array.isArray(args?.skill_ids) ? args.skill_ids.filter(Boolean) : [];
    if (ids.length === 0) return 'No skill_ids provided.';
    if (!orgId) return 'Cannot load skills without an organization context.';

    let skills;
    try {
        skills = await skillStore.getSkillsByIds(ids, orgId, userId);
    } catch (err) {
        return `Failed to load skills: ${err.message}`;
    }
    if (!skills || skills.length === 0) {
        return `None of the requested skill ids were found or accessible: ${ids.join(', ')}`;
    }

    const blocks = skills.map(s => {
        let b = `### SKILL — "${s.name}" (id: ${s.id})`;
        if (s.description)  b += `\n${s.description}`;
        if (s.instructions) b += `\n\nInstructions:\n${s.instructions}`;
        if (s.workflow)     b += `\n\nWorkflow:\n${s.workflow}`;
        if (s.rules)        b += `\n\nRules:\n${s.rules}`;
        if (s.examples)     b += `\n\nExamples:\n${s.examples}`;
        return b;
    }).join('\n\n---\n\n');

    const missing = ids.filter(id => !skills.some(s => s.id === id));
    const missingNote = missing.length > 0
        ? `\n\n(Note: ${missing.length} id(s) not found or not accessible: ${missing.join(', ')})`
        : '';

    return `Loaded ${skills.length} skill(s). Follow their guidance from this point on — you do NOT need to call activate_skill again for these in this conversation.\n\n${blocks}${missingNote}`;
}

module.exports = {
    buildSkillInjection,
    executeActivateSkill,
    ACTIVATE_SKILL_TOOL_NAME,
    SKILL_CAP,
};
