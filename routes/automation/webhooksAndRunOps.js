// §WS5 #4 — webhook management + run details/retry/approve/cancel/agent-invoke,
// extracted verbatim from routes/automation.js.
const express = require('express');
const router = express.Router();
const automationStore = require('../../stores/automationStore');

router.post('/:id/webhook', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const wh = await automationStore.createWebhook(a.id);
        res.json({ webhook: wh, url: `/api/automation/webhook/${wh.id}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/:id/webhooks', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const list = await automationStore.getWebhooksForAutomation(a.id);
        res.json({ webhooks: list });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Rotate a webhook's HMAC secret. The slug (URL) stays the same; any caller
 * still using the old secret immediately receives 401. The new secret is
 * returned ONCE so the user can copy it before navigating away — we don't
 * store it in plaintext anywhere the UI can re-read.
 */
router.post('/:id/webhook/:slug/rotate', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const rotated = await automationStore.rotateWebhookSecret(req.params.slug, a.id);
        if (!rotated) return res.status(404).json({ error: 'Webhook not found' });
        res.json({ webhook: rotated });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.delete('/:id/webhook/:slug', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const ok = await automationStore.deleteWebhook(req.params.slug, a.id);
        if (!ok) return res.status(404).json({ error: 'Webhook not found' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/runs/:id', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const run = await automationStore.getRun(req.params.id);
        if (!run) return res.status(404).json({ error: 'Not found' });
        if (run.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        res.json({ run });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/runs/:id/steps', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const run = await automationStore.getRun(req.params.id);
        if (!run) return res.status(404).json({ error: 'Not found' });
        if (run.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const steps = await automationStore.getRunSteps(run.id);
        // Return the flow snapshot AS IT WAS at run time so run history renders
        // the steps that actually existed then, not the current definition.
        // Falls back to the current definition for legacy runs whose version
        // predates version snapshotting.
        let definition = await automationStore.getVersionDefinition(run.automationId, run.version);
        if (!definition) {
            const a = await automationStore.getAutomation(run.automationId);
            definition = a?.definition || null;
        }
        res.json({ steps, definition, version: run.version });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Retry a previously failed run. Re-fires `executeAutomation` with the
 * original triggerKind+payload, links the new run to the old via
 * `parent_run_id` so the history shows the lineage. Manual user action;
 * synchronous wait capped at 60s to mirror /run.
 */
router.post('/:id/runs/:runId/retry', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (a.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const original = await automationStore.getRun(req.params.runId);
        if (!original) return res.status(404).json({ error: 'Run not found' });
        if (original.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        if (original.automationId !== a.id) return res.status(400).json({ error: 'Run does not belong to this automation' });

        const runner = require('../../core/automationRunner');
        const RESPONSE_TIMEOUT_MS = 60_000;
        let timedOut = false;
        const guard = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, RESPONSE_TIMEOUT_MS));
        const runPromise = runner.executeAutomation(a, {
            triggerKind: original.triggerKind || 'manual',
            triggerPayload: original.triggerPayload || null,
            mode: 'live',
            parentRunId: original.id,
        }).catch(e => { console.error('[automation/retry] error:', e.message); return null; });

        const run = await Promise.race([runPromise, guard]);
        if (timedOut || !run) {
            return res.status(202).json({
                accepted: true,
                pending: true,
                message: 'Retry is still in progress. Check the run history shortly.',
            });
        }
        const steps = await automationStore.getRunSteps(run.id).catch(() => []);
        return res.status(200).json({ accepted: true, run, steps });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Approve / reject the step an awaiting_approval run is paused on.
 *
 * Body: { decision: 'approve' | 'reject', reason?: string }
 * Returns the new run row produced by resumeFromStep — note this is a
 * CHILD run, linked to the original via parent_run_id; the original row
 * stays in `awaiting_approval` so the lineage is intact.
 *
 * The user must own the automation (org-level approve-anyone-else's-run
 * is intentionally NOT supported here — that requires per-step ACLs).
 */
router.post('/runs/:runId/approve-step', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const original = await automationStore.getRun(req.params.runId);
        if (!original) return res.status(404).json({ error: 'Run not found' });
        if (original.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        if (original.status !== 'awaiting_approval') {
            return res.status(409).json({ error: `Run is in ${original.status} state, not awaiting_approval` });
        }
        if (!original.awaitingStepId) {
            return res.status(409).json({ error: 'Run has no recorded awaiting step' });
        }
        // §27a: approval token expiry. Once the deadline passes, the
        // approve endpoint refuses the decision (410 Gone). Reaper later
        // transitions the row to status='error' with error_class.
        if (original.awaitingStepExpiresAt
            && new Date(original.awaitingStepExpiresAt).getTime() < Date.now()) {
            return res.status(410).json({ error: 'Approval window expired.', error_class: 'ApprovalExpired' });
        }

        const decision = String(req.body?.decision || 'approve').toLowerCase();
        if (decision !== 'approve' && decision !== 'reject') {
            return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
        }

        if (decision === 'reject') {
            // Reject finalises the original run as 'error' with a clear
            // reason. We do NOT resume — the rest of the flow is dropped.
            await automationStore.updateRun(original.id, {
                status: 'error',
                error: `Approval rejected${req.body?.reason ? `: ${req.body.reason}` : ''}`,
                finishedAt: new Date().toISOString(),
                awaitingStepId: null,
                approvalToken: null,
            });
            return res.json({ accepted: true, decision: 'reject', run: await automationStore.getRun(original.id) });
        }

        // Approve → kick off resume. Synchronous wait capped at 60s like /run.
        const runner = require('../../core/automationRunner');
        const RESPONSE_TIMEOUT_MS = 60_000;
        let timedOut = false;
        const guard = new Promise((resolve) => setTimeout(() => { timedOut = true; resolve(null); }, RESPONSE_TIMEOUT_MS));
        const resumePromise = runner.resumeFromStep(original.id, original.awaitingStepId, {
            decision: { approved: true, by: userId, reason: req.body?.reason || null, decidedAt: new Date().toISOString() },
            userId,
        }).catch(e => { console.error('[automation/approve-step] error:', e.message); return null; });

        // Mark the original run as resumed so the UI reflects state immediately
        // (the new child run carries the live execution).
        await automationStore.updateRun(original.id, {
            status: 'success',
            summary: `Resumed via approval — see child run ${(await automationStore.getRun(original.id))?.id || ''}`,
            awaitingStepId: null,
            approvalToken: null,
        }).catch(() => {});

        const newRun = await Promise.race([resumePromise, guard]);
        if (timedOut || !newRun) {
            return res.status(202).json({ accepted: true, pending: true, message: 'Resume started; check run history.' });
        }
        return res.json({ accepted: true, decision: 'approve', run: newRun });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * Request cancellation of an in-flight run. Honoured at the next "between
 * steps" check on whichever runner pod is executing the run, so cancel
 * latency is bounded by step duration. Acknowledges immediately; the UI
 * polls run status to confirm the cancellation took effect.
 */
router.post('/runs/:runId/cancel', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const original = await automationStore.getRun(req.params.runId);
        if (!original) return res.status(404).json({ error: 'Not found' });
        if (original.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        if (!['queued', 'running'].includes(original.status)) {
            return res.status(409).json({ error: `Run is in ${original.status} state and cannot be cancelled` });
        }
        const runner = require('../../core/automationRunner');
        const updated = await runner.requestCancel(original.id);
        return res.status(202).json({ accepted: true, run: updated || original });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/runs/:id/approve', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const run = await automationStore.getRun(req.params.id);
        if (!run) return res.status(404).json({ error: 'Not found' });
        if (run.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        if (run.status !== 'awaiting_confirm') return res.status(400).json({ error: 'Run is not awaiting confirmation' });
        const a = await automationStore.getAutomation(run.automationId);
        if (!a) return res.status(404).json({ error: 'Automation not found' });
        await automationStore.updateAutomation(a.id, { needsFirstRunConfirm: false }, userId);
        // Re-execute live (the original run remains in history as awaiting_confirm).
        const runner = require('../../core/automationRunner');
        setImmediate(async () => {
            try { await runner.executeAutomation({ ...a, needsFirstRunConfirm: false }, { triggerKind: 'manual', mode: 'live', confirmFirstRun: true }); }
            catch (e) { console.error('[automation/runs/approve] error:', e.message); }
        });
        res.json({ accepted: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * §28 — Agent-callable invocation endpoint. The agent runtime
 * dispatcher hits this when it sees an automation_<id> tool call.
 * Body: { args, callerUserId, callerSessionId }. Returns the final
 * step output verbatim so the agent can fold it back into its
 * reasoning.
 */
router.post('/:id/agent-invoke', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const automation = await automationStore.getAutomation(req.params.id);
        if (!automation) return res.status(404).json({ error: 'Automation not found' });
        if (automation.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        const trigger = automation.definition?.trigger;
        if (!trigger || trigger.kind !== 'agent_call') {
            return res.status(409).json({ error: 'Automation is not declared as agent-callable. Set trigger.kind = "agent_call".' });
        }
        if (!automation.isActive) {
            return res.status(409).json({ error: 'Automation is paused. Activate it first.' });
        }
        const args = (req.body && typeof req.body.args === 'object') ? req.body.args : {};
        const runner = require('../../core/automationRunner');
        const result = await runner.executeAutomation(automation, {
            triggerKind: 'agent_call',
            triggerPayload: args,
            mode: 'live',
        });
        res.json({ ok: true, output: result?.lastOutput ?? null });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/**
 * §14b — Webhook playground. Signs and posts a user-supplied payload
 * through the real webhook handler path (bypassing the nonce-replay
 * check via a single-use test token) and returns the full
 * request/response for display. Phase 2 lands the full implementation;
 * this is the route surface so the UI can target a stable URL.
 */
router.post('/:id/webhook/:slug/test', async (req, res) => {
    try {
        const userId = req.session.user.id;
        const automation = await automationStore.getAutomation(req.params.id);
        if (!automation) return res.status(404).json({ error: 'Not found' });
        if (automation.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
        // Phase 2: actually sign the supplied payload, dispatch through
        // the webhook ingestion path, capture the response. Until then
        // we acknowledge the endpoint so the UI can light up.
        res.json({
            accepted: true,
            playground: true,
            note: 'Webhook playground full implementation arrives in Phase 2.',
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
