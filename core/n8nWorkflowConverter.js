/**
 * n8n Workflow → Markdown Converter
 * 
 * Converts an n8n workflow JSON export into a well-structured Markdown document
 * suitable for KB ingestion and AI retrieval (RAG).
 * 
 * The output describes the workflow's purpose, nodes, configuration,
 * and data flow in human-readable form — optimised for embedding & search.
 */

// ── Friendly node type mappings ─────────────────────────────────────

const NODE_TYPE_LABELS = {
    'n8n-nodes-base.webhook': 'Webhook Trigger',
    'n8n-nodes-base.httpRequest': 'HTTP Request',
    'n8n-nodes-base.if': 'IF Condition',
    'n8n-nodes-base.switch': 'Switch',
    'n8n-nodes-base.set': 'Set Values',
    'n8n-nodes-base.code': 'Code (JavaScript)',
    'n8n-nodes-base.function': 'Function',
    'n8n-nodes-base.functionItem': 'Function Item',
    'n8n-nodes-base.noOp': 'No Operation',
    'n8n-nodes-base.respondToWebhook': 'Respond to Webhook',
    'n8n-nodes-base.merge': 'Merge',
    'n8n-nodes-base.splitInBatches': 'Split in Batches',
    'n8n-nodes-base.wait': 'Wait',
    'n8n-nodes-base.cron': 'Cron Schedule Trigger',
    'n8n-nodes-base.scheduleTrigger': 'Schedule Trigger',
    'n8n-nodes-base.manualTrigger': 'Manual Trigger',
    'n8n-nodes-base.errorTrigger': 'Error Trigger',
    'n8n-nodes-base.emailSend': 'Send Email',
    'n8n-nodes-base.emailReadImap': 'Read Email (IMAP)',
    'n8n-nodes-base.slack': 'Slack',
    'n8n-nodes-base.telegram': 'Telegram',
    'n8n-nodes-base.discord': 'Discord',
    'n8n-nodes-base.googleSheets': 'Google Sheets',
    'n8n-nodes-base.googleDrive': 'Google Drive',
    'n8n-nodes-base.gmail': 'Gmail',
    'n8n-nodes-base.airtable': 'Airtable',
    'n8n-nodes-base.notion': 'Notion',
    'n8n-nodes-base.hubspot': 'HubSpot',
    'n8n-nodes-base.salesforce': 'Salesforce',
    'n8n-nodes-base.postgres': 'PostgreSQL',
    'n8n-nodes-base.mysql': 'MySQL',
    'n8n-nodes-base.mongoDb': 'MongoDB',
    'n8n-nodes-base.redis': 'Redis',
    'n8n-nodes-base.openAi': 'OpenAI',
    'n8n-nodes-base.xml': 'XML',
    'n8n-nodes-base.html': 'HTML Extract',
    'n8n-nodes-base.markdown': 'Markdown',
    'n8n-nodes-base.crypto': 'Crypto',
    'n8n-nodes-base.dateTime': 'Date & Time',
    'n8n-nodes-base.itemLists': 'Item Lists',
    'n8n-nodes-base.spreadsheetFile': 'Spreadsheet File',
    'n8n-nodes-base.writeBinaryFile': 'Write Binary File',
    'n8n-nodes-base.readBinaryFile': 'Read Binary File',
    'n8n-nodes-base.executeCommand': 'Execute Command',
    'n8n-nodes-base.executeWorkflow': 'Execute Workflow',
    'n8n-nodes-base.stickyNote': 'Sticky Note',
};

/**
 * Get a human-readable label for an n8n node type.
 */
function getNodeLabel(type) {
    if (NODE_TYPE_LABELS[type]) return NODE_TYPE_LABELS[type];
    // Handle community / custom nodes: "n8n-nodes-base.fooBar" → "Foo Bar"
    const shortType = type.split('.').pop() || type;
    return shortType
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, s => s.toUpperCase())
        .trim();
}

