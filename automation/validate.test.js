/**
 * Unit tests for the structured automation validator.
 *
 * Run: node automation/validate.test.js
 *
 * No DB needed — validator is a pure function over a definition object.
 */

const assert = require('assert');
const { validateDefinition } = require('./validate');

function trigger() {
    return { id: 'trg', kind: 'manual' };
}

// ── Smoke: empty graph (just a trigger) is valid ────────────────────────
{
    const def = { trigger: trigger(), steps: [], edges: [] };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'empty graph should validate');
    assert.deepStrictEqual(r.errors, [], 'no errors expected');
}

// ── Records carry the structured shape (code/severity/path/message/hint) ─
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'condition' }], edges: [{ from: 'trg', to: 's1' }] };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'condition without expr is an error');
    const rec = r.errors.find(e => e.code === 'condition.expr_missing');
    assert.ok(rec, 'expected condition.expr_missing record');
    assert.strictEqual(rec.severity, 'error');
    assert.ok(rec.path.includes('s1'), 'path includes step id');
    assert.ok(typeof rec.message === 'string' && rec.message.length > 0, 'has message');
    assert.ok(typeof rec.hint === 'string' && rec.hint.length > 0, 'has hint');
}

// ── Condition with no edges → ERROR (was a warning before) ───────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'c1', type: 'condition', expr: 'true' }],
        edges: [{ from: 'trg', to: 'c1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'dead-branch condition must block');
    const rec = r.errors.find(e => e.code === 'condition.dead_branch');
    assert.ok(rec, 'expected condition.dead_branch error record');
}

// ── Condition with only one branch wired → WARNING (still ok) ────────────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'c1', type: 'condition', expr: 'true' },
            { id: 'n1', type: 'notification', title: 'hi' },
        ],
        edges: [
            { from: 'trg', to: 'c1' },
            { from: 'c1', to: 'n1', label: 'then' },
        ],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'partial branch is just a warning');
    const w = r.warnings.find(x => x.code === 'condition.partial_branch');
    assert.ok(w, 'expected partial_branch warning record');
}

// ── Cycle detection still works ──────────────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'a', type: 'notification', title: 'a' },
            { id: 'b', type: 'notification', title: 'b' },
        ],
        edges: [
            { from: 'trg', to: 'a' },
            { from: 'a', to: 'b' },
            { from: 'b', to: 'a' },
        ],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.find(e => e.code === 'graph.cycle'), 'expected graph.cycle');
}

// ── Unknown step type produces a stable code ─────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'wat' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.find(e => e.code === 'step.unknown_type'));
}

// ── Forward ref to a real step still warns (not error) ──────────────────
// "future" step EXISTS in the def but appears after `n1` in topo order.
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'n1', type: 'notification', title: 'using {{steps.future.output.x}}' },
            { id: 'future', type: 'notification', title: 'placeholder' },
        ],
        edges: [{ from: 'trg', to: 'n1' }, { from: 'n1', to: 'future' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'forward refs to real steps only warn');
    assert.ok(r.warnings.find(w => w.code === 'ref.forward'), 'expected ref.forward warning');
}

// ── Ref to a step that DOESN'T exist → error with did-you-mean hint ─────
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'a_4a3d50', type: 'notification', title: 'real step' },
            { id: 'n1', type: 'notification', title: 'using {{steps.step_1.output.x}}' },
        ],
        edges: [{ from: 'trg', to: 'a_4a3d50' }, { from: 'a_4a3d50', to: 'n1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'unknown-step ref must error');
    const rec = r.errors.find(e => e.code === 'ref.unknown_step');
    assert.ok(rec, 'expected ref.unknown_step record');
    assert.ok(/a_4a3d50/.test(rec.hint), `hint must surface the real id, got: ${rec.hint}`);
}

// ── position: optional but must be {x, y} numbers when present ──────────
{
    const def = {
        trigger: { id: 'trg', kind: 'manual', position: { x: 12, y: 34 } },
        steps: [{ id: 's1', type: 'notification', title: 'hi', position: { x: 100, y: 200 } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'valid positions should pass');
}
{
    const def = {
        trigger: { id: 'trg', kind: 'manual', position: { x: 'NaN', y: 0 } },
        steps: [], edges: [],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'non-numeric x must error');
    assert.ok(r.errors.some(e => e.code === 'position.coord'), 'expected position.coord error');
}
{
    const def = {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [{ id: 's1', type: 'notification', title: 'hi', position: 'left' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'non-object position must error');
    assert.ok(r.errors.some(e => e.code === 'position.shape'), 'expected position.shape error');
}

// ── n8n-style utility nodes ─────────────────────────────────────────────
//
// One pass + one fail case per new step type. We don't exhaustively cover
// every per-op variant of datetime — the validator's per-op checks are
// straightforward and additional coverage would just rehash the validator's
// own enum lists.

// set: passes when fields is omitted; fails when fields is non-object.
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'set', fields: { name: { kind: 'literal', value: 'Alice' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'set with valid fields should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'set', fields: 'not-an-object' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'set with non-object fields must error');
    assert.ok(r.errors.some(e => e.code === 'set.fields_shape'), 'expected set.fields_shape error');
}

// datetime
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'datetime', op: 'now' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'datetime op:now should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'datetime', op: 'addDays', input: 'trigger.output.t' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'addDays without amount must error');
    assert.ok(r.errors.some(e => e.code === 'datetime.amount_missing'));
}

// wait
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'wait', seconds: 5 }], edges: [{ from: 'trg', to: 's1' }] };
    assert.strictEqual(validateDefinition(def).ok, true, 'wait 5s should pass');
}
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'wait', seconds: 0 }], edges: [{ from: 'trg', to: 's1' }] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'wait.seconds_range'), 'wait < 1 must error');
}

