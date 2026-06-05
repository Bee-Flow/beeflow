/**
 * Unit tests for branch-aware edge wiring in the automation builder tools.
 *
 * Run: node automation/builderTools.test.js
 *
 * No DB needed — the add-* tools only mutate the in-memory draft definition
 * (only builder_request_dry_run / builder_finalize touch the store).
 */

const assert = require('assert');
const { applyToolCall, emptyDefinition } = require('./builderTools');
const { validateDefinition } = require('./validate');

function freshWrap() {
    return { userId: 'u_test', def: emptyDefinition() };
}
function edge(def, fromId) {
    return def.edges.filter(e => e.from === fromId);
}

(async () => {
    // ── Appending after a condition auto-labels then (first) / else (second) ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        const condId = cond.added.id;
        // Incoming edge from the (manual) trigger must stay UNLABELLED — the
        // trigger is not a branching step.
        const incoming = dw.def.edges.find(e => e.to === condId);
        assert.ok(incoming && incoming.label === undefined, 'incoming edge to condition must be unlabelled');

        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: condId }, dw);
        const a2 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: condId }, dw);
        const outs = edge(dw.def, condId);
        const e1 = outs.find(e => e.to === a1.added.id);
        const e2 = outs.find(e => e.to === a2.added.id);
        assert.strictEqual(e1.label, 'then', 'first append after condition → then');
        assert.strictEqual(e2.label, 'else', 'second append after condition → else');

        // The branch/caseName args must NOT leak onto the created step.
        assert.ok(!('branch' in a1.added) && !('caseName' in a1.added), 'branch/caseName must not leak onto the step');

        // Definition now validates — no dead_branch / partial_branch.
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => e.code === 'condition.dead_branch'), 'no dead_branch after wiring both branches');
        assert.ok(!v.warnings.some(e => e.code === 'condition.partial_branch'), 'no partial_branch after wiring both branches');
    }

    // ── Explicit branch override wins over auto-infer ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        const condId = cond.added.id;
        const a1 = await applyToolCall('builder_add_notification', { title: 'hi', afterStepId: condId, branch: 'else' }, dw);
        const e1 = edge(dw.def, condId).find(e => e.to === a1.added.id);
        assert.strictEqual(e1.label, 'else', 'explicit branch:"else" overrides the auto then-first');
    }

    // ── A one-sided condition is a WARNING (partial_branch), not an error ──
    {
        const dw = freshWrap();
        const cond = await applyToolCall('builder_add_condition', { expr: 'trigger.output.x == 1' }, dw);
        await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: cond.added.id }, dw);
        const v = validateDefinition(dw.def);
        assert.ok(!v.errors.some(e => e.code === 'condition.dead_branch'), 'one wired branch is not a dead_branch error');
        assert.ok(v.warnings.some(e => e.code === 'condition.partial_branch'), 'one-sided condition warns partial_branch');
    }

    // ── Appending after a switch with caseName labels case:<name> ──
    {
        const dw = freshWrap();
        const sw = await applyToolCall('builder_add_switch', { expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] }, dw);
        const swId = sw.added.id;
        const withCase = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: swId, caseName: 'urgent' }, dw);
        const e1 = edge(dw.def, swId).find(e => e.to === withCase.added.id);
        assert.strictEqual(e1.label, 'case:urgent', 'switch append with caseName → case:<name>');
        assert.strictEqual(e1.caseName, 'urgent', 'switch edge carries caseName');

        // default routes to case:default
        const dwd = freshWrap();
        const sw2 = await applyToolCall('builder_add_switch', { expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] }, dwd);
        const def2 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: sw2.added.id, caseName: 'default' }, dwd);
        const ed = edge(dwd.def, sw2.added.id).find(e => e.to === def2.added.id);
        assert.strictEqual(ed.label, 'case:default', 'switch append with caseName:"default" → case:default');
    }

    // ── Appending after a switch WITHOUT caseName leaves the edge unlabelled ──
    {
        const dw = freshWrap();
        const sw = await applyToolCall('builder_add_switch', { expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] }, dw);
        const noCase = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: sw.added.id }, dw);
        const e1 = edge(dw.def, sw.added.id).find(e => e.to === noCase.added.id);
        assert.strictEqual(e1.label, undefined, 'switch append without caseName stays unlabelled (today behaviour)');
    }

    // ── Appending after a NORMAL step is unchanged (plain unlabelled edge) ──
    {
        const dw = freshWrap();
        const a1 = await applyToolCall('builder_add_action', { tool: 'gmail_search' }, dw);
        const a2 = await applyToolCall('builder_add_action', { tool: 'gmail_search', afterStepId: a1.added.id }, dw);
        const e1 = edge(dw.def, a1.added.id).find(e => e.to === a2.added.id);
        assert.strictEqual(e1.label, undefined, 'append after a normal step is an unlabelled edge');
    }

    console.log('builderTools.test.js: all branch-wiring tests passed');
    // builderTools requires automationStore, which opens a DB pool that keeps
    // the event loop alive — exit explicitly once assertions pass.
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
