/**
 * Support Classifier — decides whether an inbound email is a genuine customer
 * SUPPORT request for this inbox's organization, so non-support mail (order
 * confirmations, sales pitches, personal notes that landed on the support
 * address) can be routed out of the default inbox WITHOUT being deleted.
 *
 * Design notes:
 *   • Opt-in per inbox (`classify_non_support_enabled`); off by default.
 *   • Fail SAFE: any error, low confidence, or a known-good sender keeps the
 *     ticket in the inbox. We only ever HIDE on a confident non-support verdict.
 *   • Reversible: hiding is a reserved TAG + category + audit event, never a
 *     status change and never a delete. Staff can restore in one click.
 *   • Mirrors the proven fire-and-forget LLM-JSON pattern in
 *     supportAiResponder._autoTag (fast tier + strict-JSON + regex fallback).
 */

const supportStore = require('../stores/supportStore');
const { parseAddress } = require('./email/parse');

// Reserved markers — kept out of band so the inbox/insights views can exclude them.
const NOT_SUPPORT_TAG = 'not-support';
const NOT_SUPPORT_CATEGORY = 'Not a support request';

const CLASSIFY_TIMEOUT_MS = 10000;

function _withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/** Best-effort organization name for grounding the classifier prompt. */
async function _orgName(organizationId) {
    if (!organizationId) return null;
    try {
        const userStore = require('../stores/userStore');
        const org = await userStore.getOrganization(organizationId);
        return org?.name || null;
    } catch { return null; }
}

/** Has staff previously vouched for this sender as genuine support? */
function isKnownGoodSender(inbox, fromAddress) {
    const list = Array.isArray(inbox?.known_good_senders) ? inbox.known_good_senders : [];
    if (!list.length || !fromAddress) return false;
    const f = parseAddress(fromAddress) || String(fromAddress).toLowerCase().trim();
    return list.some(s => String(s || '').toLowerCase().trim() === f);
}

/**
 * Classify a single inbound message. Returns
 *   { isSupportRequest: bool, confidence: 0..1, reason: string, suggestedCategory: string|null }
 * Never throws — on any failure returns a safe "treat as support" verdict.
 */
async function classifyInbound(inbox, { subject = '', body = '', fromAddress = '', fromName = '' } = {}) {
    const safe = { isSupportRequest: true, confidence: 0, reason: 'classifier_unavailable', suggestedCategory: null };
    try {
        const llmClient = require('../core/llmClient');
        const { resolveAgentModel } = require('../core/agentRuntime');
        const { getAIConfig } = require('../core/aiAgent');
        const orgName = await _orgName(inbox?.organization_id);
        const deskFor = orgName || inbox?.display_name || 'this company';
        const text = String(body || '').slice(0, 4000);

        const modelId = await resolveAgentModel('tier:fast', text, await getAIConfig());
        const result = await _withTimeout(llmClient.chat(modelId, [
            {
                role: 'system',
                content: `You triage email arriving at a CUSTOMER-SUPPORT mailbox for "${deskFor}". Decide whether the message is a genuine support request, question, or issue from (or on behalf of) a customer that a support agent should handle.\n\nNOT support requests include: order/delivery/payment confirmations from unrelated services, newsletters and marketing, cold sales/partnership pitches, invoices/receipts addressed to the company, automated notifications, and personal messages unrelated to the product.\n\nRespond with STRICT JSON only, no prose: {"isSupportRequest": boolean, "confidence": number (0..1, how sure you are of the verdict), "reason": "short phrase", "category": "short label or null"}.`,
            },
            {
                role: 'user',
                content: `From: ${fromName ? `${fromName} ` : ''}<${parseAddress(fromAddress) || fromAddress}>\nSubject: ${subject}\n\n${text}`,
            },
        ], { maxTokens: 150, temperature: 0 }), CLASSIFY_TIMEOUT_MS, 'classifyInbound');

        const raw = (result && result.content) || '';
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return safe;
        const parsed = JSON.parse(match[0]);
        const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
        return {
            isSupportRequest: parsed.isSupportRequest !== false, // default to support if absent
            confidence,
            reason: String(parsed.reason || '').slice(0, 200) || 'classified',
            suggestedCategory: parsed.category ? String(parsed.category).slice(0, 100) : null,
        };
    } catch (e) {
        console.warn('[SupportClassifier] classifyInbound failed:', e.message);
        return safe;
    }
}

/**
 * Orchestrate non-support filtering for a freshly-created thread. Returns
 * `{ filtered: boolean, reason?: string }`. Caller (sync engine) uses `filtered`
 * (+ inbox.classify_suppress_autoreply) to decide whether to run the AI.
 * Only call for NEW threads. Never throws.
 */
async function maybeFilterNonSupport(inbox, thread, message) {
    try {
        if (!inbox || !inbox.classify_non_support_enabled) return { filtered: false };
        if (isKnownGoodSender(inbox, message?.fromAddress)) return { filtered: false };

        const verdict = await classifyInbound(inbox, message || {});
        const threshold = Number(inbox.classify_sensitivity) || 0.85;
        if (verdict.isSupportRequest || verdict.confidence < threshold) {
            return { filtered: false };
        }

        await supportStore.addThreadTag(thread.id, NOT_SUPPORT_TAG);
        await supportStore.updateThread(thread.id, { category: verdict.suggestedCategory || NOT_SUPPORT_CATEGORY });
        await supportStore.recordThreadEvent({
            threadId: thread.id,
            actorKind: 'automation',
            action: 'classified_not_support',
            payload: { confidence: verdict.confidence, reason: verdict.reason },
        }).catch(() => {});
        return { filtered: true, reason: verdict.reason };
    } catch (e) {
        console.warn('[SupportClassifier] maybeFilterNonSupport failed:', e.message);
        return { filtered: false };
    }
}

module.exports = {
    NOT_SUPPORT_TAG,
    NOT_SUPPORT_CATEGORY,
    classifyInbound,
    isKnownGoodSender,
    maybeFilterNonSupport,
};
