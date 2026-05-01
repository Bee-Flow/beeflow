const express = require('express');
const agentStore = require('../../stores/agentStore');
const skillStore = require('../../stores/skillStore');
const kbStore = require('../../stores/knowledgeBases');
const { requirePermission, resolveUserOrgIds } = require('../../auth');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { extractJSON } = require('../../pipeline/llmHelpers');
const llmClient = require('../../core/llmClient');
const { resolveModelForTier, getTierConfig } = require('../../core/modelResolver');

const router = express.Router();

const PLAN_SCHEMA = `{
  "name": "string (short, friendly agent name)",
  "description": "string (1-2 sentences, second person, Dutch if user wrote Dutch)",
  "avatar": "single emoji",
  "channels": ["chat" | "slack" | "teams" | "discord" | "email"],
  "capabilities": ["string", ...]  // 2-5 short capability bullets
  "suggestedSkills": [{ "name": "string", "reason": "string" }],
  "systemPrompt": "string (concrete instructions for the agent, written in the user's language)"
}`;

const LOCALE_NAMES = { en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese' };

function planSystemPrompt(locale) {
    const langName = LOCALE_NAMES[(locale || 'en').toLowerCase().split('-')[0]] || 'English';
    return `You design AI agent configurations. Given a user's natural-language description, return ONLY a JSON object matching this schema:

${PLAN_SCHEMA}

Rules:
- Write all user-facing text (name, description, capabilities, systemPrompt) in ${langName}. If the user's prompt is clearly in another language, prefer that language.
- Keep "name" under 40 characters.
- Channels must be lowercase identifiers from the allowed list. Default to ["chatgpt"] if unclear.
- Capabilities are short user-visible bullets, not technical jargon.
- systemPrompt must be self-contained: tone, scope, what to do, what to avoid.
- Respond with raw JSON only, no markdown fences.`;
}

async function generatePlan({ userPrompt, priorPlan, refinement, modelTier, locale, userOrgId, userId }) {
    const tier = modelTier || 'fast';
    const modelId = await resolveModelForTier(`tier:${tier}`, { userOrgId, userId, fallbackTier: 'fast' });
    const tierConfig = await getTierConfig(tier, { userOrgId, userId });

    const messages = [{ role: 'system', content: planSystemPrompt(locale) }];
    if (priorPlan) {
        messages.push({ role: 'user', content: userPrompt || '' });
        messages.push({ role: 'assistant', content: JSON.stringify(priorPlan) });
        messages.push({ role: 'user', content: `Update the plan to address this feedback. Return the full updated JSON only.\n\nFeedback: ${refinement}` });
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

    if (!Array.isArray(plan.channels) || plan.channels.length === 0) plan.channels = ['chatgpt'];
    if (!Array.isArray(plan.capabilities)) plan.capabilities = [];
    if (!Array.isArray(plan.suggestedSkills)) plan.suggestedSkills = [];
    if (!plan.avatar) plan.avatar = '🤖';

    return plan;
}

// POST /agents/wizard/draft  { prompt, modelTier }
router.post('/wizard/draft', requirePermission('manage_agents'), async (req, res) => {
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

// POST /agents/wizard/refine  { prompt, plan, refinement, modelTier }
router.post('/wizard/refine', requirePermission('manage_agents'), async (req, res) => {
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
router.post('/wizard/commit', requirePermission('manage_agents'), async (req, res) => {
    try {
        const { plan } = req.body || {};
        if (!plan || !plan.name) return res.status(400).json({ error: 'Plan with name is required' });

        const userId = getEffectiveUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const orgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        // Best-effort: resolve suggestedSkills (by name) to real skill IDs in this org.
        let attachedSkillIds = [];
        try {
            if (orgId && Array.isArray(plan.suggestedSkills) && plan.suggestedSkills.length > 0) {
                const orgSkills = await skillStore.getAvailableSkills(orgId, userId);
                const byName = new Map(orgSkills.map(s => [String(s.name || '').toLowerCase().trim(), s.id]));
                attachedSkillIds = plan.suggestedSkills
                    .map(s => byName.get(String(s.name || '').toLowerCase().trim()))
                    .filter(Boolean);
            }
        } catch (_) { /* skills feature may be disabled — leave empty */ }

        // Auto-create a dedicated KB so users can upload files immediately —
        // they shouldn't need to leave the wizard to set up a knowledge base.
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

        // Canonical agent config shape — must match what AgentEditorUI / agentRuntime read.
        // `enabledIntegrations: null` means "all org-allowed integrations enabled" (matches AgentDesigner default).
        const config = {
            avatar: plan.avatar || '🤖',
            enabledIntegrations: null,
            knowledge_base_ids,
            attachedSkillIds,
            memoryEnabled: false,
            strictKnowledge: false,
            includeSourceReferences: false,
            // Keep the wizard plan around for traceability / re-opening the wizard later.
            wizard: {
                capabilities: plan.capabilities || [],
                suggestedSkills: plan.suggestedSkills || [],
                primaryKbId: knowledge_base_ids[0] || null,
            },
        };

        const agent = await agentStore.createAgent(
            plan.name,
            plan.description || '',
            plan.systemPrompt || '',
            userId,
            null,            // model — let user pick later
            [],              // starterPrompts
            true,            // threadsEnabled
            true,            // copyEnabled
            false,           // workspaceEnabled
            config,
            orgId,
            [],              // sharedGroups
            null             // categoryId
        );

        res.json({ agent });
    } catch (err) {
        console.error('Agent wizard commit failed:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
