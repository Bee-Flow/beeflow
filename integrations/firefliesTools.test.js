/**
 * Unit tests for the Fireflies tool title-matching logic (BFSF-227).
 *
 * Run: node integrations/firefliesTools.test.js
 *
 * No network/DB needed — we stub `configStore` like the existing
 * ticketAssistantTools tests and script `global.fetch` to play back
 * Fireflies GraphQL responses page by page.
 */

const assert = require('assert');

// Stub configStore (same trick as ticketAssistantTools.test.js).
const configStorePath = require.resolve('../stores/configStore');
require.cache[configStorePath] = {
    id: configStorePath,
    filename: configStorePath,
    loaded: true,
    exports: {
        getSecret: async () => 'fake-key',
    },
};

const { executeFirefliesTool, normalizeTitle, classifyTitleMatches } = require('./firefliesTools');

// ── fetch stub ─────────────────────────────────────────────────────────
let fetchCalls = [];
function scriptFetch(pages) {
    // pages: one transcripts array per expected upstream request, in order.
    fetchCalls = [];
    global.fetch = async (url, opts) => {
        const body = JSON.parse(opts.body);
        fetchCalls.push(body.variables);
        const transcripts = pages[fetchCalls.length - 1];
        if (transcripts === undefined) throw new Error(`Unexpected upstream request #${fetchCalls.length}`);
        return {
            ok: true,
            json: async () => ({ data: { transcripts } }),
        };
    };
}

// Minimal raw transcript record as returned by the Fireflies GraphQL API.
const T = (id, title) => ({
    id,
    title,
    date: 1700000000000,
    dateString: '2025-11-14T00:00:00.000Z',
    duration: 30,
    organizer_email: 'tom@example.com',
    participants: ['tom@example.com'],
    transcript_url: `https://app.fireflies.ai/view/${id}`,
    speakers: [{ id: 1, name: 'Tom' }],
});

(async () => {
    // ── normalizeTitle ────────────────────────────────────────────────
    assert.strictEqual(normalizeTitle('  Weekly   Sync  '), 'weekly sync');
    assert.strictEqual(normalizeTitle('A\tB\nC'), 'a b c');
    assert.strictEqual(normalizeTitle(null), '');
    assert.strictEqual(normalizeTitle(undefined), '');

    // ── classifyTitleMatches ──────────────────────────────────────────
    {
        const list = [T('a', 'Weekly Sync'), T('b', 'weekly  SYNC '), T('c', 'Weekly Sync — Q3'), T('d', 'Other')];
        const { exact, partial } = classifyTitleMatches(list, 'Weekly Sync');
        assert.deepStrictEqual(exact.map(t => t.id), ['a', 'b'], 'duplicate exact matches are all listed');
        assert.deepStrictEqual(partial.map(t => t.id), ['c'], 'superset titles count as partial');
    }
    {
        // Empty/missing titles never match (not even as partial).
        const { exact, partial } = classifyTitleMatches([T('e', ''), T('f', undefined)], 'weekly sync');
        assert.strictEqual(exact.length, 0);
        assert.strictEqual(partial.length, 0);
    }

    // ── Case 1: exact title hit on the first (filtered) page ─────────
    scriptFetch([[T('t1', 'Roadmap Review'), T('t2', 'Roadmap Review Prep')]]);
    let r = await executeFirefliesTool('fireflies_list_transcripts', { title: 'roadmap review' }, 'u1');
    assert.strictEqual(fetchCalls.length, 1, 'exactly 1 upstream request');
    assert.strictEqual(r.matchQuality, 'exact');
    assert.strictEqual(r.exactMatches[0].id, 't1');
    assert.ok(r.message.includes('Exact title match'), 'steering message present');
    assert.strictEqual(r.results[0].id, 't1', 'exact match ordered first');
    assert.strictEqual(r.count, 2, 'count still reflects returned results');

    // ── Case 2: strict-filter miss rescued by the fallback page ──────
    scriptFetch([[], [T('t9', 'Weekly Sync '), T('t8', 'Standup')]]);
    r = await executeFirefliesTool('fireflies_list_transcripts', { title: 'weekly sync' }, 'u1');
    assert.strictEqual(fetchCalls.length, 2, 'exactly 2 upstream requests');
    assert.strictEqual(fetchCalls[1].title, null, 'fallback drops the server-side title filter');
    assert.strictEqual(fetchCalls[1].limit, 50, 'fallback scans one page of 50');
    assert.strictEqual(fetchCalls[1].skip, 0);
    assert.strictEqual(r.matchQuality, 'exact', 'case/whitespace near-miss detected as exact');
    assert.strictEqual(r.exactMatches[0].id, 't9');

    // ── Case 3: no match anywhere ─────────────────────────────────────
    const noise = Array.from({ length: 50 }, (_, i) => T(`m${i}`, `Topic ${i}`));
    scriptFetch([[], noise]);
    r = await executeFirefliesTool('fireflies_list_transcripts', { title: 'Budget 2026 kickoff' }, 'u1');
    assert.strictEqual(fetchCalls.length, 2, 'exactly 2 upstream requests');
    assert.strictEqual(r.matchQuality, 'none');
    assert.ok(Array.isArray(r.scannedTitles) && r.scannedTitles.length === 50, 'scannedTitles lists everything scanned');
    assert.ok(r.results.length <= 10, 'results capped');
    assert.ok(r.message.includes('Do not guess transcript ids'), 'steering message present');

    // ── Case 3b: fallback with only partial matches → capped at 10 ───
    const partials = Array.from({ length: 15 }, (_, i) => T(`p${i}`, `Weekly Sync ${i}`));
    scriptFetch([[], partials]);
    r = await executeFirefliesTool('fireflies_list_transcripts', { title: 'Weekly Sync' }, 'u1');
    assert.strictEqual(fetchCalls.length, 2);
    assert.strictEqual(r.matchQuality, 'partial');
    assert.strictEqual(r.results.length, 10, 'partial results capped at 10');
    assert.strictEqual(r.count, 10, 'count matches returned results');
    assert.strictEqual(r.scannedTitles.length, 15);
    assert.ok(r.message.includes('No exact title match'), 'steering message present');

    // ── Case 4: no title arg → original behavior, no extra keys ──────
    scriptFetch([[T('t1', 'A'), T('t2', 'B')]]);
    r = await executeFirefliesTool('fireflies_list_transcripts', { limit: 5 }, 'u1');
    assert.strictEqual(fetchCalls.length, 1, 'single upstream request');
    assert.strictEqual(r.matchQuality, undefined, 'no matchQuality without title');
    assert.strictEqual(r.exactMatches, undefined);
    assert.strictEqual(r.scannedTitles, undefined);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.message, 'Found 2 transcript(s).');

    scriptFetch([[]]);
    r = await executeFirefliesTool('fireflies_list_transcripts', {}, 'u1');
    assert.strictEqual(fetchCalls.length, 1, 'no fallback without a title');
    assert.strictEqual(r.message, 'No transcripts found matching your criteria.');

    console.log('firefliesTools.test.js — all checks passed');
})().catch(err => {
    console.error(err);
    process.exit(1);
});
