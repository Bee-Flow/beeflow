/**
 * n8n Tools — Dynamic AI tools generated from active n8n webhook workflows
 * 
 * Unlike other integrations (per-user), n8n is configured at the ORG level.
 * Org admins set the n8n URL + API key, then select which webhook workflows
 * to expose as AI tools with configured input/output types.
 *
 * Uses raw REST API — no npm dependencies.
 */

const configStore = require('../stores/configStore');
const fetch = require('node-fetch');
const FormData = require('form-data');
const https = require('https');

// Create a permissive agent to allow connecting to self-hosted n8n instances
// with invalid or self-signed certificates.
const n8nAgent = new https.Agent({ rejectUnauthorized: false });

// ─── n8n API Client ────────────────────────────────────────────

/**
 * List active n8n workflows that have an enabled Webhook trigger node.
 */
async function listActiveWebhookWorkflows(apiBaseUrl, apiKey) {
    const headers = {
        'X-N8N-API-KEY': apiKey,
        'Content-Type': 'application/json',
    };

    // Normalize base URL
    const base = apiBaseUrl.replace(/\/+$/, '');
    const apiBase = base.includes('/api/v1') ? base : `${base}/api/v1`;

    // 1) List active workflows
    const listRes = await fetch(`${apiBase}/workflows?active=true&limit=250`, {
        headers,
        timeout: 10000,
        agent: n8nAgent,
    });
    if (!listRes.ok) {
        throw new Error(`Failed to list n8n workflows: ${listRes.status} ${await listRes.text()}`);
    }

    const listJson = await listRes.json();
    let workflows = listJson.data ?? listJson;

    // 2) Check if the list response already includes nodes (newer n8n versions do)
    const hasNodes = workflows.length > 0 && Array.isArray(workflows[0]?.nodes);

    if (!hasNodes) {
        // Fall back: fetch individual workflows (with timeout + concurrency limit of 5)
        const BATCH = 5;
        const detailed = [];
        for (let i = 0; i < workflows.length; i += BATCH) {
            const batch = workflows.slice(i, i + BATCH);
            const results = await Promise.all(
                batch.map(async (wf) => {
                    try {
                        const res = await fetch(`${apiBase}/workflows/${wf.id}`, { headers, timeout: 8000, agent: n8nAgent });
                        if (!res.ok) return null;
                        return res.json();
                    } catch (e) { return null; }
                })
            );
            detailed.push(...results);
        }
        workflows = detailed.filter(Boolean);
    }

    return workflows
        .filter((wf) => wf.active !== false)
        .filter((wf) => {
            const nodes = wf.nodes || [];
            return nodes.some(
                (n) => n.type === 'n8n-nodes-base.webhook' && n.disabled !== true
            );
        })
        .map((wf) => {
            const webhookNodes = (wf.nodes || [])
                .filter((n) => n.type === 'n8n-nodes-base.webhook' && n.disabled !== true);
            return {
                id: wf.id,
                name: wf.name,
                active: wf.active,
                webhookNodes: webhookNodes.map((n) => ({
                    name: n.name,
                    path: n.parameters?.path,
                    method: n.parameters?.httpMethod || 'POST',
                })),
            };
        });
}

/**
 * Trigger an n8n webhook workflow.
 * Supports JSON payloads and file uploads (multipart form-data).
 */
