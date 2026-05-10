/**
 * Content Moderation — Azure Content Safety + GLiNER PII detection.
 *
 * Single moderation path: Azure Content Safety. PII detection runs in parallel
 * via the guard-service /pii endpoint (GLiNER multi PII v1, Apache 2.0) with
 * Azure AI Text Analytics as an alternative when configured.
 */

const { getAIConfig } = require('./aiAgent');
const { validateWithAzureContentSafety, validateOutputWithAzureContentSafety } = require('./azureContentSafety');
const { validateInputForPii, validateOutputForPii } = require('./azurePiiDetection');

const DEFAULT_MODERATION_THRESHOLD = 0.7;

/**
 * Validate user input — runs Azure Content Safety + optional PII detection.
 *
 * @param {Array} messages - Chat messages array
 * @param {boolean} [agentModerationEnabled=false] - Per-agent override
 * @param {Array|null} [allowedCategories=null] - Only enforce these categories
 * @param {string|null} [_preferredProvider] - Reserved for future provider switching
 * @throws {Error} If content violates moderation policies (message starts with "Safety Violation")
 */
async function validateInput(messages, agentModerationEnabled = false, allowedCategories = null, _preferredProvider = null) {
    const aiConfig = await getAIConfig();

    const checks = [validateWithAzureContentSafety(messages, agentModerationEnabled, allowedCategories)];

    if (aiConfig.piiDetectionEnabled) {
        checks.push(validateInputForPii(messages, false));
    }

    const results = await Promise.allSettled(checks);
    for (const result of results) {
        if (result.status === 'rejected') {
            throw result.reason;
        }
    }
}

/**
 * Validate agent output — runs Azure Content Safety + optional PII detection.
 */
async function validateOutput(content, allowedCategories = null, _preferredProvider = null) {
    const aiConfig = await getAIConfig();

    const checks = [validateOutputWithAzureContentSafety(content, allowedCategories)];

    if (aiConfig.piiDetectionEnabled) {
        checks.push(validateOutputForPii(content));
    }

    const results = await Promise.allSettled(checks);
    for (const result of results) {
        if (result.status === 'rejected') {
            throw result.reason;
        }
    }
}

module.exports = {
    validateInput,
    validateOutput,
    validateInputForPii,
    validateOutputForPii,
    DEFAULT_MODERATION_THRESHOLD,
};
