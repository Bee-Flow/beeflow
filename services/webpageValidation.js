/**
 * Webpage post-generation validation (BFSF-222).
 *
 * Pure functions — no DB or network IO. Scans generated webpage markup for
 * the two failure modes prompt guidance alone doesn't prevent:
 *   - broken internal anchors: href="#x" with no matching id="x" / name="x"
 *   - wrong/missing images: <img src> pointing at a non-existent project
 *     asset path or an invented external URL
 *
 * Consumers: the end-of-turn repair round in routes/ai/webpageChat.js and the
 * softer per-write advisory in integrations/webpageBuilderTools.js. Everything
 * here is ADVISORY — callers never block a write or persistence on a finding.
 */

const { lineNumberForOffset } = require('../integrations/webpageDocTools');

// External <img> hosts that are always acceptable (deterministic placeholders
// the prompt contract explicitly allows). Admins can extend the list via the
// GLOBAL config key `webpage_img_host_allowlist` (comma-separated hostnames) —
// see mergeAllowedImgHosts().
const DEFAULT_ALLOWED_IMG_HOSTS = ['placehold.co'];

// Hard cap on findings — bounds repair-message prompt size.
const MAX_VIOLATIONS = 12;

/** Merge the comma-separated allowlist config value with the defaults. */
function mergeAllowedImgHosts(configValue) {
    const extra = String(configValue || '')
        .split(',')
        .map(h => h.trim().toLowerCase())
        .filter(Boolean);
    return [...new Set([...DEFAULT_ALLOWED_IMG_HOSTS, ...extra])];
}

/**
 * Blank out HTML comments so commented-out markup is never flagged. Every
 * non-newline character is replaced with a space, so offsets AND line numbers
 * in the cleaned text still map 1:1 onto the original document.
 */
function stripHtmlComments(html) {
    return String(html || '').replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
}

/** Every id="..."/name="..." value in the document (legacy <a name> included). */
function collectAnchorTargets(html) {
    const targets = new Set();
    const re = /\b(?:id|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const v = m[1] !== undefined ? m[1] : m[2];
        if (v) targets.add(v);
    }
    return targets;
}

/**
 * Every fragment href in the document → [{ fragment, offset }]. Bare
 * href="#" (the common JS-button idiom) is intentionally not matched.
 * The lookbehind keeps data-href="..." and friends out.
 */
function collectFragmentHrefs(html) {
    const out = [];
    const re = /(?<![-\w])href\s*=\s*(?:"#([^"]+)"|'#([^']+)')/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        out.push({ fragment: m[1] !== undefined ? m[1] : m[2], offset: m.index });
    }
    return out;
}

/**
 * Every <img> reference (src + each srcset candidate) → [{ src, offset,
 * hasOnerror }]. The lookbehind on src keeps lazy-load data-src="..." (and
 * srcset, which fails on the `=` check anyway) from matching.
 */
function extractImgRefs(html) {
    const out = [];
    const tagRe = /<img\b[^>]*>/gi;
    let m;
    while ((m = tagRe.exec(html)) !== null) {
        const tag = m[0];
        const offset = m.index;
        const hasOnerror = /\bonerror\s*=/i.test(tag);
        const srcMatch = /(?<![-\w])src\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        if (srcMatch) {
            out.push({ src: srcMatch[1] !== undefined ? srcMatch[1] : srcMatch[2], offset, hasOnerror });
        }
        const srcsetMatch = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        if (srcsetMatch) {
            const value = srcsetMatch[1] !== undefined ? srcsetMatch[1] : srcsetMatch[2];
            for (const candidate of value.split(',')) {
                const url = candidate.trim().split(/\s+/)[0];
                if (url) out.push({ src: url, offset, hasOnerror });
            }
        }
    }
    return out;
}

