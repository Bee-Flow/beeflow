/**
 * Beta Features — Central registry + gating helpers
 *
 * Manages which beta features exist and which organizations have access.
 * Beta features are stored per-organization in the `beta_features` column
 * on the `organizations` table (JSON array of feature IDs).
 *
 * Usage:
 *   const { requireBetaFeature, userHasBetaFeature } = require('./betaFeatures');
 *
 *   // In a route:
 *   router.get('/cool-thing', requireBetaFeature('advanced_analytics'), (req, res) => { ... });
 *
 *   // In business logic:
 *   if (await userHasBetaFeature(userId, 'ai_code_execution', req.session)) { ... }
 */

const { exec, getOne, run } = require('../db');

// ──────────────────────────────────────────────
// Beta Feature Registry
// Add new features here. This is the single source of truth.
// ──────────────────────────────────────────────
const BETA_FEATURES = [
    { id: 'advanced_analytics', name: 'Advanced Analytics', description: 'Extended analytics dashboards and reporting' },
    { id: 'ai_code_execution', name: 'AI Code Execution', description: 'Allow the AI agent to execute code in a sandboxed environment' },
    { id: 'custom_themes', name: 'Custom Themes', description: 'Organization-level custom branding and theme support' },
    { id: 'tasks', name: 'Tasks', description: 'AI-proposed task queue with mandatory human approval before execution' },
    { id: 'monitoring', name: 'Monitoring', description: 'Custom monitoring dashboards with SQL queries and data visualizations' },
    { id: 'e2e_testing', name: 'E2E Testing', description: 'AI-powered E2E test generation and execution dashboard' },
];

// ──────────────────────────────────────────────
// Lazy migration — ensure the column exists (deferred until first use)
// ──────────────────────────────────────────────
let migrated = false;
async function ensureColumn() {
    if (migrated) return;
    try {
        await exec(`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS beta_features TEXT DEFAULT '[]'`);
        console.log('[BetaFeatures] Added beta_features column to organizations table');
    } catch (_) {
        // Column already exists or table doesn't exist yet — expected during cold start
    }
    migrated = true;
}

// ──────────────────────────────────────────────
// Data helpers
// ──────────────────────────────────────────────

/**
 * Get the beta feature IDs enabled for an organization.
 * @param {string} orgId
 * @returns {Promise<string[]>}
 */
async function getOrgBetaFeatures(orgId) {
    try {
        await ensureColumn();
        const row = await getOne('SELECT beta_features FROM organizations WHERE id = $1', [orgId]);
        if (!row || !row.beta_features) return [];
        return JSON.parse(row.beta_features);
    } catch (_) {
        return [];
    }
}

/**
 * Set the beta feature IDs for an organization.
 * @param {string} orgId
 * @param {string[]} features — array of feature IDs from the registry
 * @returns {Promise<boolean>}
 */
async function setOrgBetaFeatures(orgId, features) {
    try {
        await ensureColumn();
        const validIds = new Set(BETA_FEATURES.map(f => f.id));
        const filtered = features.filter(id => validIds.has(id));
        await run('UPDATE organizations SET beta_features = $1 WHERE id = $2', [JSON.stringify(filtered), orgId]);
        return true;
    } catch (err) {
        console.error('[BetaFeatures] setOrgBetaFeatures error:', err);
        return false;
    }
}

/**
 * Resolve the full set of beta features available to a user.
 * Super admins get ALL features.
 *
 * @param {string} userId
 * @param {object|null} session — express session (for isAdmin/isDemo flags)
 * @returns {Promise<string[]>} array of feature IDs
 */
async function getUserBetaFeatures(userId, session = null) {
    if (session?.isDemo || session?.isAdmin) {
        return BETA_FEATURES.map(f => f.id);
    }

    try {
        const userStore = require('../stores/userStore');
        const user = await userStore.getUser(userId);
        if (!user) return [];

        if (user.role === 'admin') return BETA_FEATURES.map(f => f.id);

        let groupIds = [];
        if (Array.isArray(user.groups)) {
            groupIds = user.groups;
        } else {
            try { groupIds = JSON.parse(user.groups || '[]'); } catch (_) { }
        }

        const allGroups = await userStore.getAllGroups();
        const orgIds = new Set();
        if (user.organizationId) orgIds.add(user.organizationId);
        for (const gid of groupIds) {
            const group = allGroups.find(g => g.id === gid);
            if (group?.organizationId) orgIds.add(group.organizationId);
        }

        const featureSet = new Set();
        for (const orgId of orgIds) {
            for (const fid of await getOrgBetaFeatures(orgId)) {
                featureSet.add(fid);
            }
        }

        return [...featureSet];
    } catch (err) {
        console.error('[BetaFeatures] getUserBetaFeatures error:', err);
        return [];
    }
}

/**
 * Check if a specific user has access to a beta feature.
 */
async function userHasBetaFeature(userId, featureId, session = null) {
    return (await getUserBetaFeatures(userId, session)).includes(featureId);
}

/**
 * Express middleware factory — gates a route behind a beta feature flag.
 */
function requireBetaFeature(featureId) {
    return async (req, res, next) => {
        if (!req.session.isAuthenticated) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const userId = req.session.user?.id;
        if (await userHasBetaFeature(userId, featureId, req.session)) {
            next();
        } else {
            res.status(403).json({ error: `Beta feature '${featureId}' is not enabled for your organization` });
        }
    };
}

module.exports = {
    BETA_FEATURES,
    getOrgBetaFeatures,
    setOrgBetaFeatures,
    getUserBetaFeatures,
    userHasBetaFeature,
    requireBetaFeature,
};
