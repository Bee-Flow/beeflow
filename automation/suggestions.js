/**
 * Automation suggestions — pure helpers for the "Find repeating work" scan.
 *
 * The /api/automation/builder/suggest route runs a read-only agentic scan of
 * the user's connected tools and asks a model for candidate automations. This
 * module owns everything that is pure (no I/O): the system prompt, the JSON
 * parser, the deterministic complexity classifier, and the per-suggestion
 * validate/repair pass. Keeping it side-effect-free mirrors how templates.js
 * and summarise.js sit apart from their routes, and makes it `node --test`-able
 * without an HTTP server or DB pool.
 *
 * NOTE: the model's output is UNTRUSTED. It hallucinates tools, mislabels
 * complexity, and duplicates work the user already has. Every suggestion is
 * re-derived and clamped here before it reaches the client.
 */

const crypto = require('crypto');

// Complexity tiers, low → high. Index is the rank used for clamping: we never
// let a suggestion present a lower tier than the structure of its build prompt
// implies (the model under-promises effort otherwise).
const COMPLEXITY_TIERS = ['quick', 'assisted', 'orchestrated', 'advanced'];
const VALID_TRIGGER_KINDS = ['app_event', 'schedule', 'webhook', 'manual'];
const VALID_GROUNDING = ['activity', 'integration'];

const MAX_TITLE_LEN = 80;
const MAX_DESCRIPTION_LEN = 200;
// Generous so the model can hand the automation builder the FULL grounding —
// the trigger, each step, the data flow, AND the concrete specifics it observed
// during the scan (real senders/labels/folders/recurrence). The builder gets
// this verbatim, so detail here directly improves the built automation.
const MAX_BUILD_PROMPT_LEN = 1200;
const DEFAULT_MAX_SUGGESTIONS = 6;

// Defensive cap on the scan digest fed to the model. The digest is built from
// activity rows + tool shapes; we never want it to balloon a prompt.
const MAX_DIGEST_LEN = 6000;
const MAX_DIGEST_ROWS = 60;

/**
 * The structured-output contract for the scan. No provider adapter honours
 * response_format/json_schema, so the model returns its suggestions by being
 * FORCED to call this single OpenAI-format function tool exactly once. The JSON
 * shape lives here (not in the prose prompt) so the model can't drift from it.
 */
const SUGGESTIONS_TOOL = {
    type: 'function',
    function: {
        name: 'return_suggestions',
        description: 'Return the automation suggestions you found.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['suggestions'],
            properties: {
                suggestions: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['title', 'buildPrompt'],
                        properties: {
                            title: { type: 'string' },
                            description: { type: 'string' },
                            complexity: { type: 'string', enum: COMPLEXITY_TIERS },
                            requiredIntegrations: { type: 'array', items: { type: 'string' } },
                            triggerKind: { type: 'string', enum: VALID_TRIGGER_KINDS },
                            buildPrompt: { type: 'string', description: 'A COMPLETE, self-contained spec the automation builder can follow with NO extra context: the trigger, each step in order, the data flow between steps, AND the concrete specifics you observed during the scan (the actual senders/labels/folders/recurrence/frequency). Never include secrets or full personal data.' },
                            groundedIn: { type: 'string', enum: ['activity', 'integration'] },
                        },
                    },
                },
            },
        },
    },
};

/**
 * Pull the suggestions array out of the forced tool call's parsed arguments.
 * The runtime hands us whatever the model put in `return_suggestions`'s args
 * object; we only trust `.suggestions` when it's an array. Never throws.
 */
function extractSuggestionsFromToolCall(structured) {
    return Array.isArray(structured?.suggestions) ? structured.suggestions : [];
}

function tierRank(tier) {
    const i = COMPLEXITY_TIERS.indexOf(String(tier || '').toLowerCase());
    return i; // -1 when unknown
}

