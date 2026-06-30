/**
 * §WS2.4 — concurrency guard + dry-run marker gating in executeAutomation
 * (core/automationRunner.js, ~lines 2007-2035 + 2452-2472).
 *
 *  - A LIVE non-schedule run whose automationStore.markRunning() returns FALSE
 *    must NOT walk the DAG: it cancels the just-created run ('cancelled',
 *    summary mentions "already running") and returns without dispatching any
 *    step.
 *  - markRunning() returning TRUE lets the DAG run normally.
 *  - Schedule-trigger runs and dry-runs (mode:'dry_run') skip the marker
 *    entirely, so a FALSE marker can never block them.
 *  - A dry-run never owns the marker → it must NOT call releaseAutomation /
 *    updateAutomation(lastStatus); a live run does call them.
 *
 * Uses pure in-process `set` steps (execSet just resolves bindings) so there's
 * no LLM / tool / sandbox / DB dependency — fully deterministic. The store is a
 * spy-instrumented in-memory stub (mirrors automationRunner.partial.test.js).
 *
 * Run: node --test core/automationRunner.concurrency.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── Spy-instrumented in-memory automationStore stub ────────────────────────
const runs = new Map();          // runId -> run row
const runStepsByRun = new Map(); // runId -> [step row]
let runSeq = 0;

// Spy counters / control knobs reset in beforeEach.
const spies = {
    markRunning: 0,
    releaseAutomation: 0,
    updateAutomationLastStatus: 0,
    recordRunStep: 0,
    resetAttempts: 0,
    // null = fail open (catch → true); the runner only blocks on an explicit false.
    markRunningResult: true,
};

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
    createRun: async (args) => makeRun(args),
    getRun: async (id) => runs.get(id) || null,
    updateRun: async (id, updates) => {
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    getRunsForAutomation: async () => [],
    getRunSteps: async (runId) => (runStepsByRun.get(runId) || []).slice(),
    recordRunStep: async (rec) => {
        spies.recordRunStep += 1;
        const list = runStepsByRun.get(rec.runId);
        if (!list) return;
        list.push({ ...rec, attempts: rec.attempts ?? 1 });
    },
    // §WS2.4 marker. The runner treats an explicit `false` as "already running";
    // a throw is caught and treated as fail-open (true).
    markRunning: async () => {
        spies.markRunning += 1;
        if (spies.markRunningResult === 'throw') throw new Error('infra blip');
        return spies.markRunningResult;
    },
    releaseAutomation: async () => { spies.releaseAutomation += 1; },
    resetAttempts: async () => { spies.resetAttempts += 1; },
    updateAutomation: async (id, updates) => {
        if (updates && Object.prototype.hasOwnProperty.call(updates, 'lastStatus')) {
            spies.updateAutomationLastStatus += 1;
        }
        return true;
    },
    touchRunHeartbeat: async () => {},
    requestCancelRun: async () => null,
    getAutomation: async () => null,
};

// ── Stub DB-/service-touching modules BEFORE requiring the runner. ──────────
function stub(modPath, exportsObj) {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stub('../stores/automationStore', storeStub);
stub('../stores/userStore', { getUser: async () => null, getOrganization: async () => null });
stub('../stores/configStore', { getConfig: async () => null, setConfig: async () => {} });
stub('../stores/notificationStore', { createNotification: async () => {} });

process.env.ROUTINE_AUTH_LEGACY = '0';
process.env.NODE_ENV = 'test';

const runner = require('./automationRunner');

// Requiring the runner registers timers / a DB pool via init side-effects of
// other stores; force a clean exit once all tests report (same as the partial
// suite).
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

beforeEach(() => {
    runs.clear();
    runStepsByRun.clear();
    runSeq = 0;
    spies.markRunning = 0;
    spies.releaseAutomation = 0;
    spies.updateAutomationLastStatus = 0;
    spies.recordRunStep = 0;
    spies.resetAttempts = 0;
    spies.markRunningResult = true;
});

// ── The automation: trigger → A (set) ──────────────────────────────────────
// A single deterministic `set` step. If it runs we see a recorded step row
// with output { ran: true }; if the guard fires it never executes.
function freshAutomation() {
    return {
        id: 'auto-1',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'Concurrency guard regression',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [
                { id: 'A', type: 'set', fields: { ran: { kind: 'literal', value: true } } },
            ],
            edges: [{ from: 'trig', to: 'A' }],
        },
    };
}

test('§WS2.4 — live run with markRunning=false is cancelled and skips the DAG', async () => {
    spies.markRunningResult = false;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(spies.markRunning, 1, 'markRunning was consulted');
    assert.strictEqual(result.status, 'cancelled', 'run ended cancelled');
    assert.match(result.summary || '', /already running/i, 'summary cites the concurrent run');

    // No step dispatched, no step row recorded.
    assert.strictEqual(spies.recordRunStep, 0, 'no step was recorded');
    const steps = await storeStub.getRunSteps(result.id);
    assert.strictEqual(steps.length, 0, 'no step ran');

    // A blocked run never owned the marker, so it must not release it.
    assert.strictEqual(spies.releaseAutomation, 0, 'blocked run did not release the marker');
    assert.strictEqual(spies.updateAutomationLastStatus, 0, 'blocked run did not write lastStatus');
});

test('§WS2.4 — live run with markRunning=true walks the DAG normally', async () => {
    spies.markRunningResult = true;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(spies.markRunning, 1, 'markRunning was consulted');
    assert.strictEqual(result.status, 'success', `run succeeded (got ${result.status}, error: ${result.error})`);

    const steps = await storeStub.getRunSteps(result.id);
    const a = steps.find(s => s.stepId === 'A');
    assert.ok(a, 'step A was recorded (DAG ran)');
    assert.strictEqual(a.status, 'success', 'step A succeeded');
    assert.deepStrictEqual(a.output, { ran: true }, 'step A produced its real output');

    // A live success owns the marker → releases it + writes lastStatus.
    assert.strictEqual(spies.releaseAutomation, 1, 'live run released the marker');
    assert.strictEqual(spies.updateAutomationLastStatus, 1, 'live run wrote lastStatus');
});

test('§WS2.4 — markRunning that THROWS fails open (run proceeds)', async () => {
    // An infra error on the marker must not block the run: catch → true.
    spies.markRunningResult = 'throw';

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(result.status, 'success', `fail-open run succeeded (got ${result.status})`);
    const steps = await storeStub.getRunSteps(result.id);
    assert.ok(steps.some(s => s.stepId === 'A'), 'DAG ran despite marker throwing');
});

test('§WS2.4 — a SCHEDULE trigger is never blocked by markRunning (marker skipped)', async () => {
    // Schedule runs are already claimed atomically upstream; executeAutomation
    // must NOT consult the marker for them, so even a false marker cannot block.
    spies.markRunningResult = false;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'schedule', mode: 'live' });

    assert.strictEqual(spies.markRunning, 0, 'markRunning was NOT consulted for a schedule run');
    assert.strictEqual(result.status, 'success', `schedule run succeeded (got ${result.status})`);
    const steps = await storeStub.getRunSteps(result.id);
    assert.ok(steps.some(s => s.stepId === 'A'), 'schedule DAG ran');
});

test('§WS2.4 — a DRY-RUN is never blocked by markRunning (marker skipped)', async () => {
    spies.markRunningResult = false;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'dry_run' });

    assert.strictEqual(spies.markRunning, 0, 'markRunning was NOT consulted for a dry-run');
    assert.strictEqual(result.status, 'success', `dry-run succeeded (got ${result.status})`);
});

test('§WS2.4 — a DRY-RUN never releases the marker nor writes lastStatus', async () => {
    spies.markRunningResult = true; // irrelevant — marker is skipped for dry-runs

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'dry_run' });

    assert.strictEqual(result.status, 'success', `dry-run succeeded (got ${result.status})`);
    assert.strictEqual(spies.markRunning, 0, 'dry-run never marks the row running');
    assert.strictEqual(spies.releaseAutomation, 0, 'dry-run did NOT release the marker');
    assert.strictEqual(spies.updateAutomationLastStatus, 0, 'dry-run did NOT overwrite lastStatus');
    assert.strictEqual(spies.resetAttempts, 0, 'dry-run did NOT reset attempts');
});

test('§WS2.4 — a LIVE run DOES release the marker + write lastStatus (contrast)', async () => {
    spies.markRunningResult = true;

    const result = await runner.executeAutomation(freshAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(result.status, 'success', `live run succeeded (got ${result.status})`);
    assert.strictEqual(spies.releaseAutomation, 1, 'live run released the marker exactly once');
    assert.strictEqual(spies.updateAutomationLastStatus, 1, 'live run wrote lastStatus exactly once');
    assert.strictEqual(spies.resetAttempts, 1, 'live success reset attempts');
});