/** Strip leading './' and '/' plus any query/fragment for asset-set lookups. */
function normalizeAssetPath(src) {
    return String(src || '').replace(/^\.\//, '').replace(/^\/+/, '').split(/[?#]/)[0];
}

/**
 * Classify one <img> src → 'ok' | 'external-img' | 'missing-asset'.
 */
function classifyImgSrc(src, { assetPathSet, allowedHosts }) {
    const value = String(src || '').trim();
    if (/^(data|blob):/i.test(value)) return 'ok';
    // Absolute (or protocol-relative) external URL — allowlist check.
    const absolute = /^https?:\/\//i.test(value) ? value : (value.startsWith('//') ? `https:${value}` : null);
    if (absolute) {
        let hostname = '';
        try { hostname = new URL(absolute).hostname.toLowerCase(); } catch (_) { return 'external-img'; }
        const hosts = allowedHosts && allowedHosts.length ? allowedHosts : DEFAULT_ALLOWED_IMG_HOSTS;
        const allowed = hosts.some(h => {
            const host = String(h || '').toLowerCase();
            return host && (hostname === host || hostname.endsWith(`.${host}`));
        });
        return allowed ? 'ok' : 'external-img';
    }
    if (!value || value.startsWith('#')) return 'missing-asset';
    // Project-relative path — must exist as an extra file (text OR binary:
    // AI-created SVGs are TEXT extras, so the set must include them).
    const normalized = normalizeAssetPath(value);
    return assetPathSet.has(normalized) ? 'ok' : 'missing-asset';
}

/** Cheap "did you mean" — first asset whose path/basename overlaps the src. */
function suggestAsset(src, assetPathSet) {
    const base = (normalizeAssetPath(src).split('/').pop() || '').toLowerCase();
    if (!base) return null;
    const paths = [...assetPathSet];
    return paths.find(p => p.toLowerCase().endsWith(`/${base}`) || p.toLowerCase() === base)
        || paths.find(p => p.toLowerCase().includes(base))
        || null;
}

/** True when the fragment appears as a quoted/backtick string in any script. */
function fragmentInScripts(fragment, scriptTexts) {
    for (const text of scriptTexts || []) {
        if (typeof text !== 'string' || !text) continue;
        if (text.includes(`'${fragment}'`) || text.includes(`"${fragment}"`) || text.includes(`\`${fragment}\``)) {
            return true;
        }
    }
    return false;
}

/**
 * Vanilla (static HTML/CSS/JS) project scan.
 * Returns an array of violations:
 *   { type, severity: 'error'|'warn'|'info', file, line, detail, ... }
 */
function validateVanilla({ html, scriptTexts, assetPathSet, allowedHosts }) {
    const violations = [];
    const cleaned = stripHtmlComments(html);
    const targets = collectAnchorTargets(cleaned);

    for (const { fragment, offset } of collectFragmentHrefs(cleaned)) {
        if (violations.length >= MAX_VIOLATIONS) return violations;
        if (targets.has(fragment)) continue;
        // ids created at runtime by script code are the major false-positive
        // source — suppress when the fragment shows up as a quoted string.
        if (fragmentInScripts(fragment, scriptTexts)) continue;
        const line = lineNumberForOffset(cleaned, offset);
        violations.push({
            type: 'broken-anchor',
            severity: 'error',
            file: 'index.html',
            line,
            fragment,
            detail: `href="#${fragment}" (index.html line ${line}) has no matching id="${fragment}".`,
        });
    }

    for (const { src, offset, hasOnerror } of extractImgRefs(cleaned)) {
        if (violations.length >= MAX_VIOLATIONS) return violations;
        const cls = classifyImgSrc(src, { assetPathSet, allowedHosts });
        if (cls === 'ok') continue;
        const line = lineNumberForOffset(cleaned, offset);
        if (cls === 'missing-asset') {
            const suggestion = suggestAsset(src, assetPathSet);
            violations.push({
                type: 'missing-asset',
                severity: 'error',
                file: 'index.html',
                line,
                src,
                suggestion,
                detail: `<img src="${src}"> (index.html line ${line}) — no project file exists at that path.${suggestion ? ` Closest existing asset: ${suggestion}.` : ''}`,
            });
        } else {
            // External host not on the allowlist. The prompt contract mandates
            // an onerror fallback on external imgs — with one present this is
            // informational only (excluded from the repair round).
            violations.push({
                type: 'external-img',
                severity: hasOnerror ? 'info' : 'warn',
                file: 'index.html',
                line,
                src,
                detail: `<img src="${src}"> (index.html line ${line}) hotlinks an external host that is not on the image allowlist${hasOnerror ? ' (onerror fallback present)' : ' and has no onerror fallback'}.`,
            });
        }
    }

    return violations;
}

/**
 * react-mui project scan — deliberately degraded, suppression-first,
 * literal-only. JSX is dynamic, so flag a fragment ONLY when it appears as a
 * verbatim string literal, no id literal matches anywhere, and it never shows
 * up inside a template literal. Import-based assets are skipped entirely
 * (the esbuild resolver already fails loudly on missing imports).
 */
function validateReactMui({ sources, assetPathSet }) {
    const violations = [];
    const entries = Object.entries(sources || {});
    if (entries.length === 0) return violations;

    const allText = entries.map(([, text]) => text || '').join('\n');
    const idLiterals = new Set();
    const idRe = /\bid\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*["']([^"']+)["']\s*\})/g;
    let m;
    while ((m = idRe.exec(allText)) !== null) {
        idLiterals.add(m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]));
    }
    const templateBodies = [];
    const tplRe = /`[\s\S]*?`/g;
    while ((m = tplRe.exec(allText)) !== null) templateBodies.push(m[0]);
    const inTemplate = fragment => templateBodies.some(t => t.includes(fragment));

    for (const [path, text] of entries) {
        if (typeof text !== 'string' || !text) continue;

        const hrefRe = /(?<![-\w])href\s*=\s*(?:"#([^"]+)"|'#([^']+)'|\{\s*["']#([^"']+)["']\s*\})/g;
        while ((m = hrefRe.exec(text)) !== null) {
            if (violations.length >= MAX_VIOLATIONS) return violations;
            const fragment = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
            if (idLiterals.has(fragment) || inTemplate(fragment)) continue;
            const line = lineNumberForOffset(text, m.index);
            violations.push({
                type: 'broken-anchor',
                severity: 'error',
                file: path,
                line,
                fragment,
                detail: `href="#${fragment}" (${path} line ${line}) has no matching id="${fragment}" literal in any source file.`,
            });
        }

        // String-literal relative srcs only (src="assets/...").
        const srcRe = /(?<![-\w])src\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
        while ((m = srcRe.exec(text)) !== null) {
            if (violations.length >= MAX_VIOLATIONS) return violations;
            const src = m[1] !== undefined ? m[1] : m[2];
            if (/^(data|blob):/i.test(src) || /^https?:\/\//i.test(src) || src.startsWith('//') || src.startsWith('#')) continue;
            const normalized = normalizeAssetPath(src);
            if (!normalized || assetPathSet.has(normalized)) continue;
            const line = lineNumberForOffset(text, m.index);
            const suggestion = suggestAsset(src, assetPathSet);
            violations.push({
                type: 'missing-asset',
                severity: 'error',
                file: path,
                line,
                src,
                suggestion,
                detail: `<img src="${src}"> (${path} line ${line}) — no project file exists at that path.${suggestion ? ` Closest existing asset: ${suggestion}.` : ''}`,
            });
        }
    }

    return violations;
}

