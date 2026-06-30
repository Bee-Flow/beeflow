/**
 * Support Tools — read-only lookups the Bee Flow Support AI agent may call
 * while drafting a customer reply. Exposed only to the system support agent
 * (gated in agentTools/the responder), never to tenant agents.
 *
 * Security model: the thread under discussion is fixed by the responder via
 * `context.supportThreadId`. Tools IGNORE any threadId the model might pass in
 * args and always re-derive the thread from that context, so the model cannot
 * pivot to another customer's data. Every tool is strictly read-only.
 */

const supportStore = require('../stores/supportStore');
const userStore = require('../stores/userStore');

const SUPPORT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'support_get_requester_profile',
            description: 'Look up the customer behind the current support thread: name, email, whether they are logged-in, their role in their organization, and account age. Use to personalise the reply or verify who you are talking to.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_get_organization_info',
            description: 'Organization metadata for the current thread\'s customer: org name and creation date. Returns null when the thread is anonymous (no linked org).',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_get_subscription_status',
            description: 'Subscription/plan status for the customer\'s organization: plan name, tier, status (active/trialing/past_due/cancelled), and renewal date. Read-only. Returns null for anonymous threads.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_list_recent_threads_for_requester',
            description: 'List up to 10 recent support threads from the same customer (subject, status, resolved date) so you can spot repeat or related issues.',
            parameters: {
                type: 'object',
                properties: { limit: { type: 'integer', description: 'Max threads to return (1-10).' } },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_search_knowledge_base',
            description: 'Search the Bee Flow support knowledge base. Use whenever the question is about features, configuration, billing policy, or known limitations. Returns matching article snippets with titles.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search query.' },
                    topK: { type: 'integer', description: 'Number of results (default 4).' },
                },
                required: ['query'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_list_canned_responses',
            description: 'List the canned-response templates available for this thread (already variable-substituted). You may adapt their wording stylistically but must never paste a template verbatim.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

// ── Action tools — let the agent MUTATE the ticket it is handling ─────────────
// Same security model as the read tools: the thread is fixed by the responder
// via context.supportThreadId; the model can never target another ticket. Every
// action is audited and reversible, gated by the inbox reply-mode (see below),
// and never sends customer email (replies always go through the normal path).
const SUPPORT_ACTION_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'support_set_priority',
            description: 'Set the priority of the current ticket when the customer message clearly signals urgency (e.g. outage, payment failure) or the opposite. Use sparingly.',
            parameters: { type: 'object', properties: { priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] } }, required: ['priority'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_add_tag',
            description: 'Add an existing organisation tag to the current ticket to aid triage/reporting. Only tags from the team taxonomy are accepted.',
            parameters: { type: 'object', properties: { tag: { type: 'string', description: 'Tag name from the team taxonomy.' } }, required: ['tag'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_set_category',
            description: 'Set a short free-text category for the current ticket (e.g. "billing", "bug", "how-to").',
            parameters: { type: 'object', properties: { category: { type: 'string' } }, required: ['category'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_set_status',
            description: 'Change the workflow status of the current ticket. "awaiting_user" = you replied and are waiting on the customer; "awaiting_agent" = needs a human; "resolved" = the issue is fully handled.',
            parameters: { type: 'object', properties: { status: { type: 'string', enum: ['awaiting_user', 'awaiting_agent', 'resolved'] } }, required: ['status'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_request_more_info',
            description: 'Mark the current ticket as waiting on the customer because you need more information from them to proceed. Use after your reply asks a clarifying question.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_assign_to_teammate',
            description: 'Assign the current ticket to a specific human teammate by their user id (use only ids surfaced to you).',
            parameters: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'support_escalate_to_human',
            description: 'Hand the current ticket off to a human agent with a short reason. Use when you cannot safely resolve it yourself.',
            parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
        },
    },
];

// Action levels by reply mode (Tom: actions allowed "fully, but depending on the
// config for full mode"). Each level lists the action tool names it exposes; the
// 'resolved' status value is additionally gated to the 'full' level inside the
// executor. Read tools are always available when 'builtin:read' is enabled.
const ACTION_LEVELS = {
    none: [],
    low: ['support_set_priority', 'support_add_tag', 'support_set_category'],
    mid: ['support_set_priority', 'support_add_tag', 'support_set_category',
        'support_set_status', 'support_request_more_info', 'support_assign_to_teammate', 'support_escalate_to_human'],
    full: ['support_set_priority', 'support_add_tag', 'support_set_category',
        'support_set_status', 'support_request_more_info', 'support_assign_to_teammate', 'support_escalate_to_human'],
};

function actionLevelForMode(replyMode) {
    if (replyMode === 'autonomous') return 'full';
    if (replyMode === 'auto_confident') return 'mid';
    if (replyMode === 'draft') return 'low';
    return 'none'; // legacy / unknown
}

const _READ_NAMES = new Set(SUPPORT_TOOLS.map(t => t.function.name));
const _ACTION_NAMES = new Set(SUPPORT_ACTION_TOOLS.map(t => t.function.name));

function isSupportTool(toolName) {
    return _READ_NAMES.has(toolName) || _ACTION_NAMES.has(toolName);
}

function isSupportActionTool(toolName) {
    return _ACTION_NAMES.has(toolName);
}

/**
 * Build the tool definitions exposed to the support agent for a run.
 * @param {{enabledToolIds?: string[], toolsEnabled?: boolean, replyMode?: string}} cfg
 * Returns { tools, actionLevel } — `tools` is the OpenAI tool array to inject as
 * extraTools; the model only ever sees tools it is permitted to call.
 */
function buildSupportToolset({ enabledToolIds, toolsEnabled, replyMode } = {}) {
    let ids = Array.isArray(enabledToolIds) ? enabledToolIds.slice() : [];
    if (!ids.length && toolsEnabled) ids = ['builtin:read']; // legacy tools_enabled → read-only
    const tools = [];
    if (ids.includes('builtin:read')) tools.push(...SUPPORT_TOOLS);
    let actionLevel = 'none';
    if (ids.includes('builtin:action')) {
        actionLevel = actionLevelForMode(replyMode);
        const allowedNames = new Set(ACTION_LEVELS[actionLevel] || []);
        tools.push(...SUPPORT_ACTION_TOOLS.filter(t => allowedNames.has(t.function.name)));
    }
    return { tools, actionLevel };
}

/** Per-run policy object the executor mutates (budget + clobber signalling). */
function makeActionPolicy({ actionLevel = 'none', budget = 5 } = {}) {
    return {
        actionLevel,
        allowed: new Set(ACTION_LEVELS[actionLevel] || []),
        budget,
        used: 0,
        statusChangedByTool: false,
    };
}

/** Best-effort live refresh after an action (tenant SSE is inbox-scoped). */
function _emitThreadUpdated(thread) {
    try {
        if (!thread?.inbox_id) return;
        const { supportEvents } = require('../routes/support');
        supportEvents.emit('event', { event: 'thread_updated', data: { threadId: thread.id, inboxId: thread.inbox_id } });
    } catch { /* non-fatal */ }
}

async function _resolveThread(context) {
    const threadId = context?.supportThreadId || context?.userAuth?.supportThreadId || null;
    if (!threadId) return null;
    return supportStore.getThread(threadId);
}

async function _recordAction(threadId, tool, payload = {}) {
    try {
        await supportStore.recordThreadEvent({ threadId, actorKind: 'ai', action: 'ai_action', payload: { tool, ...payload } });
    } catch { /* audit is best-effort */ }
}

// The group ACL on the thread's inbox ([] = open). Used so AI assignment/
// escalation never strands a ticket on a teammate who can't access the inbox.
async function _inboxSharedGroups(thread) {
    if (!thread?.inbox_id) return [];
    try {
        const inbox = await require('../stores/supportInboxStore').getInbox(thread.inbox_id);
        return Array.isArray(inbox?.shared_groups) ? inbox.shared_groups : [];
    } catch { return []; }
}

/**
 * Execute a MUTATING support tool. Enforces the per-run action policy (level +
 * budget), audits every change, and signals status clobber so the responder can
 * yield. Never sends customer email.
 */
async function executeSupportActionTool(toolName, args, context, thread) {
    const policy = context?.supportActionPolicy || context?.userAuth?.supportActionPolicy || null;
    if (!policy || policy.actionLevel === 'none') return { error: 'Action tools are not enabled for this inbox.' };
    if (!policy.allowed || !policy.allowed.has(toolName)) {
        return { error: `This action is not permitted in the current reply mode (level: ${policy.actionLevel}).` };
    }
    if (policy.used >= policy.budget) return { error: `Action budget exhausted (max ${policy.budget} per turn).` };

    let result;
    switch (toolName) {
        case 'support_set_priority': {
            const priority = String(args.priority || '').toLowerCase();
            if (!['low', 'normal', 'high', 'urgent'].includes(priority)) return { error: 'invalid priority' };
            await supportStore.updateThread(thread.id, { priority });
            await _recordAction(thread.id, toolName, { priority });
            result = { ok: true, priority };
            break;
        }
        case 'support_add_tag': {
            const tag = String(args.tag || '').trim();
            if (!tag) return { error: 'tag required' };
            const taxonomy = await supportStore.listTags(thread.organization_id || null);
            const match = taxonomy.find(t => t.name.toLowerCase() === tag.toLowerCase());
            if (!match) return { error: 'Tag is not in the team taxonomy.' };
            await supportStore.addThreadTag(thread.id, match.name);
            await _recordAction(thread.id, toolName, { tag: match.name });
            result = { ok: true, tag: match.name };
            break;
        }
        case 'support_set_category': {
            const category = String(args.category || '').trim().slice(0, 100);
            if (!category) return { error: 'category required' };
            await supportStore.updateThread(thread.id, { category });
            await _recordAction(thread.id, toolName, { category });
            result = { ok: true, category };
            break;
        }
        case 'support_set_status': {
            const status = String(args.status || '');
            const allowedValues = policy.actionLevel === 'full'
                ? ['awaiting_user', 'awaiting_agent', 'resolved']
                : ['awaiting_user', 'awaiting_agent'];
            if (!allowedValues.includes(status)) return { error: `Status "${status}" not permitted at this level.` };
            const patch = { status };
            if (status === 'resolved' && thread.status !== 'resolved') patch.resolved_at = new Date().toISOString();
            await supportStore.updateThread(thread.id, patch);
            policy.statusChangedByTool = true;
            await _recordAction(thread.id, toolName, { status });
            result = { ok: true, status };
            break;
        }
        case 'support_request_more_info': {
            await supportStore.updateThread(thread.id, { status: 'awaiting_user' });
            policy.statusChangedByTool = true;
            await _recordAction(thread.id, toolName, {});
            result = { ok: true, status: 'awaiting_user' };
            break;
        }
        case 'support_assign_to_teammate': {
            const userId = String(args.userId || '').trim();
            if (!userId) return { error: 'userId required' };
            const { _eligibleStaffForOrg } = require('../services/supportAutoAssigner');
            const eligible = await _eligibleStaffForOrg(thread.organization_id || null).catch(() => []);
            if (!eligible.includes(userId)) return { error: 'Not an eligible teammate for this organisation.' };
            // On a group-restricted inbox the assignee must be able to work it,
            // otherwise the ticket is stranded with someone who'd be 403'd.
            const sharedGroups = await _inboxSharedGroups(thread);
            if (sharedGroups.length) {
                const access = require('../support/access');
                const g = await access.userGroupsFor(userId);
                if (!g.some(x => sharedGroups.includes(x))) {
                    return { error: 'That teammate does not have access to this inbox.' };
                }
            }
            await supportStore.updateThread(thread.id, { assignee_user_id: userId, auto_assigned: false });
            await _recordAction(thread.id, toolName, { assignee_user_id: userId });
            result = { ok: true };
            break;
        }
        case 'support_escalate_to_human': {
            const reason = String(args.reason || 'escalated by AI').slice(0, 200);
            await supportStore.appendMessage({ threadId: thread.id, authorKind: 'system', body: `AI handed off to a human agent (${reason}).` }).catch(() => {});
            await supportStore.updateThread(thread.id, { status: 'awaiting_agent', ai_handled: true, ai_escalated_reason: reason });
            policy.statusChangedByTool = true;
            try {
                const fresh = await supportStore.getThread(thread.id);
                if (fresh && !fresh.assignee_user_id) {
                    const { pickNextAssignee } = require('../services/supportAutoAssigner');
                    const sharedGroups = await _inboxSharedGroups(thread);
                    const next = await pickNextAssignee(thread.organization_id || null, { sharedGroups });
                    if (next) await supportStore.updateThread(thread.id, { assignee_user_id: next, auto_assigned: true });
                }
            } catch { /* auto-assign best-effort */ }
            await _recordAction(thread.id, toolName, { reason });
            result = { ok: true };
            break;
        }
        default:
            return { error: `Unknown support action tool: ${toolName}` };
    }

    policy.used += 1;
    const fresh = await supportStore.getThread(thread.id).catch(() => thread);
    _emitThreadUpdated(fresh || thread);
    return result || { ok: true };
}

async function executeSupportTool(toolName, args = {}, context = {}) {
    const thread = await _resolveThread(context);
    if (!thread) return { error: 'No support thread context available.' };

    if (isSupportActionTool(toolName)) {
        return executeSupportActionTool(toolName, args, context, thread);
    }

    switch (toolName) {
        case 'support_get_requester_profile': {
            let role = thread.requester_org_role || null;
            let accountCreatedAt = null;
            if (thread.requester_user_id) {
                try {
                    const user = await userStore.getUser(thread.requester_user_id);
                    if (user) {
                        role = role || user.role || null;
                        accountCreatedAt = user.createdAt || user.created_at || null;
                    }
                } catch { /* best-effort */ }
            }
            return {
                name: thread.requester_name || null,
                email: thread.requester_email,
                loggedIn: !!thread.requester_user_id,
                organizationName: thread.requester_org_name || null,
                orgRole: role,
                accountCreatedAt,
            };
        }
        case 'support_get_organization_info': {
            if (!thread.organization_id) return null;
            try {
                const org = await userStore.getOrganization(thread.organization_id);
                if (!org) return null;
                return {
                    id: org.id,
                    name: org.name || null,
                    createdAt: org.createdAt || org.created_at || null,
                };
            } catch (e) {
                return { error: e.message };
            }
        }
        case 'support_get_subscription_status': {
            if (!thread.organization_id) return null;
            try {
                const sub = await userStore.getOrgSubscription(thread.organization_id);
                if (!sub) return { status: 'none', note: 'No subscription on record (likely free/consumer account).' };
                return {
                    planName: sub.plan_name || null,
                    planTier: sub.plan_tier || null,
                    status: sub.status || null,
                    renewsAt: sub.current_period_end || sub.renews_at || null,
                };
            } catch (e) {
                return { error: e.message };
            }
        }
        case 'support_list_recent_threads_for_requester': {
            const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 10);
            const threads = await supportStore.listThreads({
                requesterEmail: thread.requester_email,
                limit,
            });
            return threads
                .filter(t => t.id !== thread.id)
                .map(t => ({
                    subject: t.subject,
                    status: t.status,
                    resolvedAt: t.resolved_at || null,
                    createdAt: t.created_at,
                }));
        }
        case 'support_search_knowledge_base': {
            const query = (args.query || '').toString().trim();
            if (!query) return { error: 'query required' };
            const topK = Math.min(Math.max(parseInt(args.topK, 10) || 4, 1), 8);
            try {
                const { quickKBSearch } = require('../core/agentRuntime/knowledgeSearch');
                const agentStore = require('../stores/agentStore');
                const agent = await agentStore.getAgent('system-bee-flow-support');
                const kbIds = Array.isArray(agent?.config?.knowledge_base_ids) ? agent.config.knowledge_base_ids : [];
                const aiUserId = `support-ai:${thread.id}`;
                const hits = await quickKBSearch(aiUserId, kbIds, query, { topK });
                return (hits || []).map(h => ({ title: h.title, content: h.content, score: h.score, source: h.source_uri }));
            } catch (e) {
                return { error: e.message };
            }
        }
        case 'support_list_canned_responses': {
            try {
                const { renderCannedBody } = require('../routes/support');
                const list = await supportStore.listCannedResponses(thread.organization_id || null);
                return list.map(c => ({
                    title: c.title,
                    shortcut: c.shortcut || null,
                    // Wrapped + rendered so the model treats it as content, not instructions.
                    body: `<canned>${renderCannedBody(c.body, thread, null)}</canned>`,
                }));
            } catch (e) {
                return { error: e.message };
            }
        }
        default:
            return { error: `Unknown support tool: ${toolName}` };
    }
}

module.exports = {
    SUPPORT_TOOLS,
    SUPPORT_ACTION_TOOLS,
    isSupportTool,
    isSupportActionTool,
    executeSupportTool,
    buildSupportToolset,
    makeActionPolicy,
    actionLevelForMode,
};
