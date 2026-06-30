/**
 * Automation Runner — DAG-based execution engine for the conversational
 * automation builder.
 *
 * Sibling of aiTaskRunner.js (which keeps running for prompt-only tasks).
 *
 *   - 60s tick: schedule trigger pickup (next_run_at <= NOW()).
 *   - 30s tick: app-event subscription renewal + polling.
 *   - executeAutomation(...) traverses the DAG and dispatches by step type.
 *
 * Per-org access is gated by the 'automations' beta feature (set in
 * the admin dashboard → Security → Beta). The runner always boots; due
 * rows owned by orgs without the beta are skipped each tick.
 */

const crypto = require('crypto');
const automationStore = require('../stores/automationStore');
const configStore = require('../stores/configStore');
const notificationStore = require('../stores/notificationStore');
// modelResolver is required lazily inside execAiStep for the
// direct-chat-style tier resolution flow.
const { getProviderForModel } = require('./aiAgent');
const { getAdapter } = require('./providers');
const { pool } = require('../db');
const { sanitizeError } = require('./errorSanitizer');
const { classifyUnknownError, remediationFor } = require('./automationErrors');
const { resolveValue, resolveDeep, resolveInputs } = require('../automation/bind');
const { evaluate } = require('../automation/expr');
const { isSideEffect } = require('../automation/sideEffectMap');
const { synthesizeDryRunOutput } = require('../automation/outputSchemas');
const shapeCache = require('../automation/shapeCache');
const { summariseDefinition } = require('../automation/summarise');
const cron = require('../automation/cron');
const sandbox = require('../automation/codeSandbox');
const { NOTIFICATION_DEFAULTS, VALID_LEVELS, normalizeChannels } = require('../automation/notificationDefaults');
const runEventBus = require('./runEventBus');
const cancellation = require('./automationRunner/cancellation');
const {
    ACTIVE_RUNS,
    registerRunCancellation,
    clearRunCancellation,
    requestCancel,
    isCancelRequested,
} = cancellation;
// Safety/monitoring backbone — PII + regex guardrails + egress logging, mirroring
// the agent/direct-chat pipeline so automations stop bypassing those controls.
const safety = require('./automationRunner/safety');
const { runWithProbe, markLocal } = require('./outboundProbe');
const usageStore = require('../stores/usageStore');
const terminationStore = require('../stores/terminationStore');

// §WS5 — execution primitives live in ./automationRunner/engine.js.
const {
    RUNNER_INTERVAL_MS,
    POLLING_INTERVAL_MS,
    REAPER_INTERVAL_MS,
    RETENTION_INTERVAL_MS,
    MAX_CONCURRENT,
    MAX_LAYER_DEPTH,
    RUN_HARD_TIMEOUT_MS,
    MAX_RUN_TIMEOUT_MS,
    REAPER_FLOOR_MS,
    REAPER_BUFFER_MS,
    REAPER_MAX_ATTEMPTS,
    APPROVAL_DEFAULT_TTL_MS,
    APPROVAL_MAX_TTL_MS,
    COLLECTION_OP_MAX_ITEMS,
    INSTANCE_ID,
    resolveApprovalTtlMs,
    clampRunTimeout,
    cloneRunValue,
    secretValuesFor,
    resolveNotificationPolicy,
    dispatchRunNotification,
    sendRunEmail,
    withConnectorIdentity,
    resolveUserSession,
    mergeEnabled,
    isEmptyToolResult,
    isToolErrorResult,
    enrichNextcloudError,
    buildAdjacency,
    nextEdgesFor,
    execIntegrationAction,
    collectAiStepOutputFields,
    execAiStep,
    execCondition,
    execNotification,
    execCode,
    ApprovalRequiredError,
    execApproval,
    execParallel,
    execLoop,
    buildLinearEdges,
    execForEachStep,
    execCallLayer,
    execLayerOutput,
    callerCanUseBlock,
    loadBlockForRun,
    execCallBlock,
    execSet,
    execDateTime,
    execWait,
    execStopError,
    execSwitch,
    resolveArrayRef,
    execFilter,
    execLimit,
    execDedupe,
    execAggregate,
    execSummarize,
    runDag,
} = require('./automationRunner/engine');

async function resumeFromStep(runId, fromStepId, { decision = null, userId = null } = {}) {
    const original = await automationStore.getRun(runId);
    if (!original) throw new Error(`Run ${runId} not found`);
    const automation = await automationStore.getAutomation(original.automationId);
    if (!automation) throw new Error(`Automation ${original.automationId} not found`);

    // Replay state from previously-recorded step rows so binding
    // expressions like {{steps.stepX.output.field}} resolve to what they
    // resolved to in the original run.
    const previousSteps = await automationStore.getRunSteps(runId);
    const replayedStepState = {};
    for (const s of previousSteps) {
        if (!s.stepId || s.status === 'awaiting_approval') continue;
        // Layer sub-steps (parent_step_id set, ids like 'cl1/out') are not
        // nodes of the parent graph — replaying them would pollute
        // runState.steps with ids no binding can reference. Retry-from-step
        // granularity stays parent-graph: re-running a call_layer step
        // re-executes the WHOLE layer.
        if (s.parentStepId) continue;
        if (s.status === 'success' && s.output != null) {
            replayedStepState[s.stepId] = { output: s.output, status: 'success' };
        } else if (s.status === 'handled_error') {
            // §WS4: a step whose failure was absorbed by an on_error branch.
            // Rebuild the handled-error payload so error-branch bindings
            // (steps.<id>.error.message etc.) resolve, and so runDag's
            // replay path routes this step along 'on_error' again. Rows are
            // ordered by attempts ASC, so the final handled_error row wins
            // over earlier 'error' attempt rows for the same step.
            replayedStepState[s.stepId] = {
                status: 'handled_error',
                output: null,
                error: { message: s.error, errorClass: s.errorClass, stepId: s.stepId },
            };
        }
    }
    // Inject the synthetic decision output for the resumption-boundary step.
    if (fromStepId) {
        replayedStepState[fromStepId] = {
            output: decision || { approved: true, resumedAt: new Date().toISOString(), by: userId },
            status: 'success',
        };
    }

    return await executeAutomation({
        ...automation,
    }, {
        triggerKind: original.triggerKind || 'manual',
        triggerPayload: original.triggerPayload || null,
        mode: 'live',
        parentRunId: runId,
        replayState: replayedStepState,
        skipUntilStepId: fromStepId,
    });
}

async function runStepAsTool(blockId, args, ctx, { mode = 'live' } = {}) {
    const automationStore = require('../stores/automationStore');
    const row = await automationStore.getAutomation(blockId).catch(() => null);
    if (!row || row.kind !== 'block') throw new Error(`Step ${blockId} not found`);
    if (row.userId !== ctx?.userId) throw new Error('Forbidden: caller does not own the Step');
    if (row.publishedVersion == null) throw new Error('Step is not published — publish it before using it in chat.');
    if (!row.exposeAsTool) throw new Error('Step is not exposed as a chat tool.');
    const def = await automationStore.getVersionDefinition(blockId, row.publishedVersion).catch(() => null) || row.definition;
    const synthetic = {
        id: row.id,
        userId: row.userId,
        organizationId: row.organizationId || null,
        title: row.title,
        version: row.publishedVersion,
        definition: def,
        kind: 'block',
    };
    const result = await executeAutomation(synthetic, {
        triggerKind: 'agent_call',
        triggerPayload: args && typeof args === 'object' ? args : {},
        mode,
    });
    return result?.lastOutput ?? null;
}

