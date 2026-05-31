/**
 * Nextcloud-aware error classifier — pure, no I/O.
 *
 * Turns a raw Nextcloud failure (a thrown Error, or the string from a soft
 * `{ error }` tool result) into a human-readable, actionable shape:
 *
 *   { code, category, message, remediation, errorClass }
 *
 * This is SURFACING ONLY. It never changes how Nextcloud connects or how
 * auth is resolved — it just reads whatever error already bubbled up and
 * produces a friendlier message plus a queryable `errorClass` that maps to
 * the existing automationErrors hierarchy (so the `error_class` column and
 * the run-facets dashboard get a consistent value without a new vocabulary).
 *
 * Used by:
 *   - automationRunner.execIntegrationAction (enrich the thrown message)
 *   - automationStore.rowToRunStep (derive remediation for legacy rows)
 *   - routes/automation.js diagnose-trigger (recent-match probe failures)
 */

/**
 * Pull an HTTP status out of the error text. The Nextcloud client throws in
 * a few shapes, e.g. "Nextcloud download failed (409)" or "... failed: 401".
 */
function extractHttpStatus(text) {
    const s = String(text || '');
    const paren = s.match(/\((\d{3})\)/);
    if (paren) return Number(paren[1]);
    const failed = s.match(/failed:\s*(\d{3})\b/i);
    if (failed) return Number(failed[1]);
    const bare = s.match(/\b(4\d{2}|5\d{2})\b/);
    if (bare) return Number(bare[1]);
    return null;
}

/**
 * @param {Error|string|{error:string}} input
 * @returns {{code:string, category:string, message:string, remediation:string, errorClass:string}}
 */
function classifyNextcloudError(input) {
    // Normalise to a single text blob we can pattern-match on.
    let text = '';
    if (input == null) {
        text = '';
    } else if (typeof input === 'string') {
        text = input;
    } else if (input instanceof Error) {
        text = input.message || String(input);
    } else if (typeof input === 'object') {
        text = String(input.error || input.message || '');
    } else {
        text = String(input);
    }
    const lower = text.toLowerCase();
    const status = extractHttpStatus(text);

    const make = (code, category, errorClass, message, remediation) => ({
        code, category, errorClass, message, remediation,
    });

    // Order matters: most specific first.
    if (/not_connected|not connected|no nextcloud (account|connection)/i.test(text)) {
        return make('NOT_CONNECTED', 'auth', 'PermissionError',
            'Nextcloud is not connected for this account.',
            'Reconnect Nextcloud in Settings → Integrations.');
    }
    if (status === 401 || /session expired|re-?authenticate|token (refresh|expired)|sign-?in (has )?expired|unauthorized/i.test(lower)) {
        return make('SESSION_EXPIRED', 'auth', 'PermissionError',
            'Your Nextcloud session has expired.',
            'Reconnect Nextcloud in Settings → Integrations, then re-run.');
    }
    if (/could not reach nextcloud|exapp|connector (did not|didn'?t) respond|connector (is )?(down|unreachable)/i.test(lower)) {
        return make('CONNECTOR_UNREACHABLE', 'connector', 'TimeoutError',
            'The Bee Flow connector could not reach Nextcloud.',
            'Make sure the Bee Flow ExApp is enabled and Nextcloud is reachable, then retry.');
    }
    if (status === 429 || status === 503 || /rate limit|too many requests/i.test(lower)) {
        return make('THROTTLED', 'transient', 'TransientError',
            'Nextcloud is rate-limiting requests.',
            'This is temporary — the routine will retry automatically.');
    }
    if (/timeout|timed out|aborted/i.test(lower) || status === 408 || status === 504) {
        return make('TIMEOUT', 'transient', 'TimeoutError',
            'Nextcloud did not respond in time.',
            'This looks transient — retry; if it persists Nextcloud may be overloaded.');
    }
    if (status === 409 || /\bparent\b|\bcollection\b|already exists|conflict/i.test(lower)) {
        return make('PARENT_MISSING', 'precondition', 'IntegrationError',
            'The target location could not be created or already exists.',
            'Check the parent folder exists (create it first) or fix the path.');
    }
    if (status === 403 || /not enabled|permission|forbidden|cors/i.test(lower)) {
        return make('APP_DISABLED', 'permission', 'PermissionError',
            'This Nextcloud app is not enabled for your account, or needs an app password.',
            'Ask your admin to enable the app (Notes/Deck may need an app password), then retry.');
    }
    if (status === 404 || /not found/i.test(lower)) {
        return make('NOT_FOUND', 'precondition', 'IntegrationError',
            'The target file, board, or room was not found.',
            'Check the path / board id / room token used in the step.');
    }
    if (/is required|required field|missing (required )?(param|field|input)|validation|schema/i.test(lower)) {
        return make('MISSING_FIELD', 'validation', 'ValidationError',
            'A required field is empty or invalid.',
            'Open the step and fill the highlighted input (e.g. a Talk room token).');
    }

    return make('UNKNOWN', 'unknown', 'IntegrationError',
        text || 'The Nextcloud step failed.',
        'Open run history for the raw error detail.');
}

/**
 * Convenience: a single enriched sentence "message — remediation" suitable
 * for the thrown Error message that gets persisted to run history.
 */
function toHumanError(rawError) {
    const c = classifyNextcloudError(rawError);
    return `${c.message} — ${c.remediation}`;
}

module.exports = {
    classifyNextcloudError,
    toHumanError,
    extractHttpStatus,
};
