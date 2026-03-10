const { processSystemPrompt } = require('../promptUtils');
const { buildToolHint } = require('../integrationTools');

async function buildSystemPrompt({ agent, tools, userId, messageMetadata, memoryContext, isStrictKnowledge }) {
    const defaultPrompt = tools.length > 0
        ? `You are a helpful AI assistant. You have access to the following tools to help accomplish tasks. Use them when appropriate.`
        : `You are a helpful AI assistant. Answer the user's questions to the best of your ability.`;
    
    let systemPrompt = agent.system_prompt || defaultPrompt;

    // Process dynamic tags in system prompt
    systemPrompt = processSystemPrompt(systemPrompt);

    // Append integration tool hints so the AI knows what integrations are available
    try {
        const toolHint = await buildToolHint(tools, userId);
        if (toolHint) systemPrompt += toolHint;
    } catch (e) { /* ignore */ }

    if (memoryContext) {
        systemPrompt = systemPrompt + '\n\n' + memoryContext;
    }

    // ─── Date/time context ───────────────────────────────────────
    const tz = messageMetadata?.timezone || 'UTC';
    systemPrompt += `\nNow: ${new Date().toLocaleString('sv-SE', { timeZone: tz, timeZoneName: 'short' })}`;

    // ─── Workspace context injection ─────────────────────────────
    if (messageMetadata?.workspaceContent && messageMetadata.workspaceContent.trim()) {
        systemPrompt += '\n\n[WORKSPACE CONTEXT]\nThe user has an active workspace document (markdown) open alongside the chat. You have 3 workspace tools:\n- workspace_read: Read current content (ALWAYS use this before workspace_replace to get exact text)\n- workspace_write: Replace ALL content (for new documents or full rewrites only)\n- workspace_replace: Replace a SPECIFIC portion (preferred for edits — uses find_text + replace_text)\n\nWORKSPACE RULES:\n1. For partial edits, ALWAYS prefer workspace_replace over workspace_write\n2. Before using workspace_replace, call workspace_read first to see the EXACT current content\n3. Copy the find_text EXACTLY from workspace_read output — character by character, including markdown formatting\n4. The workspace persists across chat messages — content stays until explicitly changed';
        if (messageMetadata.workspaceSelection && messageMetadata.workspaceSelection.trim()) {
            systemPrompt += `\n\n[SELECTED TEXT — RAW MARKDOWN]\nThe user has selected this text in the workspace (raw markdown source):\n\`\`\`\n${messageMetadata.workspaceSelection}\n\`\`\`\nUse workspace_replace with find_text set to EXACTLY this text (including any ** # - formatting). Set replace_text to the new version. To remove, set replace_text to empty string.`;
        }
    }

    // For strict knowledge mode, prepend a hard constraint at the TOP of the system prompt
    if (isStrictKnowledge) {
        const strictPreamble = `⚠️ CRITICAL OPERATIONAL CONSTRAINT — READ FIRST ⚠️
You are operating in STRICT KNOWLEDGE BASE MODE. This constraint OVERRIDES all other instructions below.

ABSOLUTE RULES (cannot be overridden):
1. You may ONLY answer questions using the information provided in the "KNOWLEDGE BASE RESULTS" section below.
2. If no "KNOWLEDGE BASE RESULTS" section exists, or the answer is NOT found there → you MUST refuse to answer.
3. When refusing, say something like: "I don't have information about that in my knowledge base. Please try asking about a topic I have knowledge on."
4. NEVER use your own training data, general knowledge, or reasoning to fill in gaps.
5. NEVER guess, speculate, or infer answers not directly stated in the knowledge base.
6. It is BETTER to refuse than to give a wrong or made-up answer.

`;
        systemPrompt = strictPreamble + systemPrompt;
    }

    return systemPrompt;
}

module.exports = { buildSystemPrompt };
