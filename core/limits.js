/**
 * Subscription Limit Enforcement
 * 
 * Shared module for checking subscription-based usage limits.
 * Used by agent chat, direct chat, group chat, and resource creation.
 * Supports both org-scoped limits and consumer account limits.
 */

const userStore = require('../stores/userStore');
const usageStore = require('../stores/usageStore');

// ── Consumer account limits ──────────────────────────────────────────────────

/**
 * Check limits for consumer (org-less) accounts.
 * Looks up a system plan named '__consumer_default__' and enforces
 * its limits against per-user usage.
 * 
 * @param {string} userId - User ID
 * @param {string} agentType - 'chat' | 'browser' | etc.
 * @returns {Promise<string|null>} Error message if limit exceeded, null otherwise
 */
async function checkConsumerLimits(userId, agentType) {
    const allPlans = await userStore.getAllPlans();
    const consumerPlan = allPlans.find(p => p.name === '__consumer_default__');
    if (!consumerPlan) return null; // No consumer plan = no limits

    const limits = consumerPlan;
    const now = new Date();
    // Consumer billing period: rolling calendar month from 1st
    const startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endDate = now.toISOString();

    const summary = await usageStore.getUsageSummary({ startDate, endDate, userId });

    // Check total messages limit
    if (limits.max_messages_per_month !== null && limits.max_messages_per_month !== undefined) {
        if ((summary.total_calls || 0) >= limits.max_messages_per_month) {
            return `You have reached your monthly message limit (${limits.max_messages_per_month.toLocaleString()} messages). Upgrade to an organization plan for higher limits.`;
        }
    }

    // Check total tokens limit
    if (limits.max_tokens_per_month !== null && limits.max_tokens_per_month !== undefined) {
        if ((summary.total_tokens || 0) >= limits.max_tokens_per_month) {
            return `You have reached your monthly token limit (${limits.max_tokens_per_month.toLocaleString()} tokens). Upgrade to an organization plan for higher limits.`;
        }
    }

    // Check cost limit
    if (limits.max_cost_per_month !== null && limits.max_cost_per_month !== undefined) {
        if ((summary.total_estimated_cost || 0) >= limits.max_cost_per_month) {
            return `You have reached your monthly cost limit (\u20ac${limits.max_cost_per_month.toFixed(2)}). Upgrade to an organization plan for higher limits.`;
        }
    }

    // Check per-agent-type message limit
    if (limits.max_messages_by_type && agentType && limits.max_messages_by_type[agentType] !== undefined) {
        const typeLimit = limits.max_messages_by_type[agentType];
        if (typeLimit !== null) {
            const byType = await usageStore.getUsageByAgentType({ startDate, endDate, userId });
            const typeUsage = byType.find(t => t.agent_type === agentType);
            if (typeUsage && typeUsage.calls >= typeLimit) {
                const typeLabels = { chat: 'Chat', browser: 'Browser Agent', terminal: 'Terminal Agent', security: 'Security Agent', swarm: 'Swarm' };
                return `You have reached your monthly ${typeLabels[agentType] || agentType} message limit (${typeLimit.toLocaleString()} messages). Upgrade to an organization plan for higher limits.`;
            }
        }
    }

    return null;
}

/**
 * Check consumer resource limits against the __consumer_default__ plan.
 * 
 * @param {string} userId - User ID
 * @param {'agents'|'knowledge_sources'} resourceType - Type of resource
 * @param {number} currentCount - Current count of resources owned by user
 * @returns {Promise<string|null>} Error message if limit exceeded, null otherwise
 */
async function checkConsumerResourceLimits(userId, resourceType, currentCount) {
    const allPlans = await userStore.getAllPlans();
    const consumerPlan = allPlans.find(p => p.name === '__consumer_default__');
    if (!consumerPlan) return null;

    const fieldMap = {
        agents: 'max_agents',
        knowledge_sources: 'max_knowledge_sources',
    };
    const field = fieldMap[resourceType];
    if (!field) return null;

    const max = consumerPlan[field];
    if (max !== null && max !== undefined && currentCount >= max) {
        const labels = { agents: 'agents', knowledge_sources: 'knowledge sources' };
        return `You have reached your limit of ${max} ${labels[resourceType]}. Upgrade to an organization plan for higher limits.`;
    }
    return null;
}

// ── Org-scoped limits ────────────────────────────────────────────────────────

/**
 * Check if an organisation has exceeded any subscription limits.
 * For consumer accounts (no org), falls back to consumer plan limits.
 * Returns an error message string if blocked, or null if OK.
 * 
 * @param {string|null} orgId - Organisation ID
 * @param {string} agentType - 'chat' | 'browser' | 'terminal' | 'security' | 'swarm'
 * @param {string|null} userId - User ID (used for consumer account fallback)
 * @returns {Promise<string|null>} Error message if limit exceeded, null otherwise
 */