// stop_error
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'stop_error', message: 'boom' }], edges: [{ from: 'trg', to: 's1' }] };
    assert.strictEqual(validateDefinition(def).ok, true, 'stop_error with message should pass');
}
{
    const def = { trigger: trigger(), steps: [{ id: 's1', type: 'stop_error' }], edges: [{ from: 'trg', to: 's1' }] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'stop_error.message_missing'));
}

// switch — needs at least one case AND at least one wired case edge.
{
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'sw', type: 'switch', expr: 'trigger.output.priority', cases: [{ name: 'urgent', value: 'high' }] },
            { id: 'n1', type: 'notification', title: 'urgent path' },
        ],
        edges: [
            { from: 'trg', to: 'sw' },
            { from: 'sw', to: 'n1', label: 'case:urgent', caseName: 'urgent' },
        ],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'switch with one wired case should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'sw', type: 'switch', expr: 'trigger.output.x', cases: [] }],
        edges: [{ from: 'trg', to: 'sw' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'switch.cases_missing'), 'empty cases must error');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'sw', type: 'switch', expr: 'x', cases: [{ name: 'a', value: 1 }] }],
        edges: [{ from: 'trg', to: 'sw' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'switch.no_branches'), 'unwired switch must error');
}

// filter / limit / aggregate / summarize — arrayRef required
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'filter', arrayRef: 'trigger.output.items', expr: 'item.flag' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'filter with arrayRef + expr should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'filter', expr: 'item.flag' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'filter.arrayRef_missing'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'limit', arrayRef: 'trigger.output.items', count: 5 }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'limit with arrayRef + count should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'aggregate', arrayRef: 'trigger.output.items' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'aggregate.field_missing'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'summarize', arrayRef: 'trigger.output.items', field: 'amount', op: 'sum' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'summarize with all fields should pass');
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'summarize', arrayRef: 'trigger.output.items', field: 'amount', op: 'median' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'summarize.op_invalid'));
}
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'dedupe', arrayRef: 'trigger.output.items', keyField: 'id' }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'dedupe with keyField should pass');
}

// ── WS-9C: tool_unknown only fires when availableTools is supplied ──────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_delete_share', inputs: { shareId: { kind: 'literal', value: 1 } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'no availableTools → tool not checked');
    const r = validateDefinition(def, { availableTools: new Set(['gmail_send']) });
    assert.strictEqual(r.ok, false, 'unknown tool blocks when catalog provided');
    assert.ok(r.errors.some(e => e.code === 'integration_action.tool_unknown'), 'tool_unknown raised');
    assert.strictEqual(validateDefinition(def, { availableTools: new Set(['nextcloud_delete_share']) }).ok, true, 'known tool passes');
}

