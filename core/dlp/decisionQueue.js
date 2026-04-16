/**
 * In-memory queue of pending DLP decisions.
 *
 * When the DLP runner returns `action: 'ask'`, the chat stream emits a
 * `dlp_preview` SSE event with a `decisionId` and then `await`s a Promise
 * from this queue. The client POSTs the user's choice to
 * `/api/chat/dlp-decision`, which calls `resolve(decisionId, choice)` here
 * and unblocks the stream.
 *
 * Decisions are **not** persisted. A server restart invalidates every pending
 * decision — the client sees the SSE error and can resend.
 *
 * Each entry also carries `userId` so the resolve-endpoint can verify that
 * only the user who raised the prompt can answer it.
 */

const crypto = require('crypto');

const _pending = new Map(); // decisionId → { resolve, reject, timeoutId, userId, conversationId, createdAt }

const DEFAULT_TIMEOUT_MS = 60 * 1000;

function _generateId() {
    return `dlp_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Register a new pending decision and return { decisionId, promise } that the
 * chat stream should await. If the timeout elapses with no resolve call, the
 * promise rejects — the caller should treat that as `block` (fail-closed).
 *
 * @param {object} opts
 * @param {string} opts.conversationId
 * @param {string} opts.userId
 * @param {number} [opts.timeoutMs]
 * @returns {{ decisionId: string, promise: Promise<Decision> }}
 *
 * @typedef {object} Decision
 * @property {'redact'|'block'|'allow'} choice
 * @property {boolean} [rememberForConversation]
 */
function register({ conversationId, userId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const decisionId = _generateId();
    const promise = new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            _pending.delete(decisionId);
            const err = new Error('DLP decision timed out');
            err.code = 'DLP_TIMEOUT';
            reject(err);
        }, timeoutMs);
        _pending.set(decisionId, {
            resolve,
            reject,
            timeoutId,
            userId: userId || null,
            conversationId: conversationId || null,
            createdAt: Date.now(),
        });
    });
    return { decisionId, promise };
}

/**
 * Resolve a pending decision. Verifies the userId matches so one user can't
 * answer another user's prompt. Returns true on success, false on not-found /
 * not-owner.
 *
 * @param {string} decisionId
 * @param {object} decision
 * @param {string} decision.choice  'redact' | 'block' | 'allow'
 * @param {boolean} [decision.rememberForConversation]
 * @param {string} callerUserId
 * @returns {boolean}
 */
function resolve(decisionId, decision, callerUserId) {
    const entry = _pending.get(decisionId);
    if (!entry) return false;
    if (entry.userId && callerUserId && entry.userId !== callerUserId) return false;
    clearTimeout(entry.timeoutId);
    _pending.delete(decisionId);
    entry.resolve(decision);
    return true;
}

/**
 * Reject a pending decision (e.g. if the conversation is deleted mid-flight).
 */
function reject(decisionId, reason) {
    const entry = _pending.get(decisionId);
    if (!entry) return false;
    clearTimeout(entry.timeoutId);
    _pending.delete(decisionId);
    const err = new Error(reason || 'DLP decision rejected');
    err.code = 'DLP_REJECTED';
    entry.reject(err);
    return true;
}

function size() {
    return _pending.size;
}

module.exports = {
    register,
    resolve,
    reject,
    size,
};
