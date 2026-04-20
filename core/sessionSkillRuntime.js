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
    // Pipeline sequencing: `order` is a 1-based step number the bootstrap
    // assigned; `dependsOn` lists skill ids that must be activated first.
    // Both are enforced server-side in executeActivateSessionSkill.
    const orderNum = Number.isFinite(raw.order) ? Math.max(1, Math.round(raw.order)) : (idx + 1);
    const dependsOn = Array.isArray(raw.dependsOn)
        ? raw.dependsOn.filter(d => typeof d === 'string' && d.length > 0).slice(0, 10)
        : [];
    return {
        id: raw.id && typeof raw.id === 'string' ? raw.id : `sess_${crypto.randomUUID()}`,
        name,
        description,
        instructions,
        workflow,
        rules,
        examples,
        order: orderNum,
        dependsOn,
        dynamicActivation: raw.dynamicActivation !== false, // default true for token savings
    };
}

// Resolve `dependsOn` strings (LLM-supplied — typically names) into canonical
// skill ids belonging to the same batch. Drops any reference that doesn't
// match a sibling skill's id or name. Runs after all ids are assigned so
// cross-references resolve cleanly.
// Return the ids of every skill at the lowest `order` value — i.e. the
// entry points of the pipeline (no dependencies, step 1). We auto-activate
// these on bootstrap so the first-turn system prompt actually carries the
// full Instructions body. Without this the AI can (and in the wild, does)
// answer using only the short manifest, making the pipeline decorative.
function initialActivatedSkillIds(skills) {
    if (!Array.isArray(skills) || skills.length === 0) return [];
    const minOrder = skills.reduce((m, s) => {
        const o = Number.isFinite(s?.order) ? s.order : Infinity;
        return o < m ? o : m;
    }, Infinity);
    if (!Number.isFinite(minOrder)) return [];
    // Step-1 skills should also have no unmet deps; filter defensively.
    return skills
        .filter(s => s && s.order === minOrder && (!Array.isArray(s.dependsOn) || s.dependsOn.length === 0))
        .map(s => s.id);
}

function resolveDependencies(skills) {
    if (!Array.isArray(skills) || skills.length === 0) return skills;
    const byKey = new Map();
    for (const s of skills) {
        if (s.id) byKey.set(s.id, s.id);
        if (s.name) byKey.set(s.name.toLowerCase(), s.id);
    }
    const resolved = skills.map(s => ({
        ...s,
        dependsOn: (s.dependsOn || [])
            .map(dep => byKey.get(dep) || byKey.get(typeof dep === 'string' ? dep.toLowerCase() : '') || null)
            .filter(id => id && id !== s.id),   // never self-depend
    }));

    // Topo-sort; any skill that can never be scheduled is part of a cycle.
    // Break the cycle by emptying its dependsOn and logging — better to run
    // the skill in the wrong order than to permanently brick the pipeline.
    const inDegree = new Map(resolved.map(s => [s.id, (s.dependsOn || []).length]));
    const graph = new Map(resolved.map(s => [s.id, []]));
    for (const s of resolved) {
        for (const dep of s.dependsOn || []) {
            if (graph.has(dep)) graph.get(dep).push(s.id);
        }
    }
    const queue = [];
    for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
    const visited = new Set();
    while (queue.length) {
        const id = queue.shift();
        visited.add(id);
        for (const next of graph.get(id) || []) {
            inDegree.set(next, inDegree.get(next) - 1);
            if (inDegree.get(next) === 0) queue.push(next);
        }
    }
    if (visited.size < resolved.length) {
        const cyclic = resolved.filter(s => !visited.has(s.id)).map(s => s.name || s.id);
        console.warn(`[sessionSkillRuntime] Cyclic dependency detected, breaking cycle for: ${cyclic.join(', ')}`);
        return resolved.map(s => visited.has(s.id) ? s : { ...s, dependsOn: [] });
    }
    return resolved;
}

function parseSkillPayload(rawText) {
    const txt = stripCodeFences(rawText);
    if (!txt) return [];
    let parsed;
    try {
        parsed = JSON.parse(txt);
    } catch (_) {
        // Malformed JSON — return [] so the caller can pick up the fallback
        // path instead of crashing the request.
        return [];
    }
    const arr = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.skills) ? parsed.skills : []);
    const normalized = arr
        .slice(0, MAX_SESSION_SKILLS)
        .map((s, i) => normalizeSessionSkill(s, i))
        .filter(Boolean);
    return resolveDependencies(normalized);
}

