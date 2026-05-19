/**
 * Content Moderation — PII detection only.
 *
 * Hate / Violence / Sexual / Self-Harm content moderation was removed when
 * the only working backend (Azure Content Safety) was dropped. The
 * `validateInput` / `validateOutput` exports remain so existing callers
 * keep working; they now run only PII detection (when enabled).
 *
 * Re-introducing content moderation later means writing a new provider
 * integration from scratch and re-adding the dispatch here.
 */

const { getAIConfig } = require('./aiAgent');
const { validateInputForPii, validateOutputForPii } = require('./piiDetection');

const DEFAULT_MODERATION_THRESHOLD = 0.7;

/**
 * Validate user input — runs PII detection when enabled.
 *
 * @param {Array} messages - Chat messages array
 * @param {boolean} [_agentModerationEnabled=false] - Reserved (legacy callers still pass it)
 * @param {Array|null} [_allowedCategories=null] - Reserved (legacy moderation categories)
 * @throws {Error} If PII is detected and the shield action is 'block'.
 */
async function validateInput(messages, _agentModerationEnabled = false, _allowedCategories = null) {
    const aiConfig = await getAIConfig();
    if (!aiConfig.piiDetectionEnabled) return;
    await validateInputForPii(messages, false);
}

/**
 * Validate agent output — runs PII detection when enabled.
 */
async function validateOutput(content, _allowedCategories = null) {
    const aiConfig = await getAIConfig();
    if (!aiConfig.piiDetectionEnabled) return;
    await validateOutputForPii(content);
}

module.exports = {
    validateInput,
    validateOutput,
    validateInputForPii,
    validateOutputForPii,
    DEFAULT_MODERATION_THRESHOLD,
};
