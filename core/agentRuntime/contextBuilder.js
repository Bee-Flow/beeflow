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
    const mcpCount = tools.filter(t => t.function?.name?.startsWith('mcp_')).length;
    console.log(`[MCP-DEBUG] contextBuilder: building system prompt with ${tools.length} tools (${mcpCount} MCP)`);
    try {
        const toolHint = await buildToolHint(tools, userId);
        if (toolHint) {
            systemPrompt += toolHint;
            console.log(`[MCP-DEBUG] contextBuilder: toolHint added (${toolHint.length} chars) — preview: ${toolHint.substring(0, 200)}`);
        } else {
            console.log(`[MCP-DEBUG] contextBuilder: toolHint returned empty/null`);
        }
    } catch (e) {
        console.error(`[MCP-DEBUG] contextBuilder: buildToolHint ERROR: ${e.message}`);
    }

    if (memoryContext) {
        systemPrompt = systemPrompt + '\n\n' + memoryContext;
    }

    // ─── Date/time context ───────────────────────────────────────
    const tz = messageMetadata?.timezone || 'UTC';
    systemPrompt += `\nNow: ${new Date().toLocaleString('sv-SE', { timeZone: tz, timeZoneName: 'short' })}`;

    // ─── Notebook context injection ─────────────────────────────
    if (messageMetadata?.workspaceContent) {
        systemPrompt += `\n\n[NOTEBOOK]
The user has a Notebook panel open. You have 4 tools:
- notebook_read: Read content. Modes: "outline" (default—headings+stats), "section" (one section by heading), "search" (find text), "full" (entire doc). Use outline first, then section/search for targeted access.
- notebook_write: Replace ALL content (for new documents or full rewrites). Write in Markdown.
- notebook_replace: Replace a SPECIFIC portion (find_text + replace_text). Preferred for edits.
- notebook_insert: Add content at "start", "end", or "after" a heading.

RULES: 1) Before notebook_replace, use notebook_read mode="search" or mode="section" to get exact text. 2) Copy find_text EXACTLY from read output. 3) For partial edits always prefer notebook_replace over notebook_write. 4) Use Markdown for rich text (headings, bold, tables, code blocks, lists, etc.).`;
        if (messageMetadata.workspaceSelection && messageMetadata.workspaceSelection.trim()) {
            systemPrompt += `\n\n[SELECTED TEXT IN NOTEBOOK]\nThe user selected this text:\n\`\`\`\n${messageMetadata.workspaceSelection}\n\`\`\`\nUse notebook_replace with find_text set to EXACTLY this text. Set replace_text to the new version.`;
        }
    }

    // ─── Skills injection ──────────────────────────────────
    const activeSkillIds = messageMetadata?.activeSkillIds;
    if (Array.isArray(activeSkillIds) && activeSkillIds.length > 0 && messageMetadata?.orgId) {
        try {
            const skillStore = require('../../stores/skillStore');
            const cappedIds = activeSkillIds.slice(0, 3);
            const skills = await skillStore.getSkillsByIds(cappedIds, messageMetadata.orgId, userId);
            if (skills.length > 0) {
                const skillBlocks = skills.map(s => {
                    let block = `\n### SKILL — "${s.name}"`;
                    if (s.instructions) block += `\nInstructions: ${s.instructions}`;
                    if (s.workflow)     block += `\nWorkflow: ${s.workflow}`;
                    if (s.rules)        block += `\nRules: ${s.rules}`;
                    if (s.examples)     block += `\nExamples: ${s.examples}`;
                    return block;
                }).join('\n');
                systemPrompt += `\n\n[ACTIVE SKILLS]\nThe user has activated the following skills. Follow their instructions precisely when the task matches.${skillBlocks}`;
                console.log(`[contextBuilder] Injected ${skills.length} skill(s): ${skills.map(s => s.name).join(', ')}`);
            }
        } catch (skillErr) {
            console.warn('[contextBuilder] Skills injection failed:', skillErr.message);
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
