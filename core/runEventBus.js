/**
 * In-process event bus for automation run lifecycle (§10 scaffolding).
 *
 * Emits structured events the SSE per-run route (`/runs/:id/stream`)
 * and the activity dashboard's org stream subscribe to. Phase 2 wires
 * the runner itself to publish; until then this module is import-safe
 * — nothing fires events yet, but consumers can already subscribe and
 * the contract is fixed.
 *
 * Events:
 *   run.started        { runId, automationId, triggerKind }
 *   run.finished       { runId, automationId, status, durationMs }
 *   run.failed         { runId, automationId, errorClass, error }
 *   step.started       { runId, stepId, stepType }
 *   step.finished      { runId, stepId, status, durationMs }
 *   step.heartbeat     { runId, stepId, at } — emitted every <30s while running
 *
 * Single Node EventEmitter is fine for now; once multi-pod fan-out is
 * needed it'll be backed by Postgres LISTEN/NOTIFY (the public API
 * stays the same — `on(event, handler)`).
 */

const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(200); // SSE clients add up; raise the cap

function emitRunEvent(type, payload) {
    bus.emit(type, { type, at: new Date().toISOString(), ...payload });
}

function onRunEvent(type, handler) {
    bus.on(type, handler);
    return () => bus.off(type, handler);
}

function onAny(handler) {
    const wrap = (type) => (payload) => handler(payload);
    const types = ['run.started', 'run.finished', 'run.failed', 'step.started', 'step.finished', 'step.heartbeat'];
    const wrappers = types.map(t => {
        const w = wrap(t);
        bus.on(t, w);
        return [t, w];
    });
    return () => { for (const [t, w] of wrappers) bus.off(t, w); };
}

module.exports = { emitRunEvent, onRunEvent, onAny };
