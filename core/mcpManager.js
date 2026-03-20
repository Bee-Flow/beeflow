/**
 * MCP Manager — Runtime manager for stdio-based MCP server connections
 * 
 * Spawns MCP servers as child processes (npx, uv, etc.) via StdioClientTransport.
 * Maintains per-user connection pools with idle timeouts for efficient reuse.
 * 
 * Admin defines servers (command + args + required env vars).
 * Users provide credentials in their settings.
 * At runtime, processes are spawned with user-specific env vars.
 * 
 * NOTE: @modelcontextprotocol/sdk is ESM-only — uses dynamic import().
 */

const mcpStore = require('../stores/mcpStore');
const configStore = require('../stores/configStore');

/** Lazy-loaded SDK modules (ESM dynamic import) */
let _Client = null;
let _StdioClientTransport = null;
let _StreamableHTTPClientTransport = null;

async function loadSDK() {
    if (_Client && _StdioClientTransport) return;
    const clientMod = await import('@modelcontextprotocol/sdk/client');
    const transportMod = await import('@modelcontextprotocol/sdk/client/stdio.js');
    _Client = clientMod.Client;
    _StdioClientTransport = transportMod.StdioClientTransport;
    try {
        const httpMod = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        _StreamableHTTPClientTransport = httpMod.StreamableHTTPClientTransport;
    } catch (_) {
        console.warn('[MCP] StreamableHTTPClientTransport not available — HTTP transport disabled');
    }
}

/**
 * Per-user connection pool: Map<`${userId}:${serverId}`, { client, transport, lastUsed, timer }>
 * Connections are kept alive for IDLE_TIMEOUT_MS then auto-closed.
 */
const connectionPool = new Map();
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Initialize: pre-cache tool definitions from all enabled servers.
 * Called once at server startup. Does NOT spawn processes — just loads config.
 */
async function initialize() {
    try {
        await loadSDK();
        const servers = await mcpStore.getEnabledServers();
        console.log(`[MCP] Initialized — ${servers.length} server definition(s) loaded`);
    } catch (err) {
        console.error('[MCP] Initialize error:', err.message);
    }
}

/**
 * Get or create a connection for a specific user + server combo.
 * Spawns the server process with user's env vars.
 */
async function getConnection(serverId, userId) {
    const poolKey = `${userId}:${serverId}`;

    // Return existing connection if alive
    const existing = connectionPool.get(poolKey);
    if (existing) {
        existing.lastUsed = Date.now();
        // Reset idle timer
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => closeConnection(poolKey), IDLE_TIMEOUT_MS);
        return existing.client;
    }

    // Load server config
    const server = await mcpStore.getServer(serverId);
    if (!server || !server.enabled) {
        throw new Error(`MCP server ${serverId} not available`);
    }

    await loadSDK();

    // Build env vars from user's stored credentials
    const userEnv = {};
    for (const cred of (server.required_credentials || [])) {
        const value = await configStore.getSecret(`mcp_cred_${serverId}_${cred.key}_user_${userId}`);
        if (value) {
            userEnv[cred.key] = value;
        }
    }

    let transport;
    if (server.transport === 'http' && server.url) {
        // Remote HTTP server
        if (!_StreamableHTTPClientTransport) {
            throw new Error('StreamableHTTP transport not available — update @modelcontextprotocol/sdk');
        }
        console.log(`[MCP] Connecting to HTTP server "${server.name}" for user ${userId}: ${server.url}`);
        const httpHeaders = {};
        // If user has an auth credential, pass it as Authorization header
        if (userEnv.AUTHORIZATION) httpHeaders['Authorization'] = userEnv.AUTHORIZATION;
        else if (userEnv.API_KEY) httpHeaders['Authorization'] = `Bearer ${userEnv.API_KEY}`;
        transport = new _StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: httpHeaders } });
    } else {
        // Local stdio server
        if (!server.command) throw new Error(`MCP server ${serverId} has no command configured`);
        console.log(`[MCP] Spawning "${server.name}" for user ${userId}: ${server.command} ${(server.args || []).join(' ')}`);
        transport = new _StdioClientTransport({
            command: server.command,
            args: server.args || [],
            env: { ...process.env, ...userEnv },
        });
    }

    const client = new _Client({
        name: 'beeflow-agent',
        version: '1.0.0',
    });

    await client.connect(transport);

    const timer = setTimeout(() => closeConnection(poolKey), IDLE_TIMEOUT_MS);
    connectionPool.set(poolKey, { client, transport, lastUsed: Date.now(), timer });

    return client;
}

