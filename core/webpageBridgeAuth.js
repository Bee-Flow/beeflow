/**
 * Webpage Bridge Auth — author-context resolver shared by all three webpage
 * runtime bridges (AI / Automations / Integrations).
 *
 * The bridges run "acts-as-author": when a visitor triggers an action from
 * a published page, the call executes with the WEBPAGE OWNER's credentials,
 * quota, and routines. This module produces the author session object that
 * downstream tool dispatchers (toolDispatcher.executeTool, automationRunner.
 * executeAutomation, llmClient.chat) expect — same shape as `req.session`.
 *
 * Mirrors `resolveUserSession` in automationRunner.js (vault-backed via
 * routineAuth.buildUserAuth, falling back to the legacy user_sessions row
 * if ROUTINE_AUTH_LEGACY=1). We duplicate rather than depend on the runner
 * so the bridge keeps working even if the runner module changes shape.
 */

const pool = require('../db').pool;
const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const routineAuth = require('./routineAuth');
const webpageStore = require('../stores/webpageStore');

function mergeEnabled(userList, orgList) {
    if (!Array.isArray(userList) && !Array.isArray(orgList)) return [];
    if (!Array.isArray(userList)) return [...orgList];
    if (!Array.isArray(orgList)) return [...userList];
    return userList.filter(id => orgList.includes(id));
}

async function resolveEnabledIntegrations(userId, organizationId) {
    const userEnabledApps = await configStore.getConfig(`enabled_apps_user_${userId}`).catch(() => null);
    let orgEnabledIntegrations = null;
    if (organizationId) {
        try {
            const org = await userStore.getOrganization(organizationId);
            if (org?.enabledIntegrations) {
                orgEnabledIntegrations = typeof org.enabledIntegrations === 'string'
                    ? JSON.parse(org.enabledIntegrations) : org.enabledIntegrations;
            } else {
                const globalDefaults = await configStore.getConfig('default_org_integrations');
                orgEnabledIntegrations = typeof globalDefaults === 'string'
                    ? JSON.parse(globalDefaults) : globalDefaults;
            }
        } catch (_) { /* ignore */ }
    }
    return mergeEnabled(userEnabledApps, orgEnabledIntegrations);
}

async function buildAuthorSession(authorUserId, authorUser) {
    const allEnabled = await resolveEnabledIntegrations(authorUserId, authorUser?.organizationId || null);
    try {
        const built = await routineAuth.buildUserAuth(authorUserId, { enabledIntegrations: allEnabled });
        if (built) {
            return {
                user: {
                    id: authorUserId,
                    email: authorUser?.email || null,
                    organizationId: authorUser?.organizationId || null,
                    role: authorUser?.role || null,
                },
                isAdmin: !!authorUser?.isAdmin,
                accessToken: built.accessToken,
                refreshToken: built.refreshToken,
                expiresAt: built.expiresAt,
                oauthProvider: built.oauthProvider,
                routineProviders: built.routineProviders || {},
            };
        }
    } catch (err) {
        console.warn(`[WebpageBridgeAuth] buildUserAuth failed for user ${authorUserId}: ${err.message}`);
    }

    // Legacy fallback (matches automationRunner.resolveUserSession).
    if (process.env.ROUTINE_AUTH_LEGACY !== '0') {
        try {
            const { rows } = await pool.query(
                `SELECT sess FROM user_sessions
                 WHERE sess::jsonb -> 'user' ->> 'id' = $1
                   AND expire > NOW()
                 ORDER BY expire DESC LIMIT 1`,
                [authorUserId],
            );
            if (rows.length > 0) {
                const sess = typeof rows[0].sess === 'string' ? JSON.parse(rows[0].sess) : rows[0].sess;
                return sess;
            }
        } catch (err) {
            console.warn(`[WebpageBridgeAuth] legacy session lookup failed: ${err.message}`);
        }
    }

    // No OAuth credentials available — return the bare shim. AI calls still
    // work (they don't need OAuth); integrations that require OAuth will
    // surface a clear "not connected" error from the dispatcher.
    return {
        user: {
            id: authorUserId,
            email: authorUser?.email || null,
            organizationId: authorUser?.organizationId || null,
            role: authorUser?.role || null,
        },
        isAdmin: !!authorUser?.isAdmin,
        routineProviders: {},
    };
}

/**
 * Load everything a bridge route needs to act on behalf of the webpage's
 * author. Returns `null` if the webpage doesn't exist.
 */
async function loadAuthorContext(webpageId) {
    if (!webpageId) return null;
    const webpage = await webpageStore.getWebpageRaw(webpageId);
    if (!webpage) return null;
    const authorUserId = webpage.userId;
    const authorUser = await userStore.getUser(authorUserId).catch(() => null);
    const authorSession = await buildAuthorSession(authorUserId, authorUser);
    const bridgeGrants = await webpageStore.getBridgeGrants(webpageId);
    return {
        webpage,
        authorUserId,
        authorOrgId: authorUser?.organizationId || null,
        authorUser,
        authorSession,
        bridgeGrants,
    };
}

module.exports = {
    loadAuthorContext,
};