function formatUserContext(userContext) {
    if (!userContext || typeof userContext !== 'object') return '';
    const parts = [];
    if (userContext.language) parts.push(`User language: ${userContext.language}`);
    if (userContext.role) parts.push(`User role: ${userContext.role}`);
    if (userContext.orgName) {
        parts.push(userContext.orgTagline
            ? `Organization: ${userContext.orgName} (${userContext.orgTagline})`
            : `Organization: ${userContext.orgName}`);
    }
    return parts.length > 0 ? parts.join(' · ') : '';
}

async function bootstrapSessionSkills({
    adapter,
    apiKey,
    apiUrl,
    modelId,
    message,
    timezone = 'UTC',
    apiVersion,
    userContext = null,
}) {
    const seed = typeof message === 'string' && message.trim()
        ? message.trim()
        : 'No explicit user text was provided. Derive broadly useful session skills from context.';

    const ctxLine = formatUserContext(userContext);

    const bootstrapMessages = [
        {
            role: 'system',
            content: [
                'You create chat-local skills for one direct-chat conversation.',
                'Return ONLY valid JSON (no prose, no markdown fences).',
                `Return an array with 2 to ${MAX_SESSION_SKILLS} objects, each with:`,
                'name, description, instructions, workflow, rules, examples, dynamicActivation, order, dependsOn',
                '',
                'IMPORTANT — skills form an ORDERED PIPELINE enforced by the server:',
                '  "order"     — 1-based step number (1, 2, 3, ...). Lowest order runs first.',
                '  "dependsOn" — array of PRIOR skill names (exact match) that must finish before',
                '                this skill becomes activatable. Use [] for the first step.',
                '  The runtime REFUSES to activate a skill whose dependencies are not yet active.',
                '  Design the chain so each skill produces what the next one needs.',
                '',
                'Keep each field concise and practical.',
                'Set dynamicActivation=true unless always-needed instructions are critical.',
                'Tailor wording, language, and examples to the user/org context if provided.',
                'Do not mention tools that are not guaranteed to exist.',
            ].join('\n'),
        },
        {
            role: 'user',
            content: [
                `User request:\n${seed}`,
                `User timezone: ${timezone}`,
                ctxLine ? `Context: ${ctxLine}` : '',
            ].filter(Boolean).join('\n\n'),
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

/**
 * Given the pipeline + the set of activated skill ids, derive which activated
 * skills should be considered "completed". A skill counts as completed when:
 *   - it's activated AND has ≥1 downstream skill that's also activated
 *     (the pipeline has moved past it), OR
 *   - it's activated AND is a terminal node (no one depends on it) —
 *     reaching it means the pipeline's work is done.
 * Pure function, no storage. Caller decides what to do with the result.
 */
function deriveCompletedSkillIds(sessionSkills, activatedSkillIds) {
    if (!Array.isArray(sessionSkills) || sessionSkills.length === 0) return [];
    const activated = new Set(Array.isArray(activatedSkillIds) ? activatedSkillIds : []);
    if (activated.size === 0) return [];
    // Build reverse-dep map: for each skill id, list ids of skills that depend on it.
    const downstream = new Map(sessionSkills.map(s => [s.id, []]));
    for (const s of sessionSkills) {
        for (const dep of s.dependsOn || []) {
            if (downstream.has(dep)) downstream.get(dep).push(s.id);
        }
    }
    const terminals = new Set(sessionSkills.filter(s => (downstream.get(s.id) || []).length === 0).map(s => s.id));
    const completed = [];
    for (const s of sessionSkills) {
        if (!activated.has(s.id)) continue;
        const down = downstream.get(s.id) || [];
        const hasActiveDownstream = down.some(id => activated.has(id));
        if (hasActiveDownstream || terminals.has(s.id)) completed.push(s.id);
    }
    return completed;
}

function buildSessionSkillInjection({ sessionSkills = [], activatedSkillIds = [], compactMode = false }) {
    if (!Array.isArray(sessionSkills) || sessionSkills.length === 0) {
        return { systemPromptAddendum: '', tools: [] };
    }
    const activated = new Set(Array.isArray(activatedSkillIds) ? activatedSkillIds : []);
    const completed = new Set(deriveCompletedSkillIds(sessionSkills, activatedSkillIds));
    // Sort by order so the LLM sees the pipeline in step sequence, not insertion order.
    const ordered = [...sessionSkills].sort((a, b) => (a.order || 0) - (b.order || 0));
    // Activated skills split into "still-in-focus" (full body) and "completed"
    // (one-line trailer only — saves tokens once the pipeline moves past them).
    const activeInFocus = ordered.filter(s => activated.has(s.id) && !completed.has(s.id));
    const completedList = ordered.filter(s => completed.has(s.id));
    const inactive = ordered.filter(s => !activated.has(s.id));
    const byId = new Map(ordered.map(s => [s.id, s]));

    let addendum = '\n\n[CHAT-LOCAL SKILLS — ORDERED PIPELINE]\nThese skills form a dependency-enforced pipeline for this direct chat. Each skill has a step number. Activate them in order — the runtime REFUSES to activate a skill whose dependencies are not yet active. Step-1 skills are already activated for you; for any later step whose work you need, YOU MUST call `' + ACTIVATE_SESSION_SKILL_TOOL_NAME + '` BEFORE producing user-facing output that relies on it. Without activation you only have the short description; your answer will be generic.';

    if (inactive.length > 0) {
        const manifest = inactive.map(s => {
            const unmet = (s.dependsOn || []).filter(depId => !activated.has(depId));
            const depNames = unmet.map(id => byId.get(id)?.name || id);
            const status = unmet.length === 0 ? 'READY' : `BLOCKED by: ${depNames.join(', ')}`;
            return `- [step ${s.order}] ${s.id} · ${s.name} — ${s.description || '(no description)'}  (${status})`;
        }).join('\n');
        addendum += `\n\n[AVAILABLE ON DEMAND]\nActivate the next READY skill when its step is relevant. Call \`${ACTIVATE_SESSION_SKILL_TOOL_NAME}\` before replying.\n${manifest}`;
    }

    if (activeInFocus.length > 0) {
        if (compactMode) {
            // Conversation was compacted; the active skill bodies have already
            // shaped the summary. Don't re-pay for them every turn — list as a
            // one-liner; the model can reload any via the activate tool.
            const lines = activeInFocus
                .map(s => `- [step ${s.order}] ${s.name} (active — body elided; call activate_session_skill to reload)`)
                .join('\n');
            addendum += `\n\n[ACTIVE CHAT-LOCAL SKILLS — bodies elided after compaction]\n${lines}`;
        } else {
            const blocks = activeInFocus.map(s => {
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
    }

    // Completed skills — work is done, full body dropped, one-line trailer so
    // the model still knows the pipeline context without re-paying the tokens.
    if (completedList.length > 0) {
        const lines = completedList
            .map(s => `- [step ${s.order}] ${s.name} ✓`)
            .join('\n');
        addendum += `\n\n[COMPLETED STEPS — work already done in this conversation]\n${lines}`;
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
    const requested = ids.map(id => byId.get(id)).filter(Boolean);
    if (requested.length === 0) return { error: 'No matching session skills found for the requested ids.' };

    // Enforce the ordered pipeline. Process the requested list in step order
    // and accumulate activations so batch activations of a valid prefix chain
    // succeed in one call. The first skill whose deps aren't met aborts the
    // whole call — partial success is confusing for the model.
    const sortedReq = [...requested].sort((a, b) => (a.order || 0) - (b.order || 0));
    const runningActivated = new Set(Array.isArray(activatedSkillIds) ? activatedSkillIds : []);
    const loaded = [];
    for (const s of sortedReq) {
        if (runningActivated.has(s.id)) { loaded.push(s); continue; }
        const unmet = (s.dependsOn || []).filter(dep => !runningActivated.has(dep));
        if (unmet.length > 0) {
            const depNames = unmet.map(id => byId.get(id)?.name || id);
            return {
                error: `Cannot activate "${s.name}" (step ${s.order}) yet — it depends on: ${depNames.join(', ')}. Activate those first.`,
            };
        }
        runningActivated.add(s.id);
        loaded.push(s);
    }

    const mergedActivated = Array.from(runningActivated);
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
    initialActivatedSkillIds,
    deriveCompletedSkillIds,
};