// ── WS-9B: required-param check (absent + empty-string literal) ─────────
{
    const reqMap = { nextcloud_talk_send_message: ['token', 'message'] };
    const emptyTok = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: { token: { kind: 'literal', value: '' }, message: { kind: 'literal', value: 'hi' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r1 = validateDefinition(emptyTok, { availableTools: new Set(['nextcloud_talk_send_message']), toolRequiredParams: reqMap });
    assert.strictEqual(r1.ok, false, 'empty-literal required param blocks');
    assert.ok(r1.errors.some(e => e.code === 'integration_action.param_missing' && e.path.endsWith('.token')), 'param_missing on token');
    const noMsg = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: { token: { kind: 'literal', value: 'abc' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r2 = validateDefinition(noMsg, { availableTools: new Set(['nextcloud_talk_send_message']), toolRequiredParams: reqMap });
    assert.ok(r2.errors.some(e => e.code === 'integration_action.param_missing' && e.path.endsWith('.message')), 'param_missing on absent message');
    const okDef = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_talk_send_message', inputs: { token: { kind: 'ref', path: 'trigger.output.roomToken' }, message: { kind: 'literal', value: 'hi' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.strictEqual(validateDefinition(okDef, { availableTools: new Set(['nextcloud_talk_send_message']), toolRequiredParams: reqMap }).ok, true, 'all required params present → passes');
    assert.strictEqual(validateDefinition(emptyTok, { availableTools: new Set(['nextcloud_talk_send_message']) }).ok, true, 'no schema map → param not checked');
}

// ── WS-9D: literal containing {{…}} → uninterpolated warning (non-blocking) ──
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_create_folder', inputs: { path: { kind: 'literal', value: '/Welcome/{{trigger.output.actor}}' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'uninterpolated literal is a warning, not an error');
    assert.ok(r.warnings.some(w => w.code === 'literal.uninterpolated'), 'literal.uninterpolated warning raised');
    const def2 = {
        trigger: trigger(),
        steps: [{ id: 's1', type: 'integration_action', tool: 'nextcloud_create_folder', inputs: { path: { kind: 'template', value: '/Welcome/{{trigger.output.actor}}' } } }],
        edges: [{ from: 'trg', to: 's1' }],
    };
    assert.ok(!validateDefinition(def2).warnings.some(w => w.code === 'literal.uninterpolated'), 'template kind → no uninterpolated warning');
}

// ── WS-9A: app_event deliverability warning (non-blocking) ─────────────
{
    const deliverable = { nextcloud: new Set(['file.new', 'calendar.event.upcoming']) };
    const mk = (ev) => ({ trigger: { id: 'trg', kind: 'app_event', appEvent: { provider: 'nextcloud', event: ev } }, steps: [], edges: [] });
    let r = validateDefinition(mk('file.new'), { deliverableEvents: deliverable });
    assert.ok(!r.warnings.some(w => w.code === 'trigger.app_event_undeliverable'), 'deliverable event → no warning');
    r = validateDefinition(mk('talk.mention.received'), { deliverableEvents: deliverable });
    assert.strictEqual(r.ok, true, 'undeliverable event is a warning, not an error');
    assert.ok(r.warnings.some(w => w.code === 'trigger.app_event_undeliverable'), 'undeliverable event → warning');
    assert.ok(!validateDefinition(mk('talk.mention.received')).warnings.some(w => w.code === 'trigger.app_event_undeliverable'), 'no deliverableEvents option → not checked');
}

// ── FIX 1: branch-labelled condition/switch edges satisfy the wiring checks ──
{
    // Condition with both then + else labelled edges (what branch-aware
    // appends now produce) — no dead_branch / partial_branch.
    const def = {
        trigger: trigger(),
        steps: [
            { id: 'c1', type: 'condition', expr: 'trigger.output.x == 1' },
            { id: 'a1', type: 'notification', title: 'yes' },
            { id: 'a2', type: 'notification', title: 'no' },
        ],
        edges: [
            { from: 'trg', to: 'c1' },
            { from: 'c1', to: 'a1', label: 'then' },
            { from: 'c1', to: 'a2', label: 'else' },
        ],
    };
    const r = validateDefinition(def);
    assert.ok(!r.errors.some(e => e.code === 'condition.dead_branch'), 'labelled then/else → no dead_branch');
    assert.ok(!r.warnings.some(e => e.code === 'condition.partial_branch'), 'labelled then/else → no partial_branch');

    // Switch with a case:<name> labelled edge → no no_branches error.
    const sw = {
        trigger: trigger(),
        steps: [
            { id: 's1', type: 'switch', expr: 'trigger.output.p', cases: [{ name: 'urgent', value: 'high' }] },
            { id: 'n1', type: 'notification', title: 'urgent!' },
        ],
        edges: [
            { from: 'trg', to: 's1' },
            { from: 's1', to: 'n1', label: 'case:urgent', caseName: 'urgent' },
        ],
    };
    assert.ok(!validateDefinition(sw).errors.some(e => e.code === 'switch.no_branches'), 'labelled case edge → no switch.no_branches');
}

// ═══ WS3: inline layers ══════════════════════════════════════════════════

function layerGraph(overrides = {}) {
    return {
        title: 'Enrich contact',
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [{ name: 'email', type: 'string', required: true }] },
        steps: [{ id: 'out', type: 'layer_output', fields: { score: { kind: 'literal', value: 1 } } }],
        edges: [{ from: 'trg', to: 'out' }],
        ...overrides,
    };
}

// ── Happy path: a layer + a call_layer referencing it validates clean ────
{
    const def = {
        schemaVersion: 2,
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich_contact', inputs: { email: { kind: 'ref', path: 'trigger.output.email' } } }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { enrich_contact: layerGraph() },
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, `valid inline layer should pass, got ${JSON.stringify(r.errors)}`);
    assert.ok(!r.warnings.some(w => w.code === 'layers.orphaned'), 'referenced layer is not orphaned');
}

// ── layers map shape + key format ────────────────────────────────────────
{
    const def = { trigger: trigger(), steps: [], edges: [], layers: ['nope'] };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.shape'), 'non-object layers → layers.shape');
}
{
    const def = { trigger: trigger(), steps: [], edges: [], layers: { 'Bad-Key': layerGraph() } };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.key_invalid'), 'invalid key → layers.key_invalid');
}
{
    const def = { trigger: trigger(), steps: [], edges: [], layers: { good_key: 'not-an-object' } };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.value_shape'), 'non-object layer value → layers.value_shape');
}

// ── unknown layerKey → error with did-you-mean hint ──────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich_contct', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { enrich_contact: layerGraph({ trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] } }) },
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    const rec = r.errors.find(e => e.code === 'call_layer.unknown_layer');
    assert.ok(rec, 'expected call_layer.unknown_layer');
    assert.ok(/enrich_contact/.test(rec.hint), `hint must suggest the real key, got: ${rec.hint}`);
}

// ── legacy layerId (pre-migration shape) → dedicated error ───────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerId: 'some-uuid', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.code === 'call_layer.legacy_layerId'), 'expected call_layer.legacy_layerId');
}

