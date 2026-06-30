const test = require('node:test');
const assert = require('node:assert');

const reg = require('./index');

// Fake providers — enrichCompany is called with an explicit providers list, so
// we can exercise the merge + partial-failure logic without any network/DB.
const kvkLike = {
    id: 'kvk', label: 'KvK',
    async isConfigured() { return true; },
    async enrichCompany() {
        return {
            fields: { company_name: 'Acme BV', address: 'Straat 1', kvk_number: '12345678' },
            provenance: { company_name: { source: 'kvk', confidence: 0.95 }, address: { source: 'kvk', confidence: 0.95 } },
            contexts: [],
        };
    },
};
const hunterLike = {
    id: 'hunter', label: 'Hunter',
    async enrichCompany() {
        return { fields: { email: 'a@acme.nl', phone: '030-1' }, provenance: { email: { source: 'hunter', confidence: 0.9 }, phone: { source: 'hunter', confidence: 0.6 } }, contexts: [] };
    },
};
const webLike = {
    id: 'web_search', label: 'Web',
    async enrichCompany() { return { fields: {}, provenance: {}, contexts: [{ source: 'web_search', text: 'blah' }] }; },
};
const throwingLike = {
    id: 'apify_linkedin', label: 'Apify',
    async enrichCompany() { throw new Error('boom'); },
};

test('_mergeResults: highest-confidence value wins per field', () => {
    const merged = reg._mergeResults([
        { fields: { email: 'low@x' }, provenance: { email: { source: 'web_search', confidence: 0.4 } } },
        { fields: { email: 'high@x' }, provenance: { email: { source: 'hunter', confidence: 0.9 } } },
    ]);
    assert.strictEqual(merged.fields.email, 'high@x');
    assert.strictEqual(merged.provenance.email.source, 'hunter');
});

test('_mergeResults: skips null/empty values and collects contexts', () => {
    const merged = reg._mergeResults([
        { fields: { email: null, sbi_codes: [] }, provenance: {}, contexts: [{ source: 'a', text: 't1' }] },
        { fields: { phone: '030' }, provenance: {}, contexts: [{ source: 'b', text: 't2' }] },
        null,
    ]);
    assert.ok(!('email' in merged.fields));
    assert.ok(!('sbi_codes' in merged.fields));
    assert.strictEqual(merged.fields.phone, '030');
    assert.strictEqual(merged.contexts.length, 2);
});

test('enrichCompany: one provider throwing does not abort the others (partial enrichment)', async () => {
    const out = await reg.enrichCompany({ company_name: 'Acme BV', website: 'acme.nl' },
        [webLike, kvkLike, hunterLike, throwingLike], { log: () => {} });
    // KvK identity present
    assert.strictEqual(out.fields.kvk_number, '12345678');
    assert.strictEqual(out.fields.address, 'Straat 1');
    // Hunter contact fields merged
    assert.strictEqual(out.fields.email, 'a@acme.nl');
    assert.strictEqual(out.provenance.email.source, 'hunter');
    assert.strictEqual(out.fields.phone, '030-1');
    // web_search context collected; throwing provider contributed nothing
    assert.ok(out.contexts.some(c => c.source === 'web_search'));
});

test('getEnabledProviders always includes web_search even with nothing requested', async () => {
    const enabled = await reg.getEnabledProviders({ orgId: null, requested: [] });
    assert.ok(enabled.some(p => p.id === 'web_search'));
});

test('registry exposes the expected provider ids', () => {
    assert.deepStrictEqual(reg.PROVIDER_IDS, ['web_search', 'kvk', 'hunter', 'apollo', 'apify_linkedin']);
    const meta = reg.listProviderMeta();
    assert.strictEqual(meta.find(m => m.id === 'web_search').alwaysOn, true);
});
