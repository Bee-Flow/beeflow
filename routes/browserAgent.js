/**
 * Browser Agent Routes
 *
 * Two endpoints the Chrome extension uses to bi-directionally communicate
 * with the server-side Claude agent loop:
 *
 *   GET  /api/browser-agent/stream  — SSE: extension subscribes, receives tool_call jobs
 *   POST /api/browser-agent/result  — extension posts tool results back
 *   POST /api/browser-agent/run     — start a browser agent session (user message → stream back)
 *
 * Auth: X-Session-Token header (injected by the extension's declarativeNetRequest rule).
 * The session-token middleware in index.js already merges token data into req.session
 * before any route handler runs.
 *
 * Per-session state is held in browserAgentSessions (in-memory, keyed by userId).
 * For multi-instance deployments this could move to Redis, but a single-server
 * setup is the common case for Bee-Flow.
 */

const express = require('express');
const router = express.Router();
const { setupSSE } = require('../core/sseHelpers');
const { runBrowserAgentLoop } = require('../agents/browserAgentLoop');

// ── Per-user session registry ──────────────────────────────────────────────
//
// Structure per userId:
//   {
//     sendEvent: Function,           // SSE emitter to the extension
//     pendingJobs: Map<jobId, { resolve, reject, timer }>,
//     abortController: AbortController,
//     connectedAt: Date,
//   }

const sessions = new Map(); // userId -> session

function requireUser(req, res) {
    const userId = req.session?.user?.id || req.session?.userId;
    if (!userId) {
        res.status(401).json({ error: 'Not authenticated' });
        return null;
    }
    return userId;
}

// ── GET /stream — extension subscribes ────────────────────────────────────

router.get('/stream', (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    // Close any existing connection for this user (side panel re-opened)
    const existing = sessions.get(userId);
    if (existing) {
        existing.abortController.abort();
        sessions.delete(userId);
    }

    const { sendEvent, abortController } = setupSSE(res);

    const session = {
        sendEvent,
        pendingJobs: new Map(),
        abortController,
        connectedAt: new Date(),
    };
    sessions.set(userId, session);

    // Send a heartbeat every 20 s to keep the connection alive through proxies
    const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': heartbeat\n\n');
        else clearInterval(heartbeat);
    }, 20_000);

    abortController.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        // Reject any jobs that were waiting on this connection
        for (const [, job] of session.pendingJobs) {
            clearTimeout(job.timer);
            job.reject(new Error('extension_disconnected'));
        }
        sessions.delete(userId);
    });

    console.log(`[BrowserAgent] Extension connected for user ${userId}`);
});

// ── POST /result — extension posts tool result ─────────────────────────────

router.post('/result', express.json(), (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const { jobId, result } = req.body || {};
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    const session = sessions.get(userId);
    if (!session) return res.status(404).json({ error: 'No active extension session' });

    const job = session.pendingJobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Unknown jobId' });

    clearTimeout(job.timer);
    session.pendingJobs.delete(jobId);
    job.resolve(result);

    res.json({ ok: true });
});

// ── POST /run — start a browser agent turn (user sends a message) ──────────

router.post('/run', express.json(), async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const session = sessions.get(userId);
    if (!session) {
        return res.status(409).json({
            error: 'No extension connected. Open the BeeFlow side panel first.',
        });
    }

    const { message, conversationId, context } = req.body || {};
    if (!message) return res.status(400).json({ error: 'Missing message' });

    const { sendEvent, abortController, markEnded } = setupSSE(res);

    // Forward SSE events to the caller AND relay tool_call jobs to the extension
    const dispatch = {
        sendEvent,
        /**
         * Push a browser tool_call job to the extension and wait for its result.
         * @param {string} name   - tool name, e.g. 'browser_click'
         * @param {object} input  - tool input
         * @returns {Promise<object>} tool result from the extension
         */
        dispatchToExtension: (name, input) => new Promise((resolve, reject) => {
            if (session.abortController.signal.aborted) {
                return reject(new Error('extension_disconnected'));
            }

            const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const TIMEOUT_MS = 30_000;

            const timer = setTimeout(() => {
                session.pendingJobs.delete(jobId);
                reject(Object.assign(new Error('tool_timeout'), { code: 'timeout', jobId }));
            }, TIMEOUT_MS);

            session.pendingJobs.set(jobId, { resolve, reject, timer });
            session.sendEvent('tool_call', { jobId, name, input });
        }),
    };

    try {
        await runBrowserAgentLoop({
            userId,
            message,
            conversationId,
            context: context || {},
            session: req.session,
            dispatch,
            abortController,
        });
        markEnded();
        res.end();
    } catch (err) {
        console.error('[BrowserAgent] Loop error:', err.message);
        sendEvent('error', { error: err.message });
        res.end();
    }
});

// ── Utility: send a tool call to the extension (used by browserTools.js) ──

function dispatchToolCall(userId, name, input) {
    const session = sessions.get(userId);
    if (!session) throw Object.assign(new Error('No active extension session'), { code: 'no_extension' });

    return new Promise((resolve, reject) => {
        const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const TIMEOUT_MS = 30_000;

        const timer = setTimeout(() => {
            session.pendingJobs.delete(jobId);
            reject(Object.assign(new Error('tool_timeout'), { code: 'timeout', jobId }));
        }, TIMEOUT_MS);

        session.pendingJobs.set(jobId, { resolve, reject, timer });
        session.sendEvent('tool_call', { jobId, name, input });
    });
}

function isExtensionConnected(userId) {
    return sessions.has(userId);
}

module.exports = router;
module.exports.dispatchToolCall = dispatchToolCall;
module.exports.isExtensionConnected = isExtensionConnected;
