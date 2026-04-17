/**
 * Browser Agent Loop — stub.
 *
 * The real implementation is in progress (see chrome-extension/background/
 * and server/routes/browserAgent.js which consumes this module). Until it
 * lands, this stub keeps the server from crashing on require while surfacing
 * a clear error to anyone who actually hits the /api/browser-agent/run
 * endpoint.
 */

async function runBrowserAgentLoop(_opts) {
    throw new Error(
        'Browser agent loop is not yet implemented on this server. ' +
        'server/agents/browserAgentLoop.js is a stub — the real loop still needs to be wired up.'
    );
}

module.exports = { runBrowserAgentLoop };
