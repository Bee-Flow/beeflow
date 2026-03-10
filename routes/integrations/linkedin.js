/**
 * LinkedIn Integration Routes
 * 
 * OAuth2 authorization flow + posting to LinkedIn.
 * Tokens are stored per-user in configStore (persistent across sessions).
 */

const express = require('express');
const router = express.Router();
const configStore = require('../../stores/configStore');

const SCOPES = ['openid', 'profile', 'w_member_social'];

/**
 * Get LinkedIn OAuth config for a user.
 * Reads per-user Client ID/Secret from configStore (set via Settings UI).
 * Falls back to environment variables.
 */
async function getLinkedInConfig() {
    // Global config set by admin
    let clientId = await configStore.getSecret('linkedin_client_id');
    let clientSecret = await configStore.getSecret('linkedin_client_secret');

    // Fallback to env vars
    if (!clientId) clientId = process.env.LINKEDIN_CLIENT_ID;
    if (!clientSecret) clientSecret = process.env.LINKEDIN_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('LinkedIn not configured. Ask your admin to set Client ID and Secret in Admin → Integrations.');
    }
    return { clientId, clientSecret };
}

// ─── Generate OAuth URL ──────────────────────────────────────────
router.get('/auth-url', async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const { clientId } = await getLinkedInConfig();

        // Build redirect URI from request origin
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const redirectUri = `${protocol}://${host}/api/integrations/linkedin/callback`;

        // CSRF state token
        const state = require('crypto').randomBytes(16).toString('hex');
        req.session.linkedinState = state;
        req.session.linkedinRedirectUri = redirectUri;
        req.session.save?.();

        const params = new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirectUri,
            state,
            scope: SCOPES.join(' ')
        });

        res.json({ url: `https://www.linkedin.com/oauth/v2/authorization?${params}` });
    } catch (err) {
        console.error('[LinkedIn] Auth URL error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── OAuth Callback (GET — LinkedIn redirects here) ──────────────
router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;
    const userId = req.session?.user?.id;

    if (error) {
        console.error('[LinkedIn] OAuth error:', error);
        return res.send(callbackHTML('LinkedIn authorization was denied.', false));
    }

    if (!userId) {
        return res.send(callbackHTML('Not authenticated. Please log in first.', false));
    }

    // CSRF check
    if (state !== req.session.linkedinState) {
        return res.send(callbackHTML('Invalid state parameter. Please try again.', false));
    }

    try {
        const { clientId, clientSecret } = await getLinkedInConfig();
        const redirectUri = req.session.linkedinRedirectUri;

        // Exchange code for access token
        const tokenRes = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: redirectUri,
                client_id: clientId,
                client_secret: clientSecret
            })
        });

        if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            throw new Error(`Token exchange failed: ${tokenRes.status} ${errText}`);
        }

        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;

        // Fetch person ID (sub) from userinfo
        const profileRes = await fetch('https://api.linkedin.com/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        if (!profileRes.ok) {
            throw new Error(`Profile fetch failed: ${profileRes.status}`);
        }

        const profileData = await profileRes.json();
        const personId = profileData.sub;
        const name = profileData.name || profileData.given_name || '';

        // Store tokens per-user (persistent)
        await configStore.setSecret(`linkedin_access_token_user_${userId}`, accessToken);
        await configStore.setConfig(`linkedin_person_id_user_${userId}`, personId);
        await configStore.setConfig(`linkedin_name_user_${userId}`, name);

        // Clean up session state
        delete req.session.linkedinState;
        delete req.session.linkedinRedirectUri;
        req.session.save?.();

        console.log(`[LinkedIn] Connected for user ${userId} (${name})`);
        res.send(callbackHTML(`Connected as ${name}!`, true));
    } catch (err) {
        console.error('[LinkedIn] Token exchange error:', err.message);
        res.send(callbackHTML('LinkedIn connection failed. Please try again.', false));
    }
});

