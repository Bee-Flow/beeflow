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
    { id: 'meeting_notes', name: 'Meeting Notes', description: 'Audio transcription, meeting summaries, and action item extraction' },
    { id: 'advanced_analytics', name: 'Advanced Analytics', description: 'Extended analytics dashboards and reporting' },
    { id: 'ai_code_execution', name: 'AI Code Execution', description: 'Allow the AI agent to execute code in a sandboxed environment' },
    { id: 'custom_themes', name: 'Custom Themes', description: 'Organization-level custom branding and theme support' },
    { id: 'skills', name: 'Skills', description: 'Reusable instruction packs for consistent AI task execution' },
    { id: 'itil_ticket_assistant', name: 'ITIL Ticket Assistant', description: 'Connect ITSM platforms (Jira, ServiceNow, Zendesk, Freshservice, TopDesk) and email mailboxes as knowledge base sources. Tickets + emails are turned into structured solution articles (Root Cause / Resolution) for agent self-service.' },
    // Legacy alias — retained for one release. The initDB() migration in
    // ticketAssistantStore.js rewrites stored org beta_features from
    // 'email_knowledge_base' to 'itil_ticket_assistant' on boot; this entry
    // keeps membership lookups working during the transition window.
    { id: 'email_knowledge_base', name: 'Email Knowledge Base (deprecated)', description: 'Renamed to "ITIL Ticket Assistant". Existing enablements are auto-migrated.', aliasOf: 'itil_ticket_assistant', deprecated: true },
    { id: 'voice_chat', name: 'Voice Chat (Beta)', description: 'Realtime voice conversation with direct chat or agents, powered by Mistral Voxtral (STT + TTS). Requires a configured Mistral API key.' },
    { id: 'swarm', name: 'Swarm Agents', description: 'Multi-agent swarms (Deep Research, etc.) that run specialised AI workers in parallel phases and synthesise a single answer. Workers share findings via a Hive Mind notebook.' },
];

// -──────────────────────────────────────────────
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
 * Given a feature ID, return the set of IDs that count as "the same feature"
 * for access-check purposes — the canonical target plus any deprecated
 * aliases pointing to it (and the reverse direction).
 */
function resolveFeatureAliases(featureId) {
    const ids = new Set([featureId]);
    for (const entry of BETA_FEATURES) {
        if (entry.id === featureId && entry.aliasOf) ids.add(entry.aliasOf);
        if (entry.aliasOf === featureId) ids.add(entry.id);
    }
    return ids;
}

/**
 * Check if a specific user has access to a beta feature.
 * Aliased feature IDs (e.g. legacy 'email_knowledge_base' →
 * 'itil_ticket_assistant') are treated as equivalent.
 */
async function userHasBetaFeature(userId, featureId, session = null) {
    const aliases = resolveFeatureAliases(featureId);
    const userFeatures = await getUserBetaFeatures(userId, session);
    return userFeatures.some(id => aliases.has(id));
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
