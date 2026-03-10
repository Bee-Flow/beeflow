/**
 * Browser Agent — Loop Detection
 */

function detectLoop(history) {
    if (history.length < 4) return false;

    const len = history.length;

    // 1. Exact match: last 2 actions identical to the 2 before them
    if (history[len - 1] === history[len - 3] && history[len - 2] === history[len - 4]) {
        return true;
    }

    // 2. Exact match: last 3 actions are all the same
    if (history[len - 1] === history[len - 2] && history[len - 2] === history[len - 3]) {
        return true;
    }

    // 3. Action-name pattern loop (catches scroll+extract with varying args)
    //    Extract just the action names and check if a 2-action pattern repeats 3+ times
    if (history.length >= 6) {
        const names = history.map(h => h.split(':')[0]);
        const lastN = names.slice(-6);
        // Check for 2-action repeating pattern: [A, B, A, B, A, B]
        if (lastN[0] === lastN[2] && lastN[2] === lastN[4] &&
            lastN[1] === lastN[3] && lastN[3] === lastN[5]) {
            return true;
        }
    }

    return false;
}

module.exports = { detectLoop };
