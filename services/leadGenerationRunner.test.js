const test = require('node:test');
const assert = require('node:assert');

const runner = require('./leadGenerationRunner');
const { extractJson, extractCandidateArray, normalizeCandidates, mergeFinalLead, chunk, stripTierPrefix } = runner._internals;

test('extractJson parses a JSON object embedded in prose', () => {
    assert.deepStrictEqual(extractJson('Here you go: {"a":1,"b":"x"} done'), { a: 1, b: 'x' });
    assert.strictEqual(extractJson('no json here'), null);
    assert.strictEqual(extractJson(''), null);
    assert.strictEqual(extractJson(null), null);
});

test('extractCandidateArray handles bare arrays and wrapped object shapes', () => {
    assert.deepStrictEqual(extractCandidateArray('[{"company_name":"A"}]'), [{ company_name: 'A' }]);
    assert.deepStrictEqual(extractCandidateArray('{"companies":[{"company_name":"B"}]}'), [{ company_name: 'B' }]);
    assert.deepStrictEqual(extractCandidateArray('{"bedrijven":[{"naam":"C"}]}'), [{ naam: 'C' }]);
    assert.deepStrictEqual(extractCandidateArray('garbage'), []);
});

test('normalizeCandidates dedupes by name, maps fields, and respects target count', () => {
    const out = normalizeCandidates([
        { company_name: 'Acme BV', website: 'acme.nl', locatie: 'Utrecht' },
        { companyName: 'acme bv' },          // dup (case-insensitive)
        { naam: 'Foo NV', plaats: 'Amsterdam' },
        { name: 'Bar' },
        { website: 'no-name.com' },          // dropped (no name)
    ], 2);
    assert.strictEqual(out.length, 2);
    assert.deepStrictEqual(out[0], { company_name: 'Acme BV', website: 'acme.nl', locatie: 'Utrecht' });
    assert.strictEqual(out[1].company_name, 'Foo NV');
    assert.strictEqual(out[1].locatie, 'Amsterdam');
});

test('mergeFinalLead: enriched (deterministic) baseline wins, AI fills gaps', () => {
    const company = { company_name: 'Candidate Name', locatie: 'Utrecht' };
    const enriched = {
        fields: { company_name: 'Acme BV', kvk_number: '12345678', address: 'Straat 1' },
        provenance: { kvk_number: { source: 'kvk', confidence: 0.95 } },
    };
    const ai = { company_name: 'Acme', email: 'info@acme.nl', phone: '030-1', ai_confidence: 0.8 };
    const { finalFields, provenance, aiConfidence } = mergeFinalLead(company, enriched, ai);
    // KvK-backed enriched name is kept (not overwritten by AI)
    assert.strictEqual(finalFields.company_name, 'Acme BV');
    assert.strictEqual(finalFields.kvk_number, '12345678');
    // AI fills fields enrichment didn't have
    assert.strictEqual(finalFields.email, 'info@acme.nl');
    assert.strictEqual(finalFields.phone, '030-1');
    // provenance for AI-filled field is attributed
    assert.strictEqual(provenance.email.source, 'web_search');
    assert.strictEqual(provenance.kvk_number.source, 'kvk');
    assert.strictEqual(aiConfidence, 0.8);
});

test('mergeFinalLead falls back to the candidate name and clamps confidence', () => {
    const { finalFields, aiConfidence } = mergeFinalLead({ company_name: 'Fallback Co' }, { fields: {}, provenance: {} }, { ai_confidence: 5 });
    assert.strictEqual(finalFields.company_name, 'Fallback Co');
    assert.strictEqual(aiConfidence, 1); // clamped to [0,1]
});

test('chunk + stripTierPrefix', () => {
    assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.strictEqual(stripTierPrefix('tier:thinking'), 'thinking');
    assert.strictEqual(stripTierPrefix('thinking'), 'thinking');
    assert.strictEqual(stripTierPrefix(null), null);
});
