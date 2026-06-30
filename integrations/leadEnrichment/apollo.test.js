const test = require('node:test');
const assert = require('node:assert');

const apollo = require('./apollo');
const configStore = require('../../stores/configStore');

function jsonResponse(payload, { ok = true } = {}) {
    return { ok, headers: { get: () => 'application/json' }, json: async () => payload };
}

// Route the two Apollo calls (api_search → people/match) to canned payloads.
function routedFetch({ search, match, searchOk = true, matchOk = true }) {
    return async (url) => {
        if (String(url).includes('/people/match')) return jsonResponse(match || {}, { ok: matchOk });
        return jsonResponse(search || {}, { ok: searchOk });
    };
}

function withEnv({ key = 'apollo-key', fetchImpl }, fn) {
    const origGetSecret = configStore.getSecret;
    const origFetch = global.fetch;
    configStore.getSecret = async (name) => (name === 'apollo_api_key' ? key : null);
    if (fetchImpl) global.fetch = fetchImpl;
    return Promise.resolve().then(fn).finally(() => { configStore.getSecret = origGetSecret; global.fetch = origFetch; });
}

test('apollo: no-op when no API key is configured', async () => {
    await withEnv({ key: null }, async () => {
        const out = await apollo.enrichCompany({ company_name: 'Acme BV', website: 'acme.nl' }, {});
        assert.deepStrictEqual(out, { fields: {}, provenance: {}, contexts: [] });
    });
});

test('apollo: search → match yields full name + verified email + phone', async () => {
    const search = { people: [{ id: 'p1', name: 'Peter J.', title: 'Eigenaar', linkedin_url: 'https://linkedin.com/in/peterjansen', email: 'email_not_unlocked@acme.nl', organization: { primary_phone: { number: '+31 20 000' } } }] };
    const match = { person: { id: 'p1', first_name: 'Peter', last_name: 'Jansen', name: 'Peter Jansen', title: 'Eigenaar', email: 'peter@acme.nl', email_status: 'verified', phone_numbers: [{ sanitized_number: '+31201234567' }] } };
    await withEnv({ fetchImpl: routedFetch({ search, match }) }, async () => {
        const out = await apollo.enrichCompany({ company_name: 'Acme BV', website: 'https://acme.nl' }, {});
        assert.strictEqual(out.fields.owner_name, 'Peter Jansen'); // full name from match wins over partial search name
        assert.strictEqual(out.fields.email, 'peter@acme.nl');     // real email (search one was masked)
        assert.strictEqual(out.fields.phone, '+31201234567');      // direct number from match
        assert.strictEqual(out.fields.contact_title, 'Eigenaar');
        assert.strictEqual(out.fields.linkedin_url, 'https://linkedin.com/in/peterjansen');
        assert.strictEqual(out.provenance.email.source, 'apollo');
    });
});

test('apollo: match failure still returns search-level fields, masked email dropped', async () => {
    const search = { people: [{ id: 'p2', name: 'Jane D.', title: 'CEO', linkedin_url: 'https://linkedin.com/in/jane', email: 'email_not_unlocked@acme.nl', organization: { primary_phone: { number: '+31 20 999' } } }] };
    await withEnv({ fetchImpl: routedFetch({ search, match: {}, matchOk: false }) }, async () => {
        const out = await apollo.enrichCompany({ company_name: 'Acme BV', website: 'acme.nl' }, { log: () => {} });
        assert.strictEqual(out.fields.owner_name, 'Jane D.');
        assert.strictEqual(out.fields.contact_title, 'CEO');
        assert.strictEqual(out.fields.phone, '+31 20 999'); // falls back to company phone
        assert.ok(!('email' in out.fields), 'masked email must not be persisted');
    });
});

test('apollo: no people returned → graceful no-op (no match call)', async () => {
    await withEnv({ fetchImpl: routedFetch({ search: { people: [] } }) }, async () => {
        const out = await apollo.enrichCompany({ company_name: 'Acme BV', website: 'acme.nl' }, {});
        assert.deepStrictEqual(out, { fields: {}, provenance: {}, contexts: [] });
    });
});

test('apollo: search transport error → graceful no-op', async () => {
    await withEnv({ fetchImpl: routedFetch({ search: {}, searchOk: false }) }, async () => {
        const out = await apollo.enrichCompany({ company_name: 'Acme BV', website: 'acme.nl' }, { log: () => {} });
        assert.deepStrictEqual(out, { fields: {}, provenance: {}, contexts: [] });
    });
});
