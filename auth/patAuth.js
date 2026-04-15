/**
 * Personal Access Token Auth Middleware
 *
 * Reads `Authorization: Bearer bf_...` header and authenticates the request
 * by populating req.session as if the user was logged in via cookie.
 *
 * This runs BEFORE requireAuth so PAT-authed requests look identical to
 * session-authed requests for downstream handlers.
 */

const patStore = require('../stores/patStore');
const userStore = require('../stores/userStore');

async function patAuthMiddleware(req, res, next) {
    // Skip if already authenticated via session cookie
    if (req.session?.isAuthenticated && req.session?.user?.id) {
        return next();
    }

    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
        return next();
    }

    const token = authHeader.slice(7).trim();
    if (!token.startsWith('bf_')) {
        return next();
    }

    try {
        const tokenInfo = await patStore.findByToken(token);
        if (!tokenInfo) return next();

        const user = await userStore.getUser(tokenInfo.userId);
        if (!user) return next();

        // Populate session as if cookie-authenticated
        req.session.isAuthenticated = true;
        req.session.user = {
            id: user.id,
            email: user.email,
            displayName: user.displayName || user.id,
            role: user.role || 'user',
            organizationId: user.organizationId || null,
        };
        req.session.isAdmin = user.role === 'admin';
        req.patAuth = { tokenId: tokenInfo.id };

        // Update last_used_at asynchronously (don't block the request)
        patStore.touchLastUsed(tokenInfo.id).catch(err =>
            console.warn('[PATAuth] touchLastUsed failed:', err.message)
        );
    } catch (err) {
        console.warn('[PATAuth] Token lookup failed:', err.message);
    }

    next();
}

module.exports = patAuthMiddleware;
