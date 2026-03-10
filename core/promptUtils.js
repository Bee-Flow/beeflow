/**
 * Shared prompt utilities — no dependencies on agentRuntime or other heavy modules.
 * This avoids circular dependency issues when browser/ modules need prompt processing.
 */

// Process dynamic tags in system prompt
function processSystemPrompt(prompt) {
    if (!prompt) return prompt;

    const now = new Date();

    // {Date} -> Unambiguous Date String (e.g. "Tuesday, February 10, 2026")
    const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    let processed = prompt.replace(/{Date}/g, now.toLocaleDateString('en-US', dateOptions));

    // {Time} -> Local Time String (e.g. "4:08:12 PM")
    processed = processed.replace(/{Time}/g, now.toLocaleTimeString('en-US'));

    // {DateTime} -> Local Date & Time String (e.g. "2/10/2026, 4:08:12 PM")
    const dateTimeOptions = { ...dateOptions, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: true };
    processed = processed.replace(/{DateTime}/g, now.toLocaleString('en-US', dateTimeOptions));

    return processed;
}

module.exports = { processSystemPrompt };
