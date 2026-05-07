/**
 * Pre-LLM phase events.
 *
 * Each chat runtime opens an SSE stream and writes events with its own
 * `send(event, data)` helper (or in the streaming agent path, a
 * `onEvent(type, data)` callback). These helpers wrap that emitter so a
 * single `phase` event format flows through to the UI:
 *
 *   { stage, status: 'start' | 'end', detail?, durationMs? }
 *
 * The UI uses these to render a status line ("Reading attachment…",
 * "Searching knowledge base…") above the typing dots so users see what is
 * happening during the seconds before the first LLM token streams.
 */

function emitPhase(send, stage, detail) {
    if (typeof send !== 'function' || !stage) return;
    try {
        send('phase', { stage, status: 'start', detail: detail || undefined });
    } catch (_) { /* never block the chat on telemetry failures */ }
}

function emitPhaseEnd(send, stage, durationMs) {
    if (typeof send !== 'function' || !stage) return;
    try {
        send('phase', { stage, status: 'end', durationMs: Number.isFinite(durationMs) ? durationMs : undefined });
    } catch (_) { /* swallow */ }
}

async function withPhase(send, stage, detail, fn) {
    emitPhase(send, stage, detail);
    const t = Date.now();
    try {
        return await fn();
    } finally {
        emitPhaseEnd(send, stage, Date.now() - t);
    }
}

module.exports = { emitPhase, emitPhaseEnd, withPhase };
