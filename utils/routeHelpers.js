/**
 * Route Helpers — shared utilities for Express route handlers
 * 
 * Extracted from duplicate definitions in routes/agents.js, routes/knowledge.js,
 * and routes/groupChats.js.
 */

const crypto = require('crypto');

/**
 * Get effective user ID from request session.
 * If authenticated, returns session user ID.
 * If not, generates a deterministic guest ID from IP + User-Agent.
 * @param {import('express').Request} req
 * @returns {string} User ID (never null)
 */
function getEffectiveUserId(req) {
    if (req.session?.user?.id) {
        return req.session.user.id;
    }
    // Generate anonymous user ID based on IP + User-Agent for consistency
    const identifier = (req.ip || 'unknown') + (req.headers['user-agent'] || '');
    return 'guest_' + crypto.createHash('md5').update(identifier).digest('hex').slice(0, 12);
}

/**
 * Get user authentication credentials for component execution.
 * Extracts OAuth tokens, Nextcloud app passwords, and encryption keys.
 * @param {import('express').Request} req
 * @returns {object} { accessToken, nextcloudUrl, appPasswordUsername, appPassword, encryptionKey }
 */
function getUserAuth(req) {
    const { resolveUserOrgIds } = require('../auth');

    // Resolve user's org for EU mode and other org-scoped features
    const orgIds = resolveUserOrgIds(req);
    const userOrgId = orgIds && orgIds.size > 0 ? Array.from(orgIds)[0] : null;

    const userAuth = {
        accessToken: req.session?.accessToken || null,
        nextcloudUrl: null,
        appPasswordUsername: null,
        appPassword: null,
        encryptionKey: req.session?.encryptionKey || null,
        userId: req.session?.user?.id || null,
        session: req.session || null,
        userOrgId
    };

    const configStore = require('../stores/configStore');
    try {
        const oauth = configStore.getConfig('oauth') || {};
        userAuth.nextcloudUrl = oauth.nextcloudUrl || null;
    } catch (e) { }

    // Check if app password was passed via session token (for embedded iframe)
    if (req.session?.appPassword) {
        userAuth.appPasswordUsername = req.session.appPassword.username;
        userAuth.appPassword = req.session.appPassword.password;
    } else {
        // Otherwise look up from userStore
        const userId = req.session?.user?.id;
        if (userId) {
            const userStore = require('../stores/userStore');
            const appPasswordData = userStore.getAppPassword(userId);
            if (appPasswordData) {
                userAuth.appPasswordUsername = appPasswordData.username;
                userAuth.appPassword = appPasswordData.password;
            }
        }
    }

    return userAuth;
}

module.exports = {
    getEffectiveUserId,
    getUserAuth
};
