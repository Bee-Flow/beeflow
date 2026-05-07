/**
 * Error sanitizer for the termination monitor.
 *
 * Privacy contract: only emit metadata. Never let user/assistant/tool content,
 * request bodies, or response bodies leak through. Operate on the assumption
 * that error messages from upstream APIs may have a payload echo prefixed
 * (e.g. "API error 400: { ... }") and aggressively trim those.
 */

const HOME_PATH_RE = new RegExp(process.env.HOME ? process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '__no_home__', 'g');

const ERROR_FIRST_LINE_MAX = 200;
const STACK_LINE_MAX = 200;
const JSON_LIKE_RE = /[{\[][\s\S]{40,}/;       // JSON/array starting after some preamble
const QUOTED_LONG_RE = /(["']).{80,}/;          // long quoted strings (likely user content)

/**
 * Map a raw error to a coarse, privacy-safe code.
 * Mirrors classifyStreamError() in chatStream.js but always returns a code,
 * even for unknown errors.
 */
function classifyErrorCode(err) {
    if (!err) return 'unknown';
    const msg = String(err.message || '');
    const status = err.status || err.statusCode || null;
    const httpMatch = msg.match(/API error (\d+)/);
    const httpStatus = status || (httpMatch ? parseInt(httpMatch[1], 10) : null);

    if (err.name === 'AbortError' || /aborted/i.test(msg)) return 'aborted';
    if (err instanceof TypeError && /network|fetch|ECONNRESET|ETIMEDOUT/i.test(msg)) return 'network';
    if (/timed out|TimeoutError/i.test(msg) || err.name === 'TimeoutError') return 'timeout';
    if (/overloaded/i.test(msg) || err.error?.type === 'overloaded_error' || httpStatus === 529) return 'overloaded';
    if (httpStatus === 429) return 'rate_limit';
    if (httpStatus === 401 || httpStatus === 403 || /api[_ ]?key|unauthori[sz]ed|forbidden/i.test(msg)) return 'auth';
    if (httpStatus === 413) return 'payload_too_large';
    if (httpStatus === 400) return 'bad_request';
    if (httpStatus && httpStatus >= 500) return 'server';
    if (/tool/i.test(msg) && /error|failed/i.test(msg)) return 'tool_error';
    if (httpStatus && httpStatus >= 400) return 'provider_error';
    return 'internal';
}

function sanitizeMessageLine(text) {
    if (!text) return null;
    let line = String(text).split('\n')[0].trim();
    // Strip common upstream payload echoes: "API error 400: <body>"
    line = line.replace(/(API error \d+:\s*).*$/i, '$1<redacted>');
    // Strip JSON/array bodies
    if (JSON_LIKE_RE.test(line)) {
        line = line.replace(JSON_LIKE_RE, '<redacted-payload>');
    }
    // Strip long quoted strings (likely user content)
    if (QUOTED_LONG_RE.test(line)) {
        line = line.replace(QUOTED_LONG_RE, '<redacted-quoted>');
    }
    if (line.length > ERROR_FIRST_LINE_MAX) {
        line = line.slice(0, ERROR_FIRST_LINE_MAX) + '…';
    }
    return line || null;
}

function firstStackLine(err) {
    if (!err?.stack) return null;
    const lines = String(err.stack).split('\n');
    // Skip the first line (which is the error message itself, possibly with content)
    for (let i = 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('at ')) {
            let scrubbed = trimmed;
            if (process.env.HOME) {
                scrubbed = scrubbed.replace(HOME_PATH_RE, '~');
            }
            // Defensive: also strip anything that looks like JSON in a stack frame
            scrubbed = scrubbed.replace(JSON_LIKE_RE, '<redacted>');
            if (scrubbed.length > STACK_LINE_MAX) {
                scrubbed = scrubbed.slice(0, STACK_LINE_MAX) + '…';
            }
            return scrubbed;
        }
    }
    return null;
}

/**
 * sanitizeError(err) → { error_code, error_class, error_first_line, stack_first_line }
 *
 * The output is the only thing that should be persisted about a failure.
 * Never persist err.message, err.stack, err.cause, err.response, etc. directly.
 */
function sanitizeError(err) {
    if (!err) {
        return {
            error_code: 'unknown',
            error_class: null,
            error_first_line: null,
            stack_first_line: null,
        };
    }
    return {
        error_code: classifyErrorCode(err),
        error_class: err?.constructor?.name || (err.name ? String(err.name) : null),
        error_first_line: sanitizeMessageLine(err.message),
        stack_first_line: firstStackLine(err),
    };
}

module.exports = { sanitizeError, classifyErrorCode };
