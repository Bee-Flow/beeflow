/**
 * Attachment text scanner — applies the org Privacy Shield (PII detection)
 * to text extracted from file attachments (PDF / Office / plain text).
 *
 * Reuses the same detector + tokeniser as the message-scan path; never
 * spins up a parallel engine. When per-page text is available (PDFs from
 * pdfjs), findings carry a `page` number for audit attribution.
 *
 * Returns one of:
 *   { action: 'pass',     text,            findings: [], summary, tokenMap: null }
 *   { action: 'tokenize', text: tokenized, findings,     summary, tokenMap }
 *   { action: 'block',    text: null,      findings,     summary, tokenMap: null }
 *
 * The returned `text` is always a drop-in replacement for the extractor's
 * flat `text` so callers can splice it straight into the message content.
 */

const crypto = require('crypto');
const { detectPii, tokenizeText, ALL_PII_CATEGORY_IDS } = require('../piiDetection');
const { mergeTokenMap, getConversationTokenMap } = require('./dlpRunner');

// Cap the number of pages we scan per attachment. Past this, we mark the
// summary as `overflow=true` and let the text through unredacted (paired
// with a log line). Hard-blocking large PDFs would surprise users who today
// upload 100-page reports without trouble.
const MAX_PAGES_DEFAULT = 50;

// Bounded concurrency for per-page detection. Sequential scanning of an
// 11-page PDF took ~15 s in production; running 4 pages at a time on the
// local CPU brings that under 5 s without overloading the inference threads
// (the local Transformers.js model already caps its own thread count).
const SCAN_CONCURRENCY_DEFAULT = 4;

// Hard wall-clock budget for the whole scan. The local model has a per-chunk
// timeout of 8 s; in the worst case a 50-page scan with 4-way concurrency
// could still walk well past a user's patience. When the deadline trips we
// either fail-closed (Block action) or pass-through unredacted with a flag
// (Tokenize action).
const MAX_SCAN_MS_DEFAULT = 30_000;

// In-process LRU. Hits avoid re-scanning identical attachment text under the
// same policy — common when conversations replay history on every turn. Cap
// of 200 keeps the memory footprint trivial (each entry is just findings +
// tokenMap, no buffers retained).
const SCAN_CACHE_MAX = 200;
const _scanCache = new Map();

function _policyTag(orgShield) {
    const cats = Array.isArray(orgShield?.piiDetectionCategories) ? orgShield.piiDetectionCategories.slice().sort().join(',') : '';
    const t = orgShield?.piiDetectionConfidenceThreshold ?? '';
    const a = orgShield?.piiDetectionAction || orgShield?.privacyAction || '';
    return `${a}|${t}|${cats}`;
}

function _cacheKey(text, orgShield) {
    const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
    return `${hash}|${_policyTag(orgShield)}`;
}

function _cacheGet(key) {
    const v = _scanCache.get(key);
    if (!v) return null;
    // Move-to-end LRU.
    _scanCache.delete(key);
    _scanCache.set(key, v);
    return v;
}

function _cacheSet(key, value) {
    if (_scanCache.size >= SCAN_CACHE_MAX) {
        const oldest = _scanCache.keys().next().value;
        _scanCache.delete(oldest);
    }
    _scanCache.set(key, value);
}

function _resolveAction(orgShield) {
    // Privacy Shield UI writes `piiDetectionAction` ∈ {'block','tokenize'}.
    // The canonical synthesised field is `privacyAction` ∈ {'block','redact','ask'}.
    const legacy = orgShield?.piiDetectionAction;
    if (legacy === 'block') return 'block';
    if (legacy === 'tokenize' || legacy === 'redact') return 'tokenize';
    const canonical = orgShield?.privacyAction;
    if (canonical === 'block') return 'block';
    if (canonical === 'redact') return 'tokenize';
    return 'tokenize';
}

function _resolveCategories(orgShield) {
    const cats = orgShield?.piiDetectionCategories;
    if (Array.isArray(cats) && cats.length > 0) {
        return cats.filter(id => ALL_PII_CATEGORY_IDS.includes(id));
    }
    return null; // null = detect everything the backend supports
}

function _resolveThreshold(orgShield) {
    const t = orgShield?.piiDetectionConfidenceThreshold;
    return typeof t === 'number' ? t : undefined;
}

function _piiEnabled(orgShield) {
    if (!orgShield) return false;
    // Shield's master flag is the only switch for PII scanning.
    return !!orgShield.enabled;
}