/**
 * Close a pooled connection.
 */
async function closeConnection(poolKey) {
    const entry = connectionPool.get(poolKey);
    if (!entry) return;

    clearTimeout(entry.timer);
    connectionPool.delete(poolKey);

    try {
        await entry.client.close();
    } catch (err) {
        console.warn(`[MCP] Error closing connection ${poolKey}:`, err.message);
    }
}

/**
 * Get all MCP tools formatted as OpenAI function-calling tools.
 * Uses cached tool definitions from the store (no process spawning).
 */
async function getAllToolsAsOpenAI() {
    const tools = [];
    try {
        const servers = await mcpStore.getEnabledServers();
        console.log(`[MCP-DEBUG] getAllToolsAsOpenAI: ${servers.length} enabled servers found`);

        for (const server of servers) {
            const cacheLen = (server.tools_cache || []).length;
            console.log(`[MCP-DEBUG]   Server "${server.id}": enabled=${server.enabled}, tools_cache=${cacheLen}, status=${server.status}`);
            for (const tool of (server.tools_cache || [])) {
                const prefixedName = `mcp_${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
                tools.push({
                    type: 'function',
                    function: {
                        name: prefixedName,
                        description: tool.description || `MCP tool: ${tool.name}`,
                        parameters: tool.inputSchema || { type: 'object', properties: {} },
                    },
                    _mcp: { serverId: server.id, originalName: tool.name },
                });
            }
        }
        console.log(`[MCP-DEBUG] getAllToolsAsOpenAI: returning ${tools.length} total MCP tools`);
    } catch (err) {
        console.error('[MCP] Error loading tools:', err.message);
    }

    return tools;
}

/**
 * Call an MCP tool by its prefixed name (e.g. "mcp_github_create_issue").
 * Finds the server, spawns/reuses connection with user's env, and calls the tool.
 */
async function callToolByPrefixedName(prefixedName, args, userId) {
    // Find which server and tool this belongs to
    const servers = await mcpStore.getEnabledServers();

    for (const server of servers) {
        for (const tool of (server.tools_cache || [])) {
            const expected = `mcp_${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
            if (expected === prefixedName) {
                return await callTool(server.id, tool.name, args, userId);
            }
        }
    }

    throw new Error(`MCP tool not found: ${prefixedName}`);
}

/**
 * Call a tool on a specific MCP server for a specific user.
 */
async function callTool(serverId, toolName, args = {}, userId) {
    if (!userId) throw new Error('User ID required for MCP tool calls');

    const client = await getConnection(serverId, userId);

    try {
        const result = await client.callTool({ name: toolName, arguments: args });
        // MCP returns { content: [{ type, text }] } — extract text
        if (result.content && Array.isArray(result.content)) {
            return result.content
                .filter(c => c.type === 'text')
                .map(c => c.text)
                .join('\n');
        }
        return JSON.stringify(result);
    } catch (err) {
        // If call fails, close the connection so it's re-spawned next time
        const poolKey = `${userId}:${serverId}`;
        await closeConnection(poolKey);
        console.error(`[MCP] Tool call failed: ${serverId}/${toolName}:`, err.message);
        throw err;
    }
}

/**
 * Test a command by spawning it temporarily and discovering tools.
 * Used by admin to validate server config before saving.
 * Returns { success, tools, error }.
 */
async function testCommand(command, args = [], envVars = {}, transportType = 'stdio', url = null) {
    await loadSDK();
    let client;
    let transport;
    try {
        if (transportType === 'http' && url) {
            if (!_StreamableHTTPClientTransport) {
                return { success: false, tools: [], error: 'StreamableHTTP transport not available' };
            }
            transport = new _StreamableHTTPClientTransport(new URL(url));
        } else {
            transport = new _StdioClientTransport({
                command,
                args,
                env: { ...process.env, ...envVars },
            });
        }
        client = new _Client({ name: 'beeflow-test', version: '1.0.0' });
        await client.connect(transport);

        const result = await client.listTools();
        const tools = (result.tools || []).map(t => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || { type: 'object', properties: {} },
        }));

        return { success: true, tools, error: null };
    } catch (err) {
        return { success: false, tools: [], error: err.message };
    } finally {
        if (client) {
            try { await client.close(); } catch (_) {}
        }
    }
}

