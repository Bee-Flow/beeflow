const { processSystemPrompt } = require('../promptUtils');
const { buildToolHint } = require('../integrationTools');
const { buildSkillInjection } = require('../skillInjection');
const houseStyleStore = require('../../stores/houseStyleStore');

async function buildSystemPrompt({ agent, tools, userId, messageMetadata, memoryContext, isStrictKnowledge, forceDynamicSkills = false }) {
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

    // ─── Routine coverage addendum (R3) ──────────────────────────
    // When this turn is being driven by an agent routine, list the topics the
    // routine has covered in the past so the model can avoid repeating them
    // unless there's a real update. Only fires when memory is enabled on the
    // agent — opt-in by design.
    const routineId = messageMetadata?.routineId;
    if (routineId && agent?.config?.memoryEnabled === true) {
        try {
            const memoryStore = require('../../stores/memoryStore');
            const covered = await memoryStore.getRoutineCoverage(routineId, { limit: 30 });
            if (covered && covered.length > 0) {
                const items = covered.map(c => {
                    const when = c.last_confirmed_at ? new Date(c.last_confirmed_at).toISOString().slice(0, 10) : 'previously';
                    const label = c.value || c.summary || c.subject;
                    return `- ${label} (last covered ${when})`;
                }).join('\n');
                systemPrompt += `\n\n[ROUTINE COVERAGE — items already surfaced in past runs of this routine]
${items}

Skip these unless there is a material update since the date shown. If you do include one, lead with what changed.`;
            }
        } catch (err) {
            console.warn(`[contextBuilder] routine coverage lookup failed: ${err.message}`);
        }
    }

    // ─── Date/time context ───────────────────────────────────────
    const tz = messageMetadata?.timezone || 'UTC';
    systemPrompt += `\nNow: ${new Date().toLocaleString('sv-SE', { timeZone: tz, timeZoneName: 'short' })}`;

    // ─── Notebook context injection ─────────────────────────────
    // Two flags from the client:
    //   - notebookspaceAvailable: the Notebook panel exists (may be closed).
    //     Tells the model that calling notebook_write will auto-open it.
    //   - notebookspaceContent: the panel is currently open. `undefined` =
    //     closed; `""` = "open but blank".
    // ─── House style awareness ───────────────────────────────────
    // Org-level Word/DOCX template that gets applied at Notebook export time.
    // We tell the model the style is active so it can match tone/structure; the
    // model should NOT try to set fonts or colors in Markdown — styling is
    // applied automatically when the user exports to .docx.
    if (messageMetadata?.orgId) {
        try {
            const houseStyle = await houseStyleStore.getDefaultForOrg(messageMetadata.orgId);
            if (houseStyle) {
                const tone = houseStyle.styleMeta?.toneDescription;
                systemPrompt += `\n\n[HOUSE STYLE ACTIVE]
Org Word/DOCX kantoorstijl "${houseStyle.name}" wordt automatisch toegepast bij export naar .docx${houseStyle.description ? ` — ${houseStyle.description}` : ''}.${tone ? ` Tone of voice: ${tone}.` : ''} Schrijf documenten in het Notebook in Markdown — opmaak (lettertype, koppen, marges, header/footer) wordt bij export geregeld; geen inline styling nodig.`;
            }
        } catch (e) {
            console.warn('[contextBuilder] house style lookup failed:', e.message);
        }
    }

    if (messageMetadata?.notebookspaceAvailable) {
        systemPrompt += `\n\n[NOTEBOOK CAPABILITY]
A Notebook panel is available in the user's UI. For long-form output the user is likely to keep or edit — memos, notes, letters, briefs, reports, articles, plans, code files, meeting notes — write the document into the notebook by calling notebook_write. The panel auto-opens when you write. Tools:
- notebook_read: Read content. Modes: "outline" (default—headings+stats), "section" (one section by heading), "search" (find text), "full" (entire doc). Use outline first, then section/search for targeted access.
- notebook_write: Replace ALL content (for new documents or full rewrites). Write in Markdown.
- notebook_replace: Replace a SPECIFIC portion (find_text + replace_text). Preferred for partial edits.
- notebook_insert: Add content at "start", "end", or "after" a heading.

CRITICAL: When you use a notebook tool, do NOT also write the document text in your chat reply. Acknowledge briefly (one short sentence) and stop — the user reads the result in the Notebook panel. Use Markdown inside the notebook for headings, bold, tables, lists, code blocks.`;
    }
    if (messageMetadata?.notebookspaceContent !== undefined) {
        systemPrompt += `\n\n[NOTEBOOK OPEN]
The Notebook panel is currently open. Edit rules: 1) Before notebook_replace, use notebook_read mode="search" or mode="section" to get exact text. 2) Copy find_text EXACTLY from read output. 3) For partial edits always prefer notebook_replace over notebook_write. 4) After any notebook tool call, your chat reply is at most one short confirmation sentence — do not repeat the new or modified content.`;
        if (messageMetadata.notebookspaceSelection && messageMetadata.notebookspaceSelection.trim()) {
            systemPrompt += `\n\n[SELECTED TEXT IN NOTEBOOK]\nThe user selected this text:\n\`\`\`\n${messageMetadata.notebookspaceSelection}\n\`\`\`\nUse notebook_replace with find_text set to EXACTLY this text. Set replace_text to the new version.`;
        }
    }

    // ─── Side-panel webpage awareness ────────────────────────────
    // When the user has a webpage open in the right-side panel (next to the
    // chat), inject its current content so the AI can reason about "this
    // page" / "deze pagina" without needing a tool call.
    if (messageMetadata?.sidePanelWebpage?.id) {
        try {
            const { buildSidePanelWebpageContext } = require('../sidePanelWebpageContext');
            const block = await buildSidePanelWebpageContext(messageMetadata.sidePanelWebpage, userId);
            if (block) systemPrompt += block;
        } catch (e) {
            console.warn('[contextBuilder] sidePanelWebpage injection failed:', e.message);
        }
    }

    // ─── Skills injection ──────────────────────────────────
    // Delegates to the shared helper which splits skills into static (full
    // body injected here) and dynamic (manifest only; AI loads via the
    // `activate_skill` tool on demand). The helper returns extra tool
    // definitions that the caller (chat.js) appends to the tools array so
    // the model can actually invoke activate_skill.
    const sessionSkillIds = Array.isArray(messageMetadata?.activeSkillIds) ? messageMetadata.activeSkillIds : [];
    const attachedSkillIds = Array.isArray(agent?.config?.attachedSkillIds) ? agent.config.attachedSkillIds : [];
    const skillInjection = await buildSkillInjection({
        sessionSkillIds,
        attachedSkillIds,
        orgId: messageMetadata?.orgId,
        userId,
        forceDynamicSkills,
    });
    if (skillInjection.systemPromptAddendum) {
        systemPrompt += skillInjection.systemPromptAddendum;
        console.log(`[contextBuilder] Skills: ${skillInjection.staticCount} static, ${skillInjection.dynamicSkillIds.length} dynamic (attached=${attachedSkillIds.length}, session=${sessionSkillIds.length})`);
    }
    // Mutate the caller's tools array in place so the model sees activate_skill
    // when any dynamic skills are in play. Safe because chatStream passes the
    // same reference it later hands to the LLM.
    if (Array.isArray(tools) && skillInjection.tools.length > 0) {
        for (const t of skillInjection.tools) tools.push(t);
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
