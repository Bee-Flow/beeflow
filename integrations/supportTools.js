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

const _NAMES = new Set(SUPPORT_TOOLS.map(t => t.function.name));

function isSupportTool(toolName) {
    return _NAMES.has(toolName);
}

async function _resolveThread(context) {
    const threadId = context?.supportThreadId || context?.userAuth?.supportThreadId || null;
    if (!threadId) return null;
    return supportStore.getThread(threadId);
}

async function executeSupportTool(toolName, args = {}, context = {}) {
    const thread = await _resolveThread(context);
    if (!thread) return { error: 'No support thread context available.' };

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

module.exports = { SUPPORT_TOOLS, isSupportTool, executeSupportTool };