/**
 * Identify the trigger node(s) in a workflow.
 */
function getTriggerNodes(nodes) {
    return (nodes || []).filter(n =>
        n.type?.includes('Trigger') ||
        n.type?.includes('trigger') ||
        n.type === 'n8n-nodes-base.webhook' ||
        n.type === 'n8n-nodes-base.cron' ||
        n.type === 'n8n-nodes-base.manualTrigger'
    );
}

/**
 * Build a simplified flow path from connections.
 * Returns an array of node-name sequences like:
 *   ["Webhook", "IF", "HTTP Request", "Respond to Webhook"]
 */
function traceFlowPaths(nodes, connections) {
    if (!connections || !nodes?.length) return [];

    const nodeMap = {};
    for (const n of nodes) nodeMap[n.name] = n;

    // Find start nodes (trigger nodes, or nodes not targeted by any connection)
    const targetedNames = new Set();
    for (const srcName of Object.keys(connections)) {
        const outputs = connections[srcName]?.main || [];
        for (const outputArr of outputs) {
            if (!Array.isArray(outputArr)) continue;
            for (const conn of outputArr) {
                if (conn.node) targetedNames.add(conn.node);
            }
        }
    }

    const triggers = getTriggerNodes(nodes);
    const startNames = triggers.length > 0
        ? triggers.map(t => t.name)
        : nodes.filter(n => !targetedNames.has(n.name) && n.type !== 'n8n-nodes-base.stickyNote').map(n => n.name);

    // BFS from each start node
    const paths = [];
    for (const startName of startNames) {
        const path = [];
        const visited = new Set();
        const queue = [startName];
        while (queue.length > 0) {
            const name = queue.shift();
            if (visited.has(name)) continue;
            visited.add(name);
            const node = nodeMap[name];
            if (node && node.type !== 'n8n-nodes-base.stickyNote') {
                path.push(node.name);
            }
            // Follow connections
            const outputs = connections[name]?.main || [];
            for (const outputArr of outputs) {
                if (!Array.isArray(outputArr)) continue;
                for (const conn of outputArr) {
                    if (conn.node && !visited.has(conn.node)) {
                        queue.push(conn.node);
                    }
                }
            }
        }
        if (path.length > 0) paths.push(path);
    }

    return paths;
}

/**
 * Extract key parameters from a node, excluding sensitive/internal fields.
 */
function extractKeyParams(node) {
    const params = node.parameters || {};
    const SKIP_KEYS = new Set([
        'options', 'additionalFields', 'headerParametersJson',
        'authentication', 'credentials', 'credential',
    ]);
    const entries = [];

    for (const [key, value] of Object.entries(params)) {
        if (SKIP_KEYS.has(key)) continue;
        if (key.toLowerCase().includes('credential')) continue;
        if (key.toLowerCase().includes('password')) continue;
        if (key.toLowerCase().includes('secret')) continue;
        if (key.toLowerCase().includes('token')) continue;
        if (typeof value === 'object' && value !== null) continue; // skip nested objects
        if (typeof value === 'string' && value.length > 200) continue; // skip very long values (code blocks etc)
        entries.push({ key, value });
    }

    return entries;
}

// ── Main converter ──────────────────────────────────────────────────

/**
 * Convert an n8n workflow JSON object into a structured Markdown document.
 * 
 * @param {Object} workflow - The n8n workflow JSON (from API or export file)
 * @returns {string} Markdown string
 */
