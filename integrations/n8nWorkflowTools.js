/**
 * n8n Workflow Management Tools — Static AI tools for managing n8n workflows
 *
 * Unlike the dynamic webhook-trigger tools in n8nTools.js, these are static
 * tools that give the AI full CRUD capabilities over n8n workflow definitions:
 * list, get, create, update (full PUT), patch (partial update via GET+merge+PUT),
 * activate, and deactivate.
 *
 * Uses the n8n REST API v1 with org-level credentials.
 */

const configStore = require('../stores/configStore');
const fetch = require('node-fetch');
const https = require('https');

// Reuse the permissive agent for self-hosted n8n with self-signed certs
const n8nAgent = new https.Agent({ rejectUnauthorized: false });

// ─── n8n API Helper ────────────────────────────────────────────

/**
 * Authenticated fetch against the org's n8n REST API.
 *
 * @param {string} orgId   - Organization ID (to look up n8n URL + API key)
 * @param {string} path    - API path (e.g. '/workflows' or '/workflows/123')
 * @param {object} options - fetch options (method, body, etc.)
 * @returns {Promise<any>} Parsed JSON response
 */
async function n8nApiFetch(orgId, path, options = {}) {
    const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
    const apiKey = await configStore.getSecret(`n8n_api_key_org_${orgId}`);

    if (!n8nUrl || !apiKey) {
        throw new Error('n8n is not configured for this organization. Set the URL and API key in Organisation Settings.');
    }

    const base = n8nUrl.replace(/\/+$/, '');
    const apiBase = base.includes('/api/v1') ? base : `${base}/api/v1`;
    const url = `${apiBase}${path}`;

    const res = await fetch(url, {
        ...options,
        headers: {
            'X-N8N-API-KEY': apiKey,
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        },
        agent: n8nAgent,
        signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`n8n API error (${res.status}): ${errText.slice(0, 300)}`);
    }

    return res.json();
}

// ─── Tool Definitions ──────────────────────────────────────────

const N8N_WORKFLOW_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_list',
            description: 'List all workflows on the connected n8n instance. Returns name, ID, active status, tags, and timestamps for each workflow.',
            parameters: {
                type: 'object',
                properties: {
                    active: {
                        type: 'boolean',
                        description: 'Filter by active status. Omit to list all workflows.',
                    },
                    limit: {
                        type: 'integer',
                        description: 'Maximum number of workflows to return (default: 50, max: 250)',
                    },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_get',
            description: 'Get the full definition of a specific n8n workflow, including all nodes, connections, and settings. Use this to inspect how a workflow is built.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: {
                        type: 'string',
                        description: 'The n8n workflow ID to retrieve',
                    },
                },
                required: ['workflow_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_create',
            description: 'Create a new workflow on the connected n8n instance. Provide the workflow name and its node/connection definitions as JSON strings.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Name for the new workflow',
                    },
                    nodes: {
                        type: 'string',
                        description: 'JSON string of the nodes array. Each node needs at minimum: name, type, typeVersion, position ([x,y]), and parameters.',
                    },
                    connections: {
                        type: 'string',
                        description: 'JSON string of the connections object defining how nodes are linked.',
                    },
                    settings: {
                        type: 'string',
                        description: 'Optional JSON string of workflow settings (e.g. executionOrder, saveManualExecutions).',
                    },
                    active: {
                        type: 'boolean',
                        description: 'Whether to activate the workflow immediately (default: false)',
                    },
                },
                required: ['name', 'nodes', 'connections'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_update',
            description: 'Fully replace an n8n workflow definition. You must provide ALL fields (nodes, connections, etc.) — anything omitted will be removed. For changing just a few fields, use n8n_workflow_patch instead.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: {
                        type: 'string',
                        description: 'The workflow ID to update',
                    },
                    name: {
                        type: 'string',
                        description: 'New workflow name',
                    },
                    nodes: {
                        type: 'string',
                        description: 'JSON string of the complete nodes array',
                    },
                    connections: {
                        type: 'string',
                        description: 'JSON string of the complete connections object',
                    },
                    settings: {
                        type: 'string',
                        description: 'JSON string of workflow settings',
                    },
                    active: {
                        type: 'boolean',
                        description: 'Whether the workflow should be active',
                    },
                },
                required: ['workflow_id', 'name', 'nodes', 'connections'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_patch',
            description: 'Partially update an n8n workflow — only the fields you provide will be changed, everything else is preserved. This is the recommended way to make small changes like renaming, adding/removing a node, or toggling settings.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: {
                        type: 'string',
                        description: 'The workflow ID to patch',
                    },
                    name: {
                        type: 'string',
                        description: 'New workflow name (only if changing)',
                    },
                    nodes: {
                        type: 'string',
                        description: 'JSON string of the updated nodes array (replaces all nodes — include unchanged nodes too)',
                    },
                    connections: {
                        type: 'string',
                        description: 'JSON string of the updated connections object (replaces all connections)',
                    },
                    settings: {
                        type: 'string',
                        description: 'JSON string of updated workflow settings (merged with existing settings)',
                    },
                    active: {
                        type: 'boolean',
                        description: 'Whether the workflow should be active',
                    },
                },
                required: ['workflow_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_activate',
            description: 'Activate an n8n workflow so it starts processing events (triggers, schedules, webhooks).',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: {
                        type: 'string',
                        description: 'The workflow ID to activate',
                    },
                },
                required: ['workflow_id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'n8n_workflow_deactivate',
            description: 'Deactivate an n8n workflow so it stops processing events.',
            parameters: {
                type: 'object',
                properties: {
                    workflow_id: {
                        type: 'string',
                        description: 'The workflow ID to deactivate',
                    },
                },
                required: ['workflow_id'],
            },
        },
    },
];

