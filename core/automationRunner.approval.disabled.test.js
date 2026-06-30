/**
 * §WS2.2 — approval deadline DISABLED via AUTOMATION_APPROVAL_TTL_MS=0.
 *
 * APPROVAL_DEFAULT_TTL_MS is computed once at module-load time from the env, so
 * this case lives in its own file with the env set BEFORE the runner is
 * required. With the default disabled and no per-step override:
 *   - resolveApprovalTtlMs(step) returns null.
 *   - execApproval (live) throws with expiresAt === null.
 *   - executeAutomation persists awaitingStepExpiresAt = null.
 * A per-step override still produces a deadline even when the default is off.
 *
 * Run: node --test core/automationRunner.approval.disabled.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

// MUST be set before requiring the runner (read at module-load time).
process.env.AUTOMATION_APPROVAL_TTL_MS = '0';

const runs = new Map();
let runSeq = 0;
const updateRunCalls = [];

function makeRun(args) {
    const id = `run-${++runSeq}`;
    const row = {
        id, ...args, status: 'queued', startedAt: new Date().toISOString(),
        finishedAt: null, durationMs: null, error: null, summary: null,
        awaitingStepId: null, approvalToken: null, awaitingStepExpiresAt: null,
        cancelRequested: false, errorClass: null, handledErrorCount: 0,
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
        if (r) Object.assign(r, updates);
        return !!r;
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

const runner = require('./automationRunner');
const { resolveApprovalTtlMs, execApproval } = runner;

after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

test('§WS2.2 — AUTOMATION_APPROVAL_TTL_MS=0 disables the default deadline (null)', () => {
    assert.strictEqual(resolveApprovalTtlMs({}), null);
    assert.strictEqual(resolveApprovalTtlMs(undefined), null);
});

test('§WS2.2 — a per-step override still wins when the default is disabled', () => {
    assert.strictEqual(resolveApprovalTtlMs({ approval: { expiresInHours: 2 } }), 2 * 3600_000);
});

test('§WS2.2 — execApproval (live) throws expiresAt=null when expiry is disabled', async () => {
    await assert.rejects(
        () => execApproval({ id: 'gate', type: 'approval' }, { layerStack: [] }, { vars: {}, secrets: {} }, 'live'),
        (err) => { assert.strictEqual(err.expiresAt, null); return true; },
    );
});

test('§WS2.2 — executeAutomation persists awaitingStepExpiresAt=null when expiry is disabled', async () => {
    runs.clear(); runSeq = 0; updateRunCalls.length = 0;
    const automation = {
        id: 'auto-appr', version: 1, userId: 'user-1', organizationId: null,
        title: 'Approval gate (expiry off)', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger' },
            steps: [{ id: 'gate', type: 'approval', prompt: 'Approve' }],
            edges: [{ from: 'trig', to: 'gate' }],
        },
    };
    const result = await runner.executeAutomation(automation, { triggerKind: 'manual', mode: 'live' });
    assert.strictEqual(result.status, 'awaiting_approval');
    const terminal = updateRunCalls.find(c => c.updates.status === 'awaiting_approval');
    assert.ok(terminal, 'terminal awaiting_approval updateRun exists');
    assert.strictEqual(terminal.updates.awaitingStepExpiresAt, null, 'deadline is null when disabled');
});