// ── required layer param must be bound ───────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich_contact', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { enrich_contact: layerGraph() },
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, false, 'missing required param must block');
    const rec = r.errors.find(e => e.code === 'call_layer.param_missing');
    assert.ok(rec && rec.path.endsWith('.email'), 'param_missing on email');
    // Empty-string literal counts as missing too.
    const def2 = { ...def, steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'enrich_contact', inputs: { email: { kind: 'literal', value: '' } } }] };
    assert.ok(validateDefinition(def2).errors.some(e => e.code === 'call_layer.param_missing'), 'empty literal → param_missing');
}

// ── approval inside a layer → error ──────────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: {
            l: layerGraph({
                trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
                steps: [
                    { id: 'ap', type: 'approval', prompt: 'ok?' },
                    { id: 'out', type: 'layer_output', fields: {} },
                ],
                edges: [{ from: 'trg', to: 'ap' }, { from: 'ap', to: 'out' }],
            }),
        },
    };
    const r = validateDefinition(def);
    const rec = r.errors.find(e => e.code === 'layer.approval_forbidden');
    assert.ok(rec, 'expected layer.approval_forbidden');
    assert.ok(rec.path.startsWith('layers.l.'), `layer-scoped path, got ${rec.path}`);
}

// ── layer trigger must be layer_input ────────────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { l: layerGraph({ trigger: { id: 'trg', type: 'trigger', kind: 'manual' } }) },
    };
    assert.ok(validateDefinition(def).errors.some(e => e.code === 'layer.trigger_kind'), 'non-layer_input trigger → layer.trigger_kind');
}

// ── layer_output count: >1 error, 0 warning; root layer_output stays legal ─
{
    const two = layerGraph({
        steps: [
            { id: 'out', type: 'layer_output', fields: {} },
            { id: 'out2', type: 'layer_output', fields: {} },
        ],
        edges: [{ from: 'trg', to: 'out' }, { from: 'out', to: 'out2' }],
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
    });
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { l: two },
    };
    assert.ok(validateDefinition(def).errors.some(e => e.code === 'layer.multiple_outputs'), 'two layer_outputs → error');

    const zero = layerGraph({
        steps: [{ id: 's1', type: 'set', fields: {} }],
        edges: [{ from: 'trg', to: 's1' }],
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
    });
    const def0 = { ...def, layers: { l: zero } };
    const r0 = validateDefinition(def0);
    assert.strictEqual(r0.ok, true, 'zero layer_outputs is only a warning');
    assert.ok(r0.warnings.some(w => w.code === 'layer.no_output'), 'zero layer_outputs → warning');

    // layer_output at the ROOT (converted orphan layers) stays legal.
    const rootOut = {
        trigger: trigger(),
        steps: [{ id: 'out', type: 'layer_output', fields: { a: { kind: 'literal', value: 1 } } }],
        edges: [{ from: 'trg', to: 'out' }],
    };
    assert.strictEqual(validateDefinition(rootOut).ok, true, 'root layer_output stays legal');
}