async function executeAutomation(automation, { triggerKind = 'manual', triggerPayload = null, mode = 'live', confirmFirstRun = false, parentRunId = null, replayState = null, skipUntilStepId = null, onlyStepId = null, fromStepId = null } = {}) {
    const startedAt = Date.now();
    const session = await resolveUserSession(automation.userId);

    // First-run confirmation gate removed by product decision — every run
    // executes in the requested mode. Local vars kept (always false) so the
    // surrounding code paths that reference them stay readable; they'll be
    // dead-code-eliminated by any future cleanup pass.
    const effectiveMode = mode;
    const firstRunNeedsConfirm = false;
    const isUserInitiated = triggerKind === 'manual' || confirmFirstRun;

    // Create a run row (queued → running).
    const run = await automationStore.createRun({
        automationId: automation.id,
        version: automation.version,
        userId: automation.userId,
        triggerKind: firstRunNeedsConfirm ? 'first_run_confirm' : triggerKind,
        triggerPayload,
        mode: effectiveMode,
        parentRunId,
    });

    // Live run-lifecycle events for the executions UI's SSE stream. Skipped for
    // dry-runs (the executions table only shows live runs) and never allowed to
    // throw — emission must not break a run. Stamped with userId so the stream
    // route can scope events per-user, + automationId so a single-surface view
    // can filter. Attached to ctx so runDag can emit step.* with the same shape.
    const emitLifecycle = (type, extra = {}) => {
        if (effectiveMode === 'dry_run') return;
        try {
            runEventBus.emitRunEvent(type, {
                runId: run.id, automationId: automation.id, userId: automation.userId, ...extra,
            });
        } catch (_) { /* never break a run on telemetry */ }
    };

    // Register a cancellation controller for this run. The cancel endpoint
    // sets cancel_requested=TRUE in the DB and aborts this controller so
    // both in-process and cross-process cancellations are honoured.
    const cancelController = registerRunCancellation(run.id);
    const cancelSignal = cancelController.signal;

    // §WS2.4 — concurrency guard. markRunning atomically flips the automations
    // row to 'running' and RETURNS FALSE if a run is already in flight. We honour
    // that so two overlapping manual/webhook/event triggers don't execute the
    // same automation twice (duplicate side effects), and so a finishing sibling
    // can't clear the running marker out from under an active run (which would
    // defeat the reaper's crash recovery). Schedule runs are already claimed
    // atomically by claimDueAutomations(), and dry-runs are previews that must
    // never touch the marker — so only LIVE non-schedule runs mark/own it here.
    // `ownsMarker` then gates releaseAutomation in the finally so a dry-run can't
    // release a concurrent live run's marker.
    const ownsMarker = effectiveMode === 'live';
    if (triggerKind !== 'schedule' && effectiveMode === 'live') {
        // Fail OPEN on an infra error (catch→true); only the explicit `false`
        // "already running" contract blocks a concurrent run.
        const acquired = await automationStore.markRunning(automation.id, INSTANCE_ID).catch(() => true);
        if (acquired === false) {
            console.warn(`[AutomationRunner] ${automation.id} already running — skipping concurrent ${triggerKind} run ${run.id}`);
            const finishedAt = new Date().toISOString();
            await automationStore.updateRun(run.id, {
                status: 'cancelled', finishedAt, durationMs: Date.now() - startedAt,
                error: 'Skipped: automation already running',
                summary: 'Skipped — this automation was already running.',
            }).catch(() => {});
            clearRunCancellation(run.id);
            emitLifecycle('run.started', { triggerKind, mode: effectiveMode, title: automation.title || null, kind: automation.kind || 'automation', version: automation.version });
            emitLifecycle('run.finished', { status: 'cancelled', durationMs: Date.now() - startedAt });
            return await automationStore.getRun(run.id).catch(() => ({ ...run, status: 'cancelled' }));
        }
    }

    await automationStore.updateRun(run.id, { status: 'running', startedAt: new Date().toISOString() });
    emitLifecycle('run.started', {
        triggerKind, mode: effectiveMode, title: automation.title || null,
        kind: automation.kind || 'automation', version: automation.version,
    });
    // Heartbeat (live runs only): keeps the SSE stream warm AND stamps
    // last_heartbeat_at so the stuck-run reaper sees the run as alive.
    const heartbeatTimer = (effectiveMode === 'dry_run') ? null : setInterval(() => {
        emitLifecycle('step.heartbeat', { at: new Date().toISOString() });
        automationStore.touchRunHeartbeat(run.id).catch(() => {});
    }, 15_000);
    if (heartbeatTimer?.unref) heartbeatTimer.unref();

    const runState = {
        trigger: { output: triggerPayload || {} },
        // Hydrate from a previous run's recorded outputs when resuming —
        // bindings like {{steps.stepA.output.field}} need the values the
        // original run produced. Deep-clone the replay snapshot so step
        // handlers can't mutate the persisted prior-run rows.
        steps: replayState ? (cloneRunValue(replayState) || {}) : {},
        vars: automation.definition?.vars || {},
        secrets: {}, // populated by sandbox/secret bridges only; never echoed
        loop: {},
        // When non-null, interpolateTemplate pushes unresolved paths here so
        // the runner can surface a single warning summary per run instead of
        // silently swallowing missing bindings.
        _templateWarnings: [],
        // §WS4: every step failure absorbed by an on_error branch lands here
        // ({stepId, message, errorClass}). Layer/loop/parallel sub-states
        // carry the SAME array reference, so nested handled errors surface
        // in the run summary + handled_error_count too.
        _handledErrors: [],
    };

    // Resolve the automation owner's groups once per run. Used by webpage
    // tools (and any future tool) to check shared/published visibility
    // outside the request-scoped audience helpers.
    let runUserGroupIds = [];
    try {
        const { resolveUserGroups } = require('../auth/audience');
        runUserGroupIds = await resolveUserGroups(automation.userId);
    } catch (_) { /* tolerate */ }

    const ctx = {
        userId: automation.userId,
        orgId: automation.organizationId,
        userGroupIds: runUserGroupIds,
        userOrgIds: automation.organizationId ? [automation.organizationId] : [],
        session,
        runId: run.id,
        // First-run guard removed; field kept for shape compatibility with
        // any callers that read it. Always false now.
        needsFirstRunConfirm: false,
        automationId: automation.id,
        // Title is used as the agent_name surrogate in egress/guardrail rows.
        automationTitle: automation.title || null,
        // Best-effort NC base URL so egress rows carry a destination for
        // nextcloud_* tools (the probe captures the real peer IP regardless).
        nextcloudUrl: session?.connectorNcBaseUrl || session?.nextcloudUrl || automation.nc_base_url || null,
        // The full draft is needed by execAiStep so it can auto-derive an
        // outputSchema from downstream refs — without this, an ai_step that
        // produces structured fields ("replyText", "summary", etc.) just
        // returns plain text and downstream bindings silently resolve to
        // undefined, breaking integration steps with cryptic "X is required"
        // errors instead of producing useful output.
        definition: automation.definition || {},
        // Inline layers (root-only map of mini-definitions). execCallLayer
        // resolves step.layerKey against this — no DB fetch.
        layers: automation.definition?.layers || {},
        // Sub-step recording context. execCallLayer derives a child with
        // prefix '<callStepId>/' + parentStepId; execLoop suppresses for
        // its body (parity with the previously-unrecorded loop bodies).
        stepRecord: { prefix: '', parentStepId: null, suppress: false },
        // Live SSE emitter (no-op for dry-run) so runDag can stream step.*.
        emitLifecycle,
    };

    // Dispatch a single step by type — no iteration. Container/control
    // steps (loop, parallel, call_layer) recurse via the `dispatchStep`
    // closure below. Referencing `dispatchStep` here is safe: it's only
    // *called* at run time, by when the const is assigned.
    const runStepLeaf = async (step, ctx_, state_, mode_) => {
        switch (step.type) {
            case 'integration_action': return execIntegrationAction(step, ctx_, state_, mode_);
            case 'ai_step':            return execAiStep(step, ctx_, state_, mode_);
            case 'condition':          return execCondition(step, ctx_, state_);
            case 'loop':               return execLoop(step, ctx_, state_, mode_, dispatchStep);
            case 'code':               return execCode(step, ctx_, state_, mode_);
            case 'notification':       return execNotification(step, ctx_, state_, mode_);
            case 'approval':           return execApproval(step, ctx_, state_, mode_);
            case 'parallel':           return execParallel(step, ctx_, state_, mode_, dispatchStep);
            case 'call_layer':         return execCallLayer(step, ctx_, state_, mode_, dispatchStep);
            case 'call_block':         return execCallBlock(step, ctx_, state_, mode_, dispatchStep);
            case 'layer_output':       return execLayerOutput(step, ctx_, state_);
            // n8n-style utility nodes
            case 'set':                return execSet(step, ctx_, state_);
            case 'datetime':           return execDateTime(step, ctx_, state_);
            case 'wait':               return execWait(step, ctx_, state_, mode_);
            case 'stop_error':         return execStopError(step, ctx_, state_);
            case 'switch':             return execSwitch(step, ctx_, state_);
            case 'filter':             return execFilter(step, ctx_, state_);
            case 'limit':              return execLimit(step, ctx_, state_);
            case 'dedupe':             return execDedupe(step, ctx_, state_);
            case 'aggregate':          return execAggregate(step, ctx_, state_);
            case 'summarize':          return execSummarize(step, ctx_, state_);
            default: throw new Error(`Unknown step type: ${step.type}`);
        }
    };

    // Wrap a leaf step with optional per-item iteration. When `step.forEach`
    // is set the step runs once per array element (see execForEachStep);
    // otherwise it runs once. Both the initial dispatch and the retry path
    // route through here so iteration composes with retry / on_error.
    const executeStepWithIteration = async (step, ctx_, state_, mode_) => {
        if (step.forEach && step.forEach.overRef) {
            // Same cancellation contract as dispatchStep, checked between
            // every iterated item (both the in-process signal and the
            // cross-process DB flag).
            const checkCancel = async () => {
                if (cancelSignal.aborted) throw new Error('Run cancelled');
                if (await isCancelRequested(run.id)) throw new Error('Run cancelled');
            };
            return execForEachStep(step, ctx_, state_, mode_, runStepLeaf, checkCancel);
        }
        return runStepLeaf(step, ctx_, state_, mode_);
    };

    const dispatchStep = async (step, ctx_, state_, mode_) => {
        // Cancellation is checked between every step. We honour both the
        // in-process AbortSignal (fast path for local cancels) and the
        // cross-process DB flag (handles cancels issued against a different
        // runner pod).
        if (cancelSignal.aborted) throw new Error('Run cancelled');
        if (await isCancelRequested(run.id)) throw new Error('Run cancelled');

        const stepStartedAt = new Date().toISOString();
        // Defensive: a step missing `id` would crash recordRunStep
        // (step_id is NOT NULL). Synthesize one so we never write null
        // and so retries / errors still get a unique row.
        if (!step.id) {
            step.id = `unknown_${Math.random().toString(36).slice(2, 8)}`;
            console.warn(`[AutomationRunner] Step missing id; synthesized ${step.id}`);
        }

        // n8n-style data pinning. When a step has `pinnedOutput` we skip
        // the real handler and emit the pinned value verbatim — saves
        // upstream API/model calls during iterative debugging. Pinned
        // steps record as 'success' with source='pinned' so audit trails
        // distinguish synthetic outputs from live ones.
        if (step.pinnedOutput !== undefined && step.pinnedOutput !== null) {
            return {
                output: step.pinnedOutput,
                startedAt: stepStartedAt,
                inputSnapshot: step.inputs ? resolveDeep(step.inputs, state_, { allowSecrets: false }) : null,
                pinned: true,
                // 'pinned' status threads through runDag's recordedStatus
                // mapper so audit rows can distinguish synthetic from live
                // outputs without having to inspect the output JSON itself.
                skippedReason: 'pinned',
            };
        }

        // n8n-style "disable this node" toggle. Disabled steps pass
        // their resolved input through as `{ disabled: true, input }`
        // so downstream bindings don't crash on undefined, and never
        // call into integrations / models / notifications.
        if (step.disabled) {
            return {
                output: { disabled: true },
                startedAt: stepStartedAt,
                inputSnapshot: step.inputs ? resolveDeep(step.inputs, state_, { allowSecrets: false }) : null,
                skippedReason: 'disabled',
            };
        }

        let result;
        try {
            result = await executeStepWithIteration(step, ctx_, state_, mode_);
            result.startedAt = stepStartedAt;
            result.inputSnapshot = step.inputs ? resolveDeep(step.inputs, state_, { allowSecrets: false }) : null;
            return result;
        } catch (err) {
            const inputForRecord = step.inputs ? resolveDeep(step.inputs, state_, { allowSecrets: false }) : null;
            const secretValues = secretValuesFor(state_);
            // Sub-step recording: namespace ids under the calling call_layer
            // step (ctx_.stepRecord.prefix) and suppress entirely inside
            // unrecorded loop bodies — mirrors the runDag record sites.
            const recStepId = (ctx_.stepRecord?.prefix || '') + step.id;
            const recParentStepId = ctx_.stepRecord?.parentStepId || null;
            const recSuppressed = !!ctx_.stepRecord?.suppress;
            // Approval pauses are not errors — record the step as
            // 'awaiting_approval' so run history shows the pause point and
            // the resume path can find it.
            if (err instanceof ApprovalRequiredError) {
                if (!recSuppressed) {
                    await automationStore.recordRunStep({
                        runId: ctx_.runId, stepId: recStepId, parentStepId: recParentStepId,
                        stepType: step.type, attempts: 1,
                        status: 'awaiting_approval', startedAt: stepStartedAt, finishedAt: new Date().toISOString(),
                        input: inputForRecord,
                        output: { prompt: err.prompt }, error: null,
                        secretValues,
                    });
                }
                throw err;
            }
            // Record the initial failed attempt up-front. Without this, an
            // initial fail followed by a successful retry would erase the
            // original error from the audit trail (runDag would overwrite
            // attempts=1 from 'error' to 'success'). Subsequent retries are
            // recorded as attempts=i+1 by the retry loop below.
            if (!recSuppressed) {
                await automationStore.recordRunStep({
                    runId: ctx_.runId, stepId: recStepId, parentStepId: recParentStepId,
                    stepType: step.type, attempts: 1,
                    status: 'error', startedAt: stepStartedAt, finishedAt: new Date().toISOString(),
                    input: inputForRecord,
                    output: null, error: err.message,
                    errorClass: err.errorClass || classifyUnknownError(err),
                    secretValues,
                });
            }
            // Attempt retry per step config. §WS2.5: a forEach that already did
            // per-item retry and threw all-failed (err.foreachHandled) must NOT
            // be retried whole here — that would re-run the entire fan-out.
            const retry = step.retry || null;
            if (retry && retry.max && retry.max > 0 && !err.foreachHandled) {
                for (let i = 1; i <= retry.max; i++) {
                    if (retry.backoffMs) await new Promise(r => setTimeout(r, retry.backoffMs));
                    const attemptStartedAt = new Date().toISOString();
                    try {
                        // Route retries through the same wrapper as the initial
                        // dispatch so per-item iteration (forEach) composes with
                        // retry. Approval throws on every call to pause; the
                        // enclosing executeAutomation handles the pause path
                        // before any retry kicks in (this block only fires for
                        // actual errors).
                        const retryResult = await executeStepWithIteration(step, ctx_, state_, mode_);
                        retryResult.startedAt = stepStartedAt;
                        retryResult.inputSnapshot = inputForRecord;
                        // Tell runDag to record the final outcome at the
                        // correct `attempts` slot rather than overwriting
                        // attempts=1 (the initial-fail row above).
                        retryResult.attempt = i + 1;
                        retryResult.attemptStartedAt = attemptStartedAt;
                        return retryResult;
                    } catch (retryErr) {
                        // Record every retry attempt — not just the last. The
                        // audit trail otherwise has no rows for intermediate
                        // failures, hiding flaky-tool patterns from users.
                        if (!recSuppressed) {
                            await automationStore.recordRunStep({
                                runId: ctx_.runId, stepId: recStepId, parentStepId: recParentStepId,
                                stepType: step.type, attempts: i + 1,
                                status: 'error', startedAt: attemptStartedAt, finishedAt: new Date().toISOString(),
                                input: inputForRecord,
                                output: null, error: retryErr.message,
                                errorClass: retryErr.errorClass || classifyUnknownError(retryErr),
                                // Retries may have pulled new secrets into state_
                                // via bridges — recompute rather than reuse.
                                secretValues: secretValuesFor(state_),
                            });
                        }
                    }
                }
            }
            // §WS4: retries are structural — they all ran above, so the
            // error escaping here IS final. Stamp which attempts slot holds
            // the last recorded 'error' row so runDag's on_error catch can
            // flip exactly that row to 'handled_error' (PK upsert) instead
            // of fabricating a duplicate attempts=1 row.
            err.finalAttempt = (retry && retry.max > 0 && !err.foreachHandled) ? retry.max + 1 : 1;
            throw err;
        }
    };

    let runResult;
    let runErrorObj = null;
    let runErrorMsg = null;
    let runStatus = 'success';
    let wasCancelled = false;

    const effectiveTimeoutMs = clampRunTimeout(automation);
    let timeoutTimer = null;
    // §WS2.1 — the DAG promise. We keep a handle so that on a timeout/cancel we
    // can abort the controller and AWAIT runDag's unwind before finalizing —
    // otherwise Promise.race only stops *waiting* for runDag; runDag itself keeps
    // dispatching steps (real side effects + recordRunStep writes) against a run
    // row we've already marked terminal. `dagDone` lets the finally skip the
    // abort on the normal success/approval path (runDag already settled there).
    let dagDone = false;
    const dagPromise = runDag(automation.definition || {}, ctx, runState, effectiveMode, dispatchStep, { recordSteps: true, skipUntilStepId, onlyStepId, fromStepId });
    dagPromise.then(() => { dagDone = true; }, () => { dagDone = true; });
    const dagSettled = dagPromise.catch(() => {}); // swallow the late rejection once the race has already taken it
    const guard = new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error('Run hard timeout')), effectiveTimeoutMs);
        if (timeoutTimer.unref) timeoutTimer.unref();
    });
    guard.catch(() => {}); // never an unhandled rejection
    // Abort signal also rejects the race, so the cancel endpoint can stop
    // the run even when the runDag promise is awaiting a long upstream call.
    const cancelGuard = new Promise((_, reject) => {
        const onAbort = () => reject(new Error('Run cancelled'));
        if (cancelSignal.aborted) onAbort();
        else cancelSignal.addEventListener('abort', onAbort, { once: true });
    });
    cancelGuard.catch(() => {}); // finally may abort() and reject this with no live race handler

    try {
        runResult = await Promise.race([dagPromise, guard, cancelGuard]);
    } catch (e) {
        runErrorObj = e;
        runErrorMsg = e.message || String(e);
        wasCancelled = cancelSignal.aborted || e.message === 'Run cancelled';
        if (e instanceof ApprovalRequiredError) {
            runStatus = 'awaiting_approval';
        } else if (wasCancelled) {
            runStatus = 'cancelled';
        } else {
            runStatus = 'error';
        }
    } finally {
        // §WS2.1 — if the race ended via timeout or cancel while runDag is still
        // in flight, abort the controller so dispatchStep's between-step check
        // short-circuits it, then wait for it to unwind so no further step runs
        // against this finalized run. On success/approval runDag already settled
        // (dagDone), so we must NOT abort — that would falsely trip the §WS2.3
        // cancel re-check below.
        if (!dagDone) {
            try { cancelController.abort(); } catch (_) { /* noop */ }
            await dagSettled;
        }
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        clearRunCancellation(run.id);
    }

    // §WS2.3 — a cancel requested while the FINAL step was executing is otherwise
    // lost: runDag returns normally (cancel is only checked at the START of each
    // step) and we'd record 'success'. Re-check the cancel authority — the
    // in-process signal OR the cross-pod cancel_requested DB flag — and downgrade
    // to 'cancelled' so the success notification + resetAttempts are skipped.
    if (runStatus === 'success' && (cancelSignal.aborted || await isCancelRequested(run.id).catch(() => false))) {
        runStatus = 'cancelled';
        wasCancelled = true;
        runErrorMsg = runErrorMsg || 'Run cancelled';
    }

    // Sanitized error fields for any persisted message visible to users.
    // The raw error stays in the run row's `error` column for diagnostics
    // (server-only); user-facing notifications get the redacted line.
    const sanitized = runErrorObj ? sanitizeError(runErrorObj) : null;
    const userSafeError = sanitized
        ? (sanitized.error_first_line || `Failed (${sanitized.error_code})`)
        : runErrorMsg;

    // Stable, queryable class for the run (lights up the run-facets dashboard).
    const runErrorClass = (runStatus === 'error' && runErrorObj)
        ? (runErrorObj.errorClass || classifyUnknownError(runErrorObj))
        : null;
    // Nextcloud errors already embed "<cause> — <remediation>" in their text;
    // for other errors append a generic remediation so we never double it.
    const runRemediation = (runStatus === 'error' && !runErrorObj?.ncError && runErrorClass)
        ? remediationFor(runErrorClass)
        : null;

    const finishedAt = new Date().toISOString();
    // §WS4: failures absorbed by on_error branches. The run still reports
    // 'success', but the summary + handled_error_count make the recoveries
    // visible in the run history.
    const handledErrorCount = Array.isArray(runState._handledErrors) ? runState._handledErrors.length : 0;
    const summary = (() => {
        if (firstRunNeedsConfirm) return 'Awaiting first-run confirmation. Review the dry-run output and approve to run live.';
        if (runErrorMsg) return runRemediation ? `Failed: ${userSafeError}. ${runRemediation}` : `Failed: ${userSafeError}`;
        const base = summariseDefinition(automation.definition || {}).summary;
        return handledErrorCount > 0
            ? `${base} — ${handledErrorCount} step error(s) handled by error branch`
            : base;
    })();

    // For awaiting_approval, persist the approval token + the step id so
    // the resume endpoint can validate and continue.
    let approvalToken = null;
    if (runStatus === 'awaiting_approval' && runErrorObj instanceof ApprovalRequiredError) {
        approvalToken = crypto.randomBytes(24).toString('hex');
    }

    await automationStore.updateRun(run.id, {
        status: firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus,
        finishedAt,
        durationMs: Date.now() - startedAt,
        error: runErrorMsg,
        ...(runErrorClass ? { errorClass: runErrorClass } : {}),
        summary,
        ...(handledErrorCount > 0 ? { handledErrorCount } : {}),
        ...(runStatus === 'awaiting_approval'
            ? {
                awaitingStepId: runErrorObj?.stepId || null,
                approvalToken,
                // §WS2.2 — persist the deadline so the approve endpoint's 410
                // guard and the reaper's expiry pass actually fire.
                awaitingStepExpiresAt: (runErrorObj instanceof ApprovalRequiredError ? runErrorObj.expiresAt : null) || null,
            }
            : {}),
    });

    // Stream the terminal state so the executions list + open execution flip
    // from running → final without a refresh.
    const finalStatus = firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus;
    if (runStatus === 'error') {
        emitLifecycle('run.failed', { status: 'error', errorClass: runErrorClass, error: userSafeError, durationMs: Date.now() - startedAt });
    } else {
        emitLifecycle('run.finished', { status: finalStatus, durationMs: Date.now() - startedAt, handledErrorCount });
    }

    // Release the running marker + update the automation's last-run state — but
    // ONLY for runs that own the marker (live runs). §WS2.4: a dry-run is a
    // preview that never marked the row running, so it must not release (which
    // would clear a concurrent live run's marker) nor overwrite lastStatus/
    // lastRunAt with preview results. Without releasing, a live row stays
    // `running` forever on a crash — the reaper still catches that; releasing
    // here is the fast path.
    if (ownsMarker) {
        try {
            await automationStore.updateAutomation(automation.id, {
                lastStatus: firstRunNeedsConfirm ? 'awaiting_confirm' : runStatus,
                lastRunAt: finishedAt,
            }, automation.userId);
            await automationStore.releaseAutomation(automation.id);
            if (runStatus === 'success') {
                await automationStore.resetAttempts(automation.id);
            }
        } catch (e) {
            console.warn(`[AutomationRunner] release/update failed for ${automation.id}: ${e.message}`);
        }
    }

    // Notifications — error path uses the sanitized message so we never
    // leak upstream API payloads or bearer tokens echoed in error bodies.
    // Each event consults the per-automation policy (see
    // resolveNotificationPolicy) so success-path noise can be silenced
    // by the user without losing failure / approval alerts.
    try {
        if (firstRunNeedsConfirm) {
            await dispatchRunNotification(automation, resolveNotificationPolicy(automation, 'onApproval'), {
                title: `Confirm first real run of "${automation.title}"`,
                message: `Your automation produced a dry-run preview. Approve to run it live (run id ${run.id}).`,
            });
        } else if (runStatus === 'success' && triggerKind !== 'dry_run' && effectiveMode === 'live') {
            await dispatchRunNotification(automation, resolveNotificationPolicy(automation, 'onSuccess'), {
                title: `🤖 ${automation.title}`,
                message: summary,
            });
        } else if (runStatus === 'error') {
            await dispatchRunNotification(automation, resolveNotificationPolicy(automation, 'onError'), {
                title: `⚠️ Automation failed: ${automation.title}`,
                message: userSafeError || 'Unknown error',
            });
        } else if (runStatus === 'awaiting_approval' && runErrorObj instanceof ApprovalRequiredError) {
            await dispatchRunNotification(automation, resolveNotificationPolicy(automation, 'onApproval'), {
                title: `🛂 Approval needed: ${automation.title}`,
                message: `${runErrorObj.prompt || 'Approval requested'} — open the run history to approve.`,
            });
        }
        // No notification for cancelled runs — the user initiated the cancel
        // so they already know. The run history shows the status.
    } catch (_) { /* notification failure is non-fatal */ }

    // Schedule advancement (unless this was a manual run or first-run confirm)
    if (automation.triggerType === 'schedule'
        && !firstRunNeedsConfirm
        && triggerKind !== 'manual'
        && triggerKind !== 'dry_run'
        && automation.scheduleCron) {
        try {
            const next = cron.nextRunAt(automation.scheduleCron, automation.scheduleTz, Date.now());
            if (next) await automationStore.updateAutomation(automation.id, { nextRunAt: next }, automation.userId);
        } catch (e) {
            console.warn(`[AutomationRunner] Cron advance failed for ${automation.id}: ${e.message}`);
        }
    }

    return await automationStore.getRun(run.id);
}

