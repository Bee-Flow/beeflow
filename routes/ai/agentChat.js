/**
 * Agent Chat Routes
 * 
 * Handles: agent chat, streaming, history, tools, component creation
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const {
    getOrCreateAgent,
    clearConversation,
} = require('../../core/aiAgent');
const { getAvailableComponents } = require('../../core/agentRuntime');
const componentManager = require('../../core/componentManager');
const { requireAuth } = require('../../auth');
const { checkSubscriptionLimits } = require('../../core/limits');
const { resolveUserOrgIds } = require('../../auth');

// Resolve the caller's primary org for quota checks, mirroring the helper
// used in /agents/:id/chat/stream.
async function _resolveLimitOrg(req) {
    try {
        const orgIds = await resolveUserOrgIds(req);
        return orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;
    } catch (_) { return null; }
}

const COMPONENTS_DIR = path.resolve(__dirname, '../../../components');

// Chat with AI agent (standard JSON response)
router.post('/chat', requireAuth, async (req, res) => {
    try {
        const sessionId = req.sessionID || 'default';
        const { message, tools, context } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message is required' });
        }

        const userId = req.session.user.id;
        const limitOrgId = await _resolveLimitOrg(req);
        const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
        if (limitError) return res.status(402).json({ error: limitError });

        const agent = getOrCreateAgent(sessionId);
        const response = await agent.chat(message, tools, context);

        res.json(response);
    } catch (error) {
        console.error('AI chat error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Chat with AI agent — SSE streaming with real-time progress
router.post('/chat-stream', requireAuth, async (req, res) => {
    const sessionId = req.sessionID || 'default';
    const { message, tools, context } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    const userId = req.session.user.id;
    const limitOrgId = await _resolveLimitOrg(req);
    const limitError = await checkSubscriptionLimits(limitOrgId, 'chat', userId);
    if (limitError) return res.status(402).json({ error: limitError });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const agent = getOrCreateAgent(sessionId);
        const response = await agent.chat(message, tools, context, (progress) => {
            send('progress', progress);
        });

        send('done', response);
    } catch (error) {
        console.error('AI chat-stream error:', error);
        send('error', { error: error.message });
    } finally {
        res.end();
    }
});

// Clear AI conversation
router.post('/clear', (req, res) => {
    const sessionId = req.sessionID || 'default';
    clearConversation(sessionId);
    res.json({ success: true });
});

// Get conversation history
router.get('/history', (req, res) => {
    const sessionId = req.sessionID || 'default';
    const agent = getOrCreateAgent(sessionId);
    res.json({ history: agent.getHistory(), toolCalls: agent.getToolCalls() });
});

// Get available tools/components for research
router.get('/tools', async (req, res) => {
    try {
        const components = await getAvailableComponents();
        const researchTools = components.filter(c => {
            const name = (c.name || '').toLowerCase();
            const desc = (c.description || '').toLowerCase();
            const category = (c.category || '').toLowerCase();
            return name.includes('search') ||
                name.includes('fetch') ||
                name.includes('api') ||
                name.includes('http') ||
                desc.includes('search') ||
                desc.includes('fetch') ||
                category.includes('api') ||
                category.includes('search');
        });
        res.json({ tools: components, researchTools });
    } catch (error) {
        console.error('Failed to get AI tools:', error);
        res.status(500).json({ error: error.message });
    }
});

// Create component from AI-generated data
router.post('/create-component', async (req, res) => {
    try {
        const { component } = req.body;

        if (!component || !component.id || !component.name || !component.code) {
            return res.status(400).json({ error: 'Invalid component data' });
        }

        if (!component.id.match(/^[a-z0-9-]+$/)) {
            return res.status(400).json({ error: 'Component ID must be lowercase letters, numbers, and hyphens only' });
        }

        const componentDir = path.join(COMPONENTS_DIR, component.id);

        if (fs.existsSync(componentDir)) {
            return res.status(400).json({ error: 'Component with this ID already exists' });
        }

        fs.mkdirSync(componentDir, { recursive: true });

        const componentJson = {
            name: component.name,
            description: component.description || '',
            category: component.category || 'Custom',
            inputs: component.inputs || {},
            outputs: component.outputs || {}
        };
        fs.writeFileSync(path.join(componentDir, 'component.json'), JSON.stringify(componentJson, null, 2));

        const packageJson = {
            name: component.id,
            version: '1.0.0',
            dependencies: component.dependencies || {}
        };
        fs.writeFileSync(path.join(componentDir, 'package.json'), JSON.stringify(packageJson, null, 2));

        const codeContent = typeof component.code === 'string' ? component.code : JSON.stringify(component.code, null, 2);
        fs.writeFileSync(path.join(componentDir, 'index.js'), codeContent);

        await componentManager.initialize();

        res.json({ success: true, id: component.id, message: 'Component created successfully' });
    } catch (error) {
        console.error('Failed to create AI component:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
