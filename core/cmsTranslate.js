/**
 * cmsTranslate — AI auto-translation for the Product Website CMS.
 *
 * Extracts the translatable text out of a page (block content + SEO) or the
 * site chrome (header/footer/page-titles), batches it through the LLM the same
 * way server/routes/admin/languageRoutes.js translates GUI strings, and folds
 * the result back into a SPARSE, text-only locale override
 * (see cmsStore.setPageLocaleOverride / setSiteLocaleOverride).
 *
 * Manual translations always win: any field that already has a non-empty
 * translation in the existing override is left untouched (never sent to the
 * LLM, never overwritten).
 *
 * The set of "translatable" fields is decided by the same denylist the admin
 * TranslationPanel uses — keep the two in sync.
 */

const llmClient = require('./llmClient');
const { resolveModelForTierName } = require('./modelResolver');

const BATCH_SIZE = 40;

// Keys whose value (and subtree) are structural, not prose — never translated.
const DENY_KEYS = new Set([
    'id', 'kind', 'type', 'slug', 'src', 'href', 'url', 'link', 'anchor',
    'path', 'pageId', 'page', 'target', 'rel', 'icon', 'platform',
    'code', 'codeRight', 'popupEmbed', 'embed', 'iframe',
    'planType', 'defaultInterval', 'enableToggle', 'interval',
    'layout', 'columnLayout', 'verticalAlign', 'mediaPosition', 'mediaSize',
    'backgroundVariant', 'background', 'gradient', 'theme', 'radius',
    'number', 'enabled', 'noIndex', 'ogImage', 'favicon', 'role', 'value',
    'style', 'align', 'variant',
]);
// Style-ish suffixes (fontSize, titleColor, headingAlign, labelFont, ...).
const DENY_SUFFIX = /(Style|Color|Font|Align|Size|Variant|Url|Src|Id|Link)$/;

function isDeniedKey(k) {
    if (typeof k !== 'string') return false; // array index — inherits parent's allow
    return DENY_KEYS.has(k) || DENY_SUFFIX.test(k);
}

function isTranslatableValue(s) {
    const t = s.trim();
    if (!t) return false;
    if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return false;          // hex color
    if (/^(https?:|mailto:|tel:|data:|\/|#)/i.test(t)) return false; // url / path / anchor
    return true;
}

function clone(v) {
    return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// Walk content emitting (fieldPath, sourceString) for every translatable leaf.
function collectStrings(node, path, emit) {
    if (Array.isArray(node)) {
        node.forEach((el, i) => collectStrings(el, [...path, i], emit));
        return;
    }
    if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (isDeniedKey(k)) continue;
            collectStrings(v, [...path, k], emit);
        }
        return;
    }
    if (typeof node === 'string' && isTranslatableValue(node)) emit(path, node);
}

// Each entry = { targetPath: [...segments into the OVERRIDE root...], source }.
function extractPageEntries(pageDoc) {
    const entries = [];
    for (const block of pageDoc.blocks || []) {
        collectStrings(block.content, [], (fp, src) => {
            entries.push({ targetPath: ['blocks', block.id, 'content', ...fp], source: src });
        });
    }
    if (pageDoc.seo) {
        for (const f of ['metaTitle', 'metaDescription']) {
            const v = pageDoc.seo[f];
            if (typeof v === 'string' && v.trim()) entries.push({ targetPath: ['seo', f], source: v });
        }
    }
    return entries;
}

function extractSiteEntries(siteDoc) {
    const entries = [];
    for (const region of ['header', 'footer']) {
        const node = siteDoc[region];
        if (node) collectStrings(node, [], (fp, src) => {
            entries.push({ targetPath: [region, ...fp], source: src });
        });
    }
    for (const p of siteDoc.pages || []) {
        if (typeof p.title === 'string' && p.title.trim()) {
            entries.push({ targetPath: ['pageTitles', p.id], source: p.title });
        }
    }
    return entries;
}

// Get/set a value at a path of string keys / numeric indices, materializing
// objects and (index-aligned, null-padded) arrays as needed.
function getAtPath(root, segs) {
    let cur = root;
    for (const k of segs) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[k];
    }
    return cur;
}

function setAtPath(root, segs, value) {
    let cur = root;
    for (let i = 0; i < segs.length - 1; i++) {
        const k = segs[i];
        const nextIsIdx = typeof segs[i + 1] === 'number';
        if (typeof k === 'number') {
            while (cur.length <= k) cur.push(null);
            if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = nextIsIdx ? [] : {};
            cur = cur[k];
        } else {
            if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = nextIsIdx ? [] : {};
            cur = cur[k];
        }
    }
    const last = segs[segs.length - 1];
    if (typeof last === 'number') { while (cur.length <= last) cur.push(null); cur[last] = value; }
    else cur[last] = value;
}

