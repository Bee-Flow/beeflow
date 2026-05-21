/**
 * Subscription Limit Enforcement
 * 
 * Shared module for checking subscription-based usage limits.
 * Used by agent chat, direct chat, group chat, and resource creation.
 * Supports both org-scoped limits and consumer account limits.
 */

const userStore = require('../stores/userStore');
const usageStore = require('../stores/usageStore');
const license = require('../license');

// One-shot 80 %-of-cap notification. Sends a single email to the org's
// admin(s) per billing period. Idempotency is enforced via the
// notifications_sent table — the key `(organization, orgId,
// 'cost_threshold_80:<period>')` is unique. Failures are swallowed.
async function _notifyCostThreshold(orgId, cap, current, periodKey) {
    try {
        const kind = `cost_threshold_80:${periodKey}`;
        const claimed = await userStore.claimNotification(
            'organization', orgId, kind,
            null, { cap, current }
        );
        if (!claimed) return; // already sent this period

        const { getAll } = require('../db');
        const admins = await getAll(
            `SELECT email FROM users WHERE "organizationId" = $1 AND (role = 'admin' OR "orgRole" IN ('org_admin', 'admin')) AND email IS NOT NULL AND email <> '' LIMIT 5`,
            [orgId],
        );
        const recipients = (admins || []).map(a => a.email).filter(Boolean);
        if (recipients.length === 0) return;

        const { sendServiceEmail } = require('../utils/emailService');
        const pct = Math.round((current / cap) * 100);
        const subject = `Bee Flow: ${pct}% of your monthly cost limit reached`;
        const text = `Your organization has used €${current.toFixed(2)} of the €${cap.toFixed(2)} monthly limit (${pct}%). When usage reaches 100%, AI calls will be blocked until the next billing period.\n\nContact your administrator to raise the cap if needed.`;
        await sendServiceEmail({ to: recipients.join(', '), subject, text }).catch(() => {});
    } catch (e) {
        console.warn('[Limits] cost threshold notify failed:', e.message);
    }
}

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
    // Self-hosted installs don't have Stripe-backed subscriptions. Skip the
    // whole limit-check stack so a misconfigured DEPLOYMENT_MODE can't
    // silently activate cloud billing on a self-hosted server.
    if ((process.env.DEPLOYMENT_MODE || 'cloud') === 'self-hosted') return null;
    if (!orgId) {
        // Consumer account — check per-user limits
        if (!userId) return null;
        return checkConsumerLimits(userId, agentType);
    }
    const limits = await userStore.getEffectiveLimits(orgId);
    if (!limits) {
        // No active subscription on cloud — block all paid surfaces. The
        // UI redirects org admins to the License page where they can pick
        // a plan; everyone else gets this 403 message until an admin
        // subscribes. Self-hosted is short-circuited above.
        return 'Your organization does not have an active subscription. Ask an organisation admin to choose a plan in Settings → Organisation → License & Usage.';
    }

    // Suspended or cancelled orgs are fully blocked
    if (limits.status === 'suspended') return 'Your organization\'s subscription is suspended. Please contact your administrator.';
    if (limits.status === 'cancelled') return 'Your organization\'s subscription has been cancelled. Please contact your administrator.';

    // Get usage for the current billing period (respects billing_cycle_start)
    const sub = await userStore.getOrgSubscription(orgId);
    const period = userStore.getBillingPeriod(sub);
    const summary = await usageStore.getUsageSummary({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: orgId });

    // Resolve pooled vs per-user budget mode for this org. '1' = pooled
    // (legacy default); '0' = each active seat gets cap / seats as their
    // personal slice. Failure to load the row falls back to pooled.
    let pooled = true;
    try {
        const org = await userStore.getOrganization(orgId);
        pooled = (org?.usage_pooled ?? '1') !== '0' && org?.usagePooled !== false;
    } catch (_) { /* keep pooled = true */ }

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

    // Check cost limit. For PAYG plans the billed_cost (post-markup) is the
    // figure the customer actually pays, so prefer it when available; fall
    // back to estimated_cost for fixed plans. The hard stop kicks in at
    // 100 % and an idempotent 80 %-of-cap warning email is sent once per
    // (orgId, billing-period) tuple. Both gates are keyed on the same
    // billing window so the warning resets cleanly each period.
    //
    // When the org runs in per-user mode (`usage_pooled = '0'`), each user
    // gets cap / max(active_seats, 1) as a personal slice. The org-wide
    // warning email still fires off the pooled total at 80 % so the admin
    // sees plan-wide pressure regardless of mode.
    if (limits.max_cost_per_month !== null && limits.max_cost_per_month !== undefined) {
        const billed = Number(summary.total_billed_cost || 0);
        const estimated = Number(summary.total_estimated_cost || 0);
        const cost = billed > 0 ? billed : estimated;
        const cap = Number(limits.max_cost_per_month);
        if (pooled) {
            if (cost >= cap) {
                return `Your organization has reached its monthly cost limit (\u20ac${cap.toFixed(2)}). Please contact your administrator.`;
            }
        } else if (userId) {
            const seats = Math.max(1, await userStore.getActiveSeatCount(orgId).catch(() => 1));
            const perUserCap = cap / seats;
            const uSummary = await usageStore.getUsageSummary({ startDate: period.startDate, endDate: new Date().toISOString(), organizationId: orgId, userId });
            const uBilled = Number(uSummary?.total_billed_cost || 0);
            const uEstimated = Number(uSummary?.total_estimated_cost || 0);
            const uCost = uBilled > 0 ? uBilled : uEstimated;
            if (uCost >= perUserCap) {
                return `You have reached your personal AI usage budget for this period (\u20ac${perUserCap.toFixed(2)}). Pooled usage is disabled \u2014 contact your administrator.`;
            }
        }
        if (cap > 0 && cost >= cap * 0.8) {
            // Fire-and-forget 80 % warning, gated by claimNotification so a
            // hot loop of chat requests doesn't fan out to N emails.
            const periodKey = (period.startDate || '').slice(0, 10); // YYYY-MM-DD
            setImmediate(() => {
                _notifyCostThreshold(orgId, cap, cost, periodKey).catch(() => {});
            });
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

    const fieldMap = {
        users: 'max_users',
        agents: 'max_agents',
        knowledge_sources: 'max_knowledge_sources',
    };
    const field = fieldMap[resourceType];
    if (!field) return null;

    let max = limits ? limits[field] : null;

    // For 'users', a license-issued seat cap also applies. When both a
    // subscription plan limit and a license max_seats exist, the lower of
    // the two wins — a customer can't bypass a seat-licensed pack by
    // bolting it onto a higher-tier subscription plan.
    if (resourceType === 'users') {
        try {
            const seatCap = await license.getMaxSeatsForOrg(orgId);
            if (seatCap !== null && (max === null || max === undefined || seatCap < max)) {
                max = seatCap;
            }
        } catch (_) { /* license module unavailable — don't fail open in production but don't crash either */ }
    }

    // Inclusive-cap convention: `max` means "you may have up to N", so the
    // (N+1)th creation is blocked. Matches the seat-cap enforcement in
    // userStore.createUserWithSeatCheck (FOR UPDATE COUNT ≥ max → block).
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
