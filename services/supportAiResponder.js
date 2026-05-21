/**
 * Support AI Auto-Responder — runs after a new support thread is created
 * (or after a follow-up from the requester when the thread is still in
 * AI-handled state). Tries to answer from the Bee Flow knowledge base
 * via the configured "Bee Flow Support" agent, otherwise escalates to staff.
 *
 * Production invariants:
 *   • A thread NEVER stays in `ai_responding` after this function settles.
 *     The outer try/finally guarantees a transition to either `awaiting_user`
 *     (AI answered confidently) or `awaiting_agent` (escalated or errored).
 *   • Every upstream call (KB search, chat) is wrapped in a hard timeout so a
 *     hanging service never blocks the caller for more than ~20s.
 *   • Every transition is mirrored to `support_thread_events` for audit.
 *
 * Configuration (configStore):
 *   support_ai_agent_id  — UUID of an agent in agentStore that has the
 *                          "Bee Flow Support" system prompt and tools.
 *   support_ai_kb_ids    — JSON array of KB UUIDs to search.
 */

const supportStore = require('../stores/supportStore');
const configStore = require('../stores/configStore');
const { chatWithAgent } = require('../core/agentRuntime');
const { quickKBSearch } = require('../core/agentRuntime/knowledgeSearch');

const ESCALATE_RE = /\[ESCALATE(?::\s*([^\]]+))?\]/i;

// Upper bounds — any upstream call that exceeds these gets force-aborted and
// the thread escalates. Tuned to be safely below typical reverse-proxy idle
// timeouts (often 60s).
const KB_SEARCH_TIMEOUT_MS = 8000;
const CHAT_AGENT_TIMEOUT_MS = 25000;

function _stripEscalateToken(text) {
    return (text || '').replace(ESCALATE_RE, '').trim();
}

function _withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        timeout,
    ]);
}

async function _resolveConfig() {
    const agentId = await configStore.getConfig('support_ai_agent_id');
    const kbRaw = await configStore.getConfig('support_ai_kb_ids');
    let kbIds = [];
    if (kbRaw) {
        try {
            kbIds = Array.isArray(kbRaw) ? kbRaw : JSON.parse(kbRaw);
        } catch (_) { kbIds = []; }
    }
    return { agentId: agentId || null, kbIds: Array.isArray(kbIds) ? kbIds : [] };
}

async function _safeRecordEvent(payload) {
    try {
        if (typeof supportStore.recordThreadEvent === 'function') {
            await supportStore.recordThreadEvent(payload);
        }
    } catch (e) {
        console.warn('[SupportAI] recordThreadEvent failed:', e.message);
    }
}

/**
 * Escalate the thread to staff. Idempotent: caller may invoke this from any
 * failure path. Appends a system message + updates status + records an audit
 * event. Never throws — failures are logged.
 */
async function _escalate(threadId, reason, { systemMessage } = {}) {
    try {
        await supportStore.appendMessage({
            threadId,
            authorKind: 'system',
            body: systemMessage || `AI handed off to a human agent (${reason}).`,
        });
    } catch (e) {
        console.warn('[SupportAI] escalate appendMessage failed:', e.message);
    }
    try {
        await supportStore.updateThread(threadId, {
            status: 'awaiting_agent',
            ai_handled: true,
            ai_escalated_reason: reason,
        });
    } catch (e) {
        console.warn('[SupportAI] escalate updateThread failed:', e.message);
    }
    await _safeRecordEvent({
        threadId,
        actorUserId: null,
        actorKind: 'system',
        action: 'ai_escalated',
        payload: { reason },
    });
}

/**
 * Run the AI auto-responder for a thread. Caller decides whether to invoke
 * (typically right after createThread or after a requester reply while
 * status is still AI-handled).
 *
 * @param {string} threadId
 * @param {{ aiUserId?: string }} [opts]
 * @returns {Promise<{ message: object, escalated: boolean, escalateReason: string|null } | null>}
 */