/**
 * Discover tools from a server by spawning it temporarily.
 * Updates the tools_cache in the store.
 */
async function refreshServerTools(serverId) {
    const server = await mcpStore.getServer(serverId);
    if (!server) throw new Error('Server not found');

    const result = await testCommand(server.command, server.args || [], {}, server.transport || 'stdio', server.url);
    if (result.success) {
        await mcpStore.updateServer(serverId, {
            tools_cache: result.tools,
            status: 'ready',
            error: null,
        });
        return result.tools;
    } else {
        await mcpStore.updateServer(serverId, {
            status: 'error',
            error: result.error,
        });
        throw new Error(result.error);
    }
}

/**
 * Add a new server definition, test it, and cache tools.
 */
async function addServer({ id, name, command, args = [], required_credentials = [], transport = 'stdio', url, category, description, icon, source = 'manual' }) {
    // Save to store
    await mcpStore.createServer({ id, name, command, args, required_credentials, transport, url, category, description, icon, source });

    // Test and cache tools
    try {
        const result = await testCommand(command, args, {}, transport, url);
        if (result.success) {
            await mcpStore.updateServer(id, {
                tools_cache: result.tools,
                status: 'ready',
                error: null,
            });
        } else {
            await mcpStore.updateServer(id, {
                status: 'error',
                error: result.error,
            });
        }
    } catch (err) {
        await mcpStore.updateServer(id, {
            status: 'error',
            error: err.message,
        });
    }

    return mcpStore.getServer(id);
}

/**
 * Remove a server — close all connections and delete from store.
 */
async function removeServer(serverId) {
    // Close all user connections for this server
    for (const [key] of connectionPool) {
        if (key.endsWith(`:${serverId}`)) {
            await closeConnection(key);
        }
    }
    return mcpStore.deleteServer(serverId);
}

/**
 * Get summary info about all servers (for admin API).
 */
async function getServersSummary() {
    return mcpStore.listServers();
}

/**
 * Get servers needing credentials for a specific user (for user settings).
 */
async function getServersForUser(userId) {
    const servers = await mcpStore.getEnabledServers();
    const result = [];

    for (const server of servers) {
        const credentials = [];
        if (server.required_credentials && server.required_credentials.length > 0) {
            for (const cred of server.required_credentials) {
                const hasValue = !!(await configStore.getSecret(`mcp_cred_${server.id}_${cred.key}_user_${userId}`));
                credentials.push({
                    key: cred.key,
                    label: cred.label || cred.key,
                    description: cred.description || '',
                    configured: hasValue,
                });
            }
        }

        result.push({
            id: server.id,
            name: server.name,
            description: server.description || '',
            icon: server.icon || '🔌',
            toolCount: (server.tools_cache || []).length,
            credentials,
            allConfigured: credentials.length === 0 || credentials.every(c => c.configured),
        });
    }

    return result;
}

/**
 * Save a user's credential for an MCP server.
 */
async function saveUserCredential(userId, serverId, credKey, value) {
    await configStore.setSecret(`mcp_cred_${serverId}_${credKey}_user_${userId}`, value || '');
    // Close any existing connection so it re-spawns with new creds
    const poolKey = `${userId}:${serverId}`;
    await closeConnection(poolKey);
}

module.exports = {
    initialize,
    getAllToolsAsOpenAI,
    callToolByPrefixedName,
    callTool,
    testCommand,
    refreshServerTools,
    addServer,
    removeServer,
    getServersSummary,
    getServersForUser,
    saveUserCredential,
};
