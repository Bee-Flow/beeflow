const express = require('express');
const agentStore = require('../../stores/agentStore');
const skillStore = require('../../stores/skillStore');
const kbStore = require('../../stores/knowledgeBases');
const userStore = require('../../stores/userStore');
const configStore = require('../../stores/configStore');
const { requirePermission, resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { extractJSON } = require('../../pipeline/llmHelpers');
const llmClient = require('../../core/llmClient');
const { resolveModelForTier, getTierConfig } = require('../../core/modelResolver');
const { perUserRateLimit } = require('../../utils/perUserRateLimit');

const router = express.Router();

// Wizard endpoints all back onto an LLM call. Without a per-user cap a
// logged-in user can run up the org's LLM bill at request rate. 30/min is
// generous for human use (a refine-burst rarely exceeds 5/min) and rejects
// bot-like abuse.
const wizardLimiter = perUserRateLimit({ windowMs: 60_000, max: 30 });

// ─────────────────────────────────────────────────────────────────
// Integration catalog the LLM can pick from. Mirrors the catalog in
// agent-hub/src/components/admin/AgentDesigner/integrations.jsx so the
// model picks ids the front-end and runtime actually understand.
// ─────────────────────────────────────────────────────────────────
const INTEGRATION_CATALOG = [
    { id: 'gmail', label: 'Gmail', group: 'google', description: 'Read and send emails' },
    { id: 'google-calendar', label: 'Google Calendar', group: 'google', description: 'Create and manage events' },
    { id: 'google-drive', label: 'Google Drive', group: 'google', description: 'Search and access files' },
    { id: 'google-sheets', label: 'Google Sheets', group: 'google', description: 'Read and write spreadsheets' },
    { id: 'google-docs', label: 'Google Docs', group: 'google', description: 'Create and edit documents' },
    { id: 'google-slides', label: 'Google Slides', group: 'google', description: 'Create presentations' },
    { id: 'google-contacts', label: 'Google Contacts', group: 'google', description: 'Search and manage contacts' },
    { id: 'google-keep', label: 'Google Keep', group: 'google', description: 'List and create notes' },
    { id: 'google-groups', label: 'Google Groups', group: 'google', description: 'Read and reply to group conversations' },
    { id: 'outlook', label: 'Outlook', description: 'Read and send Outlook emails' },
    { id: 'ms-calendar', label: 'Microsoft Calendar', description: 'Manage Microsoft calendar events' },
    { id: 'onedrive', label: 'OneDrive', description: 'Access OneDrive files' },
    { id: 'ms-contacts', label: 'Microsoft Contacts', description: 'Search Microsoft contacts' },
    { id: 'fireflies', label: 'Fireflies.ai', description: 'Meeting transcripts', requiresKey: 'hasFirefliesKey' },
    { id: 'youtrack', label: 'YouTrack', description: 'Issues and projects', requiresKey: 'hasYouTrackConfig' },
    { id: 'gamma', label: 'Gamma', description: 'AI presentations', requiresKey: 'hasGammaKey' },
    { id: 'linkedin', label: 'LinkedIn', description: 'Post and search on LinkedIn', requiresKey: 'hasLinkedInConfig' },
    { id: 'n8n', label: 'n8n', description: 'Run workflows', requiresKey: 'hasN8nConfig' },
    { id: 'web-search', label: 'Web Search', description: 'Search the web' },
    { id: 'image-gen', label: 'Image Generation', description: 'Generate images' },
];

// Compute the integrations actually available to this user — same gating
// rules as agent-hub/src/components/admin/AgentDesigner/sections/ToolsSection.jsx
async function getAvailableIntegrations(userId) {
    const user = await userStore.getUser(userId).catch(() => null);
    const orgId = user?.organizationId || null;

    let orgEnabled = null;
    if (orgId) {
        try {
            const org = await userStore.getOrganization(orgId);
            if (org?.enabledIntegrations) {
                orgEnabled = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
            } else {
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                if (globalDefaults) {
                    orgEnabled = typeof globalDefaults === 'string' ? JSON.parse(globalDefaults) : globalDefaults;
                }
            }
        } catch (_) { /* ignore */ }
    }

    const isGoogleUser = !!user?.oauthProvider && user.oauthProvider === 'google';
    const isMicrosoftUser = !!user?.oauthProvider && user.oauthProvider === 'microsoft';
    const hasFirefliesKey = !!(await configStore.getSecret(`fireflies_api_key_user_${userId}`).catch(() => null));
    const hasYouTrackConfig = !!(await configStore.getSecret(`youtrack_url_user_${userId}`).catch(() => null))
        && !!(await configStore.getSecret(`youtrack_token_user_${userId}`).catch(() => null));
    const hasGammaKey = !!(await configStore.getSecret(`gamma_api_key_user_${userId}`).catch(() => null));
    const hasLinkedInConfig = !!(await configStore.getSecret('linkedin_client_id').catch(() => null));
    let hasN8nConfig = false;
    if (orgId) {
        try {
            const url = await configStore.getConfig(`n8n_url_org_${orgId}`);
            const key = await configStore.getSecret(`n8n_api_key_org_${orgId}`);
            hasN8nConfig = !!(url && key);
        } catch (_) { /* ignore */ }
    }

    const status = { isGoogleUser, isMicrosoftUser, hasFirefliesKey, hasYouTrackConfig, hasGammaKey, hasLinkedInConfig, hasN8nConfig };

    return INTEGRATION_CATALOG.filter(item => {
        if (orgEnabled && !orgEnabled.includes(item.id)) return false;
        if (item.group === 'google') return isGoogleUser;
        if (item.id === 'outlook' || item.id === 'ms-calendar' || item.id === 'onedrive' || item.id === 'ms-contacts') return isMicrosoftUser;
        if (item.requiresKey) return !!status[item.requiresKey];
        return true;
    });
}

const PLAN_SCHEMA = `{
  "name": "string (short, friendly agent name)",
  "description": "string (1-2 sentences, second person, in the user's language)",
  "avatar": "single emoji",
  "capabilities": ["string", ...],         // 2-5 short capability bullets
  "enabledIntegrations": ["id", ...],       // pick ONLY ids from the provided list
  "skills": [
    {
      "id": "string|null",                  // null when proposing a NEW skill
      "name": "string",
      "description": "string (one line)",
      "instructions": "string (when and how the agent should use this skill, in the user's language)"
    }
  ],
  "systemPrompt": "string (concrete instructions for the agent, written in the user's language)",
  "routine": null | {                       // OPTIONAL — set ONLY when the user is asking to schedule a recurring task for THIS agent.
    "title": "string (short routine name, in the user's language)",
    "prompt": "string (what the agent should do each time the routine fires)",
    "repeatInterval": "hourly|daily|weekdays|weekly|biweekly|monthly",
    "daysOfWeek": ["mon","tue","wed","thu","fri","sat","sun"] | null,  // only for daily/weekly/biweekly when specific days matter
    "timeOfDay": "HH:MM" | null,             // 24h, in the user's local timezone; null for hourly
    "timezone": "string IANA name" | null    // e.g. "Europe/Amsterdam"; null = use the user's default
  }
}`;

const LOCALE_NAMES = { en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese' };

function planSystemPrompt(locale, availableIntegrations, existingSkills) {
    const langName = LOCALE_NAMES[(locale || 'en').toLowerCase().split('-')[0]] || 'English';
    const integrationList = availableIntegrations.length
        ? availableIntegrations.map(i => `  - ${i.id}: ${i.label} — ${i.description}`).join('\n')
        : '  (none available)';
    const skillList = existingSkills.length
        ? existingSkills.map(s => `  - id="${s.id}" name="${s.name}"${s.description ? ` — ${s.description}` : ''}`).join('\n')
        : '  (no existing skills)';

    return `You design AI agent configurations. Given a user's natural-language description, return ONLY a JSON object matching this schema:

${PLAN_SCHEMA}

Available integrations (pick from these ids only — do NOT invent others):
${integrationList}

Existing skills in the user's organization (reuse by setting "id" to one of these; otherwise propose a new skill with id=null):
${skillList}

Rules:
- Write all user-facing text (name, description, capabilities, skills.name, skills.description, skills.instructions, systemPrompt) in ${langName}. If the user's prompt is clearly in another language, prefer that language.
- Keep "name" under 40 characters.
- Capabilities are short user-visible bullets, not technical jargon.
- enabledIntegrations: include only the integrations this agent will actually use. Empty array means "no integrations needed".
- skills: propose 0-5 skills. Reuse existing ones by id when there's a clear match; otherwise propose new skills with id=null and meaningful instructions.
- systemPrompt must be self-contained: tone, scope, what to do, what to avoid.
- routine: leave null UNLESS the user is explicitly asking to SCHEDULE a recurring task ("every morning", "each Monday", "weekly", "every 2 hours", "monthly report"). When set, write title/prompt in ${langName}, and pick the cadence and time that match the user's request. Do NOT invent a routine for vague capability requests like "summarize emails" — only when there's a clear time signal.
- Respond with raw JSON only, no markdown fences.`;
}

function normalizePlan(plan, availableIntegrationIds) {
    delete plan.channels;
    delete plan.suggestedSkills; // legacy field

    if (!Array.isArray(plan.capabilities)) plan.capabilities = [];
    if (!plan.avatar) plan.avatar = '🤖';

    // Validate integration ids against the user-allowed list (security: drop unknowns).
    if (!Array.isArray(plan.enabledIntegrations)) plan.enabledIntegrations = [];
    plan.enabledIntegrations = plan.enabledIntegrations
        .map(s => String(s || '').trim())
        .filter(id => availableIntegrationIds.includes(id));

    // Skills: each must have at least a name. id may be null/missing.
    if (!Array.isArray(plan.skills)) plan.skills = [];
    plan.skills = plan.skills
        .filter(s => s && typeof s === 'object' && s.name && String(s.name).trim())
        .map(s => ({
            id: s.id || null,
            name: String(s.name).trim(),
            description: String(s.description || '').trim(),
            instructions: String(s.instructions || '').trim(),
        }));

    // Routine: optional. Validate the cadence enum + day tokens; drop the
    // whole field if it's malformed (the chat panel handles missing routines
    // gracefully, but bad data would break the routine creator on the client).
    if (plan.routine && typeof plan.routine === 'object') {
        const r = plan.routine;
        const VALID_CADENCES = ['hourly', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
        const VALID_DOW = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
        if (!r.title || !r.prompt || !VALID_CADENCES.includes(r.repeatInterval)) {
            delete plan.routine;
        } else {
            plan.routine = {
                title: String(r.title).trim().slice(0, 200),
                prompt: String(r.prompt).trim().slice(0, 4000),
                repeatInterval: r.repeatInterval,
                daysOfWeek: Array.isArray(r.daysOfWeek)
                    ? r.daysOfWeek.map(d => String(d).toLowerCase().slice(0, 3)).filter(d => VALID_DOW.has(d))
                    : null,
                timeOfDay: typeof r.timeOfDay === 'string' && /^\d{2}:\d{2}$/.test(r.timeOfDay) ? r.timeOfDay : null,
                timezone: typeof r.timezone === 'string' && r.timezone.trim() ? r.timezone.trim() : null,
            };
            if (Array.isArray(plan.routine.daysOfWeek) && plan.routine.daysOfWeek.length === 0) {
                plan.routine.daysOfWeek = null;
            }
        }
    } else {
        delete plan.routine;
    }

    return plan;
}

async function generatePlan({ userPrompt, priorPlan, refinement, modelTier, locale, userOrgId, userId }) {
    const tier = modelTier || 'fast';
    const modelId = await resolveModelForTier(`tier:${tier}`, { userOrgId, userId, fallbackTier: 'fast' });
    const tierConfig = await getTierConfig(tier, { userOrgId, userId });

    const [availableIntegrations, existingSkills] = await Promise.all([
        getAvailableIntegrations(userId).catch(() => []),
        userOrgId ? skillStore.getAvailableSkills(userOrgId, userId).catch(() => []) : Promise.resolve([]),
    ]);
    const availableIds = availableIntegrations.map(i => i.id);

    const messages = [{ role: 'system', content: planSystemPrompt(locale, availableIntegrations, existingSkills) }];
    if (priorPlan) {
        // When refining a wizard-created agent we have the original prompt and
        // can prime the model with the original-request → prior-plan turn.
        // When refining an EXISTING agent (BuilderSplit flow), userPrompt is
        // empty — sending a `{role:'user', content:''}` makes Anthropic 400 with
        // "user messages must have non-empty content". Embed the prior plan in
        // the user turn instead so there's exactly one non-empty user message.
        const trimmedPrompt = (userPrompt || '').trim();
        if (trimmedPrompt) {
            messages.push({ role: 'user', content: trimmedPrompt });
            messages.push({ role: 'assistant', content: JSON.stringify(priorPlan) });
            messages.push({ role: 'user', content: `Update the plan to address this feedback. Return the full updated JSON only.\n\nFeedback: ${refinement}` });
        } else {
            messages.push({
                role: 'user',
                content:
                    `Here is the current agent configuration as JSON:\n\n` +
                    `${JSON.stringify(priorPlan)}\n\n` +
                    `Update it to address this feedback. Return the full updated JSON only.\n\nFeedback: ${refinement}`,
            });
        }
    } else {
        messages.push({ role: 'user', content: `Build an agent for this request:\n\n${userPrompt}` });
    }

    const result = await llmClient.chat(modelId, messages, {
        temperature: tierConfig?.temperature ?? 0.4,
        maxTokens: Math.min(tierConfig?.maxTokens ?? 2000, 4000),
        budgetTokens: 0,
        reasoningEffort: 'none',
    });

    const text = result?.content || '';
    const plan = extractJSON(text);
    if (!plan || !plan.name) {
        const err = new Error('Could not parse agent plan from model output');
        err.raw = text;
        throw err;
    }

    return normalizePlan(plan, availableIds);
}

router.post('/wizard/draft', requirePermission('manage_agents'), wizardLimiter, async (req, res) => {
    try {
        const { prompt, modelTier, locale } = req.body || {};
        if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required' });
        const userId = getEffectiveUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const userOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        const plan = await generatePlan({ userPrompt: prompt, modelTier, locale, userOrgId, userId });
        res.json({ plan });
    } catch (err) {
        console.error('Agent wizard draft failed:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/wizard/refine', requirePermission('manage_agents'), wizardLimiter, async (req, res) => {
    try {
        const { prompt, plan, refinement, modelTier, locale } = req.body || {};
        if (!plan) return res.status(400).json({ error: 'Prior plan is required' });
        if (!refinement || !refinement.trim()) return res.status(400).json({ error: 'Refinement is required' });
        const userId = getEffectiveUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const userOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        const updated = await generatePlan({ userPrompt: prompt, priorPlan: plan, refinement, modelTier, locale, userOrgId, userId });
        res.json({ plan: updated });
    } catch (err) {
        console.error('Agent wizard refine failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /agents/wizard/commit  { plan }  -> creates the agent, returns it
router.post('/wizard/commit', requirePermission('manage_agents'), wizardLimiter, async (req, res) => {
    try {
        const { plan } = req.body || {};
        if (!plan || !plan.name) return res.status(400).json({ error: 'Plan with name is required' });

        const userId = getEffectiveUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        // ── Skills: reuse existing by id, create new ones ──────────────
        let attachedSkillIds = [];
        const createdSkills = [];
        if (orgId && Array.isArray(plan.skills) && plan.skills.length > 0) {
            // Best-effort lookup of existing skills — but a failure here must NOT
            // block creation of new ones. Default to empty list on error.
            let orgSkills = [];
            try {
                orgSkills = await skillStore.getAvailableSkills(orgId, userId);
            } catch (lookupErr) {
                console.warn('Wizard: getAvailableSkills failed, will only create new skills:', lookupErr.message);
            }
            const knownIds = new Set((orgSkills || []).map(s => s.id));
            const byName = new Map((orgSkills || []).map(s => [String(s.name || '').toLowerCase().trim(), s.id]));

            for (const s of plan.skills) {
                if (!s || !s.name) continue;

                // Reuse existing skill by id when valid
                if (s.id && knownIds.has(s.id)) { attachedSkillIds.push(s.id); continue; }

                // Reuse by case-insensitive name match before creating a duplicate
                const nameKey = String(s.name).toLowerCase().trim();
                const matchByName = byName.get(nameKey);
                if (matchByName) { attachedSkillIds.push(matchByName); continue; }

                // Create the skill — isolate failures per skill so one bad
                // entry doesn't drop the rest.
                try {
                    const created = await skillStore.createSkill({
                        orgId,
                        userId,
                        name: s.name,
                        description: s.description || '',
                        instructions: (s.instructions || '').slice(0, 4000),
                        workflow: '',
                        rules: '',
                        examples: '',
                        icon: null,
                        isShared: false,
                        dynamicActivation: false,
                        sharedGroups: [],
                    });
                    if (created?.id) {
                        attachedSkillIds.push(created.id);
                        createdSkills.push(created);
                    } else {
                        console.warn('Wizard: createSkill returned no id for', s.name);
                    }
                } catch (createErr) {
                    console.warn('Wizard: skill create failed for', s.name, ':', createErr.message);
                }
            }
        }
        console.log(`[Wizard commit] attached skills: ${attachedSkillIds.length}, newly created: ${createdSkills.length}`);

        // ── Integrations: validate ids against the user's allow-list ──
        // (defensive — the LLM should already only pick from allowed ones,
        // but never trust the client to round-trip server-validated state)
        const availableIntegrations = await getAvailableIntegrations(userId).catch(() => []);
        const availableIds = new Set(availableIntegrations.map(i => i.id));
        const requested = Array.isArray(plan.enabledIntegrations)
            ? plan.enabledIntegrations.filter(id => availableIds.has(id))
            : [];
        // null = "all available enabled" (matches AgentDesigner default).
        // If the AI explicitly picked a subset, store that subset.
        const enabledIntegrations = requested.length > 0 ? requested : null;

        // ── Auto-create knowledge base ─────────────────────────────────
        let knowledge_base_ids = [];
        try {
            const kb = await kbStore.createKB(
                userId,
                plan.name,
                `Auto-generated knowledge base for agent "${plan.name}"`,
                'unknown',
                orgId,
                {}
            );
            if (kb?.id) knowledge_base_ids = [kb.id];
        } catch (err) {
            console.warn('Wizard: KB auto-create failed (non-fatal):', err.message);
        }

        const config = {
            avatar: plan.avatar || '🤖',
            enabledIntegrations,
            knowledge_base_ids,
            attachedSkillIds,
            memoryEnabled: false,
            strictKnowledge: false,
            includeSourceReferences: false,
            wizard: {
                capabilities: plan.capabilities || [],
                primaryKbId: knowledge_base_ids[0] || null,
            },
        };

        const agent = await agentStore.createAgent(
            plan.name,
            plan.description || '',
            plan.systemPrompt || '',
            userId,
            null,
            [],
            true,
            true,
            false,
            config,
            orgId,
            [],
            null
        );

        // ── Optional: AI proposed a routine for this new agent ─────────
        // The wizard plan schema lets the model return an OPTIONAL `routine`
        // block. When present and the user has the `agent_routines` beta we
        // create the AI task atomically with agent creation so the user
        // doesn't need a second round-trip.
        let createdRoutine = null;
        if (agent?.id && plan.routine && typeof plan.routine === 'object') {
            try {
                const { userHasBetaFeature } = require('../../core/betaFeatures');
                const allowed = await userHasBetaFeature(userId, 'agent_routines', req.session).catch(() => false);
                if (allowed) {
                    const aiTaskStore = require('../../stores/aiTaskStore');
                    const { computeRoutineNextRun } = require('../../utils/routineSchedule');
                    const r = plan.routine;
                    // Shared TZ-aware helper — same one the modal and wizard chat
                    // use, so behavior is identical regardless of entry point.
                    const nextRunAt = computeRoutineNextRun(r, r.timezone || 'UTC');
                    createdRoutine = await aiTaskStore.createTask({
                        userId,
                        agentId: agent.id,
                        title: r.title,
                        prompt: r.prompt,
                        nextRunAt,
                        repeatInterval: r.repeatInterval,
                        modelTier: 'auto',
                        timezone: r.timezone || 'UTC',
                        daysOfWeek: r.daysOfWeek,
                        timeOfDay: r.timeOfDay,
                    });
                }
            } catch (routineErr) {
                console.warn('Wizard: routine auto-create failed (non-fatal):', routineErr.message);
            }
        }

        res.json({ agent, createdSkills, routine: createdRoutine });
    } catch (err) {
        console.error('Agent wizard commit failed:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
