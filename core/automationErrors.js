/**
 * Structured error hierarchy for the automation runner. Phase 1 lands
 * the classes and a classifier; the runner doesn't throw these yet — a
 * follow-up wires each step runner to construct typed errors so the
 * orchestrator can route on success/failure (§19), surface the class in
 * run history filters, and decide retry vs fail-fast deterministically.
 *
 * Every subclass sets a stable `code` field used as the value persisted
 * in the new `error_class` column. Don't rename the codes without a
 * corresponding data migration — they become a queryable surface for
 * the activity dashboard and alerting rules.
 *
 * The classifier (`classifyUnknownError`) converts a raw error from an
 * integration call into the closest typed sibling. Useful for the
 * transition period where most code still throws plain Error objects —
 * we can still tag the run row with the right class without rewriting
 * every call site at once.
 */

class AutomationError extends Error {
    constructor(message, opts = {}) {
        super(message);
        this.name = this.constructor.name;
        this.code = opts.code || 'AutomationError';
        this.transient = opts.transient === true;
        this.userMessage = opts.userMessage || message;
        this.cause = opts.cause || null;
    }
}

class TransientError extends AutomationError {
    constructor(message, opts = {}) {
        super(message, { transient: true, ...opts });
        this.code = 'TransientError';
    }
}

class PermissionError extends AutomationError {
    constructor(message, opts = {}) {
        super(message, opts);
        this.code = 'PermissionError';
    }
}

class IntegrationError extends AutomationError {
    constructor(message, opts = {}) {
        super(message, opts);
        this.code = 'IntegrationError';
    }
}

class ValidationError extends AutomationError {
    constructor(message, opts = {}) {
        super(message, opts);
        this.code = 'ValidationError';
    }
}

class TimeoutError extends AutomationError {
    constructor(message, opts = {}) {
        super(message, { transient: true, ...opts });
        this.code = 'TimeoutError';
    }
}

class UserCanceledError extends AutomationError {
    constructor(message, opts = {}) {
        super(message, opts);
        this.code = 'UserCanceledError';
    }
}

class ApprovalExpiredError extends AutomationError {
    constructor(message, opts = {}) {
        super(message, opts);
        this.code = 'ApprovalExpired';
    }
}

/**
 * Best-effort classification of a raw error from an integration call.
 * Returns a class code (string) suitable for persisting in
 * `error_class`. Reads:
 *   - HTTP-shaped errors (err.status / err.statusCode / err.response.status)
 *   - Node networking errors (ECONNRESET, ETIMEDOUT, EAI_AGAIN…)
 *   - Marker strings on the message
 * Falls back to 'IntegrationError' for anything that came from an
 * upstream call and 'AutomationError' for anything truly unknown.
 */
function classifyUnknownError(err) {
    if (!err) return 'AutomationError';
    if (err instanceof AutomationError && err.code) return err.code;

    const status = (
        err.status
        ?? err.statusCode
        ?? err.response?.status
        ?? null
    );
    if (status === 401 || status === 403) return 'PermissionError';
    if (status === 408 || status === 504) return 'TimeoutError';
    if (typeof status === 'number' && status >= 500) return 'TransientError';
    if (typeof status === 'number' && status >= 400) return 'IntegrationError';

    const code = err.code || err.errno || '';
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
        return 'TransientError';
    }
    if (code === 'ABORT_ERR' || err.name === 'AbortError') return 'UserCanceledError';

    const msg = String(err.message || '').toLowerCase();
    if (msg.includes('rate limit') || msg.includes('429')) return 'TransientError';
    if (msg.includes('timeout') || msg.includes('timed out')) return 'TimeoutError';
    if (msg.includes('forbidden') || msg.includes('unauthorized')) return 'PermissionError';
    if (msg.includes('validation') || msg.includes('schema')) return 'ValidationError';

    return 'IntegrationError';
}

const ALL_CODES = [
    'AutomationError',
    'TransientError',
    'PermissionError',
    'IntegrationError',
    'ValidationError',
    'TimeoutError',
    'UserCanceledError',
    'ApprovalExpired',
];

module.exports = {
    AutomationError,
    TransientError,
    PermissionError,
    IntegrationError,
    ValidationError,
    TimeoutError,
    UserCanceledError,
    ApprovalExpiredError,
    classifyUnknownError,
    ALL_CODES,
};
