/**
 * Unit tests for the binding resolver. Pure helpers — no DB / network. Run:
 *
 *   node automation/bind.test.js
 *
 * These tests pin the mutation-isolation contract that the rest of the
 * automation runner depends on: a step output that ends up in
 * `runState.steps[...]` must NOT share references with the original
 * binding source, and a downstream step mutating its inputs must not
 * silently corrupt a sibling step's binding.
 */

const assert = require('assert');
const {
    cloneLiteral,
    resolveValue,
    resolveDeep,
    resolveInputs,
    interpolateTemplate,
    walkPath,
} = require('./bind');

(() => {
    // ── cloneLiteral isolates object/array literals ────────────────────
    {
        const original = { a: 1, nested: { b: 2 } };
        const cloned = cloneLiteral(original);
        cloned.a = 99;
        cloned.nested.b = 99;
        assert.strictEqual(original.a, 1, 'object literal: top-level mutation does not leak');
        assert.strictEqual(original.nested.b, 2, 'object literal: nested mutation does not leak');
        assert.notStrictEqual(cloned, original, 'object literal: clone is a new reference');
    }

    {
        const original = [{ k: 'v' }];
        const cloned = cloneLiteral(original);
        cloned[0].k = 'mutated';
        assert.strictEqual(original[0].k, 'v', 'array literal: nested object mutation does not leak');
    }

    // ── cloneLiteral returns primitives as-is (hot path) ───────────────
    assert.strictEqual(cloneLiteral(42), 42, 'number primitive returned as-is');
    assert.strictEqual(cloneLiteral('s'), 's', 'string primitive returned as-is');
    assert.strictEqual(cloneLiteral(null), null, 'null returned as-is');
    assert.strictEqual(cloneLiteral(undefined), undefined, 'undefined returned as-is');

    // ── resolveValue: literal binding containing an object ──────────────
    {
        const binding = { kind: 'literal', value: { nested: { count: 5 } } };
        const resolved = resolveValue(binding, {});
        resolved.nested.count = 999;
        assert.strictEqual(
            binding.value.nested.count, 5,
            'literal binding: mutating resolved value does not corrupt the definition',
        );
    }

    // ── resolveInputs: each input is independently isolated ─────────────
    {
        const shared = { count: 1 };
        const inputs = {
            a: { kind: 'literal', value: shared },
            b: { kind: 'literal', value: shared },
        };
        const out = resolveInputs(inputs, {});
        out.a.count = 42;
        assert.strictEqual(out.b.count, 1, 'two inputs binding the same literal object are independent after resolve');
        assert.strictEqual(shared.count, 1, 'original shared object remains untouched');
    }

    // ── interpolateTemplate: undefined paths are recorded as warnings ───
    {
        const runState = {
            steps: { s1: { output: { found: 'yes' } } },
            _templateWarnings: [],
        };
        const out = interpolateTemplate('A={{steps.s1.output.found}} B={{steps.s1.output.missing}}', runState);
        assert.strictEqual(out, 'A=yes B=', 'undefined paths render as empty string (backward compatible)');
        assert.deepStrictEqual(
            runState._templateWarnings,
            ['steps.s1.output.missing'],
            'undefined paths push the unresolved path onto _templateWarnings',
        );
    }

    // ── interpolateTemplate: null is treated as explicit empty (no warn) ─
    {
        const runState = {
            steps: { s1: { output: { explicit: null } } },
            _templateWarnings: [],
        };
        const out = interpolateTemplate('v={{steps.s1.output.explicit}}', runState);
        assert.strictEqual(out, 'v=', 'null renders as empty string');
        assert.deepStrictEqual(runState._templateWarnings, [], 'null does not record a warning (only undefined does)');
    }

    // ── interpolateTemplate: works without _templateWarnings present ────
    {
        // Older callers that pass a minimal runState shouldn't blow up.
        const out = interpolateTemplate('x={{steps.s1.output.nope}}', { steps: {} });
        assert.strictEqual(out, 'x=', 'missing _templateWarnings array is tolerated');
    }

    // ── resolveDeep: nested object inputs with binding wrappers ─────────
    {
        const input = {
            top: 'literal-string',
            nested: { ref: { kind: 'ref', path: 'vars.x' } },
            arr: [{ kind: 'literal', value: { keep: true } }],
        };
        const state = { vars: { x: 7 }, steps: {} };
        const out = resolveDeep(input, state);
        assert.strictEqual(out.top, 'literal-string');
        assert.strictEqual(out.nested.ref, 7, 'ref binding inside nested object resolves');
        out.arr[0].keep = false;
        assert.strictEqual(
            input.arr[0].value.keep, true,
            'mutating resolved literal does not corrupt the original binding wrapper',
        );
    }

    // ── walkPath: plain dotted/bracketed paths still work ──────────────
    {
        const root = { steps: { s1: { output: { items: [{ id: 'a' }, { id: 'b' }] } } } };
        assert.strictEqual(walkPath('steps.s1.output.items[0].id', root), 'a', 'numeric index');
        assert.strictEqual(walkPath('steps.s1.output.items[1].id', root), 'b', 'numeric index 2');
        assert.strictEqual(walkPath('steps.s1.output.missing', root), undefined, 'missing path → undefined');
    }

    // ── walkPath: [*] maps over an array and flattens one level ─────────
    {
        // Mirrors gmail_search → gmail_read(forEach) shape: read's forEach
        // output is { results: [{ output: { attachments: [...] } }, ...] }.
        const root = {
            steps: { read: { output: { results: [
                { output: { attachments: [{ attachmentId: 'a1' }, { attachmentId: 'a2' }] } },
                { output: { attachments: [{ attachmentId: 'a3' }] } },
            ] } } },
        };
        const flat = walkPath('steps.read.output.results[*].output.attachments', root);
        assert.deepStrictEqual(
            flat,
            [{ attachmentId: 'a1' }, { attachmentId: 'a2' }, { attachmentId: 'a3' }],
            '[*] flattens nested attachment arrays across messages into one array',
        );

        // Scalar projection: results[*].output keeps one entry per element.
        const objs = walkPath('steps.read.output.results[*].output', root);
        assert.strictEqual(objs.length, 2, '[*] over objects yields one entry per element');

        // [*] on a non-array → undefined (no throw).
        assert.strictEqual(walkPath('steps.read.output[*]', root), undefined, '[*] on a non-array → undefined');
    }

    // ── interpolateTemplate: leaveUnresolved keeps misses verbatim ──────
    {
        const runState = {
            steps: { s1: { output: { found: 'hit', results: [{ c: 'A' }, { c: 'B' }] } } },
        };

        // Default (no opts): a missing path still blanks out, unchanged.
        assert.strictEqual(
            interpolateTemplate('x={{steps.s1.output.missing}}', runState),
            'x=',
            'default behaviour: unresolved path renders empty',
        );

        // leaveUnresolved: resolved paths still fill in, misses stay verbatim.
        const out = interpolateTemplate(
            'A={{steps.s1.output.found}} M={{steps.s1.output.missing}} L={{this.is.literal}}',
            runState,
            { leaveUnresolved: true },
        );
        assert.strictEqual(
            out,
            'A=hit M={{steps.s1.output.missing}} L={{this.is.literal}}',
            'leaveUnresolved: fills resolved tokens, leaves unresolved ones verbatim',
        );

        // [*] projection interpolates as a JSON array string.
        assert.strictEqual(
            interpolateTemplate('vals={{steps.s1.output.results[*].c}}', runState, { leaveUnresolved: true }),
            'vals=["A","B"]',
            'leaveUnresolved: [*] projection renders as JSON array',
        );
    }

    console.log('automation/bind.test.js — all checks passed');
})();
