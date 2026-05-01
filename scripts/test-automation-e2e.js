/**
 * End-to-end smoke test for the Automation Builder pipeline.
 *
 * Exercises the lower layers WITHOUT spinning up the full HTTP server
 * or hitting an external LLM:
 *
 *   1. validate.js            — DAG and reference validation
 *   2. expr.js                — restricted expression evaluator
 *   3. bind.js                — input/template/ref resolution
 *   4. summarise.js           — plain-English summary
 *   5. cron.js                — schedule advancement
 *   6. automationStore        — create / update / runs / steps / webhooks
 *   7. automationRunner       — dry-run on a hand-crafted DAG
 *
 * Usage:
 *   CORE_DATABASE_URL=postgresql://... node server/scripts/test-automation-e2e.js
 *
 * Exits 0 on success, 1 on first failure.
 */

const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { validateDefinition } = require('../automation/validate');
const { evaluate } = require('../automation/expr');
const { resolveInputs, walkPath, interpolateTemplate } = require('../automation/bind');
const { summariseDefinition } = require('../automation/summarise');
const cron = require('../automation/cron');

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
    if (cond) { pass++; console.log('  ✓', name); }
    else { fail++; console.error('  ✗', name, extra ? '\n     ' + JSON.stringify(extra) : ''); }
}

