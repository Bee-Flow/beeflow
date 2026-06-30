/**
 * Unit tests for the pure automation-suggestion helpers.
 *
 * Run: node --test automation/suggestions.test.js
 * No I/O — the module is side-effect-free, so no process.exit dance needed.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
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
} = require('./suggestions');

// ── resolveActivityFilter ──────────────────────────────────────────────
test('resolveActivityFilter scopes to org when present', () => {
    assert.deepStrictEqual(resolveActivityFilter({ organizationId: 'org1', userId: 'u1' }), { organizationId: 'org1' });
});
test('resolveActivityFilter falls back to userId for consumer (null org)', () => {
    assert.deepStrictEqual(resolveActivityFilter({ organizationId: null, userId: 'u1' }), { userId: 'u1' });
});
test('resolveActivityFilter never returns a null-org filter', () => {
    const f = resolveActivityFilter({ organizationId: null, userId: 'u1' });
    assert.ok(!('organizationId' in f), 'organizationId must be absent, not null');
});
test('resolveActivityFilter empty when nothing identifies the caller', () => {
    assert.deepStrictEqual(resolveActivityFilter({}), {});
});

// ── deriveComplexity ───────────────────────────────────────────────────
test('deriveComplexity: quick for single-app no-AI notify', () => {
    assert.strictEqual(deriveComplexity({
        buildPrompt: 'When a file is added to a folder, send me a notification.',
        requiredIntegrations: ['nextcloud'],
    }), 'quick');
});
test('deriveComplexity: assisted for one AI step + 2 apps (invoice→sheet)', () => {
    assert.strictEqual(deriveComplexity({
        buildPrompt: 'When an invoice email arrives, extract the amount and vendor with AI and append a row to the spreadsheet.',
        requiredIntegrations: ['gmail', 'google-sheets'],
    }), 'assisted');
});
test('deriveComplexity: orchestrated for branching', () => {
    assert.strictEqual(deriveComplexity({
        buildPrompt: 'Read the document, and only if it is confidential, route to the approval queue.',
        requiredIntegrations: ['nextcloud'],
    }), 'orchestrated');
});
test('deriveComplexity: orchestrated for 3+ integrations', () => {
    assert.strictEqual(deriveComplexity({
        buildPrompt: 'Copy the data across the apps.',
        requiredIntegrations: ['gmail', 'google-sheets', 'nextcloud'],
    }), 'orchestrated');
});
test('deriveComplexity: advanced for loops', () => {
    assert.strictEqual(deriveComplexity({
        buildPrompt: 'For each attachment, extract the totals and store them.',
        requiredIntegrations: ['gmail', 'google-sheets'],
    }), 'advanced');
});
test('deriveComplexity clamps a too-low model label UP to the derived tier', () => {
    // Model claims "quick" but the prompt loops over items → advanced wins.
    assert.strictEqual(deriveComplexity({
        complexity: 'quick',
        buildPrompt: 'For each invoice, extract the totals.',
        requiredIntegrations: ['gmail', 'google-sheets'],
    }), 'advanced');
});
test('deriveComplexity respects a higher model label than derived', () => {
    // Plain structure derives "quick", but the model says "orchestrated" → keep the higher.
    assert.strictEqual(deriveComplexity({
        complexity: 'orchestrated',
        buildPrompt: 'Send me a ping.',
        requiredIntegrations: ['gmail'],
    }), 'orchestrated');
});

// ── parseSuggestionsJson ───────────────────────────────────────────────
test('parseSuggestionsJson parses a clean array', () => {
    assert.deepStrictEqual(parseSuggestionsJson('[{"title":"x"}]'), [{ title: 'x' }]);
});
test('parseSuggestionsJson strips ```json fences', () => {
    const out = parseSuggestionsJson('```json\n[{"title":"x"}]\n```');
    assert.deepStrictEqual(out, [{ title: 'x' }]);
});
test('parseSuggestionsJson tolerates leading/trailing prose', () => {
    const out = parseSuggestionsJson('Here are ideas:\n[{"title":"x"}]\nHope that helps!');
    assert.deepStrictEqual(out, [{ title: 'x' }]);
});
test('parseSuggestionsJson unwraps { suggestions: [...] }', () => {
    assert.deepStrictEqual(parseSuggestionsJson('{"suggestions":[{"title":"x"}]}'), [{ title: 'x' }]);
});
test('parseSuggestionsJson returns [] on garbage, never throws', () => {
    assert.deepStrictEqual(parseSuggestionsJson('not json at all'), []);
    assert.deepStrictEqual(parseSuggestionsJson(''), []);
    assert.deepStrictEqual(parseSuggestionsJson(null), []);
    assert.deepStrictEqual(parseSuggestionsJson('{ broken'), []);
});
test('parseSuggestionsJson passes through an already-parsed array', () => {
    assert.deepStrictEqual(parseSuggestionsJson([{ title: 'x' }]), [{ title: 'x' }]);
});

// ── validateAndRepairSuggestion ────────────────────────────────────────
const FULL = {
    title: 'Auto-file incoming invoices to a spreadsheet',
    description: 'When an invoice email arrives, extract amount/vendor/date and append a row.',
    complexity: 'quick', // deliberately too low — should be clamped up
    requiredIntegrations: ['gmail', 'google-sheets'],
    triggerKind: 'app_event',
    buildPrompt: 'When an invoice email arrives, extract the amount and vendor with AI and append a row to the spreadsheet.',
    groundedIn: 'activity',
};

test('validateAndRepairSuggestion keeps a good suggestion and assigns an id', () => {
    const s = validateAndRepairSuggestion(FULL, { availableIntegrationIds: new Set(['gmail', 'google-sheets']) });
    assert.ok(s, 'should be kept');
    assert.match(s.id, /^sug_/, 'server-assigned id');
    assert.strictEqual(s.complexity, 'assisted', 'complexity re-derived & clamped up from quick');
    assert.deepStrictEqual(s.requiredIntegrations, ['gmail', 'google-sheets']);
    assert.deepStrictEqual(s.unavailableIntegrations, []);
});
test('validateAndRepairSuggestion drops elements missing title or buildPrompt', () => {
    assert.strictEqual(validateAndRepairSuggestion({ buildPrompt: 'x' }), null);
    assert.strictEqual(validateAndRepairSuggestion({ title: 'x' }), null);
    assert.strictEqual(validateAndRepairSuggestion(null), null);
    assert.strictEqual(validateAndRepairSuggestion('nope'), null);
});
test('validateAndRepairSuggestion moves unavailable integrations to a hint list', () => {
    const s = validateAndRepairSuggestion(FULL, { availableIntegrationIds: new Set(['gmail']) });
    assert.deepStrictEqual(s.requiredIntegrations, ['gmail']);
    assert.deepStrictEqual(s.unavailableIntegrations, ['google-sheets']);
});
test('validateAndRepairSuggestion dedupes against existing automation titles', () => {
    const s = validateAndRepairSuggestion(FULL, {
        availableIntegrationIds: new Set(['gmail', 'google-sheets']),
        existingTitles: ['Auto file incoming invoices to a spreadsheet'],
    });
    assert.strictEqual(s, null, 'near-duplicate of an existing automation is dropped');
});
test('validateAndRepairSuggestion clamps overlong strings and defaults bad enums', () => {
    const s = validateAndRepairSuggestion({
        title: 'T'.repeat(200),
        buildPrompt: 'B'.repeat(2000),
        description: '',
        triggerKind: 'bogus',
        groundedIn: 'bogus',
        requiredIntegrations: ['gmail'],
    }, { availableIntegrationIds: new Set(['gmail']) });
    assert.ok(s.title.length <= 80, 'title clamped');
    assert.ok(s.buildPrompt.length <= 1200, 'buildPrompt clamped');
    assert.strictEqual(s.description, s.title, 'empty description falls back to title');
    assert.strictEqual(s.triggerKind, 'manual', 'bad triggerKind defaults to manual');
    assert.strictEqual(s.groundedIn, 'integration', 'bad groundedIn defaults to integration');
});

// ── normaliseSuggestions ───────────────────────────────────────────────
test('normaliseSuggestions filters, de-dupes within batch, sorts activity-first, and caps', () => {
    const raw = [
        { title: 'Ping me on new files', buildPrompt: 'When a file arrives, send a notification.', requiredIntegrations: ['nextcloud'], groundedIn: 'integration' },
        { title: 'Invoice email to sheet', buildPrompt: 'When an invoice email arrives, extract details with AI and append a row.', requiredIntegrations: ['gmail', 'google-sheets'], groundedIn: 'activity' },
        { title: 'Invoice email → sheet', buildPrompt: 'Same idea, duplicate.', requiredIntegrations: ['gmail', 'google-sheets'], groundedIn: 'activity' }, // dupe of #2
        { title: '', buildPrompt: 'missing title' }, // dropped
    ];
    const out = normaliseSuggestions(raw, {
        availableIntegrationIds: new Set(['nextcloud', 'gmail', 'google-sheets']),
        max: 6,
    });
    assert.strictEqual(out.length, 2, 'malformed + duplicate removed');
    assert.strictEqual(out[0].groundedIn, 'activity', 'activity-grounded sorted first');
    assert.strictEqual(out[0].title, 'Invoice email to sheet');
});
test('normaliseSuggestions caps to max', () => {
    const distinctNouns = ['invoices', 'receipts', 'contracts', 'newsletters', 'calendars', 'tickets', 'reminders', 'reports', 'leads', 'expenses'];
    const raw = distinctNouns.map((noun, i) => ({
        title: `Forward ${noun} weekly`,
        buildPrompt: `Every week, collect the ${noun} and forward them ${i}.`,
        requiredIntegrations: ['gmail'],
    }));
    const out = normaliseSuggestions(raw, { availableIntegrationIds: new Set(['gmail']), max: 4 });
    assert.strictEqual(out.length, 4);
});
test('normaliseSuggestions returns [] for non-array input', () => {
    assert.deepStrictEqual(normaliseSuggestions(null, {}), []);
});

// ── stripTokens (tokenize-mode PII placeholders) ───────────────────────
test('stripTokens replaces PII tokens with readable generic nouns', () => {
    assert.strictEqual(
        stripTokens('When an email arrives from [email_1], reply to [person_2].'),
        'When an email arrives from an email address, reply to someone.',
    );
});
test('stripTokens handles unknown labels and multiple digits', () => {
    assert.strictEqual(stripTokens('ref [widget_42] and [iban_1]'), 'ref a value and a bank account');
});
test('stripTokens is case-insensitive and leaves normal text/markdown alone', () => {
    assert.strictEqual(stripTokens('see [Email_3] here'), 'see an email address here');
    assert.strictEqual(stripTokens('a [link](http://x) and [plain text]'), 'a [link](http://x) and [plain text]');
});
test('stripTokens tolerates non-strings', () => {
    assert.strictEqual(stripTokens(null), '');
    assert.strictEqual(stripTokens(undefined), '');
});
test('stripTokens neutralises regex-redaction markers too', () => {
    assert.strictEqual(stripTokens('order [REDACTED:invoice_no] shipped'), 'order redacted shipped');
});
test('validateAndRepairSuggestion neutralises tokens in title/description/buildPrompt', () => {
    const s = validateAndRepairSuggestion({
        title: 'Reply to [email_1] automatically',
        description: 'Drafts a reply to [person_1] from [email_1].',
        buildPrompt: 'When mail from [email_1] arrives, draft a reply and send it.',
        requiredIntegrations: ['gmail'],
    }, { availableIntegrationIds: new Set(['gmail']) });
    assert.ok(s, 'kept');
    for (const field of ['title', 'description', 'buildPrompt']) {
        assert.ok(!/\[[a-z]+_\d+\]/i.test(s[field]), `${field} carries no raw token: ${s[field]}`);
    }
    assert.match(s.title, /an email address/);
});

// ── titlesSimilar ──────────────────────────────────────────────────────
test('titlesSimilar catches near-duplicates and ignores distinct ideas', () => {
    assert.ok(titlesSimilar('Auto-file invoices to a sheet', 'Auto file invoices to sheet'));
    assert.ok(!titlesSimilar('Invoice to spreadsheet', 'Weekly calendar digest'));
});

// ── buildScanSystemPrompt ──────────────────────────────────────────────
test('buildScanSystemPrompt embeds integrations, activity hints, existing titles and focus', () => {
    const p = buildScanSystemPrompt({
        selectedIntegrations: ['gmail', 'google-sheets'],
        activityHints: ['gmail_search ×42'],
        existingTitles: ['My existing automation'],
        focus: 'invoices',
    });
    assert.match(p, /gmail, google-sheets/);
    assert.match(p, /gmail_search ×42/);
    assert.match(p, /My existing automation/);
    assert.match(p, /focus on: invoices/);
    // Structured output now lives in the forced tool schema, not the prose.
    assert.match(p, /call the return_suggestions tool EXACTLY ONCE/i);
    assert.doesNotMatch(p, /Return ONLY a JSON array/);
});
test('buildScanSystemPrompt handles the cold-start (no activity) case', () => {
    const p = buildScanSystemPrompt({ selectedIntegrations: ['gmail'] });
    assert.match(p, /No prior in-app tool usage/);
});

// sanity: tiers exported in order
test('COMPLEXITY_TIERS ordered low→high', () => {
    assert.deepStrictEqual(COMPLEXITY_TIERS, ['quick', 'assisted', 'orchestrated', 'advanced']);
});

// ── SUGGESTIONS_TOOL (forced structured-output contract) ───────────────
test('SUGGESTIONS_TOOL is an OpenAI-format return_suggestions function tool', () => {
    assert.strictEqual(SUGGESTIONS_TOOL.type, 'function');
    assert.strictEqual(SUGGESTIONS_TOOL.function.name, 'return_suggestions');
    assert.match(SUGGESTIONS_TOOL.function.description, /suggestion/i);
    const params = SUGGESTIONS_TOOL.function.parameters;
    assert.strictEqual(params.type, 'object');
    assert.strictEqual(params.additionalProperties, false);
    assert.deepStrictEqual(params.required, ['suggestions']);
    const item = params.properties.suggestions.items;
    assert.strictEqual(params.properties.suggestions.type, 'array');
    assert.strictEqual(item.additionalProperties, false);
    assert.deepStrictEqual(item.required, ['title', 'buildPrompt']);
    // enums wired to the canonical source-of-truth arrays
    assert.deepStrictEqual(item.properties.complexity.enum, COMPLEXITY_TIERS);
    assert.deepStrictEqual(item.properties.triggerKind.enum, VALID_TRIGGER_KINDS);
    assert.deepStrictEqual(item.properties.groundedIn.enum, ['activity', 'integration']);
});

// ── extractSuggestionsFromToolCall ─────────────────────────────────────
test('extractSuggestionsFromToolCall returns the array from {suggestions:[...]}', () => {
    assert.deepStrictEqual(
        extractSuggestionsFromToolCall({ suggestions: [{ title: 'x' }] }),
        [{ title: 'x' }],
    );
});
test('extractSuggestionsFromToolCall returns [] for null/non-object/missing, never throws', () => {
    assert.deepStrictEqual(extractSuggestionsFromToolCall(null), []);
    assert.deepStrictEqual(extractSuggestionsFromToolCall(undefined), []);
    assert.deepStrictEqual(extractSuggestionsFromToolCall('nope'), []);
    assert.deepStrictEqual(extractSuggestionsFromToolCall(42), []);
    assert.deepStrictEqual(extractSuggestionsFromToolCall({}), []);
    assert.deepStrictEqual(extractSuggestionsFromToolCall({ suggestions: 'not-array' }), []);
    assert.deepStrictEqual(extractSuggestionsFromToolCall([{ title: 'x' }]), []); // array itself has no .suggestions
});

// ── buildScanDigest ────────────────────────────────────────────────────
test('buildScanDigest cold-start when there is no activity', () => {
    const d = buildScanDigest({ activityByTool: [] });
    assert.match(d, /SCAN DIGEST/);
    assert.match(d, /cold start/i);
});
test('buildScanDigest renders rows with counts, direction, recency and shape', () => {
    const now = Date.now();
    const d = buildScanDigest({
        activityByTool: [
            { tool_name: 'gmail_search', integration_type: 'gmail', data_direction: 'read', total: 45, last_used: new Date(now - 3 * 86400000).toISOString() },
        ],
        toolShapes: { gmail_search: '{ messages: [...] }' },
    });
    assert.match(d, /gmail_search ×45 \(read, last 3d\)/);
    assert.match(d, /-> returns \{ messages/);
});
test('buildScanDigest includes existing-titles and focus lines', () => {
    const d = buildScanDigest({
        activityByTool: [{ tool_name: 'gmail_search', total: 5, data_direction: 'read', last_used: null }],
        existingTitles: ['Weekly digest'],
        focus: 'invoices',
    });
    assert.match(d, /user already automated: Weekly digest/);
    assert.match(d, /focus: invoices/);
});
test('buildScanDigest stays under the defensive length cap', () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ tool_name: `tool_${i}`, total: i, data_direction: 'read', last_used: null }));
    const d = buildScanDigest({ activityByTool: rows });
    assert.ok(d.length <= 6000, `digest length ${d.length} should be capped`);
});

// ── buildActivityIndex ─────────────────────────────────────────────────
test('buildActivityIndex keys by both tool_name and integration_type', () => {
    const now = Date.now();
    const idx = buildActivityIndex([
        { tool_name: 'gmail_search', integration_type: 'gmail', total: 45, last_used: new Date(now - 2 * 86400000).toISOString() },
    ], now);
    assert.ok(idx instanceof Map);
    assert.strictEqual(idx.get('gmail_search').count, 45);
    assert.strictEqual(idx.get('gmail').count, 45);
    assert.strictEqual(idx.get('gmail').lastUsedDays, 2);
});
test('buildActivityIndex tolerates null timestamps and sums duplicate keys', () => {
    const idx = buildActivityIndex([
        { tool_name: 'x', total: 3, last_used: null },
        { tool_name: 'x', total: 4, last_used: null },
    ]);
    assert.strictEqual(idx.get('x').count, 7);
    assert.strictEqual(idx.get('x').lastUsedDays, null);
});

// ── scoreSuggestion (fully server-derived, clamped) ────────────────────
test('scoreSuggestion: score 0-100, minutesSavedPerMonth <=600, evidence summary <=160 + PII-stripped', () => {
    const idx = buildActivityIndex([
        { tool_name: 'gmail', integration_type: 'gmail', total: 100000, last_used: new Date().toISOString() },
    ]);
    const { evidence, value } = scoreSuggestion({
        title: 'Triage [email_1] every morning',
        complexity: 'advanced',
        requiredIntegrations: ['gmail'],
        groundedIn: 'activity',
    }, { activityIndex: idx });
    assert.ok(value.score >= 0 && value.score <= 100, `score ${value.score} in range`);
    assert.ok(value.minutesSavedPerMonth <= 600, `minutes ${value.minutesSavedPerMonth} clamped`);
    assert.ok(evidence.summary.length <= 160, 'summary clamped');
    assert.ok(!/\[[a-z]+_\d+\]/i.test(evidence.summary), 'summary carries no raw PII token');
    assert.strictEqual(evidence.kind, 'activity');
    assert.ok(Array.isArray(evidence.signals));
    assert.ok(['daily', 'weekly', 'monthly', 'occasional'].includes(value.frequencyLabel));
    assert.ok(['high', 'medium', 'low'].includes(value.confidence));
});
test('scoreSuggestion with no activity falls back to integration evidence + low confidence', () => {
    const { evidence, value } = scoreSuggestion({
        title: 'Some idea',
        complexity: 'quick',
        requiredIntegrations: ['notion'],
        groundedIn: 'integration',
    }, { activityIndex: new Map() });
    assert.strictEqual(evidence.kind, 'integration');
    assert.strictEqual(value.confidence, 'low');
    assert.strictEqual(value.minutesSavedPerMonth, 0);
    assert.strictEqual(value.frequencyLabel, 'occasional');
    assert.match(evidence.summary, /notion/);
});

// ── fingerprintTitle ───────────────────────────────────────────────────
test('fingerprintTitle is stable for equivalent titles and differs by title', () => {
    const a = fingerprintTitle('Auto-file invoices', 'When an invoice arrives, file it.');
    const a2 = fingerprintTitle('Auto file the invoices', 'When an invoice arrives, file it.'); // same significant tokens
    const b = fingerprintTitle('Weekly calendar digest', 'When an invoice arrives, file it.');
    assert.strictEqual(a, a2, 'token-equivalent titles fingerprint the same');
    assert.notStrictEqual(a, b, 'different titles fingerprint differently');
    assert.match(a, /^[0-9a-f]{64}$/, 'sha256 hex');
});

// ── computeScanCacheKey ────────────────────────────────────────────────
test('computeScanCacheKey is order-insensitive on integration + title lists', () => {
    const k1 = computeScanCacheKey({ focusInteg: ['gmail', 'notion'], focus: 'x', existingTitles: ['A', 'B'] });
    const k2 = computeScanCacheKey({ focusInteg: ['notion', 'gmail'], focus: 'x', existingTitles: ['B', 'A'] });
    assert.strictEqual(k1, k2);
    const k3 = computeScanCacheKey({ focusInteg: ['gmail'], focus: 'x', existingTitles: ['A', 'B'] });
    assert.notStrictEqual(k1, k3, 'different inputs → different key');
    assert.match(k1, /^[0-9a-f]{64}$/);
});

// ── normaliseSuggestions WITH activityIndex (score-ranked) ─────────────
test('normaliseSuggestions with activityIndex attaches evidence/value and sorts by score DESC', () => {
    const idx = buildActivityIndex([
        { tool_name: 'gmail', integration_type: 'gmail', total: 500, last_used: new Date().toISOString() },
    ]);
    const raw = [
        // No activity → low score, but listed first in input.
        { title: 'Tidy my notion board', buildPrompt: 'Reorganise the notion board weekly.', requiredIntegrations: ['notion'], groundedIn: 'integration' },
        // Heavy gmail activity + grounded → high score, listed second.
        { title: 'Triage inbound gmail', buildPrompt: 'Read incoming gmail and label it.', requiredIntegrations: ['gmail'], groundedIn: 'activity' },
    ];
    const out = normaliseSuggestions(raw, {
        availableIntegrationIds: new Set(['notion', 'gmail']),
        activityIndex: idx,
    });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].title, 'Triage inbound gmail', 'higher-scoring suggestion sorts first');
    assert.ok(out[0].value.score > out[1].value.score, 'sorted by score DESC');
    assert.ok(out[0].evidence && out[0].value, 'evidence/value attached');
});
test('normaliseSuggestions WITHOUT activityIndex preserves legacy activity-first behaviour', () => {
    const raw = [
        { title: 'Ping me on new files', buildPrompt: 'When a file arrives, send a notification.', requiredIntegrations: ['nextcloud'], groundedIn: 'integration' },
        { title: 'Invoice email to sheet', buildPrompt: 'When an invoice email arrives, extract details with AI and append a row.', requiredIntegrations: ['gmail', 'google-sheets'], groundedIn: 'activity' },
    ];
    const out = normaliseSuggestions(raw, {
        availableIntegrationIds: new Set(['nextcloud', 'gmail', 'google-sheets']),
    });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].groundedIn, 'activity', 'activity-grounded still sorted first');
    assert.strictEqual(out[0].value, undefined, 'no value attached without an activity index');
});
