/**
 * Direct Chat Tool Stack — shared builder.
 *
 * Returns the tool array a direct-chat-style LLM call should see, assembled
 * from:
 *   - Components flagged for direct chat (or tier-specific tool list)
 *   - Integration tools (agent_search, gmail_*, calendar_*, drive_*, …)
 *   - Org-gated MCP tools
 *
 * Used by:
 *   - server/routes/ai/directChat.js (regular direct chat)
 *   - server/core/swarms/swarmRuntime.js (each swarm worker)
 *
 * Keeping one builder means the Swarm tier's workers see exactly the same
 * integrations the user has in plain direct chat — no drift, no separate
 * configuration surface.
 */

const componentManager = require('./componentManager');
const configStore = require('../stores/configStore');
const { getIntegrationTools } = require('./integrationTools');

async function buildDirectChatToolStack({ userId, session, isAdmin = false, resolvedTier = null } = {}) {
    // ── Components enabled for direct chat (or tier-specific list) ──
    const allComponents = componentManager.getComponents();
    const tierToolsConfig = await configStore.getConfig('direct_chat_tier_tools');
    const enabledToolIds = tierToolsConfig && resolvedTier ? tierToolsConfig[resolvedTier] : null;
    const tools = allComponents
        .filter(c => {
            if (enabledToolIds) return enabledToolIds.includes(c.id);
            return c.definition?.directChatEnabled === true;
        })
        .map(c => {
            const inputDefs = c.definition?.inputs || {};
            const visibleInputs = Object.entries(inputDefs)
                .filter(([, conf]) => {
                    if (typeof conf !== 'object') return true;
                    return !conf.secure && conf.default === undefined;
                });
            return {
                type: 'function',
                function: {
                    name: c.id,
                    description: c.definition.description || c.definition.name || c.id,
                    parameters: {
                        type: 'object',
                        properties: visibleInputs.reduce((acc, [key, conf]) => {
                            acc[key] = {
                                type: (typeof conf === 'object' ? conf.type : conf) || 'string',
                                description: (typeof conf === 'object' ? conf.description : '') || '',
                            };
                            return acc;
                        }, {}),
                        required: visibleInputs
                            .filter(([, conf]) => typeof conf === 'object' && conf.required)
                            .map(([key]) => key),
                    },
                },
            };
        });

    // ── Integration tools (agent_search, gmail, calendar, drive, …) ──
    let n8nOrgId = null;
    try {
        const integrations = await getIntegrationTools({ userId, session, isAdmin });
        n8nOrgId = integrations?.n8nOrgId || null;
        for (const tool of integrations?.tools || []) {
            if (!tools.find(t => t.function.name === tool.function.name)) {
                tools.push(tool);
            }
        }
    } catch (e) {
        console.warn('[DirectChatToolStack] integration tools failed:', e.message);
    }

    // ── MCP tools (Enterprise + org-gated) ──
    // MCP is an Enterprise feature (`mcp_marketplace`). Resolve the caller's
    // REAL tier (no super-admin elevation) and skip MCP injection entirely on
    // Community — so a downgraded org's leftover server rows never leak tools
    // to a Community agent. This mirrors the server-side requireFeature gate on
    // the /ai/.../mcp-servers routes.
    try {
        const license = require('../license');
        const userStoreForTier = require('../stores/userStore');
        const tierUser = userId ? await userStoreForTier.getUser(userId) : null;
        const mcpTier = await license.resolveTier({
            userId,
            organizationId: tierUser?.organizationId || null,
        });
        if (!license.tiers.tierHasFeature(mcpTier, 'mcp_marketplace')) {
            return { tools, n8nOrgId };
        }
    } catch (tierErr) {
        // Fail CLOSED for a paid feature — if we can't prove entitlement, don't
        // inject MCP tools.
        console.warn('[DirectChatToolStack] MCP tier check failed, skipping MCP:', tierErr.message);
        return { tools, n8nOrgId };
    }
    try {
        const mcpManager = require('./mcpManager');
        let mcpTools = await mcpManager.getAllToolsAsOpenAI();
        if (mcpTools.length > 0) {
            let orgEnabled = null;
            try {
                const userStore = require('../stores/userStore');
                const mcpUser = userId ? await userStore.getUser(userId) : null;
                if (mcpUser?.organizationId) {
                    const mcpOrg = await userStore.getOrganization(mcpUser.organizationId);
                    if (mcpOrg?.enabledIntegrations) {
                        orgEnabled = typeof mcpOrg.enabledIntegrations === 'string'
                            ? JSON.parse(mcpOrg.enabledIntegrations) : mcpOrg.enabledIntegrations;
                    } else {
                        const globalDefs = await configStore.getConfig('default_org_integrations');
                        if (globalDefs) {
                            orgEnabled = typeof globalDefs === 'string' ? JSON.parse(globalDefs) : globalDefs;
                        }
                    }
                }
            } catch (_) { /* ignore — fall through */ }
            if (orgEnabled) {
                mcpTools = mcpTools.filter(t => {
                    const serverId = t._mcp?.serverId;
                    return !serverId || orgEnabled.includes(`mcp:${serverId}`);
                });
            }
            for (const tool of mcpTools) {
                if (!tools.find(t => t.function.name === tool.function.name)) {
                    tools.push(tool);
                }
            }
        }
    } catch (mcpErr) {
        console.warn('[DirectChatToolStack] MCP tools failed:', mcpErr.message);
    }

    return { tools, n8nOrgId };
}

module.exports = { buildDirectChatToolStack };
