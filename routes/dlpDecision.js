/**
 * DLP decision endpoint — receives the user's choice (redact / block / allow)
 * from the client modal and unblocks the paused chat stream.
 */

const express = require('express');
const router = express.Router();
const decisionQueue = require('../core/dlp/decisionQueue');

function requireAuth(req, res, next) {
    if (req.session?.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

const VALID_CHOICES = new Set(['redact', 'block', 'allow']);

router.post('/', requireAuth, async (req, res) => {
    const { decisionId, choice, rememberForConversation } = req.body || {};
    if (!decisionId || typeof decisionId !== 'string') {
        return res.status(400).json({ error: 'decisionId is required' });
    }
    if (!VALID_CHOICES.has(choice)) {
        return res.status(400).json({ error: `Invalid choice. Expected one of: ${[...VALID_CHOICES].join(', ')}` });
    }
    const ok = decisionQueue.resolve(decisionId, {
        choice,
        rememberForConversation: !!rememberForConversation,
    }, req.session.user.id);
    if (!ok) {
        return res.status(404).json({ error: 'Decision not found, expired, or not owned by this user.' });
    }
    res.json({ ok: true });
});

module.exports = router;
