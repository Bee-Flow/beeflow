/**
 * §WS2.2 — approval deadline.
 *
 *  - resolveApprovalTtlMs(step): default = 7 days; a per-step override via
 *    step.approval.expiresInHours wins; expiresInMs wins over that; the result
 *    is capped at APPROVAL_MAX_TTL_MS (30 days). (The env-disable case lives in
 *    automationRunner.approval.disabled.test.js — it needs the env var set at
 *    module-load time.)
 *  - execApproval(step, ctx, state, 'live') throws an ApprovalRequiredError
 *    carrying an `expiresAt` ISO string by default (~7 days out).
 *  - executeAutomation persists a non-null awaitingStepExpiresAt in the terminal
 *    updateRun for an awaiting_approval run.
 *
 * Heavy deps pre-mocked via the require cache (same approach as the foreach /
 * partial suites). No DB / external services.
 *
 * Run: node --test core/automationRunner.approval.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── In-memory automationStore stub that captures updateRun calls ───────────
const runs = new Map();
let runSeq = 0;
const updateRunCalls = []; // { id, updates }

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
    return row;
}

const storeStub = {
    initDB: async () => {},
    createRun: async (args) => makeRun(args),
    getRun: async (id) => runs.get(id) || null,
    updateRun: async (id, updates) => {
        updateRunCalls.push({ id, updates: { ...updates } });
        const r = runs.get(id);
        if (!r) return false;
        Object.assign(r, updates);
        return true;
    },
    getRunsForAutomation: async () => [],
    getRunSteps: async () => [],
    recordRunStep: async () => {},
    markRunning: async () => true,
    releaseAutomation: async () => {},
    resetAttempts: async () => {},
    updateAutomation: async () => true,
    touchRunHeartbeat: async () => {},
    requestCancelRun: async () => null,
    getAutomation: async () => null,
};

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
// Intentionally do NOT set AUTOMATION_APPROVAL_TTL_MS here so the module-load
// default (7 days) is in effect for these tests.

const runner = require('./automationRunner');
const { resolveApprovalTtlMs, execApproval, ApprovalRequiredError } = runner;

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

beforeEach(() => {
    runs.clear();
    runSeq = 0;
    updateRunCalls.length = 0;
});

const DAY_MS = 24 * 60 * 60 * 1000;

// ── resolveApprovalTtlMs ────────────────────────────────────────────────────

test('§WS2.2 — resolveApprovalTtlMs defaults to 7 days when no override', () => {
    assert.strictEqual(resolveApprovalTtlMs({}), 7 * DAY_MS);
    assert.strictEqual(resolveApprovalTtlMs(undefined), 7 * DAY_MS);
    assert.strictEqual(resolveApprovalTtlMs({ type: 'approval' }), 7 * DAY_MS);
});

test('§WS2.2 — per-step approval.expiresInHours overrides the default', () => {
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInHours: 2 } }), 2 * 3600_000);
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInHours: 48 } }), 48 * 3600_000);
    // Bare step.expiresInHours is also honoured.
    assert.strictEqual(resolveApprovalTtlMs({ expiresInHours: 3 }), 3 * 3600_000);
});

test('§WS2.2 — approval.expiresInMs takes precedence over expiresInHours', () => {
    assert.strictEqual(
        resolveApprovalTtlMs({ approval: { expiresInMs: 90_000, expiresInHours: 5 } }),
        90_000,
    );
});

test('§WS2.2 — the override is capped at 30 days (APPROVAL_MAX_TTL_MS)', () => {
    const MAX = 30 * DAY_MS;
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInHours: 24 * 365 } }), MAX);
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInMs: 999 * DAY_MS } }), MAX);
});

test('§WS2.2 — a non-positive per-step override disables expiry (null)', () => {
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInMs: 0 } }), null);
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInHours: -1 } }), null);
});

// ── execApproval ────────────────────────────────────────────────────────────

test('§WS2.2 — execApproval (live) throws ApprovalRequiredError with an expiresAt ISO ~7 days out', async () => {
    const before = Date.now();
    const step = { id: 'gate', type: 'approval', prompt: 'OK to send?' };
    await assert.rejects(
        () => execApproval(step, { layerStack: [] }, { vars: {}, secrets: {} }, 'live'),
        (err) => {
            assert.ok(err instanceof ApprovalRequiredError, 'is an ApprovalRequiredError');
            assert.strictEqual(err.stepId, 'gate');
            assert.strictEqual(typeof err.expiresAt, 'string', 'expiresAt is an ISO string');
            const t = Date.parse(err.expiresAt);
            assert.ok(!Number.isNaN(t), 'expiresAt parses as a date');
            // ~7 days out (allow generous slack for test-runtime jitter).
            const delta = t - before;
            assert.ok(delta > 7 * DAY_MS - 60_000 && delta < 7 * DAY_MS + 60_000,
                `expiresAt ~7 days out (delta=${delta}ms)`);
            return true;
        },
    );
});

test('§WS2.2 — execApproval honours a per-step expiresInHours in the thrown deadline', async () => {
    const before = Date.now();
    const step = { id: 'gate', type: 'approval', approval: { expiresInHours: 1 } };
    await assert.rejects(
        () => execApproval(step, { layerStack: [] }, { vars: {}, secrets: {} }, 'live'),
        (err) => {
            const delta = Date.parse(err.expiresAt) - before;
            assert.ok(delta > 3600_000 - 60_000 && delta < 3600_000 + 60_000,
                `expiresAt ~1 hour out (delta=${delta}ms)`);
            return true;
        },
    );
});

test('§WS2.2 — execApproval in dry_run auto-approves (no throw, no deadline)', async () => {
    const step = { id: 'gate', type: 'approval', prompt: 'OK?' };
    const r = await execApproval(step, { layerStack: [] }, { vars: {}, secrets: {} }, 'dry_run');
    assert.strictEqual(r.output.approved, true);
    assert.strictEqual(r.output._dryRun, true);
});

// ── executeAutomation persists awaitingStepExpiresAt ────────────────────────

function approvalAutomation() {
    return {
        id: 'auto-appr',
        version: 1,
        userId: 'user-1',
        organizationId: null,
        title: 'Approval gate regression',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [
                { id: 'gate', type: 'approval', prompt: 'Approve to continue' },
            ],
            edges: [{ from: 'trig', to: 'gate' }],
        },
    };
}

test('§WS2.2 — executeAutomation persists a non-null awaitingStepExpiresAt for an awaiting_approval run', async () => {
    const result = await runner.executeAutomation(approvalAutomation(), { triggerKind: 'manual', mode: 'live' });

    assert.strictEqual(result.status, 'awaiting_approval', `run paused for approval (got ${result.status})`);

    // The terminal updateRun (the one that set status awaiting_approval) must
    // carry a non-null awaitingStepExpiresAt + the awaiting step id.
    const terminal = updateRunCalls.find(c => c.updates.status === 'awaiting_approval');
    assert.ok(terminal, 'a terminal updateRun set status=awaiting_approval');
    assert.strictEqual(terminal.updates.awaitingStepId, 'gate', 'awaitingStepId is the gate step');
    assert.ok(terminal.updates.awaitingStepExpiresAt, 'awaitingStepExpiresAt is non-null');
    assert.ok(!Number.isNaN(Date.parse(terminal.updates.awaitingStepExpiresAt)),
        'awaitingStepExpiresAt is a parseable ISO date');

    // It is persisted onto the run row that executeAutomation returns.
    assert.ok(result.awaitingStepExpiresAt, 'returned run row carries the deadline');
});

test('§WS2.2 — a shorter per-step deadline flows through to the persisted run', async () => {
    const before = Date.now();
    const automation = approvalAutomation();
    automation.definition.steps[0].approval = { expiresInHours: 1 };

    const result = await runner.executeAutomation(automation, { triggerKind: 'manual', mode: 'live' });
    assert.strictEqual(result.status, 'awaiting_approval');

    const terminal = updateRunCalls.find(c => c.updates.status === 'awaiting_approval');
    const delta = Date.parse(terminal.updates.awaitingStepExpiresAt) - before;
    assert.ok(delta > 3600_000 - 60_000 && delta < 3600_000 + 60_000,
        `persisted deadline ~1 hour out (delta=${delta}ms)`);
});
