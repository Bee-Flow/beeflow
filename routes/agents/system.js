const express = require('express');
const agentStore = require('../../stores/agentStore');
const { getProviderForModel } = require('../../core/aiAgent');
const { resolveModelWithGlobalFallback, getTierConfig } = require('../../core/modelResolver');
const llmClient = require('../../core/llmClient');
const { resolveUserOrgIds } = require('../../auth');

const router = express.Router();

// ── Generic system agent handler factory ─────────────────────────────────────
//
// Eliminates the 90% boilerplate duplication across the 4 utility endpoints.
// Each endpoint is now a thin config object.

/**
 * @param {Object} opts
 * @param {string}   opts.agentId       - System agent ID
 * @param {string}   opts.tier          - Model tier to use (e.g. 'smart', 'thinking')
 * @param {number}   opts.maxTokens     - Max tokens for the LLM call
 * @param {Function} opts.buildPrompt   - (body) => user message string
 * @param {Function} opts.parseResult   - (content, body) => response JSON
 * @param {Function} [opts.validate]    - (body) => error string | null
 */
function createHandler({ agentId, tier, maxTokens, buildPrompt, parseResult, validate }) {
    return async (req, res) => {
        try {
            // Optional validation
            if (validate) {
                const validationError = validate(req.body);
                if (validationError) {
                    return res.status(400).json({ error: validationError });
                }
            }

            // Load agent config from DB
            const agent = await agentStore.getSystemAgent(agentId);
            if (!agent) {
                return res.status(404).json({ error: `System agent ${agentId} not found` });
            }

            // Resolve model — try the configured tier, validate it exists, fallback gracefully
            let model = await resolveModelWithGlobalFallback(`tier:${tier}`);
            try {
                await getProviderForModel(model);
            } catch (_) {
                model = await resolveModelWithGlobalFallback(null);
                console.warn(`[SystemAgent:${agentId}] ${tier} tier model not found, falling back to: ${model}`);
            }

            if (!model) {
                return res.status(500).json({ error: 'No model configured. Check your model tier configuration.' });
            }

            // Build messages and call LLM
            const messages = [
                { role: 'system', content: agent.system_prompt },
                { role: 'user', content: buildPrompt(req.body) },
            ];

            const result = await llmClient.chat(model, messages, { maxTokens });
            res.json(parseResult(result.content, req.body));
        } catch (error) {
            console.error(`[SystemAgent:${agentId}] Error:`, error);
            res.status(500).json({ error: error.message });
        }
    };
}

// ── GET /system — List all system agents (Admin Dashboard) ───────────────────

router.get('/system', async (req, res) => {
    try {
        let agents = await agentStore.getSystemAgents();

        const orgIds = await resolveUserOrgIds(req);
        if (orgIds !== null) {
            agents = agents.filter(a => orgIds.has(a.organization_id));
        }

        res.json(agents);
    } catch (error) {
        console.error('Failed to get system agents:', error);
        res.status(500).json({ error: error.message });
    }
});

// ── POST /system/prompt-designer/stream — SSE streaming ──────────────────────
//
// This endpoint uses SSE streaming, so it can't use the generic handler factory.
// It stays as a standalone implementation.

router.post('/system/prompt-designer/stream', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const agent = await agentStore.getSystemAgent('system-prompt-designer');
        if (!agent) {
            return res.status(404).json({ error: 'System Prompt Designer agent not found' });
        }

        // Get thinking tier config (model + params)
        const thinkingTier = await getTierConfig('thinking');
        const modelId = thinkingTier.modelId;

        if (!modelId) {
            return res.status(500).json({ error: 'No thinking/smart/fast tier model configured. Check your model tier configuration.' });
        }

        console.log(`[PromptDesigner] Using thinking tier model: ${modelId}`);

        // Set up SSE (flushHeaders required for Nginx Proxy Manager)
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const send = (event, data) => {
            if (!res.writableEnded) {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        };

        const messages = [
            { role: 'system', content: agent.system_prompt },
            { role: 'user', content: message },
        ];

        let fullContent = '';

        await llmClient.stream(modelId, messages, {
            maxTokens: thinkingTier.maxTokens || 16384,
            temperature: thinkingTier.temperature !== undefined ? thinkingTier.temperature : 0.7,
            reasoningEffort: thinkingTier.reasoningEffort || undefined,
            budgetTokens: thinkingTier.budgetTokens || undefined,
        }, (type, data) => {
            if (type === 'text') {
                fullContent += data.text;
                send('content', { text: data.text });
            } else if (type === 'thinking') {
                send('thinking', { text: data.text });
            } else if (type === 'error') {
                send('error', data);
            }
        });

        send('done', { fullContent });
        res.end();
    } catch (error) {
        console.error('[PromptDesigner] Error:', error);
        if (res.headersSent) {
            res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
            res.end();
        } else {
            res.status(500).json({ error: error.message });
        }
    }
});

// ── POST /system/conversation-starters/generate ──────────────────────────────

router.post('/system/conversation-starters/generate',
    createHandler({
        agentId: 'system-conversation-starters',
        tier: 'smart',
        maxTokens: 500,
        buildPrompt: ({ agentName, agentDescription, systemPrompt }) =>
            `Generate 4 conversation starters for an agent with:\n- Name: ${agentName || '(not set)'}\n- Description: ${agentDescription || '(not set)'}\n- System Prompt: ${systemPrompt || '(empty)'}`,
        parseResult: (content) => {
            try {
                const jsonMatch = content.match(/\[[\s\S]*\]/);
                const starters = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
                return { starters: starters.slice(0, 4) };
            } catch (_) {
                return { starters: [] };
            }
        },
    })
);

// ── POST /system/description-improver/generate ───────────────────────────────

router.post('/system/description-improver/generate',
    createHandler({
        agentId: 'system-description-improver',
        tier: 'smart',
        maxTokens: 200,
        buildPrompt: ({ agentName, currentDescription, systemPrompt }) => {
            const promptContext = systemPrompt ? systemPrompt.substring(0, 1000) : '';
            return promptContext
                ? `Based on this system prompt, generate a concise role description:\n\n---\n${promptContext}\n---\n\nAgent name: ${agentName || 'Unknown'}\nCurrent description: ${currentDescription || '(none)'}`
                : `Generate a description for an agent named "${agentName || 'AI Assistant'}"${currentDescription ? `\nCurrent description to improve: "${currentDescription}"` : ''}`;
        },
        parseResult: (content) => ({
            description: content.replace(/^["']|["']$/g, '').trim(),
        }),
    })
);

// ── POST /system/identity-improver/generate ──────────────────────────────────

router.post('/system/identity-improver/generate',
    createHandler({
        agentId: 'system-identity-improver',
        tier: 'smart',
        maxTokens: 200,
        validate: ({ systemPrompt }) =>
            systemPrompt ? null : 'System prompt is required to generate identity',
        buildPrompt: ({ currentName, currentDescription, systemPrompt }) =>
            `Based on this system prompt, generate a name and description:\n\n---\n${systemPrompt.substring(0, 1500)}\n---\n\nCurrent name: ${currentName || '(none)'}\nCurrent description: ${currentDescription || '(none)'}`,
        parseResult: (content, { currentName, currentDescription }) => {
            try {
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const identity = JSON.parse(jsonMatch[0]);
                    return {
                        avatar: identity.avatar || '',
                        name: identity.name || currentName || '',
                        description: identity.description || currentDescription || '',
                    };
                }
            } catch (_) {
                // Fall through to error
            }
            return { error: 'Failed to parse response' };
        },
    })
);

module.exports = router;
