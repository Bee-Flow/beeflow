const express = require('express');
const agentStore = require('../../stores/agentStore');
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
  "channels": ["chatgpt" | "slack" | "teams" | "discord" | "email"],
  "capabilities": ["string", ...]  // 2-5 short capability bullets
  "suggestedSkills": [{ "name": "string", "reason": "string" }],
  "systemPrompt": "string (concrete instructions for the agent, written in the user's language)"
}`;

const PLAN_SYSTEM_PROMPT = `You design AI agent configurations. Given a user's natural-language description, return ONLY a JSON object matching this schema:

${PLAN_SCHEMA}

Rules:
- Match the user's language (Dutch input -> Dutch output).
- Keep "name" under 40 characters.
- Channels must be lowercase identifiers from the allowed list. Default to ["chatgpt"] if unclear.
- Capabilities are short user-visible bullets, not technical jargon.
- systemPrompt must be self-contained: tone, scope, what to do, what to avoid.
- Respond with raw JSON only, no markdown fences.`;

async function generatePlan({ userPrompt, priorPlan, refinement, modelTier, userOrgId, userId }) {
    const tier = modelTier || 'fast';
    const modelId = await resolveModelForTier(`tier:${tier}`, { userOrgId, userId, fallbackTier: 'fast' });
    const tierConfig = await getTierConfig(tier, { userOrgId, userId });

    const messages = [{ role: 'system', content: PLAN_SYSTEM_PROMPT }];
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
        const { prompt, modelTier } = req.body || {};
        if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required' });
        const userId = getEffectiveUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const userOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        const plan = await generatePlan({ userPrompt: prompt, modelTier, userOrgId, userId });
        res.json({ plan });
    } catch (err) {
        console.error('Agent wizard draft failed:', err);
        res.status(500).json({ error: err.message });
    }
});

// POST /agents/wizard/refine  { prompt, plan, refinement, modelTier }
router.post('/wizard/refine', requirePermission('manage_agents'), async (req, res) => {
    try {
        const { prompt, plan, refinement, modelTier } = req.body || {};
        if (!plan) return res.status(400).json({ error: 'Prior plan is required' });
        if (!refinement || !refinement.trim()) return res.status(400).json({ error: 'Refinement is required' });
        const userId = getEffectiveUserId(req);
        const orgIds = await resolveUserOrgIds(req);
        const userOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

        const updated = await generatePlan({ userPrompt: prompt, priorPlan: plan, refinement, modelTier, userOrgId, userId });
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

        const config = {
            avatar: plan.avatar || '🤖',
            wizard: {
                channels: plan.channels || [],
                capabilities: plan.capabilities || [],
                suggestedSkills: plan.suggestedSkills || [],
                memoryEnabled: false,
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
