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
 * Otherwise, issues a random opaque guest token via a long-lived cookie and
 * returns that — prevents collisions between visitors behind the same NAT/UA.
 * Why a cookie token, not hash(IP+UA): on a shared corporate proxy, every
 * employee on the same browser version hashes to the same id, exposing each
 * other's guest conversations to GET/DELETE /:id/history.
 * @param {import('express').Request} req
 * @returns {string} User ID (never null)
 */
function getEffectiveUserId(req) {
    if (req.session?.user?.id) {
        return req.session.user.id;
    }
    if (req.session) {
        if (!req.session.guestId) {
            req.session.guestId = 'guest_' + crypto.randomBytes(12).toString('hex');
        }
        return req.session.guestId;
    }
    // Sessionless fallback (rare in this codebase): still random per request
    // rather than predictable. Caller will not get continuity across requests
    // in this branch, which is acceptable for read-only flows.
    return 'guest_' + crypto.randomBytes(12).toString('hex');
}

/**
 * Get user authentication credentials for component execution.
 * Extracts OAuth tokens, Nextcloud app passwords, and encryption keys.
 * @param {import('express').Request} req
 * @returns {Promise<object>} { accessToken, nextcloudUrl, appPasswordUsername, appPassword, encryptionKey }
 */
async function getUserAuth(req) {
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
        const oauth = (await configStore.getConfig('oauth')) || {};
        userAuth.nextcloudUrl = oauth.nextcloudUrl || null;
    } catch (e) { }

    // Check if app password was passed via session token (for embedded iframe)
    if (req.session?.appPassword) {
        userAuth.appPasswordUsername = req.session.appPassword.username;
        userAuth.appPassword = req.session.appPassword.password;
        // A per-user Nextcloud URL stored alongside the credential wins over org config.
        if (req.session.appPassword.url) userAuth.nextcloudUrl = req.session.appPassword.url;
    } else {
        // Otherwise look up from userStore
        const userId = req.session?.user?.id;
        if (userId) {
            const userStore = require('../stores/userStore');
            const appPasswordData = await userStore.getAppPassword(userId);
            if (appPasswordData) {
                userAuth.appPasswordUsername = appPasswordData.username;
                userAuth.appPassword = appPasswordData.password;
                if (appPasswordData.url) userAuth.nextcloudUrl = appPasswordData.url;
            }
        }
    }

    return userAuth;
}

module.exports = {
    getEffectiveUserId,
    getUserAuth
};