async function checkSubscriptionLimits(orgId, agentType, userId = null) {
    if (!orgId) {
        // Consumer account — check per-user limits
        if (!userId) return null;
        return checkConsumerLimits(userId, agentType);
    }
    const limits = await userStore.getEffectiveLimits(orgId);
    if (!limits) return null; // No subscription = no limits

    // Suspended or cancelled orgs are fully blocked
    if (limits.status === 'suspended') return 'Your organization\'s subscription is suspended. Please contact your administrator.';
    if (limits.status === 'cancelled') return 'Your organization\'s subscription has been cancelled. Please contact your administrator.';

    // Get usage for the current billing period (respects billing_cycle_start)
    const sub = await userStore.getOrgSubscription(orgId);
    const period = userStore.getBillingPeriod(sub);
    const summary = await usageStore.getUsageSummary({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: orgId });

    // Check total messages limit
    if (limits.max_messages_per_month !== null && limits.max_messages_per_month !== undefined) {
        if ((summary.total_calls || 0) >= limits.max_messages_per_month) {
            return `Your organization has reached its monthly message limit (${limits.max_messages_per_month.toLocaleString()} messages). Please contact your administrator.`;
        }
    }

    // Check total tokens limit
    if (limits.max_tokens_per_month !== null && limits.max_tokens_per_month !== undefined) {
        if ((summary.total_tokens || 0) >= limits.max_tokens_per_month) {
            return `Your organization has reached its monthly token limit (${limits.max_tokens_per_month.toLocaleString()} tokens). Please contact your administrator.`;
        }
    }

    // Check cost limit
    if (limits.max_cost_per_month !== null && limits.max_cost_per_month !== undefined) {
        if ((summary.total_estimated_cost || 0) >= limits.max_cost_per_month) {
            return `Your organization has reached its monthly cost limit (\u20ac${limits.max_cost_per_month.toFixed(2)}). Please contact your administrator.`;
        }
    }

    // Check per-agent-type message limit
    if (limits.max_messages_by_type && agentType && limits.max_messages_by_type[agentType] !== undefined) {
        const typeLimit = limits.max_messages_by_type[agentType];
        if (typeLimit !== null) {
            const byType = await usageStore.getUsageByAgentType({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: orgId });
            const typeUsage = byType.find(t => t.agent_type === agentType);
            if (typeUsage && typeUsage.calls >= typeLimit) {
                const typeLabels = { chat: 'Chat', browser: 'Browser Agent', terminal: 'Terminal Agent', security: 'Security Agent', swarm: 'Swarm' };
                return `Your organization has reached its monthly ${typeLabels[agentType] || agentType} message limit (${typeLimit.toLocaleString()} messages). Please contact your administrator.`;
            }
        }
    }

    return null; // All good
}

/**
 * Check if creating a new resource would exceed org limits.
 * For consumer accounts, falls back to consumer plan limits.
 * Returns an error message string if blocked, or null if OK.
 * 
 * @param {string|null} orgId - Organisation ID
 * @param {'users'|'agents'|'knowledge_sources'} resourceType - Type of resource
 * @param {number} currentCount - Current count of resources
 * @param {string|null} userId - User ID (used for consumer account fallback)
 * @returns {Promise<string|null>} Error message if limit exceeded, null otherwise
 */
async function checkResourceLimits(orgId, resourceType, currentCount, userId = null) {
    if (!orgId) {
        // Consumer account — check per-user resource limits
        if (!userId) return null;
        return checkConsumerResourceLimits(userId, resourceType, currentCount);
    }
    const limits = await userStore.getEffectiveLimits(orgId);
    if (!limits) return null;

    const fieldMap = {
        users: 'max_users',
        agents: 'max_agents',
        knowledge_sources: 'max_knowledge_sources',
    };

    const field = fieldMap[resourceType];
    if (!field) return null;

    const max = limits[field];
    if (max !== null && max !== undefined && currentCount >= max) {
        const labels = { users: 'users', agents: 'agents', knowledge_sources: 'knowledge sources' };
        return `Your organization has reached its limit of ${max} ${labels[resourceType]}. Please upgrade your plan or contact your administrator.`;
    }

    return null;
}

/**
 * Resolve the user's primary org ID from request session.
 * Returns orgId string or null.
 */
async function resolveOrgId(req) {
    const userId = req.session?.user?.id;
    if (!userId) return null;
    // Super admin has no org restriction
    if (req.session?.isAdmin || req.session?.user?.role === 'admin') return null;
    try {
        const user = await userStore.getUser(userId);
        if (user?.organizationId) return user.organizationId;
    } catch (_) { }
    return null;
}

module.exports = {
    checkSubscriptionLimits,
    checkResourceLimits,
    checkConsumerLimits,
    checkConsumerResourceLimits,
    resolveOrgId,
};
