/**
 * DLP (Data Loss Prevention) runner — the single entry point for scanning a
 * user's outbound prompt before it reaches an LLM.
 *
 * Combines three signal sources:
 *   - PII detection (existing: `server/core/azurePiiDetection.js`)
 *   - Custom sensitive terms (org-defined, `server/core/dlp/customTerms.js`)
 *   - Provider classification (external vs. internal)
 *
 * And turns them into a single *action*:
 *   - 'allow'   — send the prompt as-is
 *   - 'redact'  — tokenise findings, send the tokenised text, keep a tokenMap
 *   - 'block'   — refuse the turn, surface an error to the user
 *   - 'ask'     — pause the stream, show the user a preview, wait for their choice
 *
 * The runner never throws for "PII found" the way the old flow does. Instead
 * the caller inspects `action` and drives the UX accordingly. This keeps the
 * interactive path and the auto path in the same function.
 */

const { detectPii, tokenizeText } = require('../azurePiiDetection');
const { scanCustomTerms } = require('./customTerms');
const { classifyProvider } = require('../providers/classification');

// Conversation-scoped "remember my last choice" preference. Cleared on
// explicit conversation delete (and naturally GC'd in process restart).
const conversationDlpPrefs = new Map(); // conversationId → 'redact' | 'allow'

// Conversation-scoped accumulated token maps. The same conversation may redact
// across several turns; new entries are merged in so `restoreTokens` in the
// response path can still undo an earlier turn's token.
const conversationTokenMaps = new Map(); // conversationId → Map<token, original>

const MAX_TOKENS_PER_CONV = 500;

function _ensureTokenMap(conversationId) {
    if (!conversationId) return new Map();
    let map = conversationTokenMaps.get(conversationId);
    if (!map) { map = new Map(); conversationTokenMaps.set(conversationId, map); }
    return map;
}

function _mergeIntoTokenMap(conversationId, incoming) {
    if (!conversationId || !incoming) return;
    const map = _ensureTokenMap(conversationId);
    for (const [token, original] of Object.entries(incoming)) {
        map.set(token, original);
    }
    // Cheap LRU-ish cap: trim from the insertion-order front if we exceed the cap.
    while (map.size > MAX_TOKENS_PER_CONV) {
        const firstKey = map.keys().next().value;
        map.delete(firstKey);
    }
}

/**
 * Returns the accumulated token map for a conversation as a plain object
 * (consumable by `restoreTokens`).
 */
function getConversationTokenMap(conversationId) {
    const map = conversationTokenMaps.get(conversationId);
    if (!map) return {};
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    return obj;
}

function clearConversationState(conversationId) {
    if (!conversationId) return;
    conversationDlpPrefs.delete(conversationId);
    conversationTokenMaps.delete(conversationId);
}

function setConversationPref(conversationId, choice) {
    if (!conversationId) return;
    if (choice === 'redact' || choice === 'allow') {
        conversationDlpPrefs.set(conversationId, choice);
    }
}

function getConversationPref(conversationId) {
    return conversationId ? conversationDlpPrefs.get(conversationId) || null : null;
}

/**
 * Idle-cleanup. Call periodically (the kbQueryCache GC already runs every 10 min;
 * we piggyback by exposing this and letting that file call us).
 */
function gc(maxIdleMs = 60 * 60 * 1000) {
    // In this implementation we don't track per-conversation last-access, so
    // we rely on explicit clears. This hook is reserved for future use — when
    // conversations are deleted, callers should call clearConversationState().
    void maxIdleMs;
}

/**
 * Normalise heterogeneous findings to a single shape:
 *   { category, label, offset, length, text, severity }
 */
function _normalisePiiEntities(entities) {
    if (!Array.isArray(entities)) return [];
    return entities.map(e => ({
        category: e.category || 'PII',
        label: e.label || e.category || 'PII',
        offset: typeof e.offset === 'number' ? e.offset : 0,
        length: e.length || (e.text ? e.text.length : 0),
        text: e.text || '',
        source: 'pii',
        severity: 'high',
        confidence: e.confidence,
    }));
}

function _normaliseCustomTerms(findings) {
    if (!Array.isArray(findings)) return [];
    return findings.map(f => ({
        category: 'CustomTerm',
        label: f.label,
        offset: f.start,
        length: f.end - f.start,
        text: f.match,
        source: 'custom',
        severity: 'medium',
        termId: f.termId,
    }));
}