/**
 * Recompute each entity's `offset` so it is relative to the concatenated
 * flat text we will tokenise against. The extractor's flat `text` is the
 * non-empty pages joined by '\n\n' (see pdfExtractor.js — empty pages are
 * filtered out before `.join`), so we must walk only non-empty pages here
 * and add the separator only between successive non-empty entries.
 * Otherwise empty pages would shift later offsets, splicing tokens into
 * the wrong characters in tokenizeText().
 */
function _entitiesToFlatOffsets(pageEntities, pages) {
    const out = [];
    let cursor = 0;
    const sep = '\n\n';
    let prevWasNonEmpty = false;
    for (let i = 0; i < pages.length; i++) {
        const pageText = pages[i].text || '';
        if (!pageText) continue; // skip empty pages — they aren't in the flat text
        if (prevWasNonEmpty) cursor += sep.length;
        const findings = pageEntities[i] || [];
        for (const e of findings) {
            out.push({
                ...e,
                offset: cursor + (typeof e.offset === 'number' ? e.offset : 0),
                page: pages[i].pageNumber,
            });
        }
        cursor += pageText.length;
        prevWasNonEmpty = true;
    }
    return out;
}

function _summariseFindings(findings) {
    const total = { byCategory: {}, count: findings.length, pages: {} };
    for (const f of findings) {
        const key = f.label || f.category || 'Other';
        total.byCategory[key] = (total.byCategory[key] || 0) + 1;
        if (f.page) {
            if (!total.pages[f.page]) total.pages[f.page] = {};
            total.pages[f.page][key] = (total.pages[f.page][key] || 0) + 1;
        }
    }
    return total;
}

/**
 * @param {object} params
 * @param {string} params.text                Concatenated extracted text.
 * @param {Array<{pageNumber:number,text:string}>} [params.pages]  Per-page text (PDF). Optional.
 * @param {string} params.filename
 * @param {object} params.orgShield           Resolved Privacy Shield config.
 * @param {string} [params.conversationId]    Used to merge attachment tokens into the conv map.
 * @param {number} [params.maxPages]
 */
