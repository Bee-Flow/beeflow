const test = require('node:test');
const assert = require('node:assert');

const assistant = require('./leadAiAssistant');
const { cityFromAddress, companyFromLead, leadLocatie, parseEmail } = assistant._internals;

// Stubbable singletons (the service accesses these via their module object).
const store = require('../stores/leadStudioStore');
const leadEnrichment = require('../integrations/leadEnrichment');
const agentSearch = require('../integrations/agentSearchTools');
const runner = require('./leadGenerationRunner');

// ── Pure helpers ────────────────────────────────────────────────────

test('cityFromAddress extracts the city from a Dutch address', () => {
    assert.strictEqual(cityFromAddress('Bovenkerkerweg 81b, 1187 XC Amstelveen'), 'Amstelveen');
    assert.strictEqual(cityFromAddress('Straat 1, Utrecht'), 'Utrecht');
    assert.strictEqual(cityFromAddress(null), null);
});

test('leadLocatie prefers campaign criteria, then the address', () => {
    assert.strictEqual(leadLocatie({ address: '1187 XC Amstelveen' }, { criteria: { locatie: 'Amsterdam' } }), 'Amsterdam');
    assert.strictEqual(leadLocatie({ address: '1187 XC Amstelveen' }, { criteria: {} }), 'Amstelveen');
});

test('companyFromLead shapes a lead back into a candidate', () => {
    const c = companyFromLead({ companyName: 'Acme BV', website: 'acme.nl', address: '1000 AA Amsterdam' }, { criteria: {} });
    assert.deepStrictEqual(c, { company_name: 'Acme BV', website: 'acme.nl', locatie: 'Amsterdam' });
});

test('parseEmail handles strict JSON and prose fallback', () => {
    assert.deepStrictEqual(parseEmail('{"subject":"Hoi","body":"Beste,\\n\\nGroet"}'), { subject: 'Hoi', body: 'Beste,\n\nGroet' });
    const fb = parseEmail('Onderwerp: Kennismaking\nBeste Jan,\nGraag spreken we af.');
    assert.strictEqual(fb.subject, 'Kennismaking');
    assert.match(fb.body, /Beste Jan/);
    // empty → safe default subject
    assert.strictEqual(parseEmail('').subject, 'Voorstel tot kennismaking');
});

// ── Integration (stubbed deps) ──────────────────────────────────────

function withStubs(stubs, fn) {
    const targets = [
        [store, ['getLead', 'getCampaign', 'upsertLead', 'markResearched', 'saveEmailDraft']],
        [leadEnrichment, ['getEnabledProviders', 'enrichCompany']],
        [agentSearch, ['executeWebSearch']],
        [runner, ['resolveModelAndAdapter', 'chatOnce', 'compactLead']],
    ];
    const saved = [];
    for (const [obj, keys] of targets) for (const k of keys) { saved.push([obj, k, obj[k]]); }
    Object.assign(store, stubs.store);
    Object.assign(leadEnrichment, stubs.enrich);
    Object.assign(agentSearch, stubs.search);
    Object.assign(runner, stubs.runner);
    return Promise.resolve().then(fn).finally(() => { for (const [obj, k, v] of saved) obj[k] = v; });
}

const baseLead = {
    id: 'lead-1', campaignId: 'camp-1', organizationId: 'org-1',
    companyName: 'Acme BV', website: 'acme.nl', address: '1000 AA Amsterdam',
    dedupKey: 'dom:acme.nl', status: 'qualified', notes: 'belangrijke klant', verified: true,
    email: null, phone: null,
};
const baseCampaign = { id: 'camp-1', modelTier: 'thinking', enrichmentProviders: ['web_search'], criteria: { branche: 'Bouw' }, outreachPitch: 'Wij halveren je administratie.' };