// ── Schedule tick ───────────────────────────────────────

async function processDueAutomations() {
    try {
        // Atomic claim with `FOR UPDATE SKIP LOCKED`: each row is owned by
        // exactly one runner instance, even when multiple workers share a
        // DB. Replaces the old read-then-mark pattern that allowed double
        // execution if a runner crashed between read and mark.
        const due = await automationStore.claimDueAutomations(INSTANCE_ID, 20);
        if (due.length === 0) return;

        // Filter by per-org beta access. If an org loses the 'automations'
        // beta, their automations stop firing on schedule (but stay in the
        // DB so re-enabling restores them instantly). Skipped rows are
        // released so the schedule advances on the next tick.
        const { hasCapability } = require('./entitlements');
        const allowed = [];
        for (const a of due) {
            try {
                // Resolve against the automation's OWN org (not the owner's
                // primary org) via the unified resolver, so scheduled firing
                // agrees with the requireCapability('automations') route gate.
                const ok = await hasCapability('automations', { userId: a.userId, orgId: a.organizationId });
                if (ok) allowed.push(a);
                else {
                    console.log(`[AutomationRunner] Skipping ${a.id} — owner ${a.userId} no longer has automations beta`);
                    await automationStore.releaseAutomation(a.id);
                    await automationStore.updateAutomation(a.id, { lastStatus: 'pending' }, a.userId).catch(() => {});
                }
            } catch (_) {
                // On lookup failure, release rather than fire incorrectly.
                await automationStore.releaseAutomation(a.id).catch(() => {});
            }
        }
        if (allowed.length === 0) return;

        for (let i = 0; i < allowed.length; i += MAX_CONCURRENT) {
            const batch = allowed.slice(i, i + MAX_CONCURRENT);
            await Promise.allSettled(batch.map(a => executeAutomation(a, { triggerKind: 'schedule' })));
        }
    } catch (e) {
        console.error('[AutomationRunner] processDueAutomations error:', e.message);
    }
}

