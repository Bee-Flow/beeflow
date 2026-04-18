/**
 * Session Skill Runtime
 *
 * Chat-local (ephemeral) skills for direct chat.
 * - Generated once per conversation (standard tier bootstrap).
 * - Stored in direct_conversations.meta_json (not in global skill library).
 * - Activated dynamically to reduce token usage.
 * - Optionally publishable to the persistent skill library on user request.
 */

const crypto = require('crypto');
const skillStore = require('../stores/skillStore');

const ACTIVATE_SESSION_SKILL_TOOL_NAME = 'activate_session_skill';
const PUBLISH_SESSION_SKILL_TOOL_NAME = 'publish_session_skill_to_library';
const MAX_SESSION_SKILLS = 5;

function stripCodeFences(text) {
    if (typeof text !== 'string') return '';
    const t = text.trim();
    const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return (m ? m[1] : t).trim();
}

function sanitizeText(v, max = 4000) {
    if (typeof v !== 'string') return '';
    return v.trim().slice(0, max);
}

function normalizeSessionSkill(raw, idx = 0) {
    if (!raw || typeof raw !== 'object') return null;
    const name = sanitizeText(raw.name, 120) || `Session Skill ${idx + 1}`;
    const description = sanitizeText(raw.description, 300);
    const instructions = sanitizeText(raw.instructions, 3000);
    const workflow = sanitizeText(raw.workflow, 3000);
    const rules = sanitizeText(raw.rules, 3000);
    const examples = sanitizeText(raw.examples, 3000);
    return {
        id: raw.id && typeof raw.id === 'string' ? raw.id : `sess_${crypto.randomUUID()}`,
        name,
        description,
        instructions,
        workflow,
        rules,
        examples,
        dynamicActivation: raw.dynamicActivation !== false, // default true for token savings
    };
}

function parseSkillPayload(rawText) {
    const txt = stripCodeFences(rawText);
    if (!txt) return [];
    const parsed = JSON.parse(txt);
    const arr = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed.skills) ? parsed.skills : []);
    return arr
        .slice(0, MAX_SESSION_SKILLS)
        .map((s, i) => normalizeSessionSkill(s, i))
        .filter(Boolean);
}

async function bootstrapSessionSkills({
    adapter,
    apiKey,
    apiUrl,
    modelId,
    message,
    timezone = 'UTC',
    apiVersion,
}) {
    const seed = typeof message === 'string' && message.trim()
        ? message.trim()
        : 'No explicit user text was provided. Derive broadly useful session skills from context.';

    const bootstrapMessages = [
        {
            role: 'system',
            content: [
                'You create chat-local skills for one direct-chat conversation.',
                'Return ONLY valid JSON (no prose, no markdown fences).',
                `Return an array with 2 to ${MAX_SESSION_SKILLS} objects, each with:`,
                'name, description, instructions, workflow, rules, examples, dynamicActivation',
                'Keep each field concise and practical.',
                'Set dynamicActivation=true unless always-needed instructions are critical.',
                'Do not mention tools that are not guaranteed to exist.',
            ].join('\n'),
        },
        {
            role: 'user',
            content: `User request:\n${seed}\n\nUser timezone: ${timezone}`,
        },
    ];

    const result = await adapter.chat(apiKey, apiUrl, modelId, bootstrapMessages, {
        maxTokens: 2000,
        temperature: 0.2,
        apiVersion: apiVersion || undefined,
    });

    const skills = parseSkillPayload(result?.content || '');
    if (skills.length > 0) return skills;

    // Safe fallback: one generic dynamic skill
    return [{
        id: `sess_${crypto.randomUUID()}`,
        name: 'Task Execution',
        description: 'Focuses on turning user requests into direct, structured outcomes.',
        instructions: 'Answer directly, prioritize execution, and avoid filler.',
        workflow: 'Clarify goal -> execute steps -> verify output -> provide concise result.',
        rules: 'Be specific, actionable, and accurate.',
        examples: 'If asked for a plan, provide numbered concrete steps with assumptions.',
        dynamicActivation: true,
    }];
}