// ─── JSON Parse Helper ─────────────────────────────────────────

/**
 * Safely parse a JSON string parameter, returning fallback on failure.
 */
function parseJsonParam(value, paramName) {
    if (!value) return undefined;
    if (typeof value === 'object') return value; // Already parsed
    try {
        return JSON.parse(value);
    } catch (e) {
        throw new Error(`Invalid JSON for "${paramName}": ${e.message}`);
    }
}

// ─── Workflow Summary Helper ───────────────────────────────────

/**
 * Build a compact workflow summary for AI consumption.
 */
function summarizeWorkflow(wf) {
    const nodes = (wf.nodes || []).filter(n => n.type !== 'n8n-nodes-base.stickyNote');
    return {
        id: wf.id,
        name: wf.name,
        active: wf.active,
        nodeCount: nodes.length,
        nodeTypes: [...new Set(nodes.map(n => n.type))],
        tags: (wf.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean),
        createdAt: wf.createdAt,
        updatedAt: wf.updatedAt,
    };
}

// ─── Tool Execution ────────────────────────────────────────────

async function executeN8nWorkflowTool(toolName, args, orgId) {
    if (!orgId) {
        return { error: 'No organization found. n8n workflow management requires an organization with n8n configured.' };
    }

    try {
        switch (toolName) {

            // ── List Workflows ──────────────────────────────────
            case 'n8n_workflow_list': {
                const { active, limit = 50 } = args;
                const cap = Math.min(Math.max(limit || 50, 1), 250);

                let queryParams = `limit=${cap}`;
                if (active !== undefined) {
                    queryParams += `&active=${active}`;
                }

                const data = await n8nApiFetch(orgId, `/workflows?${queryParams}`);
                const workflows = data.data ?? data;

                return {
                    total: Array.isArray(workflows) ? workflows.length : 0,
                    workflows: (Array.isArray(workflows) ? workflows : []).map(summarizeWorkflow),
                };
            }

            // ── Get Workflow ────────────────────────────────────
            case 'n8n_workflow_get': {
                const { workflow_id } = args;
                if (!workflow_id) return { error: 'workflow_id is required' };

                const wf = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`);

                // Build detailed output but cap size to prevent token overflow
                const result = {
                    id: wf.id,
                    name: wf.name,
                    active: wf.active,
                    tags: (wf.tags || []).map(t => typeof t === 'string' ? t : t.name).filter(Boolean),
                    createdAt: wf.createdAt,
                    updatedAt: wf.updatedAt,
                    settings: wf.settings || {},
                    nodes: (wf.nodes || []).map(n => ({
                        name: n.name,
                        type: n.type,
                        typeVersion: n.typeVersion,
                        position: n.position,
                        parameters: n.parameters || {},
                        disabled: n.disabled || false,
                    })),
                    connections: wf.connections || {},
                };

                // Truncate if too large
                const json = JSON.stringify(result, null, 2);
                if (json.length > 30000) {
                    // Return summary + truncation notice
                    return {
                        ...summarizeWorkflow(wf),
                        _note: `Full workflow JSON is ${json.length} chars — too large for chat context. Showing summary. Use specific node inspection or break down your request.`,
                        settings: wf.settings || {},
                        nodeDetails: (wf.nodes || []).map(n => ({
                            name: n.name,
                            type: n.type,
                            disabled: n.disabled || false,
                        })),
                    };
                }

                return result;
            }

            // ── Create Workflow ─────────────────────────────────
            case 'n8n_workflow_create': {
                const { name, active = false } = args;
                if (!name) return { error: 'name is required' };

                const nodes = parseJsonParam(args.nodes, 'nodes');
                const connections = parseJsonParam(args.connections, 'connections');
                const settings = parseJsonParam(args.settings, 'settings');

                if (!nodes || !Array.isArray(nodes)) {
                    return { error: 'nodes must be a valid JSON array of node objects' };
                }
                if (!connections || typeof connections !== 'object') {
                    return { error: 'connections must be a valid JSON object' };
                }

                const body = {
                    name,
                    nodes,
                    connections,
                    active: !!active,
                };
                if (settings) body.settings = settings;

                const created = await n8nApiFetch(orgId, '/workflows', {
                    method: 'POST',
                    body: JSON.stringify(body),
                });

                return {
                    success: true,
                    message: `Workflow "${created.name}" created successfully!`,
                    ...summarizeWorkflow(created),
                };
            }

            // ── Full Update Workflow ────────────────────────────
            case 'n8n_workflow_update': {
                const { workflow_id, name, active } = args;
                if (!workflow_id) return { error: 'workflow_id is required' };
                if (!name) return { error: 'name is required for full update' };

                const nodes = parseJsonParam(args.nodes, 'nodes');
                const connections = parseJsonParam(args.connections, 'connections');
                const settings = parseJsonParam(args.settings, 'settings');

                if (!nodes || !Array.isArray(nodes)) {
                    return { error: 'nodes must be a valid JSON array' };
                }
                if (!connections || typeof connections !== 'object') {
                    return { error: 'connections must be a valid JSON object' };
                }

                const body = { name, nodes, connections };
                if (settings) body.settings = settings;
                if (active !== undefined) body.active = !!active;

                const updated = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`, {
                    method: 'PUT',
                    body: JSON.stringify(body),
                });

                return {
                    success: true,
                    message: `Workflow "${updated.name}" fully updated.`,
                    ...summarizeWorkflow(updated),
                };
            }

            // ── Partial Update (Patch) ──────────────────────────
            case 'n8n_workflow_patch': {
                const { workflow_id, name, active } = args;
                if (!workflow_id) return { error: 'workflow_id is required' };

                // 1. Fetch current workflow
                const current = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`);

                // 2. Merge only provided fields
                const merged = {
                    name: name !== undefined ? name : current.name,
                    nodes: current.nodes,
                    connections: current.connections,
                    settings: current.settings || {},
                };

                // Parse and apply nodes if provided
                if (args.nodes) {
                    const parsedNodes = parseJsonParam(args.nodes, 'nodes');
                    if (!Array.isArray(parsedNodes)) {
                        return { error: 'nodes must be a valid JSON array' };
                    }
                    merged.nodes = parsedNodes;
                }

                // Parse and apply connections if provided
                if (args.connections) {
                    const parsedConnections = parseJsonParam(args.connections, 'connections');
                    if (typeof parsedConnections !== 'object') {
                        return { error: 'connections must be a valid JSON object' };
                    }
                    merged.connections = parsedConnections;
                }

                // Merge settings (shallow merge — new keys override, existing keys preserved)
                if (args.settings) {
                    const parsedSettings = parseJsonParam(args.settings, 'settings');
                    if (typeof parsedSettings === 'object') {
                        merged.settings = { ...merged.settings, ...parsedSettings };
                    }
                }

                if (active !== undefined) {
                    merged.active = !!active;
                }

                // 3. PUT the merged workflow back
                const updated = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}`, {
                    method: 'PUT',
                    body: JSON.stringify(merged),
                });

                return {
                    success: true,
                    message: `Workflow "${updated.name}" patched successfully.`,
                    ...summarizeWorkflow(updated),
                };
            }

            // ── Activate Workflow ───────────────────────────────
            case 'n8n_workflow_activate': {
                const { workflow_id } = args;
                if (!workflow_id) return { error: 'workflow_id is required' };

                const result = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}/activate`, {
                    method: 'POST',
                });

                return {
                    success: true,
                    message: `Workflow "${result.name || workflow_id}" activated.`,
                    id: result.id || workflow_id,
                    name: result.name,
                    active: true,
                };
            }

            // ── Deactivate Workflow ─────────────────────────────
            case 'n8n_workflow_deactivate': {
                const { workflow_id } = args;
                if (!workflow_id) return { error: 'workflow_id is required' };

                const result = await n8nApiFetch(orgId, `/workflows/${encodeURIComponent(workflow_id)}/deactivate`, {
                    method: 'POST',
                });

                return {
                    success: true,
                    message: `Workflow "${result.name || workflow_id}" deactivated.`,
                    id: result.id || workflow_id,
                    name: result.name,
                    active: false,
                };
            }

            default:
                return { error: `Unknown n8n workflow tool: ${toolName}` };
        }
    } catch (err) {
        console.error(`[n8n-workflow] ${toolName} error:`, err.message);
        return { error: `n8n workflow operation failed: ${err.message}` };
    }
}

// ─── Identification ────────────────────────────────────────────

function isN8nWorkflowTool(toolName) {
    return toolName && toolName.startsWith('n8n_workflow_');
}

// ─── Exports ───────────────────────────────────────────────────

module.exports = {
    N8N_WORKFLOW_TOOLS,
    executeN8nWorkflowTool,
    isN8nWorkflowTool,
};