/**
 * Reaper — finds rows stuck in `running` longer than REAPER_STALE_AFTER_MS
 * (a runner crash / OOM / pod kill leaves them this way) and resets them
 * so the next tick can re-claim. After REAPER_MAX_ATTEMPTS the row is
 * left in `error` and the owner is notified.
 */
async function reapStuckAutomations() {
    try {
        const reaped = await automationStore.reapStuckAutomations({
            staleAfterMs: REAPER_FLOOR_MS,
            maxAttempts: REAPER_MAX_ATTEMPTS,
            bufferMs: REAPER_BUFFER_MS,
        });
        if (reaped.length === 0) return;
        for (const a of reaped) {
            const giveUp = (a.attempts || 0) >= REAPER_MAX_ATTEMPTS;
            console.warn(`[AutomationRunner] Reaper reset stuck row ${a.id} (attempts=${a.attempts}${giveUp ? ', giving up' : ''})`);
            if (giveUp) {
                try {
                    await notificationStore.createNotification({
                        userId: a.userId,
                        category: 'urgent',
                        title: `⚠️ Automation failed: ${a.title}`,
                        message: `The automation could not complete after ${REAPER_MAX_ATTEMPTS} attempts and was paused. Open it to inspect the last run.`,
                    });
                } catch (_) { /* non-fatal */ }
            }
        }
    } catch (e) {
        console.error('[AutomationRunner] reapStuckAutomations error:', e.message);
    }

    // §WS2.2 — separately expire approval-paused runs past their deadline. These
    // live on automation_runs (not the automations row reaped above), so the
    // stuck-row reaper never sees them. Own try block so a failure here doesn't
    // mask the stuck-row pass and vice-versa.
    try {
        const expired = await automationStore.reapExpiredApprovals();
        for (const r of expired) {
            console.warn(`[AutomationRunner] Reaper expired approval run ${r.id} (automation ${r.automationId})`);
            try {
                runEventBus.emitRunEvent('run.failed', {
                    runId: r.id, automationId: r.automationId, userId: r.userId,
                    status: 'error', errorClass: 'ApprovalExpired',
                    error: 'Approval expired — no decision was made before the deadline.',
                });
            } catch (_) { /* telemetry must never break the reaper */ }
        }
    } catch (e) {
        console.error('[AutomationRunner] reapExpiredApprovals error:', e.message);
    }

    // §WS3.3 — reap orphaned run rows stuck in 'running' (worker died). Uses
    // last_heartbeat_at (a healthy long run heartbeats so it's never stale).
    try {
        const stuckRuns = await automationStore.reapStuckRuns({ staleAfterMs: REAPER_FLOOR_MS });
        for (const r of stuckRuns) {
            console.warn(`[AutomationRunner] Reaper failed stuck run ${r.id} (automation ${r.automationId}) — no heartbeat`);
            try {
                runEventBus.emitRunEvent('run.failed', {
                    runId: r.id, automationId: r.automationId, userId: r.userId,
                    status: 'error', errorClass: 'RunnerDied',
                    error: 'Run stopped heartbeating — the worker crashed or was killed.',
                });
            } catch (_) { /* telemetry must never break the reaper */ }
        }
    } catch (e) {
        console.error('[AutomationRunner] reapStuckRuns error:', e.message);
    }
}