/**
 * Remove overlapping findings (prefer higher severity / earlier source), then
 * sort for tokenisation (descending offset so we can splice from the tail).
 */
function _dedupeAndSort(findings) {
    const sorted = [...findings].sort((a, b) => a.offset - b.offset);
    const kept = [];
    for (const f of sorted) {
        const overlaps = kept.find(k => !(f.offset + f.length <= k.offset || f.offset >= k.offset + k.length));
        if (!overlaps) { kept.push(f); continue; }
        // Prefer the higher-severity finding; tie-break on longer span (more specific).
        const sevOrder = { high: 3, medium: 2, low: 1 };
        if ((sevOrder[f.severity] || 0) > (sevOrder[overlaps.severity] || 0) ||
            ((sevOrder[f.severity] || 0) === (sevOrder[overlaps.severity] || 0) && f.length > overlaps.length)) {
            kept.splice(kept.indexOf(overlaps), 1, f);
        }
    }
    return kept.sort((a, b) => b.offset - a.offset); // descending for splice-safe replacement
}

/**
 * Build a tokenised version of `text` for a list of normalised findings.
 * Returns { tokenizedText, tokenMap, summary } where summary is a compact
 * `{ category → count }` for logging and the UI.
 */
function _tokeniseAll(text, findings) {
    // `tokenizeText` from azurePiiDetection expects entities with offset/length/category/text.
    // Our normalised findings already match that shape.
    const { tokenizedText, tokenMap } = tokenizeText(text, findings);
    const summary = findings.reduce((acc, f) => {
        const key = f.label || f.category;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    return { tokenizedText, tokenMap, summary };
}

/**
 * Extract the last user message's plain-text content from a messages array.
 */
function _extractLastUserText(messages) {
    if (!Array.isArray(messages)) return '';
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== 'user') continue;
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content)) {
            const text = m.content.find(b => b?.type === 'text');
            return text?.text || '';
        }
        return '';
    }
    return '';
}

/**
 * Core entry point.
 *
 * @param {object} params
 * @param {Array}  params.messages            Full messages array (we scan the last user message)
 * @param {object} params.orgShieldConfig     Resolved config from `resolveOrgShield`
 * @param {string} params.orgId               Org ID (for the custom-terms cache)
 * @param {string} params.conversationId      Scope for the per-conversation remembered choice + tokenMap
 * @param {object} params.providerConfig      { providerType, url, displayName } for classification
 * @returns {Promise<DlpResult>}
 *
 * @typedef {object} DlpResult
 * @property {'allow'|'redact'|'block'|'ask'} action
 * @property {Array}    findings
 * @property {object}   provider             { isExternal, reason, displayName }
 * @property {string|null} redactedText      Present when action is 'redact'
 * @property {object|null} tokenMap          Map<token, original> when action is 'redact'
 * @property {string}   scanStatus           'ok' | 'failed' | 'skipped'
 * @property {object}   summary              { label → count }
 */