/**
 * Decide which activity-log filter key to use. Org users scope to the org
 * (team-wide repeating work); consumer users have organization_id = NULL and
 * MUST scope to their own user_id — passing { organizationId: null } would be
 * dropped by buildFilters and silently widen the query, so we never do that.
 */
function resolveActivityFilter({ organizationId, userId } = {}) {
    if (organizationId) return { organizationId };
    if (userId) return { userId };
    return {};
}

/**
 * Tokenise a title for fuzzy duplicate detection: lowercase, split on
 * non-alphanumerics, drop short/stop words.
 */
const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'into', 'from', 'your', 'a', 'an', 'to', 'of', 'in', 'on', 'when', 'new', 'auto']);
function titleTokens(s) {
    return new Set(
        String(s || '')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(t => t.length > 2 && !STOP_WORDS.has(t))
    );
}

/** Two titles are "the same idea" if one contains the other or their token sets overlap heavily. */
function titlesSimilar(a, b) {
    const na = String(a || '').trim().toLowerCase();
    const nb = String(b || '').trim().toLowerCase();
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) return true;
    const ta = titleTokens(a);
    const tb = titleTokens(b);
    if (ta.size === 0 || tb.size === 0) return false;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    const union = ta.size + tb.size - inter;
    return union > 0 && inter / union >= 0.6;
}

/**
 * Deterministically classify a suggestion's complexity from its structured
 * fields plus keyword signals in its build prompt/description. Returns the
 * higher of (the model's self-label, the derived tier) so we never under-state
 * effort. Highest applicable rule wins.
 */
function deriveComplexity(suggestion = {}) {
    const text = `${suggestion.buildPrompt || ''} ${suggestion.description || ''}`.toLowerCase();
    const reqs = Array.isArray(suggestion.requiredIntegrations) ? suggestion.requiredIntegrations : [];
    const count = reqs.length;

    const hasAiReasoning = /\b(extract|summari[sz]e|classif|categori[sz]e|analy[sz]e|decide|draft|generate|detect|interpret|enrich|judge|review the)\b/.test(text);
    const hasBranching = /\b(if |only if|only when|condition|otherwise|else|depending on|route to|branch)\b/.test(text);
    const hasApproval = /\b(approv|sign-?off|review before|ask (me|the owner)|confirm before|wait for)\b/.test(text);
    const hasLoop = /\b(each|every item|for all|loop|per item|iterate|one by one|all of them)\b/.test(text);

    let derived;
    if (hasLoop || count >= 4 || (hasApproval && hasBranching)) {
        derived = 'advanced';
    } else if (hasBranching || hasApproval || count >= 3) {
        derived = 'orchestrated';
    } else if (hasAiReasoning || count >= 2) {
        derived = 'assisted';
    } else {
        derived = 'quick';
    }

    const labelRank = tierRank(suggestion.complexity);
    const derivedRank = tierRank(derived);
    return COMPLEXITY_TIERS[Math.max(labelRank, derivedRank, 0)];
}

/**
 * Extract a JSON array of suggestions from a model completion. Tolerates
 * ```json fences, leading/trailing prose, and an object-wrapped
 * { "suggestions": [...] } shape. Never throws — returns [] on anything
 * unparseable.
 */