// ─── Post to LinkedIn ────────────────────────────────────────────
router.post('/post', async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const accessToken = await configStore.getSecret(`linkedin_access_token_user_${userId}`);
    const personId = await configStore.getConfig(`linkedin_person_id_user_${userId}`);

    if (!accessToken || !personId) {
        return res.status(401).json({ error: 'Not connected to LinkedIn. Connect via Settings → Integrations.' });
    }

    const { text } = req.body;
    if (!text?.trim()) {
        return res.status(400).json({ error: 'Post text is required' });
    }

    try {
        const postRes = await fetch('https://api.linkedin.com/rest/posts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
                'X-Restli-Protocol-Version': '2.0.0',
                'LinkedIn-Version': '202501'
            },
            body: JSON.stringify({
                author: `urn:li:person:${personId}`,
                commentary: text,
                visibility: 'PUBLIC',
                distribution: {
                    feedDistribution: 'MAIN_FEED',
                    targetEntities: [],
                    thirdPartyDistributionChannels: []
                },
                lifecycleState: 'PUBLISHED',
                isReshareDisabledByAuthor: false
            })
        });

        if (!postRes.ok) {
            const errBody = await postRes.text();
            console.error('[LinkedIn] Post error:', postRes.status, errBody);
            if (postRes.status === 401) {
                // Token expired — clear stored tokens
                await configStore.deleteConfig(`linkedin_access_token_user_${userId}`);
                await configStore.deleteConfig(`linkedin_person_id_user_${userId}`);
                await configStore.deleteConfig(`linkedin_name_user_${userId}`);
                return res.status(401).json({ error: 'LinkedIn token expired. Please reconnect via Settings.' });
            }
            return res.status(500).json({ error: 'Failed to post to LinkedIn' });
        }

        console.log(`[LinkedIn] Post published for user ${userId}`);
        res.json({ success: true, message: 'Post published on LinkedIn!' });
    } catch (err) {
        console.error('[LinkedIn] Post error:', err.message);
        res.status(500).json({ error: 'Failed to post to LinkedIn' });
    }
});

// ─── Connection Status ───────────────────────────────────────────
router.get('/status', async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const hasToken = !!(await configStore.getSecret(`linkedin_access_token_user_${userId}`));
    const name = await configStore.getConfig(`linkedin_name_user_${userId}`);

    res.json({
        connected: hasToken,
        name: hasToken ? name : null
    });
});

// ─── Disconnect ──────────────────────────────────────────────────
router.post('/disconnect', async (req, res) => {
    const userId = req.session?.user?.id;
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    await configStore.deleteConfig(`linkedin_access_token_user_${userId}`);
    await configStore.deleteConfig(`linkedin_person_id_user_${userId}`);
    await configStore.deleteConfig(`linkedin_name_user_${userId}`);

    console.log(`[LinkedIn] Disconnected for user ${userId}`);
    res.json({ success: true });
});

// ─── Callback HTML (self-closing popup) ──────────────────────────
function callbackHTML(message, success) {
    return `<!DOCTYPE html>
<html><head><title>LinkedIn</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fff; }
  .card { text-align: center; padding: 40px; border-radius: 16px; background: #1a1a1a; box-shadow: 0 8px 32px rgba(0,0,0,.3); max-width: 400px; }
  .icon { font-size: 48px; margin-bottom: 16px; }
  h2 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
  p { color: #888; font-size: 14px; margin: 0; }
</style>
</head><body>
<div class="card">
  <div class="icon">${success ? '✅' : '❌'}</div>
  <h2>${message}</h2>
  <p>${success ? 'You can close this window.' : 'Please close this window and try again.'}</p>
</div>
<script>
  // Notify opener (settings page) to refresh status
  if (window.opener) {
    try { window.opener.postMessage({ type: 'linkedin-callback', success: ${success} }, '*'); } catch(e) {}
    setTimeout(() => window.close(), 1500);
  }
</script>
</body></html>`;
}

module.exports = router;