async function scan({ messages, orgShieldConfig, orgId, conversationId, providerConfig }) {
    const dlpEnabled = !!orgShieldConfig?.dlpEnabled;
    if (!dlpEnabled) {
        return { action: 'allow', findings: [], provider: { isExternal: false, reason: 'dlp_disabled' }, redactedText: null, tokenMap: null, scanStatus: 'skipped', summary: {} };
    }

    const provider = classifyProvider(providerConfig || {}, orgShieldConfig?.dlpAllowlistedHosts || []);
    const scope = orgShieldConfig.dlpScope || 'external';
    if (scope === 'external' && !provider.isExternal) {
        return { action: 'allow', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: 'skipped', summary: {} };
    }

    const text = _extractLastUserText(messages);
    if (!text || text.length < 3) {
        return { action: 'allow', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: 'skipped', summary: {} };
    }

    // Scan both sources in parallel.
    // Either Azure or Local Transformers.js detector counts as "PII enabled"
    // — detectPii() picks the right backend. localPiiEnabled defaults true.
    const piiEnabled = !!(orgShieldConfig.azurePiiEnabled || orgShieldConfig.localPiiEnabled !== false);
    const piiCategories = Array.isArray(orgShieldConfig.piiDetectionCategories) && orgShieldConfig.piiDetectionCategories.length > 0
        ? orgShieldConfig.piiDetectionCategories
        : null;
    const piiThreshold = typeof orgShieldConfig.piiDetectionConfidenceThreshold === 'number'
        ? orgShieldConfig.piiDetectionConfidenceThreshold
        : undefined;

    let piiResult = null;
    let piiFailed = false;
    try {
        if (piiEnabled) {
            piiResult = await detectPii(text, piiCategories, piiThreshold);
        }
    } catch (err) {
        piiFailed = true;
        console.warn('[DLP] PII scan failed:', err.message);
    }

    const customTerms = Array.isArray(orgShieldConfig.customSensitiveTerms) ? orgShieldConfig.customSensitiveTerms : [];
    let customFindings = [];
    try {
        customFindings = scanCustomTerms(text, orgId, customTerms);
    } catch (err) {
        console.warn('[DLP] Custom-terms scan failed:', err.message);
    }

    const piiEntities = piiResult?.hasPii ? _normalisePiiEntities(piiResult.entities) : [];
    const normalisedCustom = _normaliseCustomTerms(customFindings);
    const all = _dedupeAndSort([...piiEntities, ...normalisedCustom]);

    // Handle scan failure per org policy.
    if (piiFailed && piiEnabled) {
        const failMode = orgShieldConfig.dlpFailureMode || 'fail_closed';
        if (failMode === 'fail_closed') {
            return { action: 'block', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: 'failed', summary: {}, reason: 'pii_service_unavailable' };
        }
        // fail_open: continue, but mark the scan as failed.
    }

    if (all.length === 0) {
        return { action: 'allow', findings: [], provider, redactedText: null, tokenMap: null, scanStatus: piiFailed ? 'failed' : 'ok', summary: {} };
    }

    // Apply mode: honour per-conversation remembered preference first.
    const remembered = getConversationPref(conversationId);
    const mode = orgShieldConfig.dlpMode || 'ask';
    const effectiveChoice = remembered || null;

    if (effectiveChoice === 'allow' || mode === 'auto_allow') {
        return { action: 'allow', findings: all, provider, redactedText: null, tokenMap: null, scanStatus: 'ok', summary: all.reduce((a, f) => (a[f.label] = (a[f.label] || 0) + 1, a), {}) };
    }

    if (effectiveChoice === 'redact' || mode === 'auto_redact') {
        const { tokenizedText, tokenMap, summary } = _tokeniseAll(text, all);
        _mergeIntoTokenMap(conversationId, tokenMap);
        return { action: 'redact', findings: all, provider, redactedText: tokenizedText, tokenMap, scanStatus: 'ok', summary };
    }

    if (mode === 'block') {
        const summary = all.reduce((a, f) => (a[f.label] = (a[f.label] || 0) + 1, a), {});
        return { action: 'block', findings: all, provider, redactedText: null, tokenMap: null, scanStatus: 'ok', summary };
    }

    // Default: ask the user.
    const summary = all.reduce((a, f) => (a[f.label] = (a[f.label] || 0) + 1, a), {});
    return { action: 'ask', findings: all, provider, redactedText: null, tokenMap: null, scanStatus: 'ok', summary };
}

/**
 * Helper for the callers who chose 'redact' via an interactive decision — apply
 * tokenisation now that the user has said yes.
 */
function applyRedactionChoice({ conversationId, text, findings }) {
    const { tokenizedText, tokenMap, summary } = _tokeniseAll(text, findings);
    _mergeIntoTokenMap(conversationId, tokenMap);
    return { tokenizedText, tokenMap, summary };
}

/**
 * Public helper: merge an externally-built tokenMap into the conversation's
 * shared store so the streaming un-tokeniser (wrapped around `onEvent` in
 * chatStream.js) can restore these tokens on the response.
 *
 * Used by the legacy PII path in `guardrailsRunner.js` and by direct chat,
 * both of which produce their own tokenMap but historically dropped it after
 * rewriting the user message — which meant tokens leaked through to the user
 * when DLP itself was disabled.
 */
function mergeTokenMap(conversationId, tokenMap) {
    if (!conversationId || !tokenMap) return;
    if (tokenMap instanceof Map) {
        const asObject = {};
        for (const [k, v] of tokenMap) asObject[k] = v;
        _mergeIntoTokenMap(conversationId, asObject);
    } else {
        _mergeIntoTokenMap(conversationId, tokenMap);
    }
}

module.exports = {
    scan,
    applyRedactionChoice,
    mergeTokenMap,
    getConversationTokenMap,
    clearConversationState,
    setConversationPref,
    getConversationPref,
    gc,
};