function systemPrompt(languageName, locale) {
    return `You are a professional translator for a website builder. Translate the given website text values to ${languageName} (${locale}).
Return ONLY a valid JSON object mapping each key to its translated value.
Keep the marketing tone and roughly the same length — these are website headings, labels, buttons and short paragraphs.
Preserve placeholder tokens like {name}, {count}, and any inline HTML or markdown.
Keys are opaque identifiers — return the SAME keys with translated values.
Do NOT translate keys, only values. Output raw JSON only — no explanation, no markdown, no code fences.`;
}

// Translate an array of entries; returns Map(indexIntoEntries → translatedString).
async function translateEntries(modelId, languageName, locale, entries) {
    const result = new Map();
    let errors = 0;
    const sys = systemPrompt(languageName, locale);
    const batches = [];
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        batches.push(entries.slice(i, i + BATCH_SIZE).map((e, j) => ({ idx: i + j, source: e.source })));
    }
    const settled = await Promise.allSettled(batches.map(async (batch) => {
        const obj = {};
        for (const b of batch) obj[String(b.idx)] = b.source;
        const r = await llmClient.chat(modelId, [
            { role: 'system', content: sys },
            { role: 'user', content: JSON.stringify(obj, null, 2) },
        ], { maxTokens: 4096, temperature: 0.3 });
        let text = (r.content || '').trim()
            .replace(/^```(?:json)?\s*\n?/i, '')
            .replace(/\n?```\s*$/i, '')
            .trim();
        return JSON.parse(text);
    }));
    for (const s of settled) {
        if (s.status === 'fulfilled') {
            for (const [k, v] of Object.entries(s.value)) {
                const idx = Number(k);
                if (Number.isInteger(idx) && typeof v === 'string' && v.trim()) result.set(idx, v);
            }
        } else {
            errors++;
            console.error('[cmsTranslate] batch failed:', s.reason?.message);
        }
    }
    return { translations: result, errors };
}

// Resolve the model once from a tier name (admin context — no user/org).
async function resolveModel(modelTier = 'fast') {
    try {
        return await resolveModelForTierName(modelTier || 'fast', { fallback: 'mistral-small-latest' });
    } catch (_) {
        return 'mistral-small-latest';
    }
}

// Core: given the full entry list + a starting override, translate only the
// entries that aren't already manually translated, and fold the result in.
async function translateInto(baseOverride, entries, { modelId, languageName, locale }) {
    const override = clone(baseOverride) && typeof baseOverride === 'object'
        ? clone(baseOverride) : {};
    const pending = entries.filter((e) => {
        const existing = getAtPath(override, e.targetPath);
        return !(typeof existing === 'string' && existing.trim());
    });
    if (!pending.length) {
        return { override, translated: 0, total: entries.length, errors: 0 };
    }
    const { translations, errors } = await translateEntries(modelId, languageName, locale, pending);
    let translated = 0;
    pending.forEach((e, i) => {
        const v = translations.get(i);
        if (typeof v === 'string' && v.trim()) { setAtPath(override, e.targetPath, v); translated++; }
    });
    return { override, translated, total: entries.length, errors };
}

async function aiTranslatePage({ pageDoc, existingOverride, modelTier, languageName, locale }) {
    const modelId = await resolveModel(modelTier);
    const start = existingOverride && typeof existingOverride === 'object'
        ? existingOverride
        : { version: 1, blocks: {} };
    const entries = extractPageEntries(pageDoc);
    const out = await translateInto(start, entries, { modelId, languageName, locale });
    if (!out.override.blocks) out.override.blocks = {};
    return { ...out, modelId };
}

async function aiTranslateSite({ siteDoc, existingOverride, modelTier, languageName, locale }) {
    const modelId = await resolveModel(modelTier);
    const start = existingOverride && typeof existingOverride === 'object'
        ? existingOverride
        : { version: 1 };
    const entries = extractSiteEntries(siteDoc);
    const out = await translateInto(start, entries, { modelId, languageName, locale });
    return { ...out, modelId };
}

module.exports = {
    aiTranslatePage,
    aiTranslateSite,
    // exported for tests
    extractPageEntries, extractSiteEntries, collectStrings, isDeniedKey, isTranslatableValue,
    getAtPath, setAtPath,
};