// ── Polling / renewal tick ──────────────────────────────
//
// Multi-pod safety: polling and renewal both write to the
// `automation_event_subscriptions` table and dispatch event runs. With
// multiple pods all running the same setInterval, two pods would race for
// the same subscriptions and could double-fire events. We guard the tick
// with a Postgres advisory lock — at most one pod runs polling at any
// instant. If the lock-holder crashes Postgres releases it on session end
// (the next tick on any pod re-acquires).
//
// We don't lock schedule processing (that uses FOR UPDATE SKIP LOCKED so
// it's already safe), and we don't lock per-subscription (one global lock
// keeps the implementation trivial; polling work is small enough that a
// single pod can handle it for the foreseeable future).

const POLLING_LOCK_KEY = 0xBEEF105; // arbitrary stable int for pg_try_advisory_lock

async function processPollingAndRenewals() {
    let acquired = false;
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [POLLING_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) {
            // Another pod owns the lock for this tick; back off cleanly.
            return;
        }
        const triggerBus = require('../automation/triggerBus');
        await triggerBus.runPollingPass();
        await triggerBus.renewExpiringSubscriptions();
    } catch (e) {
        console.error('[AutomationRunner] polling/renewal error:', e.message);
    } finally {
        if (client) {
            try {
                if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [POLLING_LOCK_KEY]);
            } catch (_) { /* lock release is best-effort */ }
            client.release();
        }
    }
}

