// Compute the set of tier keys a given user is allowed to select.
// Mirrors the gating logic in GET /ai/config/tiers-for-user so server-side
// validators (e.g. the agent PUT endpoint) can reject tiers the user can't use.
//
// `taskType` defaults to 'direct_chat' which is the only context where the
// direct-chat-only tiers (`standard`/Flow and `swarm`) are valid.

const userStore = require('../stores/userStore');
const configStore = require('../stores/configStore');
const { userHasBetaFeature } = require('./betaFeatures');

const STANDARD_TIER_KEYS = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'];

// Load global + org custom tiers (org wins on id collision). Mirrors
// loadMergedCustomTiers in routes/ai/config.js — kept here so the validator
// doesn't depend on the route file.
async function loadMergedCustomTiersForOrg(orgId) {
    const global = (await configStore.getConfig('custom_chat_model_tiers').catch(() => [])) || [];
    const org = orgId
        ? (await configStore.getConfig(`custom_chat_model_tiers_org_${orgId}`).catch(() => [])) || []
        : [];
    const byId = new Map();
    for (const t of (Array.isArray(global) ? global : [])) if (t && t.id) byId.set(t.id, t);
    for (const t of (Array.isArray(org) ? org : [])) if (t && t.id) byId.set(t.id, t);
    return Array.from(byId.values());
}

async function getPermittedTierKeys({ userId, session, taskType = 'direct_chat' }) {
    if (!userId) return new Set();

    const user = await userStore.getUser(userId).catch(() => null);
    const userOrgId = user?.organizationId || session?.user?.organizationId || null;
    const userGroupIds = Array.isArray(user?.groups) ? user.groups : [];
    const allGroups = await userStore.getAllGroups().catch(() => []);
    const userGroups = allGroups.filter(g => userGroupIds.includes(g.id));

    const tierPermittedByGroups = (tierId) => {
        if (userGroups.length === 0) return true;
        return userGroups.some(g => {
            const list = Array.isArray(g.allowedTiers) ? g.allowedTiers : [];
            return list.length === 0 || list.includes(tierId);
        });
    };

    const hasSkillsFeature = await userHasBetaFeature(userId, 'skills', session).catch(() => false);
    const hasSwarmFeature = await userHasBetaFeature(userId, 'swarm', session).catch(() => false);

    const allowed = new Set();
    if (tierPermittedByGroups('auto')) allowed.add('auto');
    for (const key of STANDARD_TIER_KEYS) {
        if ((key === 'standard' || key === 'swarm') && taskType !== 'direct_chat') continue;
        if (key === 'standard' && !hasSkillsFeature) continue;
        if (key === 'swarm' && !hasSwarmFeature) continue;
        if (!tierPermittedByGroups(key)) continue;
        allowed.add(key);
    }

    // Custom tiers — gated by the same group `allowedTiers` rule, plus the
    // `allowedTaskTypes` array on each tier definition.
    const customTiers = await loadMergedCustomTiersForOrg(userOrgId).catch(() => []);
    for (const t of customTiers) {
        if (!t || !t.id) continue;
        if (taskType && Array.isArray(t.allowedTaskTypes) && !t.allowedTaskTypes.includes(taskType)) continue;
        if (!tierPermittedByGroups(t.id)) continue;
        allowed.add(t.id);
    }

    return allowed;
}

module.exports = { getPermittedTierKeys };
