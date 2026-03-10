/**
 * Browser Agent — Memory & Rolling Window
 */

function pushRecent(coordinator, msg, rollingWindowSize = 8) {
    coordinator.recentMessages.push(msg);
    // Trim to rolling window
    while (coordinator.recentMessages.length > rollingWindowSize) {
        coordinator.recentMessages.shift();
    }
}

function buildMemorySummary(coordinator) {
    const history = coordinator.actionHistory;
    if (history.length === 0) return coordinator.memorySummary;

    let summary = `Actions: ${coordinator.actionsExecuted}. `;

    // Include recent action names
    const recent = history.slice(-5).map(a => a.split(':')[0]);
    summary += `Recent: ${recent.join(' → ')}. `;

    // Include recent tool outcomes deterministically (critical for avoiding repeat failures)
    const toolOutcomes = coordinator.recentMessages
        .filter(m => m.role === 'tool' && m.content)
        .slice(-3)
        .map(m => {
            try {
                const parsed = JSON.parse(m.content);
                if (parsed.error) return `FAILED: ${parsed.error.slice(0, 80)}`;
                if (parsed.text) return `Extracted ${parsed.charCount || parsed.text.length} chars`;
                if (parsed.success && parsed.url) return `OK → ${parsed.url}`;
                if (parsed.success) return 'OK';
                return null;
            } catch { return null; }
        })
        .filter(Boolean);

    if (toolOutcomes.length > 0) {
        summary += `Outcomes: ${toolOutcomes.join('; ')}`;
    }

    // Keep bounded
    if (summary.length > 400) summary = summary.slice(-400);
    return summary;
}

module.exports = { pushRecent, buildMemorySummary };