async function scanAttachmentText({ text, pages, filename, orgShield, conversationId, maxPages = MAX_PAGES_DEFAULT, concurrency = SCAN_CONCURRENCY_DEFAULT, maxScanMs = MAX_SCAN_MS_DEFAULT }) {
    if (!text || text.length < 3) {
        return { action: 'pass', text: text || '', findings: [], summary: { count: 0, byCategory: {}, pages: {} }, tokenMap: null };
    }
    if (!_piiEnabled(orgShield)) {
        return { action: 'pass', text, findings: [], summary: { count: 0, byCategory: {}, pages: {} }, tokenMap: null };
    }

    // Cache short-circuit. Re-uploads / history replays hit this path with
    // identical extracted text + same policy → reuse the prior scan result
    // and just re-merge tokens into the (possibly different) conversation map.
    const cacheKey = _cacheKey(text, orgShield);
    const cached = _cacheGet(cacheKey);
    if (cached) {
        if (cached.action === 'tokenize' && conversationId && cached.tokenMap) {
            mergeTokenMap(conversationId, cached.tokenMap);
        }
        console.log(`[AttachmentScanner] cache hit for ${filename} (${cached.action})`);
        return { ...cached, summary: { ...cached.summary, filename, cacheHit: true } };
    }

    const action = _resolveAction(orgShield);
    const categories = _resolveCategories(orgShield);
    const threshold = _resolveThreshold(orgShield);

    const start = Date.now();
    const deadline = start + maxScanMs;
    const usePerPage = Array.isArray(pages) && pages.length > 0;
    let overflow = false;
    let timedOut = false;
    const pageEntities = [];

    if (usePerPage) {
        const scanPages = pages.slice(0, maxPages);
        if (pages.length > maxPages) {
            overflow = true;
            console.warn(`[AttachmentScanner] ${filename}: ${pages.length} pages exceeds cap (${maxPages}); only first ${maxPages} scanned`);
        }
        // Pre-fill the entities array so out-of-order completions land in
        // the right slot.
        for (let i = 0; i < scanPages.length; i++) pageEntities[i] = [];

        // Bounded-concurrency runner. `next` is a shared cursor; each worker
        // picks the next index, runs the scan, writes the result, repeats.
        // `cancelled` is set when block-mode short-circuits OR the deadline
        // trips, causing workers to exit cleanly.
        let next = 0;
        let cancelled = false;
        const worker = async () => {
            while (true) {
                if (cancelled) return;
                if (Date.now() >= deadline) { cancelled = true; timedOut = true; return; }
                const i = next++;
                if (i >= scanPages.length) return;
                const p = scanPages[i];
                const pageText = (p.text || '').trim();
                if (!pageText) continue;
                try {
                    const result = await detectPii(pageText, categories, threshold);
                    pageEntities[i] = result?.hasPii ? result.entities : [];
                } catch (err) {
                    console.warn(`[AttachmentScanner] ${filename} p.${p.pageNumber} scan failed: ${err.message}`);
                    pageEntities[i] = [];
                }
                // Short-circuit on block-mode so we don't burn cycles on a 50-page
                // PDF when we already know the message is going to be rejected.
                if (action === 'block' && pageEntities[i].length > 0) { cancelled = true; return; }
            }
        };
        const lanes = Math.max(1, Math.min(concurrency, scanPages.length));
        await Promise.all(Array.from({ length: lanes }, () => worker()));
        if (timedOut) {
            console.warn(`[AttachmentScanner] ${filename}: deadline hit at ${maxScanMs}ms; ${next} of ${scanPages.length} pages scanned`);
        }
    } else {
        try {
            // Race the detect call against the deadline so the whole-text
            // path can't outrun the budget either.
            const result = await Promise.race([
                detectPii(text, categories, threshold),
                new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, Math.max(0, deadline - Date.now()))),
            ]);
            const entities = result?.hasPii ? result.entities : [];
            // Whole-text path: page = null (caller stores NULL in audit).
            pageEntities.push(entities.map(e => ({ ...e, page: null })));
        } catch (err) {
            console.warn(`[AttachmentScanner] ${filename} whole-text scan failed: ${err.message}`);
            pageEntities.push([]);
        }
    }

    // Flatten findings with offsets resolved to the concatenated text we'll
    // tokenise against. For the no-pages branch the offsets are already
    // relative to `text`, so we just copy them through.
    let findings;
    if (usePerPage) {
        findings = _entitiesToFlatOffsets(pageEntities, pages.slice(0, maxPages));
    } else {
        findings = pageEntities[0] || [];
    }

    const summary = _summariseFindings(findings);
    summary.overflow = overflow;
    summary.timeout = timedOut;
    summary.filename = filename;
    summary.scanMs = Date.now() - start;

    // Deadline policy: when the wall-clock budget tripped before the scan
    // could process every page we either pass-through unredacted (Tokenize
    // intent — "best effort + warn") or fail closed (Block intent — strict).
    // We deliberately DO NOT cache timeout outcomes: the next attempt may
    // succeed when load is lighter.
    if (timedOut) {
        if (action === 'block') {
            console.warn(`[AttachmentScanner] 🚫 ${filename}: scan timeout — failing closed under block-mode policy`);
            return { action: 'block', text: null, findings, summary, tokenMap: null };
        }
        console.warn(`[AttachmentScanner] ${filename}: scan timeout — passing through unredacted (tokenize-mode soft fail)`);
        return { action: 'pass', text, findings: [], summary, tokenMap: null };
    }

    if (findings.length === 0) {
        const result = { action: 'pass', text, findings: [], summary, tokenMap: null };
        _cacheSet(cacheKey, result);
        return result;
    }

    if (action === 'block') {
        console.warn(`[AttachmentScanner] 🚫 ${filename}: ${findings.length} finding(s) — blocking (categories: ${Object.keys(summary.byCategory).join(', ')})`);
        const result = { action: 'block', text: null, findings, summary, tokenMap: null };
        _cacheSet(cacheKey, result);
        return result;
    }

    // Tokenise. Use the flat text since findings carry flat offsets.
    // Seed with the conversation's accumulated map so attachment tokens
    // continue the per-category counter and known values reuse existing tokens
    // (avoids two different bank-account numbers both getting [bankaccount_1]
    // when a second attachment is uploaded later in the same conversation).
    const existing = conversationId ? getConversationTokenMap(conversationId) : null;
    const { tokenizedText, tokenMap } = tokenizeText(text, findings, existing);
    if (conversationId) {
        mergeTokenMap(conversationId, tokenMap);
    }
    console.log(`[AttachmentScanner] 🔒 ${filename}: tokenised ${findings.length} finding(s) in ${summary.scanMs}ms`);
    const result = { action: 'tokenize', text: tokenizedText, findings, summary, tokenMap };
    _cacheSet(cacheKey, result);
    return result;
}

class AttachmentPrivacyBlock extends Error {
    constructor({ filename, summary, findings }) {
        const cats = Object.keys(summary?.byCategory || {}).join(', ') || 'unknown';
        super(`PII detected in attachment "${filename}" (${cats}). Please remove sensitive data and re-upload.`);
        this.code = 'ATTACHMENT_PII_BLOCKED';
        this.filename = filename;
        this.summary = summary;
        this.findings = findings;
    }
}

module.exports = {
    scanAttachmentText,
    AttachmentPrivacyBlock,
    MAX_PAGES_DEFAULT,
};