test('researchLead merges new fields, stamps research, and never sends collaboration columns', async () => {
    let upsertArg = null;
    await withStubs({
        store: {
            getLead: async () => ({ ...baseLead }),
            getCampaign: async () => ({ ...baseCampaign }),
            upsertLead: async (arg) => { upsertArg = arg; return { lead: { ...baseLead, email: arg.email }, created: false }; },
            markResearched: async (id, userId) => ({ ...baseLead, email: 'info@acme.nl', lastResearchByUserId: userId, lastResearchAt: 'NOW' }),
        },
        enrich: {
            getEnabledProviders: async () => [],
            enrichCompany: async () => ({ fields: {}, provenance: {}, contexts: [] }),
        },
        search: { executeWebSearch: async () => '## result\nAcme info' },
        runner: {
            resolveModelAndAdapter: async () => ({ adapter: {}, provider: {}, modelId: 'm', tierCfg: {} }),
            compactLead: async () => ({ email: 'info@acme.nl', ai_confidence: 0.8 }),
        },
    }, async () => {
        const out = await assistant.researchLead({ leadId: 'lead-1', orgId: 'org-1', userId: 'u-1' });
        assert.ok(upsertArg, 'upsertLead was called');
        // updates in place (existing dedup key, not a recomputed one)
        assert.strictEqual(upsertArg.dedupKey, 'dom:acme.nl');
        // new contact field flows through
        assert.strictEqual(upsertArg.email, 'info@acme.nl');
        // collaboration columns are NOT part of the upsert payload
        assert.ok(!('status' in upsertArg) && !('notes' in upsertArg) && !('verified' in upsertArg));
        // changed list reports the newly-found field
        assert.deepStrictEqual(out.changed, ['email']);
        assert.strictEqual(out.usedSearch, true);
        // returned lead is markResearched's result
        assert.strictEqual(out.lead.lastResearchByUserId, 'u-1');
    });
});

test('researchLead survives a web-search failure (best-effort, non-fatal)', async () => {
    let upserted = false;
    await withStubs({
        store: {
            getLead: async () => ({ ...baseLead }),
            getCampaign: async () => ({ ...baseCampaign }),
            upsertLead: async () => { upserted = true; return { lead: baseLead, created: false }; },
            markResearched: async () => ({ ...baseLead }),
        },
        enrich: { getEnabledProviders: async () => [], enrichCompany: async () => ({ fields: {}, provenance: {}, contexts: [] }) },
        search: { executeWebSearch: async () => { throw new Error('fetch failed'); } },
        runner: {
            resolveModelAndAdapter: async () => ({ adapter: {}, provider: {}, modelId: 'm', tierCfg: {} }),
            compactLead: async () => ({}),
        },
    }, async () => {
        const out = await assistant.researchLead({ leadId: 'lead-1', orgId: 'org-1', userId: 'u-1' });
        assert.strictEqual(upserted, true);
        assert.strictEqual(out.usedSearch, false);
    });
});

test('draftEmail generates subject+body and persists the draft on the lead', async () => {
    let savedDraft = null;
    await withStubs({
        store: {
            getLead: async () => ({ ...baseLead, ownerName: 'Jan Jansen' }),
            getCampaign: async () => ({ ...baseCampaign }),
            saveEmailDraft: async (id, d) => { savedDraft = { id, ...d }; return { ...baseLead, emailDraftSubject: d.subject, emailDraftBody: d.body }; },
        },
        enrich: {},
        search: { executeWebSearch: async () => '## context\nAcme opende een nieuwe vestiging.' },
        runner: {
            resolveModelAndAdapter: async () => ({ adapter: {}, provider: {}, modelId: 'm', tierCfg: {} }),
            chatOnce: async () => ({ content: '{"subject":"Samenwerken met Acme","body":"Beste Jan,\\n\\nGefeliciteerd met jullie nieuwe vestiging.\\n\\n[Jouw naam]"}' }),
        },
    }, async () => {
        const out = await assistant.draftEmail({ leadId: 'lead-1', orgId: 'org-1', userId: 'u-1' });
        assert.strictEqual(out.subject, 'Samenwerken met Acme');
        assert.match(out.body, /Beste Jan/);
        assert.strictEqual(out.usedSearch, true);
        // persisted via saveEmailDraft with the user id
        assert.ok(savedDraft);
        assert.strictEqual(savedDraft.id, 'lead-1');
        assert.strictEqual(savedDraft.userId, 'u-1');
        assert.strictEqual(savedDraft.subject, 'Samenwerken met Acme');
    });
});

test('draftEmail with save:false does not persist', async () => {
    let saveCalled = false;
    await withStubs({
        store: {
            getLead: async () => ({ ...baseLead }),
            getCampaign: async () => ({ ...baseCampaign }),
            saveEmailDraft: async () => { saveCalled = true; return baseLead; },
        },
        enrich: {},
        search: { executeWebSearch: async () => '' },
        runner: {
            resolveModelAndAdapter: async () => ({ adapter: {}, provider: {}, modelId: 'm', tierCfg: {} }),
            chatOnce: async () => ({ content: 'Onderwerp: Hoi\nBeste,\nGroet.' }),
        },
    }, async () => {
        const out = await assistant.draftEmail({ leadId: 'lead-1', orgId: 'org-1', userId: 'u-1', save: false });
        assert.strictEqual(saveCalled, false);
        assert.strictEqual(out.subject, 'Hoi');
        assert.strictEqual(out.usedSearch, false); // empty search context
    });
});
