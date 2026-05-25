/**
 * Trigger sample vault (§4b scaffolding).
 *
 * Lets users pin a captured trigger payload for an automation so they
 * can iterate on settings without re-firing the upstream event. The
 * StepInspector's Inputs tab (Phase 1) saves to scopedStorage today; a
 * Phase 2 follow-up wires those reads through this module so samples
 * follow the automation across users/devices.
 *
 * Tables (see automation-sample-vault-2026-06 migration):
 *   automation_trigger_samples (id, automation_id, trigger_id, label,
 *                               payload jsonb, pinned_by, created_at)
 *
 * Public:
 *   listSamples(automationId, triggerId?) → row[]
 *   pinSample({ automationId, triggerId, label, payload, userId })
 *   removeSample(id)
 *   replaySample(id) — re-fires the captured payload through triggerBus
 *
 * Phase 2 implements the DB-backed body; the module exists today so
 * frontend / route work can target a stable surface.
 */

const crypto = require('crypto');

async function listSamples(/* automationId, triggerId */) {
    return [];
}

async function pinSample(/* { automationId, triggerId, label, payload, userId } */) {
    return {
        id: crypto.randomBytes(8).toString('hex'),
        createdAt: new Date().toISOString(),
    };
}

async function removeSample(/* id */) {
    return false;
}

async function replaySample(/* id */) {
    return { dispatched: false };
}

module.exports = { listSamples, pinSample, removeSample, replaySample };
