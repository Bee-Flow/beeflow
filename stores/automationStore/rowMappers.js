/**
 * Pure row→object mappers + JSON helpers (§WS5, extracted verbatim). Leaf module.
 */

function rowToAutomation(r) {
    if (!r) return null;
    return {
        id: r.id,
        userId: r.user_id,
        organizationId: r.organization_id,
        // 'automation' (default), 'layer' (legacy standalone sub-automation),
        // or 'block' (a reusable Step — standalone, added to automations via a
        // call_block step or exposed as a chat tool).
        kind: r.kind || 'automation',
        // Sharing + publish-to-apply columns (automation-steps-2026-06). Only
        // meaningful for kind='block'; automations keep the defaults.
        isPublished: r.is_published ?? false,
        sharedGroups: typeof r.shared_groups === 'string' ? safeParse(r.shared_groups, []) : (Array.isArray(r.shared_groups) ? r.shared_groups : []),
        publishedVersion: r.published_version ?? null,
        exposeAsTool: r.expose_as_tool ?? false,
        // A Step's own symbol (Lucide icon name); null = default. Only set for
        // kind='block', but harmless on automations.
        icon: r.icon ?? null,
        // User-set category for grouping Steps in the add-step menu (kind='block').
        category: r.category ?? null,
        title: r.title,
        description: r.description,
        definition: typeof r.definition_json === 'string' ? safeParse(r.definition_json, {}) : (r.definition_json || {}),
        version: r.version,
        isActive: r.is_active,
        isDraft: r.is_draft,
        needsFirstRunConfirm: r.needs_first_run_confirm,
        triggerType: r.trigger_type,
        scheduleCron: r.schedule_cron,
        scheduleTz: r.schedule_tz,
        nextRunAt: r.next_run_at ? new Date(r.next_run_at).toISOString() : null,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).toISOString() : null,
        lastStatus: r.last_status,
        // Lock + retry columns added by automation-locking-and-session-2026-05.
        runningInstanceId: r.running_instance_id ?? null,
        runningStartedAt: r.running_started_at ? new Date(r.running_started_at).toISOString() : null,
        attempts: r.attempts ?? 0,
        // Per-automation timeout override (added by automation-timeout-and-subs-2026-05).
        // NULL means "use the runner's default".
        runTimeoutMs: r.run_timeout_ms ?? null,
        builderSession: typeof r.builder_session === 'string' ? safeParse(r.builder_session, null) : (r.builder_session ?? null),
        createdFromChatId: r.created_from_chat_id,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
        updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    };
}

function rowToRun(r) {
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        version: r.version,
        userId: r.user_id,
        triggerKind: r.trigger_kind,
        triggerPayload: typeof r.trigger_payload === 'string' ? safeParse(r.trigger_payload, null) : (r.trigger_payload || null),
        mode: r.mode,
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        durationMs: r.duration_ms,
        error: r.error,
        summary: r.summary,
        // Cancel + retry plumbing (added by automation-timeout-and-subs-2026-05).
        // parentRunId is the run a retry replays. cancelRequested is flipped
        // by the cancel endpoint and read by the runner between steps.
        parentRunId: r.parent_run_id ?? null,
        cancelRequested: !!r.cancel_requested,
        // Approval / resume plumbing (added by automation-approval-and-parallel-2026-06).
        awaitingStepId: r.awaiting_step_id ?? null,
        approvalToken: r.approval_token ?? null,
        // §27a — optional deadline on awaiting_approval. NULL means "no
        // expiry"; a past timestamp causes the approve route to 410.
        awaitingStepExpiresAt: r.awaiting_step_expires_at
            ? new Date(r.awaiting_step_expires_at).toISOString()
            : null,
        // §25 — typed error class persisted alongside the free-text error.
        errorClass: r.error_class ?? null,
        // §WS4 — how many step failures were absorbed by on_error branches.
        // The run itself still reports 'success'; the UI surfaces the count
        // as a "N handled" note.
        handledErrorCount: r.handled_error_count ?? 0,
    };
}

function rowToRunStep(r) {
    if (!r) return null;
    const out = {
        runId: r.run_id,
        stepId: r.step_id,
        // Layer sub-step nesting: non-null on rows recorded inside a
        // call_layer ('cl1/out' → parent 'cl1'). Run-history UIs nest on it;
        // replay-state builders skip rows that carry it.
        parentStepId: r.parent_step_id ?? null,
        stepType: r.step_type,
        attempts: r.attempts,
        status: r.status,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        // input_json / output_json are jsonb — node-postgres already parses
        // them to JS (object / array / string / number / bool). They must NOT
        // be re-parsed: a bare-STRING value (e.g. an AI step's free-text or a
        // ```json fenced reply) comes back as a JS string, and JSON.parse-ing
        // that throws → the old `safeParse(..., null)` turned it into null, so
        // string outputs silently vanished from the Run/Output panels.
        input: fromJsonb(r.input_json),
        output: fromJsonb(r.output_json),
        error: r.error,
        errorClass: r.error_class ?? null,
        branchIndex: r.branch_index ?? null,
    };
    // Derive a human "what to do next" hint for LEGACY Nextcloud error rows
    // recorded before the runner enriched the message. New rows already embed
    // "<cause> — <remediation>" in `error`, so skip those to avoid doubling.
    if (r.error && !String(r.error).includes(' — ') && /nextcloud|webdav|deck|talk|ocs/i.test(String(r.error))) {
        try {
            const { classifyNextcloudError } = require('../../core/nextcloudErrorClassifier');
            out.errorRemediation = classifyNextcloudError(r.error).remediation;
        } catch { /* best-effort */ }
    }
    return out;
}

function safeParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
}

// Read a value from a jsonb column. node-postgres already parses jsonb to the
// right JS type (object / array / string / number / bool), so we pass it
// through verbatim. Re-running JSON.parse here — as the old code did for string
// values — corrupted data both ways: a non-JSON string (an AI step's free-text
// or a ```json fenced reply) threw and became null, while a string that merely
// looked like JSON ("42", "[…]") was silently retyped. The driver's single
// parse is the correct one.
function fromJsonb(v) {
    return v ?? null;
}

// ── Automations CRUD ───────────────────────────────────


module.exports = { rowToAutomation, rowToRun, rowToRunStep, safeParse, fromJsonb };
