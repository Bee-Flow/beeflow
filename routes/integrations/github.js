/**
 * GitHub Integration Routes — PAT-based
 * 
 * Minimal routes for token management (status, disconnect).
 * No OAuth flow needed — users paste their PAT in Settings.
 */

const express = require('express');
const router = express.Router();
const configStore = require('../../stores/configStore');

// ─── Connection Status ───────────────────────────────────────────
router.get('/status', async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const hasToken = !!(await configStore.getSecret(`github_token_user_${userId}`));
    const username = await configStore.getConfig(`github_username_user_${userId}`);

    res.json({
        connected: hasToken,
        username: hasToken ? username : null,
    });
});

// ─── Save Token ──────────────────────────────────────────────────
router.post('/connect', async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { token } = req.body;
    if (!token?.trim()) {
        return res.status(400).json({ error: 'Token is required' });
    }

    try {
        // Validate token by fetching user profile
        const userRes = await fetch('https://api.github.com/user', {
            headers: {
                'Authorization': `Bearer ${token.trim()}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(10000),
        });

        if (!userRes.ok) {
            return res.status(400).json({ error: 'Invalid GitHub token. Please check and try again.' });
        }

        const userData = await userRes.json();
        const username = userData.login;

        // Store token and username
        await configStore.setSecret(`github_token_user_${userId}`, token.trim());
        await configStore.setConfig(`github_username_user_${userId}`, username);

        console.log(`[GitHub] Connected for user ${userId} (${username})`);
        res.json({ success: true, username });
    } catch (err) {
        console.error('[GitHub] Connect error:', err.message);
        res.status(500).json({ error: 'Failed to validate GitHub token' });
    }
});

// ─── Disconnect ──────────────────────────────────────────────────
router.post('/disconnect', async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    await configStore.deleteConfig(`github_token_user_${userId}`);
    await configStore.deleteConfig(`github_username_user_${userId}`);

    console.log(`[GitHub] Disconnected for user ${userId}`);
    res.json({ success: true });
});

module.exports = router;