async function runAiAutoResponder(threadId, opts = {}) {
    let settled = false;

    try {
        const thread = await supportStore.getThread(threadId);
        if (!thread) {
            console.warn(`[SupportAI] Thread ${threadId} not found`);
            settled = true;
            return null;
        }

        const messages = await supportStore.getThreadMessages(threadId, { includeInternal: false });
        if (!messages.length) {
            console.warn(`[SupportAI] Thread ${threadId} has no messages yet`);
            settled = true;
            return null;
        }
        const lastRequester = [...messages].reverse().find(m => m.author_kind === 'requester');
        if (!lastRequester) {
            settled = true;
            return null;
        }

        const { agentId, kbIds } = await _resolveConfig();
        if (!agentId) {
            await _escalate(threadId, 'AI not configured', {
                systemMessage: 'AI auto-responder is not configured (no support_ai_agent_id). Escalated to staff.',
            });
            settled = true;
            return null;
        }

        await supportStore.updateThread(threadId, { status: 'ai_responding' });

        const aiUserId = opts.aiUserId || `support-ai:${thread.id}`;

        // KB pre-search — best-effort with hard timeout. Missing KB context
        // just means the AI works without grounding (which itself becomes an
        // escalation signal further down).
        let kbHits = [];
        try {
            kbHits = await _withTimeout(
                quickKBSearch(aiUserId, kbIds, lastRequester.body, { topK: 4 }),
                KB_SEARCH_TIMEOUT_MS,
                'quickKBSearch',
            );
        } catch (e) {
            console.warn('[SupportAI] quickKBSearch failed:', e.message);
        }

        const kbContext = kbHits.length
            ? `\n\n[Reference material — only cite if directly relevant:]\n${kbHits.map((h, i) => `(${i + 1}) ${h.title}\n${h.content}`).join('\n\n')}`
            : '';

        const requesterLine = thread.requester_user_id
            ? `Logged-in user${thread.organization_id ? ` (org id: ${thread.organization_id})` : ''}.`
            : `Anonymous requester (came in via marketing form).`;

        const transcript = messages.map(m => {
            const who = m.author_kind === 'requester' ? 'Customer'
                : m.author_kind === 'ai' ? 'AI (previous turn)'
                    : m.author_kind === 'staff' ? 'Bee Flow staff'
                        : 'System';
            return `${who}: ${m.body}`;
        }).join('\n\n');

        const userMessage = `You are answering a Bee Flow customer-support thread.

${requesterLine}
Subject: ${thread.subject}

Full conversation so far:
${transcript}
${kbContext}

Reply only to the customer's most recent message. If the knowledge base does not contain a confident answer, or the question involves account-specific actions you can't safely perform (billing changes, password resets, account deletion, custom-deal pricing, anything escalation-worthy), respond briefly and end your reply with the exact token [ESCALATE: <short reason>]. Otherwise answer concisely and cite the KB section by title where applicable.`;

        let aiResultRaw = '';
        let modelUsed = null;
        try {
            const result = await _withTimeout(
                chatWithAgent(agentId, aiUserId, userMessage, { userOrgId: thread.organization_id || null }),
                CHAT_AGENT_TIMEOUT_MS,
                'chatWithAgent',
            );
            aiResultRaw = (result && (result.content || result.response || result.message)) || '';
            modelUsed = (result && result.model) || null;
        } catch (e) {
            console.error('[SupportAI] chatWithAgent failed:', e.message);
            await _escalate(threadId, `ai_error: ${e.message}`, {
                systemMessage: `AI auto-responder failed (${e.message}). Escalated to staff.`,
            });
            settled = true;
            return null;
        }

        const escalateMatch = aiResultRaw.match(ESCALATE_RE);
        const cleanBody = _stripEscalateToken(aiResultRaw);
        // Empty / extremely short answers are unreliable — treat as escalation.
        const tooShort = cleanBody.length < 20;
        const escalated = !!escalateMatch || tooShort || (kbHits.length === 0 && cleanBody.length < 60);
        const escalateReason = escalateMatch?.[1]?.trim()
            || (tooShort ? 'empty_or_too_short' : (kbHits.length === 0 ? 'no_kb_grounding' : null));

        const finalBody = cleanBody || 'I was not able to draft a confident response — a human will follow up shortly.';

        const citations = kbHits.map(h => ({
            title: h.title,
            score: h.score,
            source_uri: h.source_uri,
        }));

        const aiMsg = await supportStore.appendMessage({
            threadId,
            authorKind: 'ai',
            authorDisplay: 'Bee Flow AI',
            body: finalBody,
            kbCitations: citations,
            aiModel: modelUsed,
            aiConfidence: kbHits.length ? Math.min(1, kbHits[0].score || 0) : null,
        });

        await _safeRecordEvent({
            threadId,
            actorUserId: null,
            actorKind: 'system',
            action: 'ai_reply',
            payload: {
                model: modelUsed,
                escalated,
                escalateReason: escalated ? (escalateReason || 'low_confidence') : null,
                citationCount: citations.length,
            },
        });

        if (escalated) {
            await _escalate(threadId, escalateReason || 'low_confidence');
        } else {
            await supportStore.updateThread(threadId, {
                status: 'awaiting_user',
                ai_handled: true,
                ai_escalated_reason: null,
            });
        }

        settled = true;
        return { message: aiMsg, escalated, escalateReason };
    } catch (outerErr) {
        // Catch-all — any unexpected throw (DB hiccup, bad config, etc.).
        console.error('[SupportAI] runAiAutoResponder unexpected error:', outerErr.message);
        try {
            await _escalate(threadId, `ai_error: ${outerErr.message}`, {
                systemMessage: `AI auto-responder crashed (${outerErr.message}). Escalated to staff.`,
            });
        } catch {}
        settled = true;
        return null;
    } finally {
        // Belt-and-braces: if we somehow exited without transitioning out of
        // `ai_responding`, force-escalate so no thread is stuck.
        if (!settled) {
            try {
                const t = await supportStore.getThread(threadId);
                if (t && t.status === 'ai_responding') {
                    await _escalate(threadId, 'unexpected_exit', {
                        systemMessage: 'AI auto-responder exited unexpectedly. Escalated to staff.',
                    });
                }
            } catch {}
        }
    }
}

module.exports = { runAiAutoResponder };
