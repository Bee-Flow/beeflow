// Compute the set of tier keys a given user is allowed to select.
// Mirrors the gating logic in GET /ai/config/tiers-for-user so server-side
// validators (e.g. the agent PUT endpoint) can reject tiers the user can't use.
//
// `taskType` defaults to 'direct_chat' which is the only context where the
// direct-chat-only tiers (`standard`/Flow and `swarm`) are valid.

const userStore = require('../stores/userStore');
const { userHasBetaFeature } = require('./betaFeatures');

const STANDARD_TIER_KEYS = ['fast', 'standard', 'swarm', 'thinking', 'writer', 'pro'];

async function getPermittedTierKeys({ userId, session, taskType = 'direct_chat' }) {
    if (!userId) return new Set();

    const user = await userStore.getUser(userId).catch(() => null);
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
    return allowed;
}

module.exports = { getPermittedTierKeys };
