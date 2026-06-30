process.env.LEAD_CRM_TASK_TICK = 'false'; // no scheduler during tests

const test = require('node:test');
const assert = require('node:assert');

const assistant = require('./leadCrmAssistant');
const leadStudioStore = require('../stores/leadStudioStore');
const leadCrmStore = require('../stores/leadCrmStore');
const runner = require('./leadGenerationRunner');

function withStubs(stubs, fn) {
    const targets = [
        [leadStudioStore, ['getLead', 'getCampaign', 'listAllLeads', 'setHotness']],
        [leadCrmStore, ['listActivities', 'listTasks', 'logActivity']],
        [runner, ['resolveModelAndAdapter', 'chatOnce']],
    ];
    const saved = [];
    for (const [obj, keys] of targets) for (const k of keys) saved.push([obj, k, obj[k]]);
    Object.assign(leadStudioStore, stubs.store);
    Object.assign(leadCrmStore, stubs.crm);
    Object.assign(runner, stubs.runner);
    return Promise.resolve().then(fn).finally(() => { for (const [o, k, v] of saved) o[k] = v; });
}

const lead = { id: 'l1', campaignId: 'c1', organizationId: 'org1', companyName: 'Acme BV', status: 'contacted', updatedAt: new Date().toISOString() };
const campaign = { id: 'c1', modelTier: 'thinking' };
const mc = { adapter: {}, provider: {}, modelId: 'm', tierCfg: {} };

test('suggestNextStep normalises the AI response', async () => {
    await withStubs({
        store: { getLead: async () => lead, getCampaign: async () => campaign },
        crm: { listActivities: async () => [], listTasks: async () => [] },
        runner: {
            resolveModelAndAdapter: async () => mc,
            chatOnce: async () => ({ content: '{"suggestion":"Stuur een opvolgmail","rationale":"Geen reactie in 5 dagen","action":{"type":"email"},"taskTitle":null,"taskDueInDays":null}' }),
        },
    }, async () => {
        const out = await assistant.suggestNextStep({ leadId: 'l1', orgId: 'org1', userId: 'u1' });
        assert.strictEqual(out.action.type, 'email');
        assert.match(out.suggestion, /opvolgmail/);
        assert.match(out.rationale, /5 dagen/);
    });
});

test('suggestNextStep falls back to a task when the action type is invalid', async () => {
    await withStubs({
        store: { getLead: async () => lead, getCampaign: async () => campaign },
        crm: { listActivities: async () => [], listTasks: async () => [] },
        runner: { resolveModelAndAdapter: async () => mc, chatOnce: async () => ({ content: 'geen json' }) },
    }, async () => {
        const out = await assistant.suggestNextStep({ leadId: 'l1', orgId: 'org1', userId: 'u1' });
        assert.strictEqual(out.action.type, 'task');
        assert.ok(out.suggestion); // safe default
    });
});

test('logFromNotes persists a structured activity and returns suggestions', async () => {
    let logged = null;
    await withStubs({
        store: { getLead: async () => lead, getCampaign: async () => campaign },
        crm: { logActivity: async (a) => { logged = a; return { id: 'a1', ...a }; } },
        runner: {
            resolveModelAndAdapter: async () => mc,
            chatOnce: async () => ({ content: '{"type":"call","body":"Goed gesprek, interesse in demo","suggestedStatus":"qualified","suggestedTask":{"title":"Demo plannen","dueInDays":3}}' }),
        },
    }, async () => {
        const out = await assistant.logFromNotes({ leadId: 'l1', orgId: 'org1', userId: 'u1', text: 'belde, wil demo' });
        assert.ok(logged && logged.type === 'call');
        assert.match(logged.body, /demo/i);
        assert.strictEqual(out.suggestedStatus, 'qualified'); // differs from current 'contacted'
        assert.strictEqual(out.suggestedTask.title, 'Demo plannen');
        assert.strictEqual(out.suggestedTask.dueInDays, 3);
    });
});

test('logFromNotes drops a suggestedStatus equal to the current stage', async () => {
    await withStubs({
        store: { getLead: async () => lead, getCampaign: async () => campaign },
        crm: { logActivity: async (a) => ({ id: 'a1', ...a }) },
        runner: { resolveModelAndAdapter: async () => mc, chatOnce: async () => ({ content: '{"type":"note","body":"x","suggestedStatus":"contacted","suggestedTask":null}' }) },
    }, async () => {
        const out = await assistant.logFromNotes({ leadId: 'l1', orgId: 'org1', userId: 'u1', text: 'x' });
        assert.strictEqual(out.suggestedStatus, null);
    });
});

test('scoreHotness persists scores and returns only valid lead ids', async () => {
    const leads = [{ id: 'l1', companyName: 'Acme', status: 'new', updatedAt: lead.updatedAt }, { id: 'l2', companyName: 'Beta', status: 'contacted', updatedAt: lead.updatedAt }];
    const stamped = [];
    await withStubs({
        store: { listAllLeads: async () => leads, setHotness: async (id, h) => { stamped.push({ id, ...h }); } },
        crm: {},
        runner: {
            resolveModelAndAdapter: async () => mc,
            chatOnce: async () => ({ content: '[{"id":"l1","score":80,"reason":"compleet contact"},{"id":"l2","score":40,"reason":"net gestart"},{"id":"ghost","score":99,"reason":"x"}]' }),
        },
    }, async () => {
        const out = await assistant.scoreHotness({ orgIds: ['org1'], userId: 'u1' });
        assert.strictEqual(out.length, 2); // ghost id dropped
        assert.strictEqual(out[0].score, 80);
        assert.strictEqual(stamped.length, 2);
        assert.strictEqual(stamped[0].id, 'l1');
    });
});

test('pipelineDigest returns a structured digest', async () => {
    await withStubs({
        store: { listAllLeads: async () => [{ id: 'l1', companyName: 'Acme', status: 'contacted', updatedAt: lead.updatedAt }] },
        crm: { listTasks: async () => [] },
        runner: {
            resolveModelAndAdapter: async () => mc,
            chatOnce: async () => ({ content: '{"summary":"3 deals open","stalled":[{"company":"Acme","reason":"10 dagen stil"}],"today":["Bel Acme"],"hottest":[{"company":"Acme","reason":"hoge fit"}]}' }),
        },
    }, async () => {
        const d = await assistant.pipelineDigest({ orgIds: ['org1'], userId: 'u1' });
        assert.match(d.summary, /3 deals/);
        assert.strictEqual(d.stalled[0].company, 'Acme');
        assert.deepStrictEqual(d.today, ['Bel Acme']);
    });
});

test('pipelineDigest short-circuits with no open leads', async () => {
    await withStubs({
        store: { listAllLeads: async () => [{ id: 'l1', status: 'converted' }] },
        crm: { listTasks: async () => [] },
        runner: { resolveModelAndAdapter: async () => { throw new Error('should not be called'); }, chatOnce: async () => ({}) },
    }, async () => {
        const d = await assistant.pipelineDigest({ orgIds: ['org1'] });
        assert.match(d.summary, /[Gg]een open leads/);
    });
});
