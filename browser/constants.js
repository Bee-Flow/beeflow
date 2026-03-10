/**
 * Browser Agent — Default Constants & Action Normalization
 */

const DEFAULTS = {
    rollingWindowSize: 8,
    replanAfterErrors: 2,
    replanAfterStale: 3,
    maxRetriesPerAction: 1,
    memorySummaryInterval: 3,
    actionBatchSize: 5,
    plannerEnabled: true,
    loopDetection: true,
    retryEscalation: true,
    maxMilestones: 6
};

// Per-action timeouts (ms) — short for interactive, long for navigation
const ACTION_TIMEOUTS = {
    click: 5000,
    type_text: 5000,
    press_key: 2000,
    scroll: 1500,
    observe: 5000,
    extract_text: 15000,
    navigate: 45000,
    take_screenshot: 8000,
    wait: 15000,
    go_back: 20000
};

// Valid action names, used for normalization of malformed LLM output
const VALID_ACTIONS = new Set(['navigate', 'click', 'type_text', 'scroll', 'extract_text',
    'observe', 'take_screenshot', 'wait', 'go_back', 'done', 'press_key']);

// Actions that change the page and warrant an observation afterwards
const PAGE_CHANGING_ACTIONS = new Set(['navigate', 'click', 'type_text', 'scroll', 'go_back', 'press_key']);

function normalizeActionName(raw) {
    if (!raw) return null;
    if (VALID_ACTIONS.has(raw)) return raw;
    // Recovery: find any known tool name as substring (longest match first)
    const sorted = [...VALID_ACTIONS].sort((a, b) => b.length - a.length);
    for (const name of sorted) {
        if (raw.includes(name)) {
            console.log(`[BrowserAgent] Normalized malformed action name "${raw}" → "${name}"`);
            return name;
        }
    }
    return null;
}

module.exports = {
    DEFAULTS,
    ACTION_TIMEOUTS,
    VALID_ACTIONS,
    PAGE_CHANGING_ACTIONS,
    normalizeActionName
};