// Talk auto-record: poll active Talk calls of opted-in users and start
// recording the ones they moderate. Single-pod-per-tick via its own advisory
// lock (same discipline as polling — a different stable key).
const TALK_AUTORECORD_LOCK_KEY = 0xBEEF106;

async function processTalkAutoRecord() {
    let acquired = false;
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [TALK_AUTORECORD_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        await require('./meetingNotes/talkAutoRecord').scanAndRecord();
    } catch (e) {
        console.error('[AutomationRunner] talk auto-record error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [TALK_AUTORECORD_LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
    }
}

// §WS3.1 — run-history retention sweep. Advisory-locked so only one pod drains
// the backlog per tick (the DELETE is safe concurrently, but one pod is enough).
const RETENTION_LOCK_KEY = 0xBEEF107;

async function processRunRetention() {
    let acquired = false;
    let client;
    try {
        client = await pool.connect();
        const lockRes = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [RETENTION_LOCK_KEY]);
        acquired = !!lockRes.rows[0]?.locked;
        if (!acquired) return; // another pod owns this tick
        await require('../jobs/runRetention').runRetentionPass();
    } catch (e) {
        console.error('[AutomationRunner] run-retention error:', e.message);
    } finally {
        if (client) {
            try { if (acquired) await client.query('SELECT pg_advisory_unlock($1)', [RETENTION_LOCK_KEY]); } catch (_) { /* best-effort */ }
            client.release();
        }
    }
}