/**
 * Dispatcher. assetPaths must include ALL extra files (text AND binary).
 * Returns { violations } capped at MAX_VIOLATIONS.
 */
function validateWebpageProject({ framework, html, scriptTexts, sources, assetPaths, allowedHosts }) {
    const assetPathSet = new Set((assetPaths || []).map(normalizeAssetPath).filter(Boolean));
    const hosts = allowedHosts && allowedHosts.length ? allowedHosts : DEFAULT_ALLOWED_IMG_HOSTS;
    const violations = framework === 'react-mui'
        ? validateReactMui({ sources, assetPathSet, allowedHosts: hosts })
        : validateVanilla({ html: html || '', scriptTexts: scriptTexts || [], assetPathSet, allowedHosts: hosts });
    return { violations: violations.slice(0, MAX_VIOLATIONS) };
}

/**
 * The end-of-turn repair system message fed back to the generating model.
 */
function buildRepairMessage(violations, { assetPaths } = {}) {
    const assetList = assetPaths && assetPaths.length
        ? assetPaths.slice(0, 20).join(', ')
        : '(none uploaded)';
    const lines = ['AUTOMATED POST-GENERATION VALIDATION — the page you just saved has issues the user will see:'];
    for (const v of (violations || []).slice(0, MAX_VIOLATIONS)) {
        if (v.type === 'broken-anchor') {
            lines.push(`- [${v.severity}] ${v.detail} Add the id to the intended section or fix the href using webpage_file_replace.`);
        } else if (v.type === 'missing-asset') {
            lines.push(`- [${v.severity}] ${v.detail} Existing assets: ${assetList}. Use a real uploaded asset path, inline SVG/CSS, or https://placehold.co/WIDTHxHEIGHT.`);
        } else {
            lines.push(`- [${v.severity}] ${v.detail} Use an uploaded asset or https://placehold.co/WIDTHxHEIGHT, or add an onerror fallback (e.g. onerror="this.style.visibility='hidden'").`);
        }
    }
    lines.push('Fix these now with webpage_file_replace / webpage_replace_in_file. If a finding is intentional (e.g. the id is created dynamically at runtime), briefly tell the user why instead.');
    return lines.join('\n');
}

/**
 * Compact single-line note for the builder-tools per-write hook. '' when clean.
 */
function formatToolWarning(violations) {
    const actionable = (violations || []).filter(v => v.severity !== 'info');
    if (actionable.length === 0) return '';
    const summary = actionable.slice(0, MAX_VIOLATIONS).map(v => v.detail).join(' ');
    return `\nVALIDATION: ${summary} If you are about to add those sections/assets in your next calls, proceed; otherwise fix the hrefs/srcs.`;
}

module.exports = {
    DEFAULT_ALLOWED_IMG_HOSTS,
    MAX_VIOLATIONS,
    mergeAllowedImgHosts,
    stripHtmlComments,
    collectAnchorTargets,
    collectFragmentHrefs,
    extractImgRefs,
    classifyImgSrc,
    validateVanilla,
    validateReactMui,
    validateWebpageProject,
    buildRepairMessage,
    formatToolWarning,
};
