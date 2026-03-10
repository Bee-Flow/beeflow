/**
 * Sanitization Utility
 * Redacts sensitive fields from objects before sending to client
 */

// Field names that should be redacted (case-insensitive partial match)
const SENSITIVE_PATTERNS = [
    'apikey',
    'api_key',
    'accesstoken',
    'access_token',
    'password',
    'secret',
    'bearer',
    'authorization',
    'auth_token',
    'authtoken',
    'private_key',
    'privatekey',
    'credential',
    'apppassword',
    'app_password'
];

// Redaction placeholder
const REDACTED = '[REDACTED]';

/**
 * Check if a field name matches any sensitive pattern
 * @param {string} fieldName - The field name to check
 * @returns {boolean}
 */
function isSensitiveField(fieldName) {
    if (!fieldName || typeof fieldName !== 'string') return false;
    const lower = fieldName.toLowerCase();
    return SENSITIVE_PATTERNS.some(pattern => lower.includes(pattern));
}

/**
 * Recursively sanitize an object, redacting sensitive fields
 * @param {any} obj - The object to sanitize
 * @param {number} depth - Current recursion depth (prevents infinite loops)
 * @returns {any} - Sanitized copy of the object
 */
function sanitize(obj, depth = 0) {
    // Prevent infinite recursion
    if (depth > 20) return obj;

    // Handle null/undefined
    if (obj === null || obj === undefined) return obj;

    // Handle primitives
    if (typeof obj !== 'object') return obj;

    // Handle arrays
    if (Array.isArray(obj)) {
        return obj.map(item => sanitize(item, depth + 1));
    }

    // Handle objects
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
        if (isSensitiveField(key)) {
            // Redact sensitive fields
            sanitized[key] = REDACTED;
        } else if (typeof value === 'object' && value !== null) {
            // Recursively sanitize nested objects
            sanitized[key] = sanitize(value, depth + 1);
        } else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

/**
 * Sanitize tool results before sending to client
 * @param {any} result - Tool execution result
 * @returns {any} - Sanitized result
 */
function sanitizeToolResult(result) {
    return sanitize(result);
}

module.exports = {
    sanitize,
    sanitizeToolResult,
    isSensitiveField,
    SENSITIVE_PATTERNS,
    REDACTED
};