// ── Boot ────────────────────────────────────────────────

async function start() {
    if (started) return;
    // Always start the tick. Per-org gating via the 'automations' beta
    // feature is enforced inside processDueAutomations() — orgs without
    // the beta will have their due rows skipped each tick.
    started = true;
    setInterval(processDueAutomations, RUNNER_INTERVAL_MS).unref();
    setInterval(processPollingAndRenewals, POLLING_INTERVAL_MS).unref();
    setInterval(reapStuckAutomations, REAPER_INTERVAL_MS).unref();
    setInterval(processTalkAutoRecord, RUNNER_INTERVAL_MS).unref();
    // §WS3.1 — run-history retention. Hourly is plenty (it batch-drains a
    // platform-wide age window); the job no-ops when retention is disabled.
    setInterval(processRunRetention, RETENTION_INTERVAL_MS).unref();
    setTimeout(processDueAutomations, 10_000).unref?.();
    setTimeout(reapStuckAutomations, 15_000).unref?.();
    setTimeout(processRunRetention, 60_000).unref?.();
    console.log(`[AutomationRunner] started (instance=${INSTANCE_ID}, 60s schedule, 30s polling, 60s reaper, 60s talk-autorecord, ${Math.round(RETENTION_INTERVAL_MS / 60000)}m retention)`);
}

/**
 * Locate a step that lives inside a flowlet/layer (definition.layers[*])
 * rather than the root graph. Returns { layerKey, layer } when `stepId` is
 * one of the layer's own steps (or its layer_input trigger), else null.
 */
function findStepInLayers(def, stepId) {
    const layers = def?.layers || {};
    for (const [layerKey, layer] of Object.entries(layers)) {
        if (!layer || typeof layer !== 'object') continue;
        const hit = layer.trigger?.id === stepId
            || (Array.isArray(layer.steps) && layer.steps.some(s => s?.id === stepId));
        if (hit) return { layerKey, layer };
    }
    return null;
}

/**
 * "Execute step" / "retry from step" for a node that lives INSIDE a flowlet
 * (layer). A layer is a self-contained mini-definition (layer_input trigger +
 * steps + layer_output), so we run IT as the top-level DAG with `stepId` as
 * the partial-run target — the root graph never contains the node, which is
 * why the plain root lookup throws "step not found".
 *
 * Seeding mirrors the root partial run:
 *   - The layer_input (trigger.output) is filled from the inputs the most
 *     recent real run mapped into a call_layer step that targets this layer,
 *     so bindings like {{trigger.output.x}} resolve to realistic values.
 *     Falls back to {} (same as a dry-run with no payload).
 *   - The layer's own steps replay from that run's namespaced sub-step rows
 *     ('<callStepId>/<subId>') so upstream side effects aren't re-run; any gap
 *     is filled live by runDag (fillMissingUpstream). Pinned outputs win.
 *
 * The synthetic definition keeps the full `layers` map (so nested call_layer
 * still resolves) and document-level `vars`. Recorded step ids are the layer's
 * own bare ids, so the inspector finds the target step record by its id.
 */
async function runPartialInLayer(automation, { layerKey, layer }, stepId, { mode = 'only', triggerKind = 'manual', triggerPayload = null } = {}) {
    const def = automation.definition || {};
    const isLayerTrigger = layer.trigger?.id === stepId;

    const prior = await automationStore.getRunsForAutomation(automation.id, { limit: 1 }).catch(() => []);
    const priorRunId = prior?.[0]?.id || null;
    const priorSteps = priorRunId
        ? await automationStore.getRunSteps(priorRunId).catch(() => [])
        : [];

    // Seed the layer input. Prefer an explicit payload, else the inputs a prior
    // run fed into a call_layer step that targets this layer.
    let layerInput = triggerPayload;
    if (layerInput == null && priorSteps.length) {
        const callStepIds = new Set(
            (def.steps || [])
                .filter(s => s?.type === 'call_layer' && s.layerKey === layerKey)
                .map(s => s.id),
        );
        const callRec = priorSteps.find(s => callStepIds.has(s.stepId) && s.input != null);
        if (callRec) layerInput = callRec.input;
    }

    // Trigger-only run on the flowlet input: synthesize a run whose single
    // recorded step IS the input (its payload is its output), mirroring the
    // root trigger path. Nothing downstream to execute.
    if (isLayerTrigger && mode === 'only') {
        const run = await automationStore.createRun({
            automationId: automation.id,
            version: automation.version,
            userId: automation.userId,
            triggerKind,
            triggerPayload: layerInput || {},
            mode: 'live',
            parentRunId: priorRunId,
        });
        const output = layerInput || {};
        const nowIso = new Date().toISOString();
        try {
            await automationStore.recordRunStep({
                runId: run.id,
                stepId,
                stepType: 'trigger',
                attempts: 1,
                status: 'success',
                startedAt: nowIso,
                finishedAt: nowIso,
                input: layerInput ?? null,
                output,
                error: null,
                secretValues: [],
            });
        } catch (_) { /* best-effort */ }
        await automationStore.updateRun(run.id, {
            status: 'success',
            startedAt: nowIso,
            finishedAt: nowIso,
            output,
            summary: 'Flowlet input (no downstream execution)',
        }).catch(() => {});
        return { ...run, status: 'success', output };
    }

    // Replay the layer's own steps from the prior run's namespaced rows.
    const layerStepIds = new Set((layer.steps || []).map(s => s?.id).filter(Boolean));
    const replayState = {};
    for (const s of priorSteps) {
        if (!s.parentStepId || typeof s.stepId !== 'string' || !s.stepId.includes('/')) continue;
        const subId = s.stepId.slice(s.stepId.lastIndexOf('/') + 1);
        if (!layerStepIds.has(subId)) continue;
        if (s.status === 'success' && s.output != null) {
            replayState[subId] = { output: s.output, status: 'success' };
        } else if (s.status === 'handled_error') {
            replayState[subId] = {
                status: 'handled_error',
                output: null,
                error: { message: s.error, errorClass: s.errorClass, stepId: subId },
            };
        }
    }
    // Pinned outputs on the layer's steps override historical replay.
    for (const s of (layer.steps || [])) {
        if (s?.pinnedOutput !== undefined && s?.pinnedOutput !== null) {
            replayState[s.id] = { output: s.pinnedOutput, status: 'success' };
        }
    }

    // The layer becomes the top-level definition; keep nested flowlets
    // resolvable and document-level vars visible.
    const syntheticAutomation = {
        ...automation,
        definition: {
            ...layer,
            layers: def.layers || {},
            vars: def.vars || layer.vars || {},
        },
    };

    const opts = {
        triggerKind,
        triggerPayload: layerInput || {},
        mode: 'live',
        parentRunId: priorRunId,
        replayState,
    };
    // "From the flowlet input" → run the whole layer downstream of its trigger.
    if (isLayerTrigger && mode === 'from') {
        // No partial flags — let runDag walk the full layer DAG.
    } else if (mode === 'only') {
        opts.onlyStepId = stepId;
    } else if (mode === 'from') {
        opts.fromStepId = stepId;
    } else {
        throw new Error(`runPartial: unknown mode "${mode}" (expected 'only' or 'from')`);
    }

    return executeAutomation(syntheticAutomation, opts);
}

