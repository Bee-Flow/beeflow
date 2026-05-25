/**
 * Step input/output truncation for the run history (§13).
 *
 * The run-step rows hold the full step input + output as JSONB. Some
 * integrations (search, large attachments, sheet exports) emit
 * megabyte-scale payloads that explode database size and slow run
 * detail rendering. We cap the persisted JSON at `DEFAULT_MAX_BYTES`,
 * replace anything past the limit with a marker, and (Phase 2) push
 * the full blob to object storage when it overflows.
 *
 * Public:
 *   truncatePayload(value, opts?) → { value, truncated, originalBytes }
 *
 * Non-mutating; returns a new value tree when truncation kicks in.
 */

const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KB per payload
const TRUNCATED_MARKER = '__truncated__';

function truncatePayload(value, opts = {}) {
    const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
    let originalBytes = 0;
    let serialized;
    try {
        serialized = JSON.stringify(value);
        originalBytes = serialized ? Buffer.byteLength(serialized, 'utf8') : 0;
    } catch {
        return { value, truncated: false, originalBytes: 0 };
    }
    if (originalBytes <= maxBytes) {
        return { value, truncated: false, originalBytes };
    }
    // Replace with a marker. Keep a short head sample so the user can
    // still see the shape — the rest of the payload is dropped (Phase 2
    // pushes the full blob to object storage and embeds a link).
    const headSample = serialized.slice(0, Math.min(serialized.length, 1024));
    return {
        value: {
            [TRUNCATED_MARKER]: true,
            originalBytes,
            headSample,
        },
        truncated: true,
        originalBytes,
    };
}

module.exports = { truncatePayload, DEFAULT_MAX_BYTES, TRUNCATED_MARKER };
