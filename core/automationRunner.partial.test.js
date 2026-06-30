/**
 * Regression test for runPartial(..., { mode: 'only' }) — the "Execute step"
 * single-node run in the builder.
 *
 * Behaviour under test (runDag fillMissingUpstream, ~lines 1585-1622):
 *   When a partial run targets one step, an UPSTREAM prerequisite that has NO
 *   replay data (no prior run, no pinned output) is now EXECUTED LIVE instead
 *   of being skipped — so the target step receives the upstream's real output
 *   rather than `undefined`. Approval-resume (skipUntilStepId) keeps strict
 *   replay and is NOT exercised here.
 *
 * Uses pure in-process `set` steps (execSet just resolves bindings) so there's
 * no LLM / tool / sandbox / DB dependency — fully deterministic.
 *
 * Run: node --test core/automationRunner.partial.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

// ── In-memory automationStore stub ────────────────────────────────────────
// Records runs + steps into plain arrays. getRunSteps() returns the recorded
// rows in the camelCase shape the runner reads (rowToRunStep). For the key
// case getRunsForAutomation() returns [] so there's no prior run to replay.
const runs = new Map();        // runId -> run row
const runStepsByRun = new Map(); // runId -> [step row]
let runSeq = 0;

function makeRun({ automationId, version, userId, triggerKind, triggerPayload, mode, parentRunId }) {
    const id = `run-${++runSeq}`;
    const row = {
        id, automationId, version, userId, triggerKind,
        triggerPayload: triggerPayload || null, mode, status: 'queued',
        startedAt: new Date().toISOString(), finishedAt: null, durationMs: null,
        error: null, summary: null, parentRunId: parentRunId ?? null,
        cancelRequested: false, awaitingStepId: null, approvalToken: null,
        awaitingStepExpiresAt: null, errorClass: null, handledErrorCount: 0,
    };
    runs.set(id, row);
    runStepsByRun.set(id, []);
    return row;
}

const storeStub = {
    initDB: async () => {},
    // ── run lifecycle ──
    createRun: async (args) => makeRun(args),
    getRun: async (id) => runs.get(id) || null,
    updateRun: async (id, updates) => {
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    // No prior run → forces fillMissingUpstream to execute the upstream live.
    getRunsForAutomation: async () => [],
    getRunSteps: async (runId) => (runStepsByRun.get(runId) || []).slice(),
    recordRunStep: async (rec) => {
        const list = runStepsByRun.get(rec.runId);
        if (!list) return;
        // Upsert on (stepId, attempts) to mirror the real PK semantics so a
        // retry/handled-error flip overwrites rather than duplicates.
        const existing = list.find(s => s.stepId === rec.stepId && s.attempts === rec.attempts);
        const row = {
            runId: rec.runId,
            stepId: rec.stepId,
            parentStepId: rec.parentStepId ?? null,
            stepType: rec.stepType,
            attempts: rec.attempts ?? 1,
            status: rec.status,
            startedAt: rec.startedAt ?? null,
            finishedAt: rec.finishedAt ?? null,
            input: rec.input ?? null,
            output: rec.output ?? null,
            error: rec.error ?? null,
            errorClass: rec.errorClass ?? null,
            branchIndex: rec.branchIndex ?? null,
        };
        if (existing) Object.assign(existing, row);
        else list.push(row);
    },
    // ── automation row bookkeeping (best-effort in the runner) ──
    markRunning: async () => {},
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => {},
    // Cancellation flag is read between steps — never cancelled here.
    getRun_noop: undefined,
    requestCancelRun: async () => null,
};

// ── Stub modules that touch the DB / external services BEFORE requiring the
// runner, so it loads without booting a pool or hitting integrations. ────────
function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stub('../stores/automationStore', storeStub);
// resolveUserSession() reads these; all are tolerant of nulls/throws. Stub so
// the session resolves to null without hitting the DB pool.
stub('../stores/userStore', {
    getUser: async () => null,
    getOrganization: async () => null,
});
stub('../stores/configStore', {
    getConfig: async () => null,
    setConfig: async () => {},
});
stub('../stores/notificationStore', {
    createNotification: async () => {},
});

// Skip the legacy user_sessions pool query in resolveUserSession.
process.env.ROUTINE_AUTH_LEGACY = '0';
// Block the boot tick / setIntervals.
process.env.NODE_ENV = 'test';

const runner = require('./automationRunner');

// Requiring the runner pulls in app modules (stores / pricing service) that
// register non-unref'd timers and a DB pool during their init side-effects.
// They have nothing to do with these tests, but they keep the event loop
// alive so `node --test` never exits. Force a clean exit once all tests have
// reported. (The existing automationRunner.test.js does the same via an
// explicit process.exit(0) at the end of its IIFE.)
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

// ── The automation: trigger → A → B, B binds A's output ───────────────────
// A (set): emits { value: 21 }
// B (set): emits { doubled: <A.value> * 2 } via an expr binding on A's output.
function freshAutomation() {
    return {
        id: 'auto-1',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'Partial run regression',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [
                {
                    id: 'A',
                    type: 'set',
                    fields: { value: { kind: 'literal', value: 21 } },
                },
                {
                    id: 'B',
                    type: 'set',
                    fields: { doubled: { kind: 'expr', value: 'steps.A.output.value * 2' } },
                },
            ],
            edges: [
                { from: 'trig', to: 'A' },
                { from: 'A', to: 'B' },
            ],
        },
    };
}

test('runPartial(only) executes a missing upstream live so the target gets real inputs', async () => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;

    const automation = freshAutomation();
    // No prior run (getRunsForAutomation → []), no pinned outputs.
    const result = await runner.runPartial(automation, 'B', { mode: 'only' });

    // The run finished successfully.
    assert.ok(result, 'runPartial returns the finished run row');
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    // Inspect the recorded step rows for this run.
    const steps = await storeStub.getRunSteps(result.id);
    const byId = new Map(steps.map(s => [s.stepId, s]));

    // A was EXECUTED LIVE (the regression): it has a recorded success row with
    // its real output, even though it was never the target and had no replay.
    const a = byId.get('A');
    assert.ok(a, 'upstream step A was recorded (executed live, not skipped)');
    assert.strictEqual(a.status, 'success', 'A recorded as success');
    assert.deepStrictEqual(a.output, { value: 21 }, 'A produced its real output');

    // B (the target) received A's real output rather than undefined.
    const b = byId.get('B');
    assert.ok(b, 'target step B was recorded');
    assert.strictEqual(b.status, 'success', 'B recorded as success');
    assert.deepStrictEqual(b.output, { doubled: 42 }, 'B doubled A\'s live output (21 * 2)');
});

test('runPartial(only) on the target reuses a PINNED upstream output instead of executing it', async () => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;

    const automation = freshAutomation();
    // Pin A's output → replayState gets it → A is replayed, NOT executed live.
    automation.definition.steps.find(s => s.id === 'A').pinnedOutput = { value: 100 };

    const result = await runner.runPartial(automation, 'B', { mode: 'only' });
    assert.strictEqual(result.status, 'success', `run status (got ${result.status}, error: ${result.error})`);

    const steps = await storeStub.getRunSteps(result.id);
    const byId = new Map(steps.map(s => [s.stepId, s]));

    // A is in the replayState (pinned), so runDag replays it: no recorded step
    // row is written for A during this partial run (replay path doesn't record).
    assert.ok(!byId.has('A'), 'pinned upstream A is replayed, not re-executed/recorded');

    // B still resolves against the pinned A output: 100 * 2 = 200.
    const b = byId.get('B');
    assert.ok(b, 'target step B was recorded');
    assert.deepStrictEqual(b.output, { doubled: 200 }, 'B used the pinned A output (100 * 2)');
});