function parseSuggestionsJson(content) {
    if (Array.isArray(content)) return content;
    let text = String(content || '').trim();
    if (!text) return [];

    // Strip code fences (```json ... ``` or ``` ... ```).
    text = text.replace(/```(?:json)?/gi, '').trim();

    const tryParse = (s) => {
        try { return JSON.parse(s); } catch { return undefined; }
    };

    // First, a straight parse (handles a clean array or { suggestions: [...] }).
    let parsed = tryParse(text);
    if (parsed === undefined) {
        // Fall back to slicing the outermost array out of surrounding prose.
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        if (start !== -1 && end > start) parsed = tryParse(text.slice(start, end + 1));
    }
    if (parsed === undefined) {
        // Last resort: an object literal that wraps the array.
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start !== -1 && end > start) parsed = tryParse(text.slice(start, end + 1));
    }

    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.suggestions)) return parsed.suggestions;
    return [];
}

function clampString(v, max) {
    if (typeof v !== 'string') return '';
    const s = v.replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max).trim() : s;
}

function normaliseIntegrationIds(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
        const id = String(raw || '').trim().toLowerCase();
        if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
}

// When the org runs the Privacy Shield in "tokenize" mode, the scan feeds the
// model tokenized data (`[email_1]`, `[person_2]`, … from piiDetection's
// tokenizeText). The model is told to stay generic, but a token can still leak
// into a suggestion. We never restore the real value into a suggestion (it's a
// generic pattern, not someone's data) and we never want a raw token to reach
// the UI or the downstream builder — so residual tokens are replaced with a
// readable generic noun. Matches `[<catKey>_<n>]`, case-insensitive.
const TOKEN_WORDS = {
    email: 'an email address',
    person: 'someone',
    name: 'a name',
    phone: 'a phone number',
    phonenumber: 'a phone number',
    creditcard: 'a card number',
    iban: 'a bank account',
    ssn: 'an ID number',
    nationalid: 'an ID number',
    nationalidentificationnumber: 'an ID number',
    passport: 'a passport number',
    address: 'an address',
    location: 'a place',
    organization: 'an organisation',
    organisation: 'an organisation',
    org: 'an organisation',
    company: 'a company',
    url: 'a link',
    ip: 'an IP address',
    ipaddress: 'an IP address',
    date: 'a date',
    dob: 'a date of birth',
};
const TOKEN_RE = /\[([a-z][a-z0-9]*)_\d+\]/gi;
const REDACTED_RE = /\[REDACTED:[^\]]*\]/gi;
function stripTokens(text) {
    if (typeof text !== 'string' || text.indexOf('[') === -1) return text || '';
    return text
        .replace(TOKEN_RE, (_m, label) => TOKEN_WORDS[String(label).toLowerCase()] || 'a value')
        .replace(REDACTED_RE, 'redacted');
}

/**
 * Validate and repair one raw suggestion from the model. Returns a clean
 * suggestion object, or null when the element is too malformed to keep or is a
 * near-duplicate of an automation the user already has.
 *
 * @param {object} raw
 * @param {object} opts
 * @param {Iterable<string>} [opts.availableIntegrationIds] integration ids the
 *        user can actually use. Required ids outside this set are kept but moved
 *        to `unavailableIntegrations` (shown as a muted "needs X" hint).
 * @param {string[]} [opts.existingTitles] titles of the user's current
 *        automations, for duplicate suppression.
 */
function validateAndRepairSuggestion(raw, { availableIntegrationIds, existingTitles = [] } = {}) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    // Neutralise any PII tokens the model echoed from tokenized scan data, so a
    // raw `[email_1]` never reaches the UI or the downstream builder.
    const title = clampString(stripTokens(raw.title), MAX_TITLE_LEN);
    const buildPrompt = clampString(stripTokens(raw.buildPrompt), MAX_BUILD_PROMPT_LEN);
    if (!title || !buildPrompt) return null; // the two load-bearing fields

    // Drop ideas the user already automated.
    for (const existing of existingTitles) {
        if (titlesSimilar(title, existing)) return null;
    }

    let description = clampString(stripTokens(raw.description), MAX_DESCRIPTION_LEN);
    if (!description) description = title;

    const triggerKind = VALID_TRIGGER_KINDS.includes(raw.triggerKind) ? raw.triggerKind : 'manual';
    const groundedIn = VALID_GROUNDING.includes(raw.groundedIn) ? raw.groundedIn : 'integration';

    // Split required integrations into available vs not. When the caller did not
    // supply an availability set, treat everything as available.
    const reqs = normaliseIntegrationIds(raw.requiredIntegrations);
    let requiredIntegrations = reqs;
    let unavailableIntegrations = [];
    if (availableIntegrationIds) {
        const avail = availableIntegrationIds instanceof Set ? availableIntegrationIds : new Set(availableIntegrationIds);
        requiredIntegrations = reqs.filter(id => avail.has(id));
        unavailableIntegrations = reqs.filter(id => !avail.has(id));
    }

    const suggestion = {
        id: `sug_${crypto.randomUUID().slice(0, 8)}`,
        title,
        description,
        requiredIntegrations,
        unavailableIntegrations,
        triggerKind,
        buildPrompt,
        groundedIn,
    };
    // Re-derive complexity from the repaired fields (clamped against the label).
    suggestion.complexity = deriveComplexity({ ...suggestion, complexity: raw.complexity });
    return suggestion;
}

/**
 * Validate+repair a whole batch: drop malformed/duplicate elements, suppress
 * cross-suggestion duplicates, sort activity-grounded ideas first, and cap to
 * `max`.
 */
function normaliseSuggestions(rawArray, { availableIntegrationIds, existingTitles = [], max = DEFAULT_MAX_SUGGESTIONS, activityIndex = null } = {}) {
    if (!Array.isArray(rawArray)) return [];
    const kept = [];
    const keptTitles = [];
    for (const raw of rawArray) {
        const s = validateAndRepairSuggestion(raw, { availableIntegrationIds, existingTitles });
        if (!s) continue;
        if (keptTitles.some(t => titlesSimilar(t, s.title))) continue; // de-dupe within the batch
        // When an activity index is supplied, attach server-derived evidence/value
        // (the model never supplies these) so the client can rank + justify ideas.
        if (activityIndex) {
            const { evidence, value } = scoreSuggestion(s, { activityIndex });
            s.evidence = evidence;
            s.value = value;
        }
        kept.push(s);
        keptTitles.push(s.title);
        if (kept.length >= max) break;
    }
    if (activityIndex) {
        // Rank by the server-derived value score (DESC), stable on ties.
        return kept
            .map((s, i) => ({ s, i }))
            .sort((a, b) => (b.s.value.score - a.s.value.score) || (a.i - b.i))
            .map(({ s }) => s);
    }
    // Legacy behaviour (no activity index): stable sort with activity-grounded first.
    return kept
        .map((s, i) => ({ s, i }))
        .sort((a, b) => {
            const av = a.s.groundedIn === 'activity' ? 0 : 1;
            const bv = b.s.groundedIn === 'activity' ? 0 : 1;
            return av - bv || a.i - b.i;
        })
        .map(({ s }) => s);
}

/**
 * Build the system prompt for the read-only scan. The model is given the user's
 * read-only tools (as OpenAI function schemas, separately) and told to inspect
 * recent data, find repeating work, and emit a JSON array of suggestions.
 */
function buildScanSystemPrompt({ selectedIntegrations = [], activityHints = [], existingTitles = [], focus = '', maxSuggestions = DEFAULT_MAX_SUGGESTIONS } = {}) {
    const integrationList = selectedIntegrations.length
        ? selectedIntegrations.join(', ')
        : '(none selected)';

    const activityBlock = activityHints.length
        ? `\nRecent tool usage (frequency signal — higher counts = more repetitive):\n${activityHints.map(h => `  - ${h}`).join('\n')}`
        : '\nNo prior in-app tool usage recorded — ideate from what the connected tools can do.';

    const existingBlock = existingTitles.length
        ? `\nThe user ALREADY has these automations — do NOT suggest near-duplicates:\n${existingTitles.map(t => `  - ${t}`).join('\n')}`
        : '';

    const focusBlock = focus ? `\nThe user asked you to focus on: ${focus}` : '';

    return [
        'You are Bee Flow\'s automation scout. Your job is to find REPEATING work a user does inside their connected apps and propose automations that would save them time.',
        '',
        'You have been given READ-ONLY tools for these integrations: ' + integrationList + '.',
        'Use them to inspect the user\'s recent data — search/list recent emails, files, calendar events, etc. Look for patterns that repeat: the same kind of email or attachment arriving often, recurring reports, manual copying of data between apps.',
        'BE EFFICIENT: a few targeted reads per app are enough to see its patterns — list/search the most recent items, note what repeats, then move ON. Do NOT repeat near-identical searches on the same app, and try to SAMPLE EACH selected app at least once rather than spending every read on one. Once you have enough signal, STOP reading and call return_suggestions.',
        'Combine signals ACROSS apps. A great suggestion often spans two tools (e.g. invoice PDFs arriving in email → key details extracted into a spreadsheet), even if no ready-made template exists for it.',
        activityBlock,
        existingBlock,
        focusBlock,
        '',
        'RULES:',
        '- Only propose automations buildable from the listed integrations.',
        '- Prefer ideas grounded in the user\'s ACTUAL recent activity over generic ones; mark those with "groundedIn":"activity".',
        '- Be specific and concrete (reference the real senders/labels/folders you observed when you can), but never include secrets or full personal data in the text.',
        '- Do not invent tools or apps the user does not have.',
        '',
        'COMPLEXITY guidance for each suggestion:',
        '  quick = single app, 1-2 steps, no AI; assisted = one AI step + 1-2 apps;',
        '  orchestrated = branching/approval or 3+ apps; advanced = loops, multiple AI decisions, or governance + branching.',
        '',
        `When you are done inspecting, call the return_suggestions tool EXACTLY ONCE with up to ${maxSuggestions} suggestions.`,
        'For each suggestion include a short imperative "title", a one-sentence plain-language "description" for a non-technical user, a "complexity" tier, the "requiredIntegrations" ids it needs, a "triggerKind", and "groundedIn" set to "activity" if you saw evidence in the scanned data, else "integration".',
        'The "buildPrompt" is the most important field: write a COMPLETE, self-contained spec the automation builder can follow with no extra context — the trigger, each step in order, the data flow between steps, AND the concrete specifics you actually observed (the real senders/labels/folders/recurrence/frequency that make this idea worth automating). Be detailed; the builder receives this verbatim. Never include secrets or full personal data.',
        'If you find nothing worth automating, call return_suggestions with an empty list.',
    ].join('\n');
}

/**
 * How many days ago a timestamp was, relative to `now`. Tolerates null/invalid
 * inputs (returns null — "never used / unknown").
 */
function daysSince(ts, now = Date.now()) {
    if (ts == null) return null;
    const t = ts instanceof Date ? ts.getTime() : Date.parse(ts);
    if (!Number.isFinite(t)) return null;
    const days = Math.floor((now - t) / 86400000);
    return days < 0 ? 0 : days;
}

/** Render a small "last used" hint from a day count (null → '', 0 → 'today'). */
function lastUsedHint(days) {
    if (days == null) return '';
    if (days <= 0) return 'today';
    return `last ${days}d`;
}

/**
 * Build a compact, model-facing digest of the user's recent tool activity plus
 * (optionally) short return-shape hints, the focus, and what they already
 * automated. Pure string building — capped defensively so it can't bloat the
 * prompt. Each row renders like `gmail_search ×45 (read, last 3d)` and, when a
 * short shape string is known, ` -> returns {…}`.
 */
function buildScanDigest({ activityByTool = [], existingTitles = [], focus = '', toolShapes = {} } = {}) {
    const lines = ['SCAN DIGEST — observed tool activity:'];
    const rows = Array.isArray(activityByTool) ? activityByTool : [];

    if (!rows.length) {
        lines.push('  (cold start: no prior in-app tool usage recorded — ideate from what the connected tools can do)');
    } else {
        for (const row of rows.slice(0, MAX_DIGEST_ROWS)) {
            if (!row) continue;
            const tool = String(row.tool_name || row.integration_type || '').trim();
            if (!tool) continue;
            const total = Number(row.total) || 0;
            const dir = String(row.data_direction || '').trim();
            const used = lastUsedHint(daysSince(row.last_used));
            const meta = [dir, used].filter(Boolean).join(', ');
            let line = `  - ${tool} ×${total}${meta ? ` (${meta})` : ''}`;
            const shape = toolShapes && typeof toolShapes[tool] === 'string' ? toolShapes[tool].trim() : '';
            if (shape) line += ` -> returns ${clampString(shape, 120)}`;
            lines.push(line);
        }
    }

    const titles = Array.isArray(existingTitles) ? existingTitles.filter(Boolean) : [];
    if (titles.length) {
        lines.push(`user already automated: ${titles.map(t => clampString(stripTokens(t), MAX_TITLE_LEN)).join('; ')}`);
    }

    const f = clampString(String(focus || ''), 200);
    if (f) lines.push(`focus: ${f}`);

    return clampString(lines.join('\n'), MAX_DIGEST_LEN);
}

/**
 * Index activity rows for O(1) lookup during scoring. Keyed by BOTH the
 * tool_name and the integration_type so a suggestion's requiredIntegrations
 * (which are integration ids, e.g. "gmail") OR a raw tool name both resolve.
 * Tolerates null timestamps. When the same key appears twice, counts sum and we
 * keep the most-recent lastUsedDays.
 */
function buildActivityIndex(activityRows = [], now = Date.now()) {
    const map = new Map();
    const rows = Array.isArray(activityRows) ? activityRows : [];
    const add = (rawKey, count, days) => {
        const key = String(rawKey || '').trim().toLowerCase();
        if (!key) return;
        const prev = map.get(key);
        if (prev) {
            prev.count += count;
            if (days != null && (prev.lastUsedDays == null || days < prev.lastUsedDays)) prev.lastUsedDays = days;
        } else {
            map.set(key, { count, lastUsedDays: days });
        }
    };
    for (const row of rows) {
        if (!row) continue;
        const count = Number(row.total) || 0;
        const days = daysSince(row.last_used, now);
        add(row.tool_name, count, days);
        if (row.integration_type && row.integration_type !== row.tool_name) add(row.integration_type, count, days);
    }
    return map;
}

// Per-occurrence minutes saved, by complexity tier — a manual run of a more
// involved automation costs the user more, so it saves more when automated.
const MINUTES_PER_OCCURRENCE = { quick: 2, assisted: 4, orchestrated: 8, advanced: 12 };
const MAX_MINUTES_PER_MONTH = 600;

function frequencyLabel(monthlyCount) {
    if (monthlyCount >= 20) return 'daily';
    if (monthlyCount >= 4) return 'weekly';
    if (monthlyCount >= 1) return 'monthly';
    return 'occasional';
}

/**
 * Derive evidence + value for a suggestion from the activity index. The MODEL
 * never supplies these — they are fully server-computed and clamped, so a
 * hallucinated "this saves 10 hours" can never reach the UI. Deterministic.
 *
 * @returns {{ evidence: object, value: object }}
 */
function scoreSuggestion(suggestion = {}, { activityIndex } = {}) {
    const idx = activityIndex instanceof Map ? activityIndex : new Map();
    const reqs = Array.isArray(suggestion.requiredIntegrations) ? suggestion.requiredIntegrations : [];

    const signals = [];
    let totalCount = 0;
    let minLastUsedDays = null;
    for (const raw of reqs) {
        const integration = String(raw || '').trim().toLowerCase();
        if (!integration) continue;
        const hit = idx.get(integration);
        const count = hit ? hit.count : 0;
        const lastUsedDays = hit ? hit.lastUsedDays : null;
        signals.push({ tool: integration, integration, count, lastUsedDays });
        totalCount += count;
        if (lastUsedDays != null && (minLastUsedDays == null || lastUsedDays < minLastUsedDays)) {
            minLastUsedDays = lastUsedDays;
        }
    }

    const hasActivity = totalCount > 0;
    const groundedActivity = suggestion.groundedIn === 'activity';

    // ── score (0-100) ──────────────────────────────────────────────────
    // Base on summed activity counts (diminishing returns), plus a grounding
    // bonus, a recency bonus (small lastUsedDays → fresher), and a small
    // complexity factor (heavier work is worth automating). Clamped 0-100.
    let score = Math.min(60, Math.round(Math.sqrt(totalCount) * 9)); // up to ~60 from volume
    if (groundedActivity) score += 15;
    if (minLastUsedDays != null) {
        if (minLastUsedDays <= 3) score += 15;
        else if (minLastUsedDays <= 7) score += 10;
        else if (minLastUsedDays <= 30) score += 5;
    }
    score += Math.max(0, tierRank(suggestion.complexity)) * 2; // 0..6
    score = Math.max(0, Math.min(100, Math.round(score)));

    // ── minutesSavedPerMonth ───────────────────────────────────────────
    const perOcc = MINUTES_PER_OCCURRENCE[String(suggestion.complexity || '').toLowerCase()] || MINUTES_PER_OCCURRENCE.quick;
    const minutesSavedPerMonth = Math.min(MAX_MINUTES_PER_MONTH, Math.max(0, Math.round(totalCount * perOcc)));

    const confidence = hasActivity ? (totalCount >= 10 ? 'high' : 'medium') : 'low';

    // ── evidence.summary (PII-stripped, <=160) ─────────────────────────
    let summary;
    if (hasActivity) {
        const top = signals.filter(s => s.count > 0).sort((a, b) => b.count - a.count)[0];
        const windowDays = minLastUsedDays != null ? Math.max(minLastUsedDays, 1) : 30;
        summary = top
            ? `${top.tool} ×${top.count} in ${windowDays}d`
            : `${totalCount} recent uses`;
    } else {
        const apps = reqs.length ? reqs.join(', ') : 'connected apps';
        summary = `based on what ${apps} can do`;
    }
    summary = clampString(stripTokens(summary), 160);

    return {
        evidence: {
            kind: groundedActivity ? 'activity' : 'integration',
            signals,
            summary,
        },
        value: {
            score,
            minutesSavedPerMonth,
            frequencyLabel: frequencyLabel(totalCount),
            confidence,
        },
    };
}

/**
 * Stable content fingerprint for a suggestion, for cross-scan de-duplication /
 * caching. Built from the title's significant tokens (order-insensitive) plus a
 * short, PII-stripped slice of the build prompt. Pure.
 */
function fingerprintTitle(title, buildPrompt = '') {
    const tokens = [...titleTokens(title)].sort().join(',');
    const tail = clampString(stripTokens(buildPrompt), 50);
    return crypto.createHash('sha256').update(`${tokens}|${tail}`).digest('hex');
}

/**
 * Cache key for a whole scan request. Order-insensitive on the integration and
 * existing-title lists so the same intent hits the same cache slot. Pure.
 */
function computeScanCacheKey({ focusInteg = [], focus = '', existingTitles = [] } = {}) {
    const integ = [...(Array.isArray(focusInteg) ? focusInteg : [])].map(String).sort().join(',');
    const titles = [...(Array.isArray(existingTitles) ? existingTitles : [])].map(String).sort().join(',');
    return crypto.createHash('sha256').update(`${integ}|${String(focus || '')}|${titles}`).digest('hex');
}

module.exports = {
    COMPLEXITY_TIERS,
    VALID_TRIGGER_KINDS,
    SUGGESTIONS_TOOL,
    resolveActivityFilter,
    deriveComplexity,
    parseSuggestionsJson,
    extractSuggestionsFromToolCall,
    validateAndRepairSuggestion,
    normaliseSuggestions,
    buildScanSystemPrompt,
    buildScanDigest,
    buildActivityIndex,
    scoreSuggestion,
    fingerprintTitle,
    computeScanCacheKey,
    titlesSimilar,
    stripTokens,
    // internal, exported for tests
    _test: { tierRank, titleTokens, clampString, normaliseIntegrationIds, daysSince },
};
