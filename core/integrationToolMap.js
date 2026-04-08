/**
 * Integration Tool Map — Maps tool names to their integration metadata.
 *
 * This centralized mapping identifies which tools are "external integrations"
 * and records the server/endpoint they connect to, the data direction,
 * and what categories of data they typically handle.
 *
 * Used by the tool dispatcher in chatStream.js / directChat.js to decide
 * whether a tool call should be logged in the integration_activity_log.
 */

const INTEGRATION_TOOL_MAP = {
    // ── Email ────────────────────────────────────────────────
    send_email: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'smtp/imap',
        direction: 'sent',
        dataCategories: 'email_content, recipients, subject',
    },
    read_emails: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'imap',
        direction: 'received',
        dataCategories: 'email_content, senders, subject',
    },
    search_emails: {
        integration: 'email',
        label: 'Email',
        serverFn: (args) => args?.provider === 'microsoft' ? 'graph.microsoft.com' : 'imap',
        direction: 'both',
        dataCategories: 'email_content, search_query',
    },

    // ── Calendar ─────────────────────────────────────────────
    read_calendar: {
        integration: 'calendar',
        label: 'Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'received',
        dataCategories: 'calendar_events, attendees, organizer',
    },
    create_calendar_event: {
        integration: 'calendar',
        label: 'Calendar',
        serverFn: () => 'graph.microsoft.com',
        direction: 'sent',
        dataCategories: 'calendar_events, attendees, location',
    },

    // ── Web Search ───────────────────────────────────────────
    agent_search: {
        integration: 'web_search',
        label: 'Web Search',
        serverFn: () => 'api.serper.dev (Google Search)',
        direction: 'sent',
        dataCategories: 'search_query',
    },

    // ── Maps / Places ────────────────────────────────────────
    search_maps: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'location_query, coordinates',
    },
    get_directions: {
        integration: 'maps',
        label: 'Google Maps',
        serverFn: () => 'maps.googleapis.com',
        direction: 'both',
        dataCategories: 'addresses, coordinates',
    },

    // ── n8n Workflows ────────────────────────────────────────
    n8n_execute: {
        integration: 'n8n',
        label: 'n8n Workflow',
        serverFn: (args, ctx) => ctx?.n8nUrl || 'n8n-server (configured)',
        direction: 'both',
        dataCategories: 'workflow_payload',
    },

    // ── MCP (Model Context Protocol) ─────────────────────────
    // MCP tools are dynamic — handled via a pattern match
};

// PII category descriptions for data sovereignty reports
const PII_CATEGORIES = [
    'Person Name', 'Email Address', 'Phone Number', 'Physical Address',
    'Credit Card', 'Bank Account', 'IBAN', 'SSN', 'Passport Number',
    'IP Address', 'URL', "Driver's License", 'EU National ID / BSN',
];

/**
 * Resolve tool metadata for logging.
 *
 * @param {string} toolName - The tool_name from the function call
 * @param {object} toolArgs - The arguments passed to the tool
 * @param {object} ctx - Runtime context (n8n URL, MCP config, etc.)
 * @returns {object|null} { integration, label, server, direction, dataCategories } or null for non-integration tools
 */
function resolveIntegration(toolName, toolArgs = {}, ctx = {}) {
    // Direct match
    const mapped = INTEGRATION_TOOL_MAP[toolName];
    if (mapped) {
        return {
            integration: mapped.integration,
            label: mapped.label,
            server: typeof mapped.serverFn === 'function' ? mapped.serverFn(toolArgs, ctx) : mapped.serverFn,
            direction: mapped.direction,
            dataCategories: mapped.dataCategories,
        };
    }

    // MCP tool pattern: mcp__<server>__<tool>
    if (toolName?.startsWith('mcp__') || toolName?.startsWith('mcp_')) {
        const parts = toolName.split('__');
        const mcpServer = parts[1] || 'unknown';
        return {
            integration: 'mcp',
            label: `MCP: ${mcpServer}`,
            server: ctx?.mcpEndpoint || `mcp-server://${mcpServer}`,
            direction: 'both',
            dataCategories: 'mcp_payload',
        };
    }

    // n8n dynamic tools (prefixed)
    if (toolName?.startsWith('n8n_')) {
        return {
            integration: 'n8n',
            label: 'n8n Workflow',
            server: ctx?.n8nUrl || 'n8n-server',
            direction: 'both',
            dataCategories: 'workflow_payload',
        };
    }

    // Not an external integration tool
    return null;
}

module.exports = {
    INTEGRATION_TOOL_MAP,
    PII_CATEGORIES,
    resolveIntegration,
};