/**
 * Run a single step (n8n "Execute step"), or a step and everything
 * downstream of it (retry-from-step). Builds the synthetic `replayState`
 * from the most recent successful run's recorded step rows so binding
 * expressions resolve to real upstream values, and from any step's
 * `pinnedOutput` so pinned data wins over historical output.
 *
 * mode='only' → dispatch just `stepId`, then stop.
 * mode='from' → dispatch `stepId` and walk the downstream subgraph live.
 *
 * The new run is recorded as a CHILD of the most recent run when one
 * exists so audit history threads back to the run that seeded the
 * replay. With no prior run, runs from a fresh state.
 */
async function runPartial(automation, stepId, { mode = 'only', triggerKind = 'manual', triggerPayload = null } = {}) {
    if (!stepId) throw new Error('runPartial: stepId is required');
    const def = automation.definition || {};
    const steps = Array.isArray(def.steps) ? def.steps : [];
    const triggerId = def.trigger?.id || null;
    const isTrigger = triggerId && stepId === triggerId;
    const target = isTrigger ? def.trigger : steps.find(s => s.id === stepId);
    if (!target) {
        // The step may live inside a flowlet/layer — those aren't nodes of the
        // root DAG, so run the layer's own sub-graph with this step as target.
        const inLayer = findStepInLayers(def, stepId);
        if (inLayer) {
            return runPartialInLayer(automation, inLayer, stepId, { mode, triggerKind, triggerPayload });
        }
        throw new Error(`runPartial: step ${stepId} not found in definition`);
    }

    // Trigger-only run: there's nothing to execute downstream. Synthesize a
    // run with just the trigger output so the UI's "Run step" on a trigger
    // node returns a real run record (the payload IS the output).
    if (isTrigger && mode === 'only') {
        const run = await automationStore.createRun({
            automationId: automation.id,
            version: automation.version,
            userId: automation.userId,
            triggerKind,
            triggerPayload,
            mode: 'live',
            parentRunId: null,
        });
        const triggerOutput = triggerPayload || {};
        const nowIso = new Date().toISOString();
        try {
            await automationStore.recordRunStep({
                runId: run.id,
                stepId: triggerId,
                stepType: 'trigger',
                attempts: 1,
                status: 'success',
                startedAt: nowIso,
                finishedAt: nowIso,
                input: triggerPayload ?? null,
                output: triggerOutput,
                error: null,
                // No runState here — a trigger-only synthetic run executes no
                // steps, so no secret bridge can have populated any secrets.
                secretValues: [],
            });
        } catch (_) { /* recordRunStep is best-effort here */ }
        await automationStore.updateRun(run.id, {
            status: 'success',
            startedAt: nowIso,
            finishedAt: nowIso,
            output: triggerOutput,
            summary: 'Trigger step (no downstream execution)',
        }).catch(() => {});
        return { ...run, status: 'success', output: triggerOutput };
    }

    // Seed replay from the most recent prior run's persisted step rows.
    // Bindings like {{steps.stepA.output.field}} need real values to
    // resolve. Any upstream step NOT covered here (no prior run, no pin)
    // is executed live by runDag (fillMissingUpstream) so the target still
    // gets real inputs rather than undefined.
    const prior = await automationStore.getRunsForAutomation(automation.id, { limit: 1 }).catch(() => []);
    const priorRunId = prior?.[0]?.id || null;
    const replayState = {};
    if (priorRunId) {
        const priorSteps = await automationStore.getRunSteps(priorRunId).catch(() => []);
        for (const s of priorSteps) {
            // Skip layer sub-steps — they're recorded under namespaced ids
            // ('cl1/out') that aren't parent-graph nodes. A partial run that
            // hits a call_layer step re-runs the whole layer.
            if (s.parentStepId) continue;
            if (s.status === 'success' && s.output != null) {
                replayState[s.stepId] = { output: s.output, status: 'success' };
            } else if (s.status === 'handled_error') {
                // §WS4: replayed handled errors keep their error payload so
                // error-branch bindings resolve, and runDag routes them along
                // 'on_error' (see the replay branch there).
                replayState[s.stepId] = {
                    status: 'handled_error',
                    output: null,
                    error: { message: s.error, errorClass: s.errorClass, stepId: s.stepId },
                };
            }
        }
    }
    // Pinned outputs override historical replay so the user's "Pin" wins.
    for (const s of steps) {
        if (s.pinnedOutput !== undefined && s.pinnedOutput !== null) {
            replayState[s.id] = { output: s.pinnedOutput, status: 'success' };
        }
    }

    const opts = {
        triggerKind,
        triggerPayload,
        mode: 'live',
        parentRunId: priorRunId,
        replayState,
    };
    // "From trigger" → run the whole automation downstream of the trigger.
    // Treating it as a normal run (no fromStepId/onlyStepId) is the cleanest
    // way to do this and matches the user's intent of "execute from here".
    if (isTrigger && mode === 'from') {
        // No partial-execution flags — let runDag walk the full DAG.
    } else if (mode === 'only') {
        opts.onlyStepId = stepId;
    } else if (mode === 'from') {
        opts.fromStepId = stepId;
    } else {
        throw new Error(`runPartial: unknown mode "${mode}" (expected 'only' or 'from')`);
    }

    return executeAutomation(automation, opts);
}

module.exports = {
    start,
    executeAutomation,
    processDueAutomations,
    reapStuckAutomations,
    requestCancel,
    resumeFromStep,
    runPartial,
    ApprovalRequiredError,
    INSTANCE_ID,
    // Exported for unit tests.
    execCallLayer,
    execCallBlock,
    runStepAsTool,
    loadBlockForRun,
    execLayerOutput,
    execLoop,
    execForEachStep,
    execApproval,
    resolveApprovalTtlMs,
    MAX_LAYER_DEPTH,
    runDag,
    execFilter,
    execDedupe,
    execAiStep,
    COLLECTION_OP_MAX_ITEMS,
    resolveNotificationPolicy,
    dispatchRunNotification,
    sendRunEmail,
};