// ── nested layers key inside a layer → error ─────────────────────────────
{
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { l: layerGraph({ layers: { inner: {} }, trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] } }) },
    };
    assert.ok(validateDefinition(def).errors.some(e => e.code === 'layers.nested'), 'nested layers map → layers.nested');
}

// ── cycle A → B → A → layers.cycle ───────────────────────────────────────
{
    const callTo = (key) => layerGraph({
        trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
        steps: [
            { id: 'cl', type: 'call_layer', layerKey: key, inputs: {} },
            { id: 'out', type: 'layer_output', fields: {} },
        ],
        edges: [{ from: 'trg', to: 'cl' }, { from: 'cl', to: 'out' }],
    });
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'a', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { a: callTo('b'), b: callTo('a') },
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.cycle'), 'A→B→A must raise layers.cycle');
}

// ── chain deeper than 8 layers → layers.depth_exceeded ───────────────────
{
    const layers = {};
    const N = 9; // root → l1 → … → l9 = depth 9 > MAX_LAYER_DEPTH (8)
    for (let i = 1; i <= N; i++) {
        const next = i < N ? `l${i + 1}` : null;
        layers[`l${i}`] = layerGraph({
            trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] },
            steps: [
                ...(next ? [{ id: 'cl', type: 'call_layer', layerKey: next, inputs: {} }] : []),
                { id: 'out', type: 'layer_output', fields: {} },
            ],
            edges: next
                ? [{ from: 'trg', to: 'cl' }, { from: 'cl', to: 'out' }]
                : [{ from: 'trg', to: 'out' }],
        });
    }
    const def = {
        trigger: trigger(),
        steps: [{ id: 'cl1', type: 'call_layer', layerKey: 'l1', inputs: {} }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers,
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'layers.depth_exceeded'), `9-deep chain must raise layers.depth_exceeded, got ${JSON.stringify(r.errors.map(e => e.code))}`);
}

// ── never-referenced layer → orphan warning (non-blocking) ───────────────
{
    const def = {
        trigger: trigger(),
        steps: [],
        edges: [],
        layers: { unused_layer: layerGraph({ trigger: { id: 'trg', type: 'trigger', kind: 'layer_input', params: [] } }) },
    };
    const r = validateDefinition(def);
    assert.strictEqual(r.ok, true, 'orphan layer is a warning, not an error');
    assert.ok(r.warnings.some(w => w.code === 'layers.orphaned'), 'expected layers.orphaned warning');
}

// ── call_layer inside a loop body is checked too (unknown key) ───────────
{
    const def = {
        trigger: trigger(),
        steps: [{
            id: 'loop1', type: 'loop', overRef: 'trigger.output.items', itemVar: 'item', maxIterations: 10,
            body: [{ id: 'cl1', type: 'call_layer', layerKey: 'missing', inputs: {} }],
        }],
        edges: [{ from: 'trg', to: 'loop1' }],
        layers: {},
    };
    const r = validateDefinition(def);
    assert.ok(r.errors.some(e => e.code === 'call_layer.unknown_layer' && /body/.test(e.path)), 'loop-body call_layer is validated');
}

// ── leftover denormalized contract fields are tolerated (ignored) ────────
{
    const def = {
        trigger: trigger(),
        steps: [{
            id: 'cl1', type: 'call_layer', layerKey: 'enrich_contact',
            inputs: { email: { kind: 'literal', value: 'a@b.c' } },
            migratedFromLayerId: 'old-uuid',
            inputContract: [{ name: 'email' }], outputContract: [{ name: 'score' }],
        }],
        edges: [{ from: 'trg', to: 'cl1' }],
        layers: { enrich_contact: layerGraph() },
    };
    assert.strictEqual(validateDefinition(def).ok, true, 'leftover contract fields are ignored');
}

console.log('validate.test.js — all checks passed');
