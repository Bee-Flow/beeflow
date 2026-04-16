/**
 * Custom sensitive-term scanner for the org Privacy Shield.
 *
 * Admins configure a list of terms (regex or literal) that should be treated
 * like PII — redacted or blocked before prompts leave the organisation.
 * Typical examples: project codenames, contract-number patterns, customer
 * list entries, internal product names.
 *
 * Performance: terms are compiled into a single union regex per org and cached
 * until the admin saves a change (the route calls `invalidate(orgId)`).
 */

// In-memory cache: orgId → { compiled: RegExp|null, termIndex: Array<{ id, label, pattern, caseSensitive }> }
const _cache = new Map();

function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile an array of term configs into a single union regex plus a lookup
 * table (so we can attribute a match to its original term).
 *
 * @param {Array} terms  [{ id, label, pattern, caseSensitive, type: 'regex'|'literal' }]
 * @returns {{ compiled: RegExp|null, termIndex: Array }}
 */
function _compile(terms) {
    if (!Array.isArray(terms) || terms.length === 0) {
        return { compiled: null, termIndex: [] };
    }
    const parts = [];
    const termIndex = [];
    for (const term of terms) {
        if (!term?.pattern || !term?.label) continue;
        const raw = term.type === 'literal' ? escapeRegex(term.pattern) : term.pattern;
        // Wrap in a named group so matches can be attributed. Group names must
        // be unique per regex, so we derive a short alias from the index.
        const groupName = `t${termIndex.length}`;
        try {
            // Compile individually first to reject a bad regex cheaply.
            new RegExp(raw, term.caseSensitive ? 'g' : 'gi');
        } catch (err) {
            console.warn(`[CustomTerms] Skipping invalid term "${term.label}": ${err.message}`);
            continue;
        }
        parts.push(`(?<${groupName}>${raw})`);
        termIndex.push({
            id: term.id || groupName,
            label: term.label,
            pattern: term.pattern,
            type: term.type === 'literal' ? 'literal' : 'regex',
            caseSensitive: !!term.caseSensitive,
            groupName,
        });
    }
    if (parts.length === 0) return { compiled: null, termIndex: [] };

    // V8's regex engine does not accept inline-flag groups like `(?i:...)`
    // nested inside a named capture group, so we can't mix per-term case-
    // sensitivity inside a single union regex. We work around it by compiling
    // the union as case-insensitive and then dropping any match whose literal
    // text doesn't satisfy a case-sensitive comparison for terms that asked
    // for one. This keeps the happy path on a single regex pass.
    const unionSource = termIndex
        .map((entry, i) => {
            const raw = terms[i].type === 'literal' ? escapeRegex(terms[i].pattern) : terms[i].pattern;
            return `(?<${entry.groupName}>${raw})`;
        })
        .join('|');

    let compiled;
    try {
        compiled = new RegExp(unionSource, 'gi');
    } catch (err) {
        console.error('[CustomTerms] Union compile failed, falling back to per-term scanning:', err.message);
        return { compiled: null, termIndex };
    }
    return { compiled, termIndex };
}

function _getCompiled(orgId, terms) {
    const cached = _cache.get(orgId);
    if (cached) return cached;
    const compiled = _compile(terms);
    _cache.set(orgId, compiled);
    return compiled;
}

/**
 * Drop the cached compile for an org. Call from the Privacy Shield PUT route.
 */
function invalidate(orgId) {
    if (orgId) _cache.delete(orgId);
}

/**
 * Scan `text` for any of the org's configured sensitive terms.
 *
 * @param {string} text
 * @param {string} orgId
 * @param {Array} terms  Raw term config from org Privacy Shield
 * @returns {Array<{ category: string, label: string, start: number, end: number, match: string, termId: string }>}
 */
function scanCustomTerms(text, orgId, terms) {
    if (!text || !orgId || !Array.isArray(terms) || terms.length === 0) return [];

    const { compiled, termIndex } = _getCompiled(orgId, terms);
    if (!compiled) {
        // Fallback: scan each term individually. Slower but robust to union-compile failures.
        const findings = [];
        for (const term of terms) {
            if (!term?.pattern) continue;
            try {
                const raw = term.type === 'literal' ? escapeRegex(term.pattern) : term.pattern;
                const re = new RegExp(raw, term.caseSensitive ? 'g' : 'gi');
                let m;
                while ((m = re.exec(text)) !== null) {
                    findings.push({
                        category: 'CustomTerm',
                        label: term.label,
                        start: m.index,
                        end: m.index + m[0].length,
                        match: m[0],
                        termId: term.id || term.label,
                    });
                    if (m.index === re.lastIndex) re.lastIndex++; // guard zero-width matches
                }
            } catch (_) { /* skip invalid term */ }
        }
        return findings;
    }

    const findings = [];
    let m;
    compiled.lastIndex = 0;
    while ((m = compiled.exec(text)) !== null) {
        // Figure out which named group matched.
        const namedGroups = m.groups || {};
        let entry = null;
        for (const e of termIndex) {
            if (namedGroups[e.groupName] !== undefined) { entry = e; break; }
        }
        if (entry) {
            // Case-sensitive post-filter: the union regex is compiled `gi`, so
            // for a term that wants exact-case matching we verify here.
            if (entry.caseSensitive) {
                const pattern = entry.type === 'literal' ? entry.pattern : null;
                // For literal case-sensitive: exact string equality.
                // For regex case-sensitive: recompile the single pattern without 'i'.
                if (pattern != null) {
                    if (m[0] !== pattern) { if (m.index === compiled.lastIndex) compiled.lastIndex++; continue; }
                } else {
                    try {
                        const sensitive = new RegExp(`^(?:${entry.pattern})$`);
                        if (!sensitive.test(m[0])) { if (m.index === compiled.lastIndex) compiled.lastIndex++; continue; }
                    } catch (_) { /* if recompile fails, accept the case-insensitive match */ }
                }
            }
            findings.push({
                category: 'CustomTerm',
                label: entry.label,
                start: m.index,
                end: m.index + m[0].length,
                match: m[0],
                termId: entry.id,
            });
        }
        if (m.index === compiled.lastIndex) compiled.lastIndex++; // zero-width guard
    }
    return findings;
}

module.exports = {
    scanCustomTerms,
    invalidate,
    _compile, // exported for tests
};