function buildSessionSkillInjection({ sessionSkills = [], activatedSkillIds = [] }) {
    if (!Array.isArray(sessionSkills) || sessionSkills.length === 0) {
        return { systemPromptAddendum: '', tools: [] };
    }
    const activated = new Set(Array.isArray(activatedSkillIds) ? activatedSkillIds : []);
    const active = sessionSkills.filter(s => activated.has(s.id));
    const inactive = sessionSkills.filter(s => !activated.has(s.id));

    let addendum = '\n\n[CHAT-LOCAL SKILLS]\nThese skills are valid only for this direct chat conversation.';

    if (inactive.length > 0) {
        const manifest = inactive
            .map(s => `- ${s.id} · ${s.name} — ${s.description || '(no description)'}`)
            .join('\n');
        addendum += `\n\n[AVAILABLE ON DEMAND]\nActivate only when relevant to the current user request. Call \`${ACTIVATE_SESSION_SKILL_TOOL_NAME}\` before replying when needed.\n${manifest}`;
    }

    if (active.length > 0) {
        const blocks = active.map(s => {
            let b = `### SESSION SKILL — "${s.name}" (id: ${s.id})`;
            if (s.description) b += `\n${s.description}`;
            if (s.instructions) b += `\nInstructions:\n${s.instructions}`;
            if (s.workflow) b += `\nWorkflow:\n${s.workflow}`;
            if (s.rules) b += `\nRules:\n${s.rules}`;
            if (s.examples) b += `\nExamples:\n${s.examples}`;
            return b;
        }).join('\n\n---\n\n');
        addendum += `\n\n[ACTIVE CHAT-LOCAL SKILLS]\n${blocks}`;
    }

    addendum += `\n\nIf the user asks to save one of these skills permanently, call \`${PUBLISH_SESSION_SKILL_TOOL_NAME}\`.`;

    const tools = [
        {
            type: 'function',
            function: {
                name: ACTIVATE_SESSION_SKILL_TOOL_NAME,
                description: 'Load full chat-local skill instructions for one or more session skill ids before answering.',
                parameters: {
                    type: 'object',
                    properties: {
                        skill_ids: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Session skill ids to activate for this conversation.',
                        },
                    },
                    required: ['skill_ids'],
                },
            },
        },
        {
            type: 'function',
            function: {
                name: PUBLISH_SESSION_SKILL_TOOL_NAME,
                description: 'Publish one chat-local session skill to the persistent skill library when the user explicitly asks.',
                parameters: {
                    type: 'object',
                    properties: {
                        skill_id: { type: 'string', description: 'Session skill id to publish.' },
                        name: { type: 'string', description: 'Optional override name in skill library.' },
                        is_shared: { type: 'boolean', description: 'Whether to share with the whole organisation.' },
                        dynamic_activation: { type: 'boolean', description: 'Keep dynamic activation in the skill library. Default true.' },
                    },
                    required: ['skill_id'],
                },
            },
        },
    ];

    return { systemPromptAddendum: addendum, tools };
}

async function executeActivateSessionSkill({ args, sessionSkills = [], activatedSkillIds = [] }) {
    const ids = Array.isArray(args?.skill_ids) ? args.skill_ids.filter(Boolean) : [];
    if (ids.length === 0) return { error: 'No skill_ids provided.' };

    const byId = new Map((sessionSkills || []).map(s => [s.id, s]));
    const loaded = ids.map(id => byId.get(id)).filter(Boolean);
    if (loaded.length === 0) return { error: 'No matching session skills found for the requested ids.' };

    const mergedActivated = Array.from(new Set([...(activatedSkillIds || []), ...loaded.map(s => s.id)]));
    const blocks = loaded.map(s => {
        let b = `### SESSION SKILL — "${s.name}" (id: ${s.id})`;
        if (s.description) b += `\n${s.description}`;
        if (s.instructions) b += `\n\nInstructions:\n${s.instructions}`;
        if (s.workflow) b += `\n\nWorkflow:\n${s.workflow}`;
        if (s.rules) b += `\n\nRules:\n${s.rules}`;
        if (s.examples) b += `\n\nExamples:\n${s.examples}`;
        return b;
    }).join('\n\n---\n\n');

    return {
        success: true,
        activatedSkillIds: mergedActivated,
        content: `Loaded ${loaded.length} session skill(s). Follow them from this point in this conversation.\n\n${blocks}`,
    };
}

async function executePublishSessionSkill({
    args,
    sessionSkills = [],
    orgId,
    userId,
}) {
    const skillId = typeof args?.skill_id === 'string' ? args.skill_id : '';
    if (!skillId) return { error: 'skill_id is required.' };
    if (!orgId || !userId) return { error: 'Cannot publish skill without authenticated org/user context.' };

    const src = (sessionSkills || []).find(s => s.id === skillId);
    if (!src) return { error: `Session skill not found: ${skillId}` };

    const created = await skillStore.createSkill({
        orgId,
        userId,
        name: sanitizeText(args?.name, 120) || src.name,
        description: src.description || '',
        instructions: src.instructions || '',
        workflow: src.workflow || '',
        rules: src.rules || '',
        examples: src.examples || '',
        icon: '⚡',
        isShared: args?.is_shared === true,
        dynamicActivation: args?.dynamic_activation !== false,
    });

    return {
        success: true,
        librarySkillId: created.id,
        message: `Session skill "${src.name}" was published to the skill library.`,
    };
}

module.exports = {
    ACTIVATE_SESSION_SKILL_TOOL_NAME,
    PUBLISH_SESSION_SKILL_TOOL_NAME,
    bootstrapSessionSkills,
    buildSessionSkillInjection,
    executeActivateSessionSkill,
    executePublishSessionSkill,
};