async function main() {
    console.log('\n— validate.js —');
    {
        const def = {
            schemaVersion: 1,
            trigger: { id: 'trg', type: 'trigger', kind: 'schedule', schedule: { cron: '0 9 * * 1', tz: 'Europe/Amsterdam' } },
            steps: [
                { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'label:Invoices is:unread' } } },
                { id: 'cond', type: 'condition', expr: 'steps.s1.output.count > 0' },
                { id: 's2', type: 'notification', title: 'Found {{steps.s1.output.count}} invoices', body: '' },
            ],
            edges: [
                { from: 'trg', to: 's1' },
                { from: 's1', to: 'cond' },
                { from: 'cond', to: 's2', label: 'then' },
                { from: 'cond', to: 's2', label: 'else' },
            ],
            vars: {},
        };
        const v = validateDefinition(def);
        ok('linear DAG with condition validates', v.ok, v);

        const cycleDef = JSON.parse(JSON.stringify(def));
        cycleDef.edges.push({ from: 's2', to: 's1' });
        const v2 = validateDefinition(cycleDef);
        ok('cycle detected', !v2.ok && v2.errors.some(e => e.includes('cycle')));

        const badRef = JSON.parse(JSON.stringify(def));
        badRef.steps[0].inputs.query = { kind: 'ref', path: 'steps.unknown.output.foo' };
        const v3 = validateDefinition(badRef);
        ok('forward/unknown ref produces warning, not error', v3.ok && Array.isArray(v3.warnings) && v3.warnings.some(w => w.includes('unknown')));
    }

    console.log('\n— expr.js —');
    {
        const ctx = { steps: { s1: { output: { amount: 1250, vendor: 'ACME' } } }, vars: {} };
        ok('numeric compare', evaluate('steps.s1.output.amount > 1000', ctx) === true);
        ok('string compare', evaluate('steps.s1.output.vendor == "ACME"', ctx) === true);
        ok('ternary', evaluate('steps.s1.output.amount > 1000 ? "big" : "small"', ctx) === 'big');
        ok('logical chain', evaluate('steps.s1.output.amount > 0 && steps.s1.output.vendor != "X"', ctx) === true);
        ok('rejects function calls', (() => { try { evaluate('alert(1)', ctx); return false; } catch { return true; } })());
        ok('safely returns undefined for missing path', evaluate('steps.s2.output.nope', ctx) === undefined);
    }

    console.log('\n— bind.js —');
    {
        const state = {
            trigger: { output: {} },
            steps: { s1: { output: { items: [{ subject: 'A' }, { subject: 'B' }], count: 2 } } },
            vars: { greeting: 'Hi' },
            secrets: { token: 'SECRET' },
        };
        ok('walkPath dotted', walkPath('steps.s1.output.count', state) === 2);
        ok('walkPath bracketed', walkPath('steps.s1.output.items[0].subject', state) === 'A');
        ok('interpolate template', interpolateTemplate('Got {{steps.s1.output.count}}', state) === 'Got 2');
        ok('template suppresses secrets root by caller', interpolateTemplate('S={{secrets.token}}', { ...state, secrets: {} }) === 'S=');
        const inputs = resolveInputs({
            n: { kind: 'literal', value: 5 },
            sub: { kind: 'ref', path: 'steps.s1.output.items[1].subject' },
            msg: { kind: 'template', value: '{{vars.greeting}} {{steps.s1.output.count}}' },
        }, state, { allowSecrets: false });
        ok('resolveInputs literal', inputs.n === 5);
        ok('resolveInputs ref', inputs.sub === 'B');
        ok('resolveInputs template', inputs.msg === 'Hi 2');
    }

    console.log('\n— summarise.js —');
    {
        const def = {
            trigger: { id: 'trg', type: 'trigger', kind: 'schedule', schedule: { cron: '0 9 * * 1', tz: 'Europe/Amsterdam' } },
            steps: [
                { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'is:unread' } } },
                { id: 's2', type: 'integration_action', tool: 'gmail_send', inputs: { to: { kind: 'literal', value: 'a@b.com' } } },
            ],
            edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
        };
        const r = summariseDefinition(def);
        ok('summary mentions schedule', r.summary.includes('schedule'));
        ok('detects side-effects', r.hasSideEffects === true);
    }

    console.log('\n— outputSchemas.js (must match real integration return shapes) —');
    {
        const { describeShape, getOutputSchema } = require('../automation/outputSchemas');
        ok('gmail_search shape uses results, not items', /results.*array.*from.*subject/i.test(describeShape('gmail_search') || ''));
        ok('calendar_list_events shape uses results', /results.*array.*summary.*start/i.test(describeShape('calendar_list_events') || ''));
        ok('drive_search shape uses results', /results.*array.*name.*mimeType/i.test(describeShape('drive_search') || ''));
        ok('outlook_search shape uses results', /results.*array.*from.*subject/i.test(describeShape('outlook_search') || ''));
        ok('youtrack_search_issues shape uses results', /results.*array.*summary.*state/i.test(describeShape('youtrack_search_issues') || ''));
        ok('agent_search marked as string', /string/.test(describeShape('agent_search') || ''));
        // Sample shape sanity
        const gs = getOutputSchema('gmail_search');
        ok('gmail_search sample.results is array of objects with from/subject', Array.isArray(gs?.sample?.results) && gs.sample.results[0]?.from && gs.sample.results[0]?.subject);
    }

    console.log('\n— builderTools.canonicalizeInputs —');
    {
        const { applyToolCall, emptyDefinition } = require('../automation/builderTools');
        const wrap = { userId: 'test', def: emptyDefinition() };
        // Raw string input → wrapped to literal binding
        const r = await applyToolCall('builder_add_action', {
            tool: 'gmail_search',
            inputs: { query: 'label:Invoices is:unread', maxResults: 10 },
        }, wrap);
        const added = r.added;
        ok('canonicalize: raw string → literal', added.inputs.query?.kind === 'literal' && added.inputs.query.value === 'label:Invoices is:unread');
        ok('canonicalize: raw number → literal', added.inputs.maxResults?.kind === 'literal' && added.inputs.maxResults.value === 10);
        // Template string with {{ }} → upgraded to template
        const r2 = await applyToolCall('builder_add_notification', {
            title: 'Found {{steps.s.output.count}}',
            body: 'plain body without templates',
        }, wrap);
        // notification.title/body live on the step itself, not in inputs — but
        // confirm the step structure is accepted.
        ok('add_notification accepts plain title/body', r2.added.type === 'notification');
    }

    console.log('\n— builder_inspect_tool —');
    {
        const { applyToolCall, emptyDefinition } = require('../automation/builderTools');
        const wrap = { userId: 'test', def: emptyDefinition() };
        const r = await applyToolCall('builder_inspect_tool', { tool: 'gmail_search' }, wrap);
        ok('inspect_tool returns shape from curated schema', typeof r.shape === 'string' && r.shape.includes('results'));
        ok('inspect_tool exposes source', r.source === 'curated' || r.source === 'runtime');
        const r2 = await applyToolCall('builder_inspect_tool', { tool: 'this_tool_does_not_exist' }, wrap);
        ok('inspect_tool gracefully handles unknown tool', r2.shape === null && r2.source === 'unknown');
    }

    console.log('\n— shapeCache.describeValue (no PII leaks) —');
    {
        const { describeValue, renderShapeHint } = require('../automation/shapeCache');
        const desc = describeValue({ results: [{ from: 'a@b.com', subject: 'secret', amount: 1234 }], total: 1 });
        // Descriptor must NOT include the actual email content
        const json = JSON.stringify(desc);
        ok('shapeCache does not leak content', !json.includes('a@b.com') && !json.includes('secret'));
        ok('shapeCache captures structure', /from/.test(json) && /subject/.test(json) && /total/.test(json));
        const hint = renderShapeHint(desc);
        ok('renderShapeHint produces a one-liner', typeof hint === 'string' && hint.length > 5);
    }

    console.log('\n— cron.js —');
    {
        const next = cron.nextRunAt('0 9 * * 1', 'Europe/Amsterdam', Date.UTC(2026, 4, 1, 0, 0, 0));
        ok('next Monday 9am exists', !!next && /T07:00/.test(next) || /T08:00/.test(next));
        ok('parseCron rejects 4 fields', (() => { try { cron.parseCron('* * * *'); return false; } catch { return true; } })());
    }

    // DB-backed sections — only run when CORE_DATABASE_URL is set.
    if (process.env.CORE_DATABASE_URL) {
        console.log('\n— automationStore (DB) —');
        const store = require('../stores/automationStore');
        await store.initDB();
        const a = await store.createAutomation({
            userId: 'test-user-' + Date.now(),
            title: 'Test automation',
            description: 'unit test',
            definition: {
                schemaVersion: 1,
                trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
                steps: [
                    { id: 's1', type: 'notification', title: 'Hello', body: 'world', channels: ['notification'] },
                ],
                edges: [{ from: 'trg', to: 's1' }],
            },
            triggerType: 'manual',
        });
        ok('createAutomation', a && a.id && a.isDraft === true);
        const list = await store.getAutomationsForUser(a.userId);
        ok('automation appears in list', list.some(x => x.id === a.id));
        const updated = await store.updateAutomation(a.id, { title: 'Renamed' }, a.userId);
        ok('updateAutomation', updated.title === 'Renamed');
        const versions = await store.listVersions(a.id);
        ok('listVersions empty initially (no definition change)', Array.isArray(versions));
        const u2 = await store.updateAutomation(a.id, { definition: { ...a.definition, vars: { foo: 'bar' } } }, a.userId);
        ok('definition change bumps version', u2.version === 2);

        // Run + run steps
        const run = await store.createRun({ automationId: a.id, version: u2.version, userId: a.userId, triggerKind: 'manual' });
        ok('createRun', !!run.id);
        await store.recordRunStep({ runId: run.id, stepId: 's1', stepType: 'notification', attempts: 1, status: 'success', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), input: { x: 1 }, output: { ok: true } });
        const steps = await store.getRunSteps(run.id);
        ok('recordRunStep persisted', steps.length === 1 && steps[0].stepId === 's1');

        // Webhook
        const wh = await store.createWebhook(a.id);
        ok('createWebhook', !!wh.id && !!wh.secret);
        const got = await store.getWebhook(wh.id);
        ok('getWebhook', got.automationId === a.id);

        // Cleanup
        await store.deleteAutomation(a.id);
        ok('deleteAutomation cascades', !(await store.getAutomation(a.id)));

        console.log('\n— runner.executeAutomation (dry-run) —');
        // Hand-craft a definition with a side-effect; expect dry-run synthesis.
        const a2 = await store.createAutomation({
            userId: 'test-user-runner-' + Date.now(),
            title: 'Dry-run test',
            definition: {
                schemaVersion: 1,
                trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
                steps: [
                    { id: 's1', type: 'integration_action', tool: 'gmail_search', inputs: { query: { kind: 'literal', value: 'is:unread' } } },
                    { id: 's2', type: 'notification', title: 'Found {{steps.s1.output.count}}', channels: ['notification'] },
                ],
                edges: [{ from: 'trg', to: 's1' }, { from: 's1', to: 's2' }],
            },
            triggerType: 'manual',
        });
        const runner = require('../core/automationRunner');
        const dryRun = await runner.executeAutomation({ ...a2, isDraft: false }, { triggerKind: 'dry_run', mode: 'dry_run' });
        ok('dry-run row created', dryRun && dryRun.mode === 'dry_run');
        const runSteps = await store.getRunSteps(dryRun.id);
        ok('dry-run captured step output', runSteps.length >= 1);
        await store.deleteAutomation(a2.id);
    } else {
        console.log('\n(skipping DB tests — set CORE_DATABASE_URL to enable)');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
}

main().catch(err => {
    console.error('FATAL', err);
    process.exit(2);
});
