/**
 * Multi-Agent Designer Routes
 * 
 * Handles: swarm pipeline start, clarification, credentials, config
 */

const express = require('express');
const router = express.Router();

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

const { designer: multiAgentDesigner, getConfig: getMultiAgentConfig, updateConfig: updateMultiAgentConfig } = require('../../agents/designer/coordinator');

// Start the swarm pipeline (SSE streaming)
router.post('/multi-agent/start', async (req, res) => {
    const sessionId = req.sessionID || 'default';
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

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
        const result = await multiAgentDesigner.startSwarm(sessionId, message, (type, detail) => {
            send('progress', { type, ...detail });
        });
        send('done', result);
    } catch (error) {
        console.error('[Swarm] Pipeline error:', error);
        send('error', { error: error.message });
    } finally {
        res.end();
    }
});

// Submit clarification answers (SSE streaming)
router.post('/multi-agent/clarify', async (req, res) => {
    const sessionId = req.sessionID || 'default';
    const { answers } = req.body;

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
        const result = await multiAgentDesigner.submitClarification(sessionId, answers || {}, (type, detail) => {
            send('progress', { type, ...detail });
        });
        send('done', result);
    } catch (error) {
        console.error('[Swarm] Clarification/research error:', error);
        send('error', { error: error.message });
    } finally {
        res.end();
    }
});

// Submit credentials and build (SSE streaming)
router.post('/multi-agent/build', async (req, res) => {
    const sessionId = req.sessionID || 'default';
    const { credentials } = req.body;

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
        const result = await multiAgentDesigner.submitCredentials(sessionId, credentials || {}, (type, detail) => {
            send('progress', { type, ...detail });
        });
        send('done', result);
    } catch (error) {
        console.error('[Swarm] Credentials/build error:', error);
        send('error', { error: error.message });
    } finally {
        res.end();
    }
});

// Credential chat
router.post('/multi-agent/credential-chat', async (req, res) => {
    const sessionId = req.sessionID || 'default';
    const { message } = req.body;

    if (!message) {
        return res.status(400).json({ error: 'Message is required' });
    }

    try {
        const result = await multiAgentDesigner.credentialChat(sessionId, message);
        res.json(result);
    } catch (error) {
        console.error('[Swarm] Credential chat error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get/update swarm pipeline config
router.get('/multi-agent/config', requireAuth, (req, res) => {
    try {
        const config = getMultiAgentConfig();
        res.json(config);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.put('/multi-agent/config', requireAuth, (req, res) => {
    try {
        const updated = updateMultiAgentConfig(req.body);
        res.json(updated);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
