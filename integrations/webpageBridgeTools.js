/**
 * Webpage Bridge Tools — studio-AI tools that let the author manage which
 * platform capabilities are exposed to the running page via
 * window.beeflowAI / .beeflowAutomations / .beeflowIntegrations.
 *
 * Each grant is stored in webpages.bridge_grants. The bridges run
 * acts-as-author, so this allowlist is the sole opt-in surface — viewers
 * cannot bypass it.
 *
 * Tools:
 *   webpage_grant_ai             { enabled, groundOnPage, defaultTier? }
 *   webpage_list_my_automations  → author's owned active automations
 *   webpage_grant_automation     { automationId, label? }
 *   webpage_revoke_automation    { automationId }
 *   webpage_list_my_integrations → author's permitted+connected integration tools
 *   webpage_grant_integration    { tool, fixedArgs?, label? }
 *   webpage_revoke_integration   { tool }
 */

const webpageStore = require('../stores/webpageStore');
const automationStore = require('../stores/automationStore');
const { TOOL_REGISTRY, loadTools, findOwnerOfTool } = require('../automation/toolRegistry');

const WEBPAGE_BRIDGE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'webpage_grant_ai',
            description: 'Configure the AI bridge for this webpage (window.beeflowAI). Controls whether the page can chat the platform LLM and whether the page\'s own knowledge is auto-injected as context.',
            parameters: {
                type: 'object',
                properties: {
                    enabled: { type: 'boolean', description: 'Master on/off for window.beeflowAI. Default: true.' },
                    groundOnPage: { type: 'boolean', description: 'When true, the AI auto-pulls the page\'s knowledge_base_ids and uploaded sources as context. Default: true.' },
                    defaultTier: { type: 'string', description: 'Default model tier used when the page does not specify one. e.g. "fast", "smart", "thinking".' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_list_my_automations',
            description: 'List the page author\'s own automations (studio routines). Call before granting one to a page.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_grant_automation',
            description: 'Allow the running page to trigger one of the author\'s automations via window.beeflowAutomations.run(). Acts-as-author at runtime.',
            parameters: {
                type: 'object',
                properties: {
                    automationId: { type: 'string', description: 'ID of an automation owned by the page author.' },
                    label: { type: 'string', description: 'Optional display label; defaults to the automation title.' },
                },
                required: ['automationId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_revoke_automation',
            description: 'Remove an automation grant from this webpage.',
            parameters: {
                type: 'object',
                properties: { automationId: { type: 'string' } },
                required: ['automationId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_list_my_integrations',
            description: 'List the page author\'s permitted and connected integration tools (Gmail send, Slack post, Sheets append, …). Call before granting a tool to a page.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_grant_integration',
            description: 'Allow the running page to call one specific integration tool via window.beeflowIntegrations.run(). Acts-as-author. ALWAYS use fixedArgs to pin sensitive fields (channel, recipient, sheet ID) the visitor must not be allowed to override.',
            parameters: {
                type: 'object',
                properties: {
                    tool: { type: 'string', description: 'Exact tool name, e.g. "slack_post_message", "gmail_send", "sheets_append_row".' },
                    fixedArgs: { type: 'object', description: 'Args the author pins server-side. These ALWAYS win over viewer-supplied args at call time. Use for channel, recipient, document/sheet IDs, etc.' },
                    label: { type: 'string', description: 'Optional display label.' },
                },
                required: ['tool'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'webpage_revoke_integration',
            description: 'Remove an integration tool grant from this webpage.',
            parameters: {
                type: 'object',
                properties: { tool: { type: 'string' } },
                required: ['tool'],
            },
        },
    },
];

const TOOL_NAMES = new Set(WEBPAGE_BRIDGE_TOOLS.map(t => t.function.name));

function isBridgeTool(name) {
    return TOOL_NAMES.has(name);
}

async function executeBridgeTool(toolName, args, { webpageId, userId, session }) {
    if (toolName === 'webpage_grant_ai') {
        const patch = { ai: {} };
        if (typeof args.enabled === 'boolean') patch.ai.enabled = args.enabled;
        if (typeof args.groundOnPage === 'boolean') patch.ai.groundOnPage = args.groundOnPage;
        if (typeof args.defaultTier === 'string') patch.ai.defaultTier = args.defaultTier;
        const merged = await webpageStore.updateBridgeGrants(webpageId, userId, patch);
        if (!merged) return { error: 'Webpage not found or read-only' };
        return { success: true, ai: merged.ai };
    }

    if (toolName === 'webpage_list_my_automations') {
        const list = await automationStore.getAutomationsForUser(userId).catch(() => []);
        return {
            automations: list.map(a => ({
                automationId: a.id,
                title: a.title,
                description: a.description || '',
                isActive: !!a.isActive,
                isDraft: !!a.isDraft,
                triggerType: a.triggerType,
            })),
        };
    }

    if (toolName === 'webpage_grant_automation') {
        if (typeof args.automationId !== 'string' || !args.automationId.trim()) {
            return { error: 'automationId is required' };
        }
        const a = await automationStore.getAutomation(args.automationId).catch(() => null);
        if (!a) return { error: `Automation ${args.automationId} not found` };
        if (a.userId !== userId) return { error: 'You can only grant your own automations' };
        const current = await webpageStore.getBridgeGrants(webpageId);
        const next = current.automations.filter(g => g.automationId !== args.automationId);
        next.push({ automationId: args.automationId, ...(args.label ? { label: String(args.label) } : {}) });
        const merged = await webpageStore.updateBridgeGrants(webpageId, userId, { automations: next });
        if (!merged) return { error: 'Webpage not found or read-only' };
        return { success: true, automationId: args.automationId, title: a.title };
    }

    if (toolName === 'webpage_revoke_automation') {
        const current = await webpageStore.getBridgeGrants(webpageId);
        const next = current.automations.filter(g => g.automationId !== args.automationId);
        const merged = await webpageStore.updateBridgeGrants(webpageId, userId, { automations: next });
        if (!merged) return { error: 'Webpage not found or read-only' };
        return { success: true, removed: args.automationId };
    }

    if (toolName === 'webpage_list_my_integrations') {
        // Use the existing integration-discovery helper so we only report
        // tools the user has actually connected. Falls back to the full
        // registry surface if discovery fails (e.g. user not fully set up).
        let availableNames = null;
        try {
            const { getIntegrationTools } = require('../core/integrationTools');
            const result = await getIntegrationTools({ userId, session, isAdmin: !!session?.isAdmin });
            availableNames = new Set((result.tools || []).map(t => t?.function?.name).filter(Boolean));
        } catch (_) { /* fall through to registry-only view */ }

        const out = [];
        for (const entry of TOOL_REGISTRY) {
            const tools = loadTools(entry);
            for (const t of tools) {
                const name = t?.function?.name;
                if (!name) continue;
                if (availableNames && !availableNames.has(name)) continue;
                out.push({
                    tool: name,
                    label: name.replace(/_/g, ' '),
                    description: t.function?.description || '',
                    integrationId: entry.app,
                    integrationLabel: entry.label,
                });
            }
        }
        return { integrations: out };
    }

    if (toolName === 'webpage_grant_integration') {
        if (typeof args.tool !== 'string' || !args.tool.trim()) {
            return { error: 'tool is required' };
        }
        const owner = findOwnerOfTool(args.tool);
        if (!owner) return { error: `Unknown tool: ${args.tool}` };
        const current = await webpageStore.getBridgeGrants(webpageId);
        const next = current.integrations.filter(g => g.tool !== args.tool);
        const entry = { tool: args.tool };
        if (args.fixedArgs && typeof args.fixedArgs === 'object') entry.fixedArgs = args.fixedArgs;
        if (args.label) entry.label = String(args.label);
        next.push(entry);
        const merged = await webpageStore.updateBridgeGrants(webpageId, userId, { integrations: next });
        if (!merged) return { error: 'Webpage not found or read-only' };
        return { success: true, tool: args.tool, integrationId: owner.app };
    }

    if (toolName === 'webpage_revoke_integration') {
        const current = await webpageStore.getBridgeGrants(webpageId);
        const next = current.integrations.filter(g => g.tool !== args.tool);
        const merged = await webpageStore.updateBridgeGrants(webpageId, userId, { integrations: next });
        if (!merged) return { error: 'Webpage not found or read-only' };
        return { success: true, removed: args.tool };
    }

    return { error: `Unknown bridge tool: ${toolName}` };
}

module.exports = {
    WEBPAGE_BRIDGE_TOOLS,
    isBridgeTool,
    executeBridgeTool,
};