function convertN8nWorkflowToMarkdown(workflow) {
    const name = workflow.name || 'Untitled Workflow';
    const nodes = workflow.nodes || [];
    const connections = workflow.connections || {};
    const active = workflow.active !== false;
    const tags = (workflow.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean);

    // Filter out sticky notes for counting
    const actionNodes = nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote' && n.disabled !== true);
    const triggers = getTriggerNodes(actionNodes);
    const triggerLabel = triggers.length > 0
        ? triggers.map(t => getNodeLabel(t.type)).join(', ')
        : 'Unknown';

    const lines = [];

    // ── Header ────────────────────────────────────────────────────
    lines.push(`# n8n Workflow: ${name}`);
    lines.push('');
    lines.push(`| Property | Value |`);
    lines.push(`|----------|-------|`);
    lines.push(`| **Status** | ${active ? '✅ Active' : '⏸️ Inactive'} |`);
    lines.push(`| **Trigger** | ${triggerLabel} |`);
    lines.push(`| **Nodes** | ${actionNodes.length} |`);
    if (workflow.id) lines.push(`| **Workflow ID** | ${workflow.id} |`);
    if (tags.length > 0) lines.push(`| **Tags** | ${tags.join(', ')} |`);
    lines.push('');

    // ── Sticky notes as description ───────────────────────────────
    const stickyNotes = nodes.filter(n => n.type === 'n8n-nodes-base.stickyNote');
    if (stickyNotes.length > 0) {
        lines.push('## Workflow Notes');
        lines.push('');
        for (const note of stickyNotes) {
            const content = note.parameters?.content || '';
            if (content.trim()) {
                lines.push(`> ${content.replace(/\n/g, '\n> ')}`);
                lines.push('');
            }
        }
    }

    // ── Data Flow ─────────────────────────────────────────────────
    const flowPaths = traceFlowPaths(nodes, connections);
    if (flowPaths.length > 0) {
        lines.push('## Data Flow');
        lines.push('');
        for (const path of flowPaths) {
            lines.push(`\`${path.join(' → ')}\``);
            lines.push('');
        }
    }

    // ── Node Details ──────────────────────────────────────────────
    lines.push('## Nodes');
    lines.push('');

    for (let i = 0; i < actionNodes.length; i++) {
        const node = actionNodes[i];
        const label = getNodeLabel(node.type);
        const nodeName = node.name || label;

        lines.push(`### ${i + 1}. ${nodeName}`);
        lines.push('');
        lines.push(`- **Type**: ${label} (\`${node.type}\`)`);
        if (node.disabled) lines.push(`- **Status**: Disabled`);

        // Key parameters
        const params = extractKeyParams(node);
        if (params.length > 0) {
            lines.push(`- **Configuration**:`);
            for (const { key, value } of params) {
                lines.push(`  - ${key}: \`${value}\``);
            }
        }

        // Webhook-specific info
        if (node.type === 'n8n-nodes-base.webhook') {
            const webhookPath = node.parameters?.path || '';
            const method = node.parameters?.httpMethod || 'POST';
            if (webhookPath) {
                lines.push(`- **Endpoint**: ${method} /webhook/${webhookPath}`);
            }
        }

        // HTTP Request specific info
        if (node.type === 'n8n-nodes-base.httpRequest') {
            const url = node.parameters?.url || '';
            const method = node.parameters?.method || node.parameters?.requestMethod || 'GET';
            if (url) {
                lines.push(`- **Request**: ${method} ${url}`);
            }
        }

        lines.push('');
    }

    // ── Connections detail ────────────────────────────────────────
    if (Object.keys(connections).length > 0) {
        lines.push('## Connections');
        lines.push('');
        for (const [srcName, srcConnections] of Object.entries(connections)) {
            const outputs = srcConnections?.main || [];
            for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
                const outputArr = outputs[outIdx];
                if (!Array.isArray(outputArr)) continue;
                for (const conn of outputArr) {
                    const outputLabel = outputs.length > 1 ? ` (output ${outIdx})` : '';
                    lines.push(`- **${srcName}**${outputLabel} → **${conn.node}**`);
                }
            }
        }
        lines.push('');
    }

    lines.push('---');
    lines.push(`*Imported from n8n workflow "${name}"${workflow.id ? ` (ID: ${workflow.id})` : ''}*`);

    return lines.join('\n');
}

module.exports = {
    convertN8nWorkflowToMarkdown,
    getNodeLabel,
};