async function triggerWebhookWorkflow(n8nBaseUrl, webhookPath, method, payload, files) {
    const base = n8nBaseUrl.replace(/\/+$/, '');
    const url = `${base}/webhook/${webhookPath.replace(/^\/+/, '')}`;
    console.log(`[n8n] Triggering webhook: ${method} ${url}`);

    const hasFiles = files && files.length > 0;

    if (hasFiles) {
        // Send as multipart form-data for file uploads
        const form = new FormData();

        // Add regular payload fields
        if (payload) {
            for (const [key, value] of Object.entries(payload)) {
                if (key !== '_files') {
                    form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
                }
            }
        }

        // Add files
        for (const file of files) {
            const buffer = Buffer.isBuffer(file.content)
                ? file.content
                : Buffer.from(file.content, file.encoding || 'base64');
            form.append(file.fieldName || 'file', buffer, {
                filename: file.name,
                contentType: file.mimeType || 'application/octet-stream',
            });
        }

        const res = await fetch(url, {
            method: method || 'POST',
            body: form,
            headers: form.getHeaders(),
            agent: n8nAgent,
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`n8n webhook error ${res.status}: ${errText}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return await res.json();
        }
        return await res.text();
    } else {
        // Send as JSON
        const actualMethod = method || 'POST';
        const fetchOptions = {
            method: actualMethod,
            headers: { 'Content-Type': 'application/json' },
            agent: n8nAgent,
        };
        
        if (actualMethod !== 'GET' && actualMethod !== 'HEAD') {
            fetchOptions.body = JSON.stringify(payload || {});
        }

        const res = await fetch(url, fetchOptions);

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`n8n webhook error ${res.status}: ${errText}`);
        }

        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            return await res.json();
        }
        return await res.text();
    }
}

// ─── Dynamic Tool Builder ──────────────────────────────────────

/**
 * Create a URL-safe slug from a workflow name.
 */
function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .substring(0, 50);
}

/**
 * Build OpenAI function-calling tool definitions from org's configured n8n workflows.
 * Returns array of tool definitions ready to push into directChatTools.
 */
async function buildN8nTools(orgId) {
    const workflowsConfig = await configStore.getConfig(`n8n_workflows_org_${orgId}`);
    if (!workflowsConfig) return [];

    const workflows = typeof workflowsConfig === 'string'
        ? JSON.parse(workflowsConfig)
        : workflowsConfig;

    const tools = [];

    for (const wf of workflows) {
        if (!wf.enabled) continue;

        const slug = wf.slug || slugify(wf.name);
        const toolName = `n8n_run_${slug}`;

        // Build parameters from configured inputs
        const properties = {};
        const required = [];

        for (const input of (wf.inputs || [])) {
            const prop = {
                type: input.type === 'file' ? 'string' : (input.type || 'string'),
                description: input.description || input.name,
            };
            if (input.type === 'file') {
                prop.description = `${prop.description} (provide the filename of an uploaded attachment, or base64 content)`;
            }
            if (input.type === 'json') {
                prop.type = 'string';
                prop.description = `${prop.description} (provide as JSON string)`;
            }
            properties[input.name] = prop;
            if (input.required !== false) {
                required.push(input.name);
            }
        }

        // Always allow a free-form data parameter if no inputs are configured
        if (Object.keys(properties).length === 0) {
            properties.data = {
                type: 'string',
                description: 'JSON data to send to the workflow',
            };
        }

        // Always add include_attachments so AI can forward uploaded files
        properties.include_attachments = {
            type: 'boolean',
            description: 'Set to true to forward the user\'s uploaded files/attachments to this workflow. Only set this if the user has uploaded files and you think the workflow needs them.',
        };

        tools.push({
            type: 'function',
            function: {
                name: toolName,
                description: wf.description || `Run n8n workflow: ${wf.name}`,
                parameters: {
                    type: 'object',
                    properties,
                    required,
                },
            },
            // Store metadata for execution
            _n8n: {
                workflowId: wf.id,
                webhookPath: wf.webhookPath,
                httpMethod: wf.httpMethod || 'POST',
                inputs: wf.inputs || [],
                slug,
            },
        });
    }

    return tools;
}

// ─── Tool Execution ────────────────────────────────────────────

/**
 * Execute an n8n tool call. Resolves the workflow config, builds the payload,
 * handles file attachments, and triggers the webhook.
 */
async function executeN8nTool(toolName, args, orgId, attachments) {
    // Load org's n8n config
    const n8nUrl = await configStore.getConfig(`n8n_url_org_${orgId}`);
    const n8nApiKey = await configStore.getSecret(`n8n_api_key_org_${orgId}`);

    if (!n8nUrl) {
        console.log(`[n8n] No n8n URL configured for org ${orgId}`);
        return JSON.stringify({ error: 'n8n is not configured for this organization' });
    }

    console.log(`[n8n] Executing tool ${toolName} for org ${orgId}, n8nUrl=${n8nUrl}`);

    // Load workflow config to find the matching tool
    const workflowsConfig = await configStore.getConfig(`n8n_workflows_org_${orgId}`);
    if (!workflowsConfig) {
        return JSON.stringify({ error: 'No n8n workflows configured' });
    }

    const workflows = typeof workflowsConfig === 'string'
        ? JSON.parse(workflowsConfig)
        : workflowsConfig;

    // Find the matching workflow by tool name
    const slug = toolName.replace('n8n_run_', '');
    const workflow = workflows.find(wf => (wf.slug || slugify(wf.name)) === slug);

    if (!workflow) {
        console.log(`[n8n] Workflow not found for slug "${slug}". Available:`, workflows.map(w => w.slug));
        return JSON.stringify({ error: `Workflow not found for tool: ${toolName}` });
    }

    console.log(`[n8n] Found workflow: ${workflow.name}, webhookPath=${workflow.webhookPath}, method=${workflow.httpMethod}`);

    // Build payload
    const payload = {};
    const files = [];

    for (const input of (workflow.inputs || [])) {
        const value = args[input.name];
        if (value === undefined) continue;

        if (input.type === 'file') {
            // Try to find matching attachment
            const att = (attachments || []).find(a =>
                a.name === value || a.name?.includes(value)
            );
            if (att && att.content) {
                // Extract base64 content from data URL if needed
                let content = att.content;
                let encoding = 'base64';
                if (content.startsWith('data:')) {
                    content = content.split(',')[1] || content;
                }
                files.push({
                    fieldName: input.name,
                    name: att.name,
                    content,
                    encoding,
                    mimeType: att.type || 'application/octet-stream',
                });
            } else if (value) {
                // Treat as base64 content directly
                files.push({
                    fieldName: input.name,
                    name: input.name,
                    content: value,
                    encoding: 'base64',
                    mimeType: 'application/octet-stream',
                });
            }
        } else if (input.type === 'json') {
            try {
                payload[input.name] = JSON.parse(value);
            } catch (e) {
                payload[input.name] = value;
            }
        } else {
            payload[input.name] = value;
        }
    }

    // If no specific inputs configured, pass all args as payload
    if ((workflow.inputs || []).length === 0) {
        try {
            const { include_attachments, ...restArgs } = args;
            const data = restArgs.data ? JSON.parse(restArgs.data) : restArgs;
            Object.assign(payload, data);
        } catch (e) {
            const { include_attachments, ...restArgs } = args;
            Object.assign(payload, restArgs);
        }
    }

    // Auto-include attachments if AI decided to
    if (args.include_attachments && attachments && attachments.length > 0) {
        for (const att of attachments) {
            if (att.content) {
                let content = att.content;
                if (content.startsWith('data:')) {
                    content = content.split(',')[1] || content;
                }
                files.push({
                    fieldName: att.name || 'file',
                    name: att.name || 'attachment',
                    content,
                    encoding: 'base64',
                    mimeType: att.type || 'application/octet-stream',
                });
            }
        }
        console.log(`[n8n] Including ${files.length} attachment(s) from chat`);
    }

    try {
        const result = await triggerWebhookWorkflow(
            n8nUrl,
            workflow.webhookPath,
            workflow.httpMethod || 'POST',
            payload,
            files.length > 0 ? files : null
        );

        console.log(`[n8n] Webhook result:`, typeof result === 'string' ? result.substring(0, 200) : JSON.stringify(result).substring(0, 200));
        // Always return a JSON object string (Google Gemini requires Struct, not plain string)
        if (typeof result === 'object' && result !== null) {
            return JSON.stringify(result, null, 2);
        }
        return JSON.stringify({ result: result });
    } catch (err) {
        console.error(`[n8n] Webhook call failed:`, err.message);
        return JSON.stringify({ error: `n8n workflow failed: ${err.message}` });
    }
}

/**
 * Check if a tool name is an n8n tool.
 */
function isN8nTool(toolName) {
    return toolName && toolName.startsWith('n8n_');
}

/**
 * Fetch a single workflow's full definition from the n8n API.
 * Returns the complete workflow JSON including nodes, connections, and settings.
 */
async function fetchWorkflowById(apiBaseUrl, apiKey, workflowId) {
    const headers = {
        'X-N8N-API-KEY': apiKey,
        'Content-Type': 'application/json',
    };
    const base = apiBaseUrl.replace(/\/+$/, '');
    const apiBase = base.includes('/api/v1') ? base : `${base}/api/v1`;

    const res = await fetch(`${apiBase}/workflows/${workflowId}`, {
        headers,
        timeout: 10000,
        agent: n8nAgent,
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch n8n workflow ${workflowId}: ${res.status} ${await res.text()}`);
    }
    return res.json();
}

// ─── Exports ───────────────────────────────────────────────────

module.exports = {
    listActiveWebhookWorkflows,
    fetchWorkflowById,
    triggerWebhookWorkflow,
    buildN8nTools,
    executeN8nTool,
    isN8nTool,
    slugify,
};
